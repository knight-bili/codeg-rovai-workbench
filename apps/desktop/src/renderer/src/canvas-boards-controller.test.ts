import { afterEach, expect, it, vi } from 'vitest'
import type { CanvasBoardsSnapshot, CoreEvent, CoreMethod, StoredCommandResult } from '@contracts'
import { CanvasBoardsController, type CanvasBoardIntent } from './canvas-boards-controller'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function snapshot(revision = 1, sequence = revision * 10): CanvasBoardsSnapshot {
  return { boards: [{ id: 'board', name: null, description: null, color: null, revision, createdAt: 'time', updatedAt: 'time' }], throughGlobalSequence: sequence }
}
function fixture(handler: (method: CoreMethod, params: unknown) => Promise<unknown>) {
  const events = new Set<(event: CoreEvent) => void>(), requests: Array<{ method: CoreMethod; params: unknown }> = []
  const client = {
    request<T>(method: CoreMethod, params?: unknown): Promise<T> { requests.push({ method, params: structuredClone(params) }); return handler(method, params) as Promise<T> },
    onEvent(listener: (event: CoreEvent) => void) { events.add(listener); return () => { events.delete(listener) } }
  }
  const controller = new CanvasBoardsController(client)
  controllers.push(controller)
  return { controller, requests, events }
}

it('keeps summaries in the authoritative board read and rejects mixed revisions or partial geometry without replacing the last snapshot', async () => {
  const rect = { kind: 'note' as const, x: -120, y: 80, width: 320, height: 260, color: 'orange' }
  let next: CanvasBoardsSnapshot = { ...snapshot(), summaries: [{ boardId: 'board', revision: 1, nodeCount: 1, terminalCount: 0, preview: [rect] }] }
  const transport = fixture(async () => structuredClone(next)), current = transport.controller
  current.start(); await current.refresh()
  const accepted = current.getSnapshot().snapshot!
  expect(accepted.summaries?.[0].preview).toEqual([rect])
  for (const change of [{ revision: 0 }, { boardId: 'other' }, { nodeCount: -1 }, { terminalCount: 2 }, { preview: [] },
    { preview: [{ ...rect, width: Infinity }] }]) {
    next = { ...snapshot(), summaries: [{ ...accepted.summaries![0], ...change }] }
    await expect(current.refresh()).rejects.toThrow('统计与列表不一致')
    expect(current.getSnapshot().snapshot).toBe(accepted)
  }
  next = { ...snapshot(2, 20), summaries: [{ boardId: 'board', revision: 2, nodeCount: 201, terminalCount: 1, preview: Array.from({ length: 200 }, () => rect) }] }
  await current.refresh(); expect(current.getSnapshot().snapshot?.summaries?.[0].nodeCount).toBe(201)
  next = snapshot(3, 30); await current.refresh()
  expect(current.getSnapshot().snapshot?.summaries).toBeUndefined()
  expect(transport.requests.every(item => item.method === 'canvas.boards.list')).toBe(true)
})
function receipt(id: string, operation: string, payload: StoredCommandResult['payload'] = {}): StoredCommandResult {
  return { commandId: id, commandType: operation, status: 'applied', code: 'canvas.board.created', payload, resultEntity: null, recordedAt: 'time' }
}
const controllers: CanvasBoardsController[] = []
afterEach(() => { controllers.splice(0).forEach(item => item.dispose()); vi.useRealTimers() })

it('subscribes before reading and refetches rather than applying board events or stale node-shared revisions', async () => {
  vi.useFakeTimers()
  const initial = deferred<CanvasBoardsSnapshot>(); let reads = 0
  const transport = fixture(async method => {
    expect(method).toBe('canvas.boards.list'); expect(transport.events.size).toBe(1)
    return ++reads === 1 ? initial.promise : snapshot(4, 42)
  })
  transport.controller.start()
  transport.events.forEach(listener => listener({ method: 'events.batch', params: { events: [
    { eventType: 'canvas.board.invalidated', globalSequence: 42, payload: { boardId: 'board', revision: 4, name: 'untrusted event name' } }
  ] } }))
  initial.resolve(snapshot()); await vi.advanceTimersByTimeAsync(0)
  expect(transport.controller.getSnapshot().snapshot).toBeNull()
  await vi.advanceTimersByTimeAsync(1000)
  expect(transport.controller.getSnapshot().snapshot).toEqual(snapshot(4, 42))
  transport.controller.dispose()
  expect(transport.events.size).toBe(0)
  await expect(transport.controller.apply({ operation: 'canvas.boards.create', command: {} })).rejects.toThrow('尚未同步')
})

it('freezes all three board command envelopes and only explicitly retries the same unknown identity', async () => {
  for (const operation of ['canvas.boards.create', 'canvas.boards.update', 'canvas.boards.delete'] as const) {
    let writes = 0, revision = 1
    const transport = fixture(async (method, params) => {
      if (method === 'canvas.boards.list') return snapshot(revision)
      if (method === 'commands.reconcile') return { state: 'unknown' }
      if (++writes === 1) throw new TypeError('response lost')
      return receipt((params as { commandId: string }).commandId, operation)
    })
    const current = transport.controller; current.start(); await current.refresh()
    const intent: CanvasBoardIntent = operation === 'canvas.boards.create' ? { operation, command: { name: 'original' } }
      : { operation, command: { boardId: 'board', expectedRevision: 1 } }
    await expect(current.apply(intent)).rejects.toThrow('response lost')
    if ('expectedRevision' in intent.command) intent.command.expectedRevision = 99
    else intent.command.name = 'changed'
    revision = 9; await current.refresh()
    expect(await current.reconcile()).toBeNull(); expect(writes).toBe(1)
    await expect(current.apply({ operation: 'canvas.boards.create', command: {} })).rejects.toThrow('仍待核对')
    await current.retry()
    const sent = transport.requests.filter(item => item.method === operation)
    expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0])
    expect(current.getSnapshot().pending).toBeNull()
  }
})

it('keeps recorded results through read failures and guards a disposed owner against late publication', async () => {
  let fails = false
  const transport = fixture(async (method, params) => {
    if (method === 'canvas.boards.list') { if (fails) throw Error('offline after commit'); return snapshot() }
    fails = true
    return receipt((params as { commandId: string }).commandId, 'canvas.boards.create')
  })
  const current = transport.controller; current.start(); await current.refresh()
  const saved = await current.apply({ operation: 'canvas.boards.create', command: {} })
  await Promise.resolve(); await Promise.resolve()
  expect(current.getSnapshot().lastResult).toBe(saved); expect(current.getSnapshot().pending).toBeNull()
  expect(current.getSnapshot().readError).toBeTruthy()
  await expect(current.apply({ operation: 'canvas.boards.create', command: {} })).rejects.toThrow('尚未同步')
  const delayed = deferred<CanvasBoardsSnapshot>(), previous = fixture(async () => delayed.promise)
  const listener = vi.fn(); previous.controller.subscribe(listener); previous.controller.start(); previous.controller.dispose()
  const calls = listener.mock.calls.length
  delayed.resolve(snapshot(9)); await Promise.resolve(); await Promise.resolve()
  expect(listener).toHaveBeenCalledTimes(calls); expect(previous.controller.getSnapshot().snapshot).toBeNull()
})

it('accepts authoritative deletion, never resurrects a board from a receipt and rejects an older list', async () => {
  let list = snapshot()
  const transport = fixture(async (method, params) => {
    if (method === 'canvas.boards.list') return list
    list = { boards: [], throughGlobalSequence: 20 }
    return receipt((params as { commandId: string }).commandId, 'canvas.boards.delete', { boardId: 'board', revision: 2 })
  })
  const current = transport.controller; current.start(); await current.refresh()
  await current.apply({ operation: 'canvas.boards.delete', command: { boardId: 'board', expectedRevision: 1 } })
  await current.refresh(); expect(current.getSnapshot().snapshot?.boards).toEqual([])
  list = snapshot()
  await expect(current.refresh()).rejects.toThrow('同步最新修改')
  expect(current.getSnapshot().snapshot?.boards).toEqual([])
})
