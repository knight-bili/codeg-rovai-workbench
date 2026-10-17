import { afterEach, expect, it, vi } from 'vitest'
import type { CoreEvent, CoreMethod, NavigationActivitySnapshot, ThreadReadInvalidation } from '@contracts'
import { NavigationActivityController, navigationActivityForGroups, navigationActivityInvalidation } from './navigation-activity-controller'

type Params = { groupKeys: string[]; threadIds?: string[] }
const A = 'directory:/a', B = 'directory:/b'
const snapshot = (keys: string[], count = 0, sequence = 10): NavigationActivitySnapshot => ({ schemaVersion: 1, throughGlobalSequence: sequence,
  groups: keys.map(groupKey => ({ groupKey, activeThreadCount: count })) })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const owners: NavigationActivityController[] = []
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers() })
function fixture(read: (params: Params) => Promise<NavigationActivitySnapshot>) {
  const events = new Set<(event: CoreEvent) => void>(), invalidations = new Set<(change?: ThreadReadInvalidation) => void>(), calls: Params[] = []
  const controller = new NavigationActivityController({
    request: <T,>(method: CoreMethod, params?: unknown): Promise<T> => { expect(method).toBe('navigation.activity'); const query = structuredClone(params as Params); calls.push(query); return read(query) as Promise<T> },
    onEvent(listener) { events.add(listener); return () => { events.delete(listener) } },
    onInvalidated(listener) { invalidations.add(listener); return () => { invalidations.delete(listener) } }
  })
  owners.push(controller)
  return { controller, calls, events, invalidations, emit: (params: Record<string, unknown>) => events.forEach(listener => listener({ method: 'navigation.invalidated', params })) }
}
async function start(test: ReturnType<typeof fixture>, keys = [A, B]) {
  test.controller.start(); test.controller.setGroups(keys); test.controller.setVisible(true); await vi.advanceTimersByTimeAsync(80)
}

it('reads bounded full metadata chunks once without per-Thread reads or collapsing unknown to zero', async () => {
  vi.useFakeTimers()
  const test = fixture(async params => snapshot(params.groupKeys)), keys = Array.from({ length: 401 }, (_, index) => `directory:/p${index}`)
  expect(navigationActivityForGroups(test.controller.getSnapshot(), keys).count).toBeNull()
  await start(test, keys)
  expect(test.calls.map(call => call.groupKeys.length)).toEqual([200, 200, 1])
  expect(test.controller.getSnapshot().groups.size).toBe(401)
  expect(navigationActivityForGroups(test.controller.getSnapshot(), keys)).toEqual({ count: 0, complete: true })
})

it('coalesces window-external run notifications into Core-owned group resolution and ignores read/rename or message-only invalidations', async () => {
  vi.useFakeTimers()
  const test = fixture(async params => params.threadIds ? snapshot([A], 8, 11) : snapshot(params.groupKeys))
  await start(test)
  test.emit({ scope: 'camp', reason: 'navigation.campViewed', threadId: 'outside' }); test.emit({ scope: 'camp', reason: 'camps.rename', threadId: 'outside' })
  test.emit({ scope: 'group', groupKeys: ['directory:/foreign'], throughGlobalSequence: 9999 })
  test.invalidations.forEach(listener => listener({ messages: [] })); await vi.advanceTimersByTimeAsync(100)
  expect(test.calls).toHaveLength(1)
  test.emit({ scope: 'camp', reason: 'agent_run.started', threadId: 'outside-one' })
  test.emit({ scope: 'camp', reason: 'agent_run.terminal', threadId: 'outside-two' })
  expect(test.controller.getSnapshot().resolving).toBe(true)
  await vi.advanceTimersByTimeAsync(80)
  expect(test.calls[1]).toEqual({ groupKeys: [A, B], threadIds: ['outside-one', 'outside-two'] })
  expect(test.calls).toHaveLength(2)
  expect(navigationActivityForGroups(test.controller.getSnapshot(), [A, B])).toEqual({ count: 8, complete: true })
})

it('refreshes known affected groups without rereading unrelated metadata and keeps failed counts explicitly stale', async () => {
  vi.useFakeTimers()
  let fail = false, count = 2, sequence = 10
  const test = fixture(async params => { if (fail) throw new Error('offline'); return snapshot(params.groupKeys, count, sequence) })
  await start(test); fail = true
  test.emit({ scope: 'group', groupKeys: [B], reason: 'camps.create' }); await vi.advanceTimersByTimeAsync(80)
  expect(test.calls[1]).toEqual({ groupKeys: [B] })
  expect(test.controller.getSnapshot().groups.get(A)?.complete).toBe(true)
  expect(test.controller.getSnapshot().groups.get(B)).toEqual({ count: 2, sequence: 10, complete: false })
  fail = false; count = 0; sequence = 11; await vi.advanceTimersByTimeAsync(1000)
  expect(test.controller.getSnapshot().groups.get(B)).toEqual({ count: 0, sequence: 11, complete: true })
})

it('does not publish an in-flight read invalidated during its response and schedules a complete trailing scoped read', async () => {
  vi.useFakeTimers()
  const first = deferred<NavigationActivitySnapshot>(); let reads = 0
  const test = fixture(async params => ++reads === 1 ? first.promise : snapshot(params.groupKeys, 3, 11))
  const seen: Array<number | undefined> = []; test.controller.subscribe(() => seen.push(test.controller.getSnapshot().groups.get(A)?.count))
  await start(test)
  test.emit({ scope: 'camp', reason: 'agent_run.started', threadId: 'outside' })
  first.resolve(snapshot([A, B], 99)); await vi.advanceTimersByTimeAsync(160)
  expect(seen).not.toContain(99); expect(test.controller.getSnapshot().groups.get(A)?.count).toBe(3)
  expect(test.controller.getSnapshot().resolving).toBe(false)
})

it('rejects malformed, foreign, incomplete or regressed replies and preserves the last successful value for manual/poll recovery', async () => {
  vi.useFakeTimers()
  for (const bad of [
    { ...snapshot([A], 0), schemaVersion: 2 }, snapshot([A], -1), snapshot([A], 1.5), snapshot([A], 0, 9),
    snapshot(['directory:/foreign']), snapshot([]), { ...snapshot([A]), groups: [snapshot([A]).groups[0], snapshot([A]).groups[0]] }
  ] as NavigationActivitySnapshot[]) {
    let reply = snapshot([A], 4)
    const test = fixture(async () => reply); await start(test, [A]); reply = bad
    const refresh = test.controller.refresh('explicit'); const rejected = expect(refresh).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(0); await rejected
    expect(test.controller.getSnapshot().groups.get(A)).toEqual({ count: 4, sequence: 10, complete: false })
    test.controller.dispose()
  }
})

it('removes departed groups and ignores late/disposed responses, subscriptions and empty-scope events', async () => {
  vi.useFakeTimers()
  const pending = deferred<NavigationActivitySnapshot>(); let wait = false
  const test = fixture(async params => wait ? pending.promise : snapshot(params.groupKeys, 1))
  await start(test); wait = true
  const refresh = test.controller.refresh('explicit'); await vi.advanceTimersByTimeAsync(0)
  test.controller.setGroups([]); pending.resolve(snapshot([A, B], 90, 11)); await vi.advanceTimersByTimeAsync(80); await refresh
  expect(test.controller.getSnapshot()).toEqual({ groups: new Map(), resolving: false })
  const calls = test.calls.length; test.emit({ scope: 'all' }); await vi.advanceTimersByTimeAsync(1000); expect(test.calls).toHaveLength(calls)
  test.controller.dispose(); expect(test.events.size).toBe(0); expect(test.invalidations.size).toBe(0)
})

it('pauses hidden reads and caps pending Thread IDs by reconciling metadata after a notification burst', async () => {
  vi.useFakeTimers()
  const test = fixture(async params => snapshot(params.groupKeys, 1)); await start(test)
  test.controller.setVisible(false)
  for (let index = 0; index < 450; index++) test.emit({ scope: 'camp', reason: 'agent_run.started', threadId: `hidden-${index}` })
  await vi.advanceTimersByTimeAsync(5000); expect(test.calls).toHaveLength(1)
  test.controller.setVisible(true); await vi.advanceTimersByTimeAsync(80)
  expect(test.calls.length).toBeLessThanOrEqual(3)
  expect(test.calls.every(call => call.groupKeys.length <= 200 && (call.threadIds?.length ?? 0) <= 200)).toBe(true)
  expect(test.controller.getSnapshot().resolving).toBe(false)
})

it('deduplicates parent/group keys and never labels partial topology, missing values or unsafe sums as a complete total', () => {
  const state = { groups: new Map([[A, { count: 2, sequence: 10, complete: true }], [B, { count: 3, sequence: 11, complete: true }]]), resolving: false }
  expect(navigationActivityForGroups(state, [A, B, A])).toEqual({ count: 5, complete: true })
  expect(navigationActivityForGroups(state, [A], false)).toEqual({ count: null, complete: false })
  expect(navigationActivityForGroups(state, ['missing'])).toEqual({ count: null, complete: false })
  expect(navigationActivityForGroups({ ...state, resolving: true }, [A])).toEqual({ count: 2, complete: false })
  expect(navigationActivityForGroups(state, [])).toEqual({ count: 0, complete: true })
  expect(navigationActivityForGroups({ groups: new Map([[A, { count: Number.MAX_SAFE_INTEGER, sequence: 1, complete: true }], [B, { count: 1, sequence: 1, complete: true }]]), resolving: false }, [A, B])).toEqual({ count: null, complete: false })
  expect(navigationActivityInvalidation({ method: 'canvas.changed', params: {} })).toBeNull()
  expect(navigationActivityInvalidation({ method: 'navigation.invalidated', params: { scope: 'all', threadId: 'ignore' } })).toEqual({ sequence: 0 })
})

it('collapses restored in-flight Thread IDs into a full bounded metadata read when newer events already fill the pending cap', async () => {
  vi.useFakeTimers()
  const waiting = deferred<NavigationActivitySnapshot>(); let first = true
  const test = fixture(async params => {
    if (params.threadIds && first) { first = false; return waiting.promise }
    return snapshot(params.groupKeys, 3, 12)
  })
  await start(test)
  for (let index = 0; index < 200; index++) test.emit({ scope: 'camp', reason: 'agent_run.started', threadId: `first-${index}` })
  await vi.advanceTimersByTimeAsync(80)
  for (let index = 0; index < 200; index++) test.emit({ scope: 'camp', reason: 'agent_run.started', threadId: `next-${index}` })
  waiting.resolve(snapshot([A, B], 99, 12)); await vi.advanceTimersByTimeAsync(160)
  expect(test.calls).toHaveLength(3); expect(test.calls[1].threadIds).toHaveLength(200)
  expect(test.calls[2]).toEqual({ groupKeys: [A, B] })
  expect(navigationActivityForGroups(test.controller.getSnapshot(), [A, B])).toEqual({ count: 6, complete: true })
})
