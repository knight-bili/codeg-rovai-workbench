import { afterEach, expect, it, vi } from 'vitest'
import type { CanvasReferencePage, CanvasThreadReference, CoreEvent, CoreMethod } from '@contracts'
import { CanvasReferenceController, canvasReferencesInvalidation } from './canvas-reference-controller'

const row = (threadId: string): CanvasThreadReference => ({ threadId, title: threadId, projectBindingKind: 'directory', projectPath: '/project',
  updatedAt: '2026-10-15T00:00:00Z', version: 1, missionId: null, members: [], privateConversations: [] })
const page = (ids: string[], next: string | null, upper: string | null): CanvasReferencePage => ({ schemaVersion: 1, throughGlobalSequence: 10,
  items: ids.map(row), nextAfterThreadId: next, upperThreadId: upper })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
function fixture(handler: (params: { afterThreadId: string | null; upperThreadId: string | null }) => Promise<CanvasReferencePage>) {
  const events = new Set<(event: CoreEvent) => void>(), calls: unknown[] = []
  const controller = new CanvasReferenceController({
    request: <T,>(method: CoreMethod, params?: unknown): Promise<T> => {
      expect(method).toBe('canvas.references.page'); expect(events.size).toBe(1)
      calls.push(structuredClone(params)); return handler(params as Parameters<typeof handler>[0]) as Promise<T>
    },
    onEvent(listener) { events.add(listener); return () => { events.delete(listener) } }
  })
  controllers.push(controller)
  return { controller, calls, emit: (event: CoreEvent) => events.forEach(listener => listener(event)) }
}
const controllers: CanvasReferenceController[] = []
afterEach(() => { controllers.splice(0).forEach(item => item.dispose()); vi.useRealTimers() })

it('reads every page under one upper bound and ignores graph-only events without per-Thread fanout', async () => {
  vi.useFakeTimers()
  const transport = fixture(async params => params.afterThreadId === null ? page(['a'], 'a', 'b') : page(['b'], null, 'b'))
  transport.controller.start(); await vi.advanceTimersByTimeAsync(0)
  expect(transport.calls).toEqual([{ afterThreadId: null, upperThreadId: null, limit: 200 }, { afterThreadId: 'a', upperThreadId: 'b', limit: 200 }])
  expect(transport.controller.getSnapshot()).toMatchObject({ complete: true, loading: false, pagesRead: 2 })
  expect(transport.controller.getSnapshot().items.map(item => item.threadId)).toEqual(['a', 'b'])
  expect(canvasReferencesInvalidation({ method: 'events.batch', params: { events: [{ eventType: 'canvas.node.moved', globalSequence: 20 }] } })).toBeNull()
  expect(canvasReferencesInvalidation({ method: 'events.batch', params: { events: [{ eventType: 'agent_run.status_changed', globalSequence: 20 }] } })).toBe(20)
  transport.emit({ method: 'canvas.board.invalidated', params: { boardId: 'unrelated' } })
  await vi.advanceTimersByTimeAsync(200); expect(transport.calls).toHaveLength(2)
  transport.emit({ method: 'single_chat.changed', params: {} })
  expect(transport.controller.getSnapshot().complete).toBe(false)
  await vi.advanceTimersByTimeAsync(200)
  expect(transport.controller.getSnapshot().complete).toBe(true); expect(transport.calls).toHaveLength(4)
})

it('rejects looping pages, changed bounds and mismatched private owners without claiming an empty complete directory', async () => {
  vi.useFakeTimers()
  for (const invalid of [
    () => page(['a'], 'a', 'b'),
    () => page(['b'], null, 'c'),
    () => ({ ...page(['b'], null, 'b'), items: [{ ...row('b'), privateConversations: [{ conversationId: 'private', agentId: 'foreign', updatedAt: 'time' }] }] }),
    () => ({ ...page(['b'], null, 'b'), items: [{ ...row('b'), publicActiveRunCount: -1 }] }),
    () => ({ ...page(['b'], null, 'b'), items: [{ ...row('b'), publicActiveRunCount: Number.NaN }] }),
    () => ({ ...page(['b'], null, 'b'), items: [{ ...row('b'), members: [{ agentId: 'a', displayName: 'A', runtimeKind: null, lastRunModel: { runId: '', adapterKind: 'codex-cli', modelId: 'model', reasoningEffort: null } }] }] }),
    () => ({ ...page(['b'], null, 'b'), items: [{ ...row('b'), members: [{ agentId: 'a', displayName: 'A', runtimeKind: null }], privateConversations: [{ conversationId: 'private', agentId: 'a', updatedAt: 'time', lastRunModel: { runId: 'run', adapterKind: 'codex-cli', modelId: '' , reasoningEffort: null } }] }] })
  ]) {
    const transport = fixture(async params => params.afterThreadId === null ? page(['a'], 'a', 'b') : invalid())
    transport.controller.start(); await vi.advanceTimersByTimeAsync(0)
    expect(transport.controller.getSnapshot()).toMatchObject({ complete: false, loading: false })
    expect(transport.controller.getSnapshot().error).toBeTruthy()
    expect(transport.controller.getSnapshot().items.map(item => item.threadId)).toEqual(['a'])
    transport.controller.dispose()
  }
})

it('keeps an invalidated scan partial until the trailing bounded scan includes the new identity', async () => {
  vi.useFakeTimers()
  const second = deferred<CanvasReferencePage>(), trailing = deferred<CanvasReferencePage>(); let scans = 0
  const transport = fixture(async params => {
    if (params.afterThreadId === null) return ++scans === 1 ? page(['a'], 'a', 'b') : trailing.promise
    return second.promise
  })
  transport.controller.start(); await vi.advanceTimersByTimeAsync(0)
  transport.emit({ method: 'navigation.invalidated', params: {} })
  second.resolve(page(['b'], null, 'b')); await vi.advanceTimersByTimeAsync(0)
  expect(transport.controller.getSnapshot().items.map(item => item.threadId)).toEqual(['a', 'b'])
  expect(transport.controller.getSnapshot().complete).toBe(false)
  trailing.resolve(page(['a', 'b', 'c'], null, 'c')); await vi.advanceTimersByTimeAsync(0)
  expect(transport.controller.getSnapshot().items.map(item => item.threadId)).toEqual(['a', 'b', 'c'])
  expect(transport.controller.getSnapshot().complete).toBe(true)
})

it('stops a disposed Host from publishing late data or requesting another page', async () => {
  vi.useFakeTimers()
  const delayed = deferred<CanvasReferencePage>(), previous = fixture(async () => delayed.promise)
  const listener = vi.fn(); previous.controller.subscribe(listener); previous.controller.start(); previous.controller.dispose()
  const count = listener.mock.calls.length
  delayed.resolve(page(['a'], 'a', 'b')); await vi.advanceTimersByTimeAsync(0)
  expect(listener).toHaveBeenCalledTimes(count); expect(previous.calls).toHaveLength(1)
  const next = fixture(async () => page([], null, null)); next.controller.start(); await vi.advanceTimersByTimeAsync(0)
  expect(next.controller.getSnapshot()).toMatchObject({ items: [], complete: true })
  expect(previous.controller.getSnapshot().items).toEqual([])
})
