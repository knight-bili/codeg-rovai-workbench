import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasGraphSnapshot, CanvasNodeMutation, CoreEvent, CoreMethod, StoredCommandResult } from '@contracts'
import { CanvasGraphController, canvasGraphInvalidation } from './canvas-graph-controller'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function snapshot(id = 'board', revision = 1, sequence = revision * 10): CanvasGraphSnapshot {
  return { board: { id, name: id, description: null, color: null, revision, createdAt: 'time', updatedAt: 'time' },
    nodes: [], throughGlobalSequence: sequence }
}
function result(commandId: string, revision = 2, status: StoredCommandResult['status'] = 'applied'): StoredCommandResult {
  return { commandId, commandType: 'canvas.nodes.apply', status, code: status === 'rejected' ? 'canvas.nodes.conflict' : 'canvas.nodes.updated',
    payload: { boardId: 'board', revision, nodeIds: ['node'], deletedNodeIds: [] }, resultEntity: null, recordedAt: 'time' }
}
function fixture(handler: (method: CoreMethod, params: unknown) => Promise<unknown>) {
  const events = new Set<(event: CoreEvent) => void>(), invalidations = new Set<() => void>()
  const requests: Array<{ method: CoreMethod; params: unknown }> = []
  const client = {
    request<T>(method: CoreMethod, params?: unknown): Promise<T> {
      requests.push({ method, params: structuredClone(params) })
      return handler(method, params) as Promise<T>
    },
    onEvent(listener: (event: CoreEvent) => void) { events.add(listener); return () => { events.delete(listener) } },
    onInvalidated(listener: () => void) { invalidations.add(listener); return () => { invalidations.delete(listener) } }
  }
  return { client, requests, events, invalidations,
    emit(event: CoreEvent) { for (const listener of events) listener(event) } }
}
const controllers: CanvasGraphController[] = []
const controller = (client: ConstructorParameters<typeof CanvasGraphController>[0], board = 'board') => {
  const current = new CanvasGraphController(client, board); controllers.push(current); return current
}
afterEach(() => { controllers.splice(0).forEach(item => item.dispose()); vi.useRealTimers() })

it.each([undefined, 0, 1])('独立对象写入按快照能力声明准入（%s）', async version => {
  const transport = fixture(async (method, params) => method === 'canvas.nodes.snapshot'
    ? { ...snapshot(), objectReferenceVersion: version } : result((params as { commandId: string }).commandId))
  const current = controller(transport.client); current.start(); await current.refresh()
  const mutation: CanvasNodeMutation = { type: 'create', node: { kind: 'conversation', conversation: { threadId: 'thread', conversationId: null },
    objectReference: { kind: 'mission', missionId: 'original' }, x: 0, y: 0, width: 224, height: 132 } }
  if (version === 1) {
    await current.apply(mutation)
    expect(transport.requests.filter(item => item.method === 'canvas.nodes.apply')).toHaveLength(1)
  } else {
    await expect(current.apply(mutation)).rejects.toThrow('升级服务')
    expect(transport.requests.filter(item => item.method === 'canvas.nodes.apply')).toEqual([])
    expect(current.getSnapshot().pending).toBeNull()
  }
})

describe('Canvas graph ownership and command recovery', () => {
  it.each([undefined, 0, 1])('文件来源创建与旧节点显式绑定均按能力准入（%s）', async version => {
    for (const mutation of [
      { type: 'create', node: { kind: 'file', path: '/原文件.txt ', fileReference: { threadId: 'original-thread' }, x: 0, y: 0, width: 320, height: 220 } },
      { type: 'bind_file', nodeId: 'legacy-node', threadId: 'original-thread' }
    ] satisfies CanvasNodeMutation[]) {
      const transport = fixture(async (method, params) => method === 'canvas.nodes.snapshot'
        ? { ...snapshot(), fileReferenceVersion: version } : result((params as { commandId: string }).commandId))
      const current = controller(transport.client); current.start(); await current.refresh()
      if (version === 1) { await current.apply(mutation); expect(transport.requests.filter(item => item.method === 'canvas.nodes.apply')).toHaveLength(1) }
      else {
        await expect(current.apply(mutation)).rejects.toThrow('升级服务')
        expect(transport.requests.filter(item => item.method === 'canvas.nodes.apply')).toEqual([])
        expect(current.getSnapshot().pending).toBeNull()
      }
    }
  })
  it('subscribes before reading, rejects a pre-invalidation snapshot, then converges without replaying events', async () => {
    vi.useFakeTimers()
    const first = deferred<CanvasGraphSnapshot>()
    let reads = 0
    const transport = fixture(async method => {
      expect(method).toBe('canvas.nodes.snapshot')
      expect(transport.events.size).toBe(1)
      return ++reads === 1 ? first.promise : snapshot('board', 2, 22)
    })
    const current = controller(transport.client)
    current.start()
    transport.emit({ method: 'events.batch', params: { events: [
      { eventType: 'canvas.board.invalidated', globalSequence: 22, payload: { boardId: 'board', revision: 2, nodes: ['untrusted delta'] } }
    ] } })
    first.resolve(snapshot())
    await vi.advanceTimersByTimeAsync(0)
    expect(current.getSnapshot().snapshot).toBeNull()
    await vi.advanceTimersByTimeAsync(1000)
    expect(current.getSnapshot().snapshot).toEqual(snapshot('board', 2, 22))
    const count = transport.requests.length
    transport.emit({ method: 'canvas.board.invalidated', params: { boardId: 'another', revision: 50 } })
    transport.emit({ method: 'canvas.board.invalidated', params: { boardId: 'board', revision: 1 } })
    await vi.advanceTimersByTimeAsync(200)
    expect(transport.requests).toHaveLength(count)
    expect(canvasGraphInvalidation({ method: 'events.batch', params: { resetRequired: true, throughGlobalSequence: 30 } }, 'board')).toEqual({ revision: 0, sequence: 30 })
    expect(canvasGraphInvalidation({ method: 'events.batch', params: { events: [{ eventType: 'command.result', payload: {} }] } }, 'board')).toBeNull()
    expect(canvasGraphInvalidation({ method: 'events.batch', params: { events: [
      { eventType: 'canvas.board.invalidated', globalSequence: 31, payload: { boardId: 'board', revision: 3 } },
      { eventType: 'canvas.board.invalidated', globalSequence: 32, payload: { boardId: 'foreign', revision: 90 } },
      { eventType: 'canvas.board.invalidated', globalSequence: 33, payload: { boardId: 'board', revision: 4 } }
    ] } }, 'board')).toEqual({ revision: 4, sequence: 33 })
  })

  it('disposes the previous Host/board scope before late reads can publish into the new scope', async () => {
    const oldRead = deferred<CanvasGraphSnapshot>()
    const oldHost = fixture(async () => oldRead.promise), newHost = fixture(async () => snapshot('other', 5))
    const previous = controller(oldHost.client)
    const changed = vi.fn(); previous.subscribe(changed); previous.start(); previous.dispose()
    const calls = changed.mock.calls.length
    const next = controller(newHost.client, 'other'); next.start(); await next.refresh()
    oldRead.resolve(snapshot()); await Promise.resolve(); await Promise.resolve()
    expect(changed).toHaveBeenCalledTimes(calls)
    expect(previous.getSnapshot().snapshot).toBeNull()
    expect(next.getSnapshot().snapshot?.board?.id).toBe('other')
    expect(oldHost.events.size).toBe(0); expect(oldHost.invalidations.size).toBe(0)
    await expect(previous.apply({ type: 'prune' })).rejects.toThrow('无法修改')
  })

  it('keeps the exact unknown gesture across newer reads and only retries its original identity and revision', async () => {
    const cases: CanvasNodeMutation[] = [
      { type: 'create', node: { kind: 'conversation', conversation: { threadId: 'thread', conversationId: null },
        objectReference: { kind: 'mission_diff', missionId: 'original-mission', path: ' dir/原文件.rs ' }, x: 0, y: 0, width: 224, height: 132 } },
      { type: 'move', moves: [{ nodeId: 'node', x: 12, y: 24 }] },
      { type: 'create', node: { kind: 'file', path: '/原文件.txt ', fileReference: { threadId: 'original-thread' }, x: 0, y: 0, width: 320, height: 220 } },
      { type: 'bind_file', nodeId: 'original-file-node', threadId: 'original-thread' },
      { type: 'group', targetNodeId: 'target', newRegion: null,
        conversations: [{ threadId: 'thread', conversationId: 'private' }], consumeNodeIds: [],
        sourceMembers: [{ regionId: 'source', conversation: { threadId: 'thread', conversationId: 'private' } }] }
    ]
    for (const gesture of cases) {
      let revision = 1, writes = 0
      const transport = fixture(async (method, params) => {
        if (method === 'canvas.nodes.snapshot') return { ...snapshot('board', revision), objectReferenceVersion: 1, fileReferenceVersion: 1 }
        if (method === 'canvas.nodes.apply') {
          if (++writes === 1) throw new TypeError('response lost')
          return result((params as { commandId: string }).commandId)
        }
        throw Error(method)
      })
      const current = controller(transport.client); current.start(); await current.refresh()
      const original = structuredClone(gesture)
      await expect(current.apply(gesture)).rejects.toThrow('response lost')
      if (gesture.type === 'move') gesture.moves[0].x = 900
      if (gesture.type === 'group') { gesture.conversations.length = 0; gesture.sourceMembers![0].conversation.conversationId = 'changed' }
      if (gesture.type === 'create' && gesture.node.objectReference?.kind === 'mission_diff') gesture.node.objectReference.missionId = 'later-rebound-mission'
      if (gesture.type === 'create' && gesture.node.fileReference) { gesture.node.fileReference.threadId = 'replacement'; gesture.node.path = '/replacement.txt' }
      if (gesture.type === 'bind_file') { gesture.threadId = 'replacement'; gesture.nodeId = 'replacement-file-node' }
      revision = 9; await current.refresh()
      expect(current.getSnapshot().pending?.state).toBe('unknown')
      await expect(current.apply({ type: 'prune' })).rejects.toThrow('原操作')
      const receipt = await current.retry()
      const sent = transport.requests.filter(item => item.method === 'canvas.nodes.apply')
      expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0])
      expect(sent[1].params).toMatchObject({ command: { expectedRevision: 1, mutation: original } })
      expect(current.getSnapshot().lastResult).toBe(receipt)
      expect(current.getSnapshot().pending).toBeNull()
    }
  })

  it('retains a successful result when the following read fails and does not silently rebase a conflict', async () => {
    vi.useFakeTimers()
    let readFails = false, revision = 1, writes = 0
    const transport = fixture(async (method, params) => {
      if (method === 'canvas.nodes.snapshot') {
        if (readFails) throw Error('offline after commit')
        return snapshot('board', revision)
      }
      ++writes
      const receipt = result((params as { commandId: string }).commandId, revision + 1, writes === 1 ? 'applied' : 'rejected')
      if (writes === 1) { ++revision; readFails = true }
      return receipt
    })
    const current = controller(transport.client); current.start(); await current.refresh()
    const saved = await current.apply({ type: 'prune' }); await vi.advanceTimersByTimeAsync(0)
    expect(saved.status).toBe('applied'); expect(current.getSnapshot().lastResult).toBe(saved)
    expect(current.getSnapshot().pending).toBeNull(); expect(current.getSnapshot().readError).toBeTruthy()
    await expect(current.apply({ type: 'prune' })).rejects.toThrow('尚未同步')
    readFails = false; await current.refresh()
    expect((await current.apply({ type: 'prune' })).status).toBe('rejected')
    await vi.advanceTimersByTimeAsync(0)
    expect(current.getSnapshot().snapshot?.board?.revision).toBe(2)
    expect(current.getSnapshot().readError).toBeTruthy()
    revision = 3; await current.refresh()
    expect(current.getSnapshot().snapshot?.board?.revision).toBe(3)
    expect(writes).toBe(2)
    expect(current.getSnapshot().pending).toBeNull()
  })

  it('uses the version captured when editing or dragging began even if a newer read arrived before submit', async () => {
    let revision = 1
    const transport = fixture(async (method, params) => {
      if (method === 'canvas.nodes.snapshot') return snapshot('board', revision)
      return result((params as { commandId: string }).commandId, revision, 'rejected')
    })
    const current = controller(transport.client); current.start(); await current.refresh()
    const gestureRevision = current.getSnapshot().snapshot!.board!.revision
    revision = 4; await current.refresh()
    expect((await current.apply({ type: 'move', moves: [{ nodeId: 'node', x: 48, y: 72 }] }, gestureRevision)).status).toBe('rejected')
    expect(transport.requests.filter(item => item.method === 'canvas.nodes.apply')).toHaveLength(1)
    expect(transport.requests.find(item => item.method === 'canvas.nodes.apply')?.params).toMatchObject({ command: { expectedRevision: 1 } })
  })

  it('reconciles unknown receipts without dispatch and leaves an overlapping explicit retry in control', async () => {
    const delayed = deferred<{ state: 'recorded'; result: StoredCommandResult }>()
    let writes = 0, lookups = 0, commandId = ''
    const transport = fixture(async (method, params) => {
      if (method === 'canvas.nodes.snapshot') return snapshot('board', writes > 1 ? 2 : 1)
      if (method === 'commands.reconcile') return ++lookups === 1 ? { state: 'unknown' } : delayed.promise
      commandId = (params as { commandId: string }).commandId
      if (++writes === 1) throw Error('lost')
      return result(commandId)
    })
    const current = controller(transport.client); current.start(); await current.refresh()
    await expect(current.apply({ type: 'prune' })).rejects.toThrow('lost')
    expect(await current.reconcile()).toBeNull(); expect(writes).toBe(1)
    const lookup = current.reconcile()
    const retried = await current.retry()
    delayed.resolve({ state: 'recorded', result: { ...retried } })
    expect(await lookup).toEqual(retried)
    expect(current.getSnapshot().lastResult).toBe(retried)
    expect(current.getSnapshot().pending).toBeNull()
    expect(writes).toBe(2)
  })
})
