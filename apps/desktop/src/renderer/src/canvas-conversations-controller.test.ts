import { expect, it, vi } from 'vitest'
import type { CanvasNode, CoreMethod } from '@contracts'
import { CanvasConversationsController } from './canvas-conversations-controller'
import { canvasComposerContextKey, type CanvasComposerContext } from './canvas-composer-drafts'
import type { CanvasConversationTarget } from './canvas-conversation'
import type { ThreadSurfaceSnapshot } from './thread-workspace-data'
import { CanvasConversationRecovery } from './canvas-conversation-recovery'

const context: CanvasComposerContext = { host: 'host', core: '/core', boardId: 'board', nodeId: 'first', threadId: 'thread', conversationId: null }
const target = (changes: Partial<CanvasComposerContext> = {}): CanvasConversationTarget => {
  const draftContext = { ...context, ...changes }
  return { boardId: draftContext.boardId, nodeId: draftContext.nodeId, draftContext,
    reference: { threadId: draftContext.threadId, conversationId: draftContext.conversationId }, presentation: 'inline' }
}
function fixture(handler: (method: CoreMethod, params?: unknown) => Promise<unknown> = async method => method === 'app.info' ? { dataDir: '/core' } : null, afterCommit: () => Promise<void> = async () => undefined, recovery?: CanvasConversationRecovery) {
  const requests: Array<{ method: CoreMethod; params: unknown }> = []
  const client = { presentationScope: context.host, request<T>(method: CoreMethod, params?: unknown): Promise<T> {
    requests.push({ method, params }); return handler(method, params) as Promise<T>
  } }
  const reads = { open: vi.fn(async (threadId: string) => ({ snapshot: { thread: { id: threadId }, throughGlobalSequence: 1 } as ThreadSurfaceSnapshot,
    traceId: 'trace', startedAt: 0, receivedAt: 1 })) }
  const ownedReads = { ...reads, refresh: vi.fn(async (threadId: string) => reads.open(threadId)) }
  return { requests, reads: ownedReads, controller: new CanvasConversationsController(client, ownedReads, afterCommit, recovery) }
}

function storage() { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } } }
const node = (item: CanvasConversationTarget): CanvasNode => ({ id: item.nodeId, boardId: item.boardId, data: { kind: 'conversation', conversation: item.reference } } as CanvasNode)

it('keeps the exact editors mounted while preparing navigation and unlocks them on rollback', async () => {
  const f = fixture(), complete = vi.fn()
  await f.controller.open(target()); const before = f.controller.getSnapshot().instances
  f.controller.register(before[0].key, async () => ({ complete }))
  const prepared = await f.controller.prepareLeave()
  expect(f.controller.getSnapshot().instances).toBe(before)
  expect(f.controller.getSnapshot()).toMatchObject({ opening: true, leaving: true, busyKeys: [before[0].key] })
  expect(await f.controller.open(target({ nodeId: 'other' }))).toBe(false)
  expect(await f.controller.close()).toBe(false)
  expect(complete).not.toHaveBeenCalled()
  await prepared.complete(false); await prepared.complete(true)
  expect(complete).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.controller.getSnapshot().instances).toBe(before)
  expect(f.controller.getSnapshot()).toMatchObject({ opening: false, leaving: false, busyKeys: [] })
})

it('rolls all earlier editors back when a later navigation preparation fails', async () => {
  const f = fixture(), complete = vi.fn()
  await f.controller.open(target()); await f.controller.open(target({ nodeId: 'other' }))
  const before = f.controller.getSnapshot().instances
  f.controller.register(before[0].key, async () => ({ complete }))
  f.controller.register(before[1].key, async () => { throw new Error('cannot save editor') })
  await expect(f.controller.prepareLeave()).rejects.toThrow('cannot save editor')
  expect(complete).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.controller.getSnapshot().instances).toBe(before)
  expect(f.controller.getSnapshot()).toMatchObject({ opening: false, leaving: false })
})

it('waits for a committed transition checkpoint before removing only its selected editors', async () => {
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve }), complete = vi.fn()
  const local = storage(), recovery = new CanvasConversationRecovery(local), f = fixture(undefined, () => waiting, recovery)
  await f.controller.open(target()); await f.controller.open(target({ nodeId: 'other' }))
  const before = f.controller.getSnapshot().instances, remembered = [...local.values]
  f.controller.register(before[0].key, async () => ({ complete }))
  const prepared = await f.controller.prepareLeave([before[0].key]), completing = prepared.complete(true)
  await Promise.resolve()
  expect(f.controller.getSnapshot().instances).toBe(before)
  expect(complete).not.toHaveBeenCalled()
  release(); await completing
  expect(f.controller.getSnapshot().instances).toEqual([before[1]])
  expect(complete).toHaveBeenCalledExactlyOnceWith(true)
  expect([...local.values]).toEqual(remembered)
})

it('shares pending navigation preparation without allowing a superseded attempt to unlock a newer attempt', async () => {
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve }), complete = vi.fn(), guard = vi.fn(async () => { await waiting; return { complete } })
  const f = fixture(); await f.controller.open(target())
  const before = f.controller.getSnapshot().instances
  f.controller.register(before[0].key, guard)
  const first = f.controller.prepareLeave(), second = f.controller.prepareLeave()
  release(); const [a, b] = await Promise.all([first, second])
  expect(guard).toHaveBeenCalledOnce()
  await a.complete(false)
  expect(complete).not.toHaveBeenCalled()
  expect(f.controller.getSnapshot().leaving).toBe(true)
  expect(f.controller.getSnapshot().instances).toBe(before)
  await b.complete(false)
  expect(complete).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.controller.getSnapshot().instances).toBe(before)
})

it('commits a shared leave only after every attempt releases its input lease', async () => {
  const f = fixture(), complete = vi.fn(); await f.controller.open(target())
  f.controller.register(f.controller.getSnapshot().instances[0].key, async () => ({ complete }))
  const first = await f.controller.prepareLeave(), second = await f.controller.prepareLeave()
  await first.complete(true)
  expect(complete).not.toHaveBeenCalled(); expect(f.controller.getSnapshot().instances).toHaveLength(1)
  await second.complete(false)
  expect(complete).toHaveBeenCalledExactlyOnceWith(true)
  expect(f.controller.getSnapshot().instances).toEqual([])
})

it('rejects a different editor set while an original leave is pending', async () => {
  const f = fixture(); await f.controller.open(target()); await f.controller.open(target({ nodeId: 'other' }))
  const prepared = await f.controller.prepareLeave()
  await expect(f.controller.prepareLeave([f.controller.getSnapshot().instances[0].key])).rejects.toThrow()
  await prepared.complete(false)
  expect(f.controller.getSnapshot().instances).toHaveLength(2)
})

it('preserves original editors and unlocks input when the commit checkpoint fails', async () => {
  const f = fixture(undefined, async () => { throw new Error('checkpoint failed') }), complete = vi.fn()
  await f.controller.open(target()); const before = f.controller.getSnapshot().instances
  f.controller.register(before[0].key, async () => ({ complete }))
  const prepared = await f.controller.prepareLeave()
  await expect(prepared.complete(true)).rejects.toThrow('checkpoint failed')
  expect(complete).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.controller.getSnapshot().instances).toBe(before)
  expect(f.controller.getSnapshot().leaving).toBe(false)
})

it('unlocks a prepared editor once on disposal and rejects a late commit', async () => {
  const f = fixture(), complete = vi.fn(); await f.controller.open(target())
  const before = f.controller.getSnapshot().instances
  f.controller.register(before[0].key, async () => ({ complete }))
  const prepared = await f.controller.prepareLeave()
  f.controller.dispose(); await prepared.complete(true)
  expect(complete).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.controller.getSnapshot().instances).toBe(before)
})

it('rolls back a guard that finishes only after its controller was disposed', async () => {
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve }), f = fixture(), complete = vi.fn()
  await f.controller.open(target()); f.controller.register(f.controller.getSnapshot().instances[0].key, async () => { await waiting; return { complete } })
  const pending = f.controller.prepareLeave(), rejected = expect(pending).rejects.toThrow()
  await Promise.resolve(); f.controller.dispose(); release(); await rejected
  expect(complete).toHaveBeenCalledExactlyOnceWith(false)
})

it('suspends a board without collapsing saved expansions and restores each Thread with one fresh read', async () => {
  const local = storage(), recovery = new CanvasConversationRecovery(local), first = fixture(undefined, undefined, recovery)
  await first.controller.open(target()); await first.controller.open(target({ nodeId: 'mirror' })); await first.controller.open(target({ nodeId: 'other', threadId: 'other' }))
  await first.controller.open({ ...target(), presentation: 'drawer' })
  expect(await first.controller.close(undefined, false)).toBe(true)
  const restored = fixture(undefined, undefined, new CanvasConversationRecovery(local)), targets = [target(), target({ nodeId: 'mirror' }), target({ nodeId: 'other', threadId: 'other' })]
  expect(await restored.controller.restore(context, 'board', targets.map(node))).toBe(true)
  expect(restored.controller.getSnapshot().instances).toHaveLength(3)
  expect(restored.controller.getSnapshot().instances.every(item => item.target.presentation === 'inline')).toBe(true)
  expect(restored.reads.refresh.mock.calls.map(call => call[0]).sort()).toEqual(['other', 'thread'])
  expect(restored.requests.every(request => request.method === 'app.info')).toBe(true)
  expect(await restored.controller.close([restored.controller.getSnapshot().instances[0].key])).toBe(true)
  expect(new CanvasConversationRecovery(local).load(context, 'board')).toHaveLength(2)
})
it('retains a rebound or missing context without reading its replacement Thread', async () => {
  const local = storage(), recovery = new CanvasConversationRecovery(local)
  recovery.remember(target(), true); recovery.remember(target({ nodeId: 'missing' }), true)
  const f = fixture(undefined, undefined, recovery)
  expect(await f.controller.restore(context, 'board', [node(target({ threadId: 'replacement' }))])).toBe(false)
  expect(f.reads.open).not.toHaveBeenCalled(); expect(f.reads.refresh).not.toHaveBeenCalled()
  expect(new CanvasConversationRecovery(local).load(context, 'board')).toHaveLength(2)
  expect(f.controller.getSnapshot().issue).toContain('原引用记录仍保留')
})
it('keeps ended private references and failed reads for explicit retry without creating successors', async () => {
  const local = storage(), recovery = new CanvasConversationRecovery(local), privateTarget = target({ conversationId: 'private' })
  recovery.remember(privateTarget, true); recovery.remember(target({ nodeId: 'public' }), true)
  const f = fixture(async method => method === 'app.info' ? { dataDir: '/core' } : { conversation: { id: 'private', threadId: 'thread', status: 'ended' } }, undefined, recovery)
  expect(await f.controller.restore(context, 'board', [node(privateTarget), node(target({ nodeId: 'public' }))])).toBe(false)
  expect(f.controller.getSnapshot().instances.map(item => item.target.nodeId)).toEqual(['public'])
  expect(new CanvasConversationRecovery(local).load(context, 'board')).toHaveLength(2)
  expect(f.requests.every(request => ['app.info', 'singleChat.get'].includes(request.method))).toBe(true)
})
it('cancels restoration and rejects its late results while a new manual opening may proceed', async () => {
  const local = storage(), recovery = new CanvasConversationRecovery(local)
  recovery.remember(target(), true)
  let release!: (value: unknown) => void
  const waiting = new Promise(resolve => { release = resolve })
  const f = fixture(async () => waiting, undefined, recovery)
  const restoring = f.controller.restore(context, 'board', [node(target())])
  await vi.waitFor(() => expect(f.controller.getSnapshot().restoring?.total).toBe(1))
  expect(await f.controller.close()).toBe(false)
  f.controller.cancelRestore(); release({ dataDir: '/core' })
  expect(await restoring).toBe(false); expect(f.controller.getSnapshot().instances).toEqual([])
  expect(f.controller.getSnapshot()).toMatchObject({ opening: false, restoring: null })
  expect(await f.controller.open(target({ nodeId: 'manual' }))).toBe(true)
})
it('does not overwrite the remembered layout when input preparation rejects a suspend', async () => {
  const local = storage(), recovery = new CanvasConversationRecovery(local), f = fixture(undefined, undefined, recovery)
  await f.controller.open(target()); const before = [...local.values]
  f.controller.register(f.controller.getSnapshot().instances[0].key, async () => { throw new Error('input save failed') })
  expect(await f.controller.close(undefined, false)).toBe(false)
  expect(f.controller.getSnapshot().instances).toHaveLength(1); expect([...local.values]).toEqual(before)
})

it('opens multiple real card contexts, including mirrors, without replacing their instances or entering a Thread', async () => {
  const f = fixture()
  expect(await f.controller.open(target())).toBe(true)
  expect(await f.controller.open(target({ nodeId: 'mirror' }))).toBe(true)
  expect(await f.controller.open(target({ nodeId: 'other-thread', threadId: 'other' }))).toBe(true)
  expect(f.controller.getSnapshot().instances.map(item => item.target.nodeId)).toEqual(['first', 'mirror', 'other-thread'])
  expect(new Set(f.controller.getSnapshot().instances.map(item => item.key)).size).toBe(3)
  expect(f.requests.map(item => item.method)).toEqual(['app.info', 'app.info', 'app.info'])
  expect(f.reads.open.mock.calls.map(([id]) => id)).toEqual(['thread', 'thread', 'other'])
})

it('changes presentation of the same context without reading again, re-keying input or closing another card', async () => {
  const f = fixture()
  await f.controller.open(target()); await f.controller.open(target({ nodeId: 'second' }))
  const first = f.controller.getSnapshot().instances[0], guard = vi.fn()
  f.controller.register(first.key, guard)
  expect(await f.controller.open({ ...first.target, presentation: 'drawer' })).toBe(true)
  const changed = f.controller.getSnapshot().instances.find(item => item.key === first.key)!
  expect(changed.key).toBe(first.key)
  expect(changed.target.draftContext).toEqual(first.target.draftContext)
  expect(f.controller.getSnapshot().instances.map(item => item.target.nodeId)).toEqual(['first', 'second'])
  expect(f.controller.getSnapshot().instances).toHaveLength(2)
  expect(f.reads.open).toHaveBeenCalledTimes(2)
  expect(guard).not.toHaveBeenCalled()
  await f.controller.open({ ...target({ nodeId: 'second' }), presentation: 'drawer' })
  expect(f.controller.getSnapshot().instances.filter(item => item.target.presentation === 'drawer')).toHaveLength(1)
  expect(f.controller.getSnapshot().instances.map(item => item.target.nodeId)).toEqual(['first', 'second'])
  expect(f.controller.getSnapshot().instances[0].target.presentation).toBe('inline')
  expect(f.controller.getSnapshot().instances[1].target.presentation).toBe('drawer')
  await f.controller.open({ ...first.target, presentation: 'inline' })
  expect(f.controller.getSnapshot().instances.map(item => item.target.nodeId)).toEqual(['first', 'second'])
  expect(f.requests.map(item => item.method)).toEqual(['app.info', 'app.info'])
})

it('rejects missing, substituted or foreign Host/Core input ownership before loading a Thread', async () => {
  const f = fixture()
  const wrong = [ { ...target(), draftContext: undefined }, target({ host: 'other' }), target({ core: '/other' }),
    { ...target(), nodeId: 'substituted' }, { ...target(), reference: { threadId: 'other', conversationId: null } } ]
  for (const item of wrong) expect(await f.controller.open(item)).toBe(false)
  expect(f.controller.getSnapshot().instances).toEqual([])
  expect(f.reads.open).not.toHaveBeenCalled()
})

it('verifies the exact private conversation before using shared public Thread data and never creates a replacement', async () => {
  const f = fixture(async (method, params) => method === 'app.info' ? { dataDir: '/core' } : {
    conversation: { id: (params as { conversationId: string }).conversationId, threadId: 'thread', agentId: 'member', status: 'active' }
  })
  expect(await f.controller.open(target({ conversationId: 'private' }))).toBe(true)
  expect(f.requests).toEqual([{ method: 'app.info', params: undefined }, { method: 'singleChat.get', params: { conversationId: 'private' } }])
  expect(f.controller.getSnapshot().instances[0].conversation?.id).toBe('private')
  const ended = fixture(async method => method === 'app.info' ? { dataDir: '/core' } : { conversation: { id: 'private', threadId: 'thread', status: 'ended' } })
  expect(await ended.controller.open(target({ conversationId: 'private' }))).toBe(false)
  expect(ended.reads.open).not.toHaveBeenCalled()
})

it('prepares a whole close batch and rolls every prepared editor back if a later editor cannot leave', async () => {
  const f = fixture(), complete = vi.fn()
  await f.controller.open(target()); await f.controller.open(target({ nodeId: 'second' }))
  const before = f.controller.getSnapshot().instances
  f.controller.register(before[0].key, async () => ({ complete }))
  f.controller.register(before[1].key, async () => { throw new Error('unsaved input') })
  expect(await f.controller.close()).toBe(false)
  expect(f.controller.getSnapshot().instances).toBe(before)
  expect(complete).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.controller.getSnapshot()).toMatchObject({ opening: false, busyKeys: [] })
})

it('closes only selected cards and completes leave only after their committed unmount checkpoint', async () => {
  const complete = vi.fn()
  let release!: () => void
  const committed = new Promise<void>(resolve => { release = resolve })
  const f = fixture(undefined, () => committed)
  await f.controller.open(target()); await f.controller.open(target({ nodeId: 'second' }))
  const first = f.controller.getSnapshot().instances[0]
  f.controller.register(first.key, async () => ({ complete }))
  const closing = f.controller.close([first.key])
  await vi.waitFor(() => expect(f.controller.getSnapshot().instances.map(item => item.target.nodeId)).toEqual(['second']))
  expect(complete).not.toHaveBeenCalled()
  expect(await f.controller.open(target({ nodeId: 'third' }))).toBe(false)
  release(); expect(await closing).toBe(true)
  expect(complete).toHaveBeenCalledExactlyOnceWith(true)
})

it('does not publish a delayed open after client disposal and blocks conflicting close during that open', async () => {
  let release!: (value: unknown) => void
  const f = fixture(async () => new Promise(resolve => { release = resolve }))
  const opening = f.controller.open(target())
  expect(await f.controller.close()).toBe(false)
  f.controller.dispose(); release({ dataDir: '/core' })
  expect(await opening).toBe(false)
  expect(f.reads.open).not.toHaveBeenCalled()
  expect(f.controller.getSnapshot().instances).toEqual([])
})

it('uses exact context identities when one pin is rebound and retains the old input as a separate instance', async () => {
  const f = fixture()
  await f.controller.open(target()); await f.controller.open(target({ threadId: 'replacement' }))
  const keys = f.controller.getSnapshot().instances.map(item => item.key)
  expect(keys).toEqual([canvasComposerContextKey(context), canvasComposerContextKey({ ...context, threadId: 'replacement' })])
})

it('flushes cards for a graph mutation but keeps their instances and unlocks them when pins disappear', async () => {
  const f = fixture(), complete = vi.fn()
  await f.controller.open(target())
  const before = f.controller.getSnapshot().instances
  f.controller.register(before[0].key, async () => ({ complete }))
  const preparation = await f.controller.prepare([before[0].key])
  expect(f.controller.getSnapshot().instances).toBe(before)
  expect(f.controller.getSnapshot().busyKeys).toEqual([before[0].key])
  preparation.complete(true); preparation.complete(false)
  expect(complete).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.controller.getSnapshot()).toMatchObject({ instances: before, opening: false, busyKeys: [] })
})

it('rolls back a failed graph preparation without closing any of its cards', async () => {
  const f = fixture(), complete = vi.fn()
  await f.controller.open(target()); await f.controller.open(target({ nodeId: 'second' }))
  const before = f.controller.getSnapshot().instances
  f.controller.register(before[0].key, async () => ({ complete }))
  f.controller.register(before[1].key, async () => { throw new Error('storage quota') })
  await expect(f.controller.prepare(before.map(item => item.key))).rejects.toThrow('storage quota')
  expect(f.controller.getSnapshot().instances).toBe(before)
  expect(complete).toHaveBeenCalledExactlyOnceWith(false)
})
