import { expect, it, vi } from 'vitest'
import type { CoreMethod, ThreadMessagePage, ThreadMessageView, ThreadOpenProjection } from '@contracts'
import { ThreadProjectionStore, ThreadProjectionSupersededError } from './thread-projection-store'

const message = (sequence: number, body = `message-${sequence}`): ThreadMessageView => ({
  id: `message-${sequence}`, sequence, timelineGlobalSequence: null, authorType: 'user', authorId: 'local_user', sourceAgentRunId: null,
  body, content: [{ kind: 'text', text: body }], attachments: [], quotes: [], withdrawn: false, canWithdraw: false, version: 1,
  addressMode: 'default', addressedAgentIds: [], replyToThreadMessageId: null, threadTurnId: null, presentation: null, createdAt: '2026-10-15T00:00:00Z'
})
function projection(threadId: string, watermark = 10, messages = [message(10)], total = messages.length): ThreadOpenProjection {
  const empty = { loadedCount: 0, totalCount: 0, omittedCount: 0, complete: true }
  return { schemaVersion: 8, throughGlobalSequence: watermark,
    thread: { id: threadId, title: threadId, activationState: 'active', projectBindingKind: 'quick_chat', projectPath: '/quick-chat',
      defaultLeadAgentId: 'member', membershipGeneration: 1, version: 1, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z' },
    members: [], membershipReconciliations: [], tasks: [], messages, messageDeliveries: [], turns: [], agentRuns: [],
    executionEvidence: [], agentRunFileChanges: [], approvals: [], coverage: { tasks: empty, messageDeliveries: empty, turns: empty,
      agentRuns: empty, approvals: empty, messages: { loadedCount: messages.length, totalCount: total, omittedCount: total - messages.length,
        complete: total === messages.length, hasEarlier: total > messages.length, oldestLoadedSequence: messages[0]?.sequence ?? null,
        newestLoadedSequence: messages.at(-1)?.sequence ?? null } } }
}
function page(threadId = 'a', watermark = 10, messages = [message(1)]): ThreadMessagePage {
  return { schemaVersion: 1, threadId, throughGlobalSequence: watermark, requestedBeforeSequence: 10, nextBeforeSequence: null, hasMore: false, messages }
}
function fixture() {
  const pending: Array<{ method: CoreMethod; params: Record<string, unknown>; resolve(value: unknown): void; reject(value: unknown): void }> = []
  const request = <T,>(method: CoreMethod, params?: unknown): Promise<T> => new Promise((resolve, reject) => {
    pending.push({ method, params: params as Record<string, unknown>, resolve: value => resolve(value as T), reject })
  })
  return { pending, request, store: new ThreadProjectionStore({ request }) }
}

it('shares an in-flight readonly open per Thread while clients and other Threads remain independent', async () => {
  const f = fixture(), other = fixture(), a = f.store.open('a'), mirror = f.store.open('a'), b = f.store.open('b'), foreign = other.store.open('a')
  expect(mirror).toBe(a)
  await vi.waitFor(() => expect(f.pending).toHaveLength(2))
  await vi.waitFor(() => expect(other.pending).toHaveLength(1))
  f.pending[1].resolve(projection('b', 20)); f.pending[0].resolve(projection('a', 10)); other.pending[0].resolve(projection('a', 30))
  expect((await b).snapshot.thread.id).toBe('b')
  expect((await a).snapshot.throughGlobalSequence).toBe(10)
  expect((await foreign).snapshot.throughGlobalSequence).toBe(30)
  expect(f.pending.map(item => item.method)).toEqual(['threads.open', 'threads.open'])
  expect(f.pending[0].params).toEqual({ threadId: 'a', traceId: expect.any(String) })
  expect(f.store.peek('a')?.throughGlobalSequence).toBe(10)
})

it('coalesces refresh signals during a read into a fresh follow-up instead of missing the invalidation', async () => {
  const f = fixture(), first = f.store.open('a')
  await vi.waitFor(() => expect(f.pending).toHaveLength(1))
  const refresh = f.store.refresh('a'), again = f.store.refresh('a')
  expect(refresh).toBe(first); expect(again).toBe(first)
  f.pending[0].resolve(projection('a', 10))
  await vi.waitFor(() => expect(f.pending).toHaveLength(2))
  f.pending[1].resolve(projection('a', 11))
  expect((await first).snapshot.throughGlobalSequence).toBe(11)
  expect(f.pending).toHaveLength(2)
  expect(f.store.getSnapshot('a').loading).toBe(false)
})

it('retains the last valid snapshot on failure, exposes the error and retries only on a new request', async () => {
  const f = fixture(), saved = f.store.accept('a', projection('a'))
  const reading = f.store.refresh('a'), failed = expect(reading).rejects.toThrow('offline')
  await vi.waitFor(() => expect(f.pending).toHaveLength(1))
  f.pending[0].reject(new Error('offline')); await failed
  expect(f.store.getSnapshot('a')).toMatchObject({ snapshot: saved, loading: false, error: expect.any(Error) })
  expect(f.pending).toHaveLength(1)
  const retry = f.store.open('a')
  await vi.waitFor(() => expect(f.pending).toHaveLength(2))
  f.pending[1].resolve(projection('a', 11)); await retry
  expect(f.store.getSnapshot('a').error).toBeNull()
})

it('allows a signaled follow-up to recover an earlier failed read without reporting the stale failure', async () => {
  const f = fixture(), reading = f.store.open('a')
  await vi.waitFor(() => expect(f.pending).toHaveLength(1))
  f.store.refresh('a'); f.pending[0].reject(new Error('old failure'))
  await vi.waitFor(() => expect(f.pending).toHaveLength(2))
  f.pending[1].resolve(projection('a', 12))
  expect((await reading).snapshot.throughGlobalSequence).toBe(12)
  expect(f.store.getSnapshot('a').error).toBeNull()
})

it('rejects incompatible or foreign projections and never rolls a Thread back below its accepted watermark', () => {
  const f = fixture(), current = f.store.accept('a', projection('a', 20))
  expect(f.store.accept('a', projection('a', 10))).toBe(current)
  expect(() => f.store.accept('a', projection('foreign', 30))).toThrow()
  expect(() => f.store.accept('a', { ...projection('a'), schemaVersion: 7 } as unknown as ThreadOpenProjection)).toThrow()
  expect(f.store.peek('a')).toBe(current)
  expect(f.store.peek('foreign')).toBeNull()
})

it('deduplicates history loads and preserves the exact page watermark, ordering and coverage', async () => {
  const f = fixture()
  f.store.accept('a', projection('a', 10, [message(10)], 2))
  const first = f.store.loadEarlier('a'), second = f.store.loadEarlier('a')
  expect(second).toBe(first)
  await vi.waitFor(() => expect(f.pending).toHaveLength(1))
  expect(f.pending[0]).toMatchObject({ method: 'thread.messages.page', params: { threadId: 'a', beforeSequence: 10, throughGlobalSequence: 10, limit: 50 } })
  f.pending[0].resolve(page())
  const result = await first
  expect(result?.messages.map(item => item.sequence)).toEqual([1, 10])
  expect(result?.openCoverage?.messages).toMatchObject({ loadedCount: 2, totalCount: 2, omittedCount: 0, hasEarlier: false, complete: true })
  expect(await f.store.loadEarlier('a')).toBeNull()
  expect(f.pending).toHaveLength(1)
})

it('drops a history page overtaken by a newer projection so old text cannot be resurrected', async () => {
  const f = fixture()
  f.store.accept('a', projection('a', 10, [message(10)], 2))
  const oldPage = f.store.loadEarlier('a')
  await vi.waitFor(() => expect(f.pending).toHaveLength(1))
  const newer = f.store.accept('a', projection('a', 11, [message(10, 'updated')], 1))
  f.pending[0].resolve(page('a', 10, [message(1, 'stale withdrawn body')]))
  expect(await oldPage).toBeNull()
  expect(f.store.peek('a')).toBe(newer)
  expect(f.store.peek('a')?.messages.map(item => item.body)).toEqual(['updated'])
})

it('rejects malformed or foreign pages without changing the accepted snapshot', async () => {
  const f = fixture(), saved = f.store.accept('a', projection('a', 10, [message(10)], 2))
  const invalid = [page('other'), page('a', 11), { ...page(), requestedBeforeSequence: 9 },
    { ...page(), nextBeforeSequence: 1 }, page('a', 10, [message(10)]), { ...page(), schemaVersion: 2 }]
  for (const bad of invalid) {
    const expectedCount = f.pending.length + 1
    const reading = f.store.loadEarlier('a'), fail = expect(reading).rejects.toThrow()
    await vi.waitFor(() => expect(f.pending).toHaveLength(expectedCount))
    f.pending.at(-1)!.resolve(bad); await fail
    expect(f.store.peek('a')).toBe(saved)
  }
})

it('fences forgotten or reset reads and pages, then permits an independent explicit reopen', async () => {
  const f = fixture(), open = f.store.open('a'), oldFailure = expect(open).rejects.toThrow()
  await vi.waitFor(() => expect(f.pending).toHaveLength(1))
  f.store.forget('a')
  const next = f.store.open('a')
  await vi.waitFor(() => expect(f.pending).toHaveLength(2))
  f.pending[0].resolve(projection('a', 99)); await oldFailure
  expect(f.store.peek('a')).toBeNull()
  f.pending[1].resolve(projection('a', 10, [message(10)], 2)); await next
  const history = f.store.loadEarlier('a'), historyFailure = expect(history).rejects.toThrow()
  await vi.waitFor(() => expect(f.pending).toHaveLength(3))
  f.store.reset(); f.pending[2].resolve(page()); await historyFailure
  expect(f.store.peek('a')).toBeNull()
})

it('keeps all mounted or observed Threads while bounding only idle cache entries and releasing leases once', () => {
  const f = fixture(), release: Array<() => void> = []
  for (let index = 0; index < 8; index += 1) {
    const id = `thread-${index}`
    release.push(f.store.retain(id)); f.store.accept(id, projection(id))
  }
  expect(Array.from({ length: 8 }, (_, index) => f.store.peek(`thread-${index}`))).not.toContain(null)
  release.forEach(stop => { stop(); stop() })
  expect(Array.from({ length: 8 }, (_, index) => Boolean(f.store.peek(`thread-${index}`))).filter(Boolean)).toHaveLength(5)
  const notify = vi.fn(), stop = f.store.subscribe('observed', notify)
  f.store.accept('observed', projection('observed'))
  for (let index = 0; index < 8; index += 1) f.store.accept(`idle-${index}`, projection(`idle-${index}`))
  expect(f.store.peek('observed')).not.toBeNull()
  expect(notify).toHaveBeenCalledTimes(1)
  stop()
})

it('keeps a loaded history page when a later bounded open returns the same Thread window', async () => {
  const f = fixture()
  f.store.accept('a', projection('a', 10, [message(10)], 2))
  const history = f.store.loadEarlier('a')
  await vi.waitFor(() => expect(f.pending).toHaveLength(1))
  f.pending[0].resolve(page()); await history
  const fresh = f.store.refresh('a')
  await vi.waitFor(() => expect(f.pending).toHaveLength(2))
  f.pending[1].resolve(projection('a', 11, [message(10, 'newest')], 2))
  expect((await fresh).snapshot.messages.map(item => item.body)).toEqual(['message-1', 'newest'])
})

it('normalizes non-Error transport failures without reporting a successful undefined read', async () => {
  const f = fixture(), reading = f.store.open('a'), failed = expect(reading).rejects.toThrow('undefined')
  await vi.waitFor(() => expect(f.pending).toHaveLength(1))
  f.pending[0].reject(undefined); await failed
  expect(f.store.getSnapshot('a').snapshot).toBeNull()
  expect(f.store.getSnapshot('a').loading).toBe(false)
})

it('preserves mounted leases across reset and prevents an old request from clearing the new read state', async () => {
  const f = fixture(), release = f.store.retain('a'), old = f.store.open('a'), oldFailure = expect(old).rejects.toThrow()
  await vi.waitFor(() => expect(f.pending).toHaveLength(1))
  const epoch = f.store.epoch
  f.store.reset()
  expect(f.store.epoch).not.toBe(epoch)
  const fresh = f.store.open('a')
  await vi.waitFor(() => expect(f.pending).toHaveLength(2))
  f.pending[0].resolve(projection('a', 99)); await oldFailure
  expect(f.store.getSnapshot('a')).toMatchObject({ snapshot: null, loading: true, error: null })
  f.pending[1].resolve(projection('a', 10)); await fresh
  for (let index = 0; index < 8; index += 1) f.store.accept(`idle-${index}`, projection(`idle-${index}`))
  expect(f.store.peek('a')?.throughGlobalSequence).toBe(10)
  release(); release()
})

it('keeps current subscribers attached across reset and stops notifying after their cleanup', () => {
  const f = fixture(), observed: Array<number | null> = [], stop = f.store.subscribe('a', () => { observed.push(f.store.getSnapshot('a').snapshot?.throughGlobalSequence ?? null) })
  f.store.accept('a', projection('a', 10)); f.store.reset(); f.store.accept('a', projection('a', 11))
  expect(observed).toEqual([10, null, 11])
  stop(); f.store.accept('a', projection('a', 12))
  expect(observed).toEqual([10, null, 11])
})

it('classifies a late transport rejection from an invalidated owner as superseded without polluting the current error state', async () => {
  const f = fixture(), release = f.store.retain('a'), old = f.store.open('a')
  const failed = expect(old).rejects.toBeInstanceOf(ThreadProjectionSupersededError)
  await vi.waitFor(() => expect(f.pending).toHaveLength(1))
  f.store.reset()
  const fresh = f.store.open('a')
  await vi.waitFor(() => expect(f.pending).toHaveLength(2))
  f.pending[0].reject(new Error('failure from retired service')); await failed
  expect(f.store.getSnapshot('a')).toMatchObject({ loading: true, error: null })
  f.pending[1].resolve(projection('a')); await fresh
  release()
})
