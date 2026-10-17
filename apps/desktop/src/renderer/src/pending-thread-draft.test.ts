import { describe, expect, it, vi } from 'vitest'
import { emptyLocalThreadComposerDraft, loadLocalThreadComposerDraft, saveLocalThreadComposerDraft, threadComposerDraftStorage } from './camp-composer-local-store'
import { PendingThreadDraftPersistence, hasAnyPendingThreadDraftInput, retainPendingThreadDraftSurface, hasPendingThreadDraftSurfaces } from './pending-thread-draft'
import { canvasComposerDraftStorage, type CanvasComposerContext } from './canvas-composer-drafts'

describe('Pending Thread draft recovery', () => {
  it('uses the verified editor store before presence and blocks acknowledgement if that store fails', async () => {
    const values = new Map<string, unknown>()
    const request = vi.fn(async () => ({ changed: true }))
    const editingRecovery = { get: (key: string) => values.get(key), set: vi.fn((key: string, value: unknown) => { values.set(key, value) }) }
    const persistence = new PendingThreadDraftPersistence({ request: request as never, editingRecovery })
    const draft = { ...emptyLocalThreadComposerDraft('pending'), body: 'private', content: { version: 2 as const, segments: [{ kind: 'text' as const, text: 'private' }] } }
    await persistence.persist(draft)
    expect(loadLocalThreadComposerDraft('pending', threadComposerDraftStorage(editingRecovery))).toEqual(draft)
    expect(request).toHaveBeenCalledWith('threads.pendingDraft.setPresence', { threadId: 'pending', present: true })
    editingRecovery.set.mockImplementationOnce(() => { throw new Error('editor quota') })
    await expect(persistence.persist(emptyLocalThreadComposerDraft('pending'))).rejects.toThrow('editor quota')
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('restores independent drafts, including attachment-only input, and releases visibility when cleared', async () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
    const request = vi.fn(async () => ({ changed: true }))
    const persistence = new PendingThreadDraftPersistence({ request: request as never }, draft => saveLocalThreadComposerDraft(draft, storage))
    const first = { ...emptyLocalThreadComposerDraft('first'), body: 'keep my draft', content: { version: 2 as const, segments: [{ kind: 'text' as const, text: 'keep my draft' }] } }
    const second = { ...emptyLocalThreadComposerDraft('second'), attachments: [{ id: '11111111-1111-4111-8111-111111111111', displayName: 'image.png', kind: 'file' as const, fileCount: 1, mediaType: 'image/png', byteSize: 12, previewKind: 'image' as const, availability: 'available' as const, sourcePath: '/tmp/image.png' }] }
    await persistence.persist(first)
    await persistence.persist(second)
    expect(loadLocalThreadComposerDraft('first', storage)).toEqual(first)
    expect(loadLocalThreadComposerDraft('second', storage)).toEqual(second)
    await persistence.persist(first)
    expect(request).toHaveBeenCalledTimes(2)
    await persistence.persist(emptyLocalThreadComposerDraft('first'))
    expect(request).toHaveBeenLastCalledWith('threads.pendingDraft.setPresence', { threadId: 'first', present: false })
    expect(loadLocalThreadComposerDraft('first', storage)).toBeNull()
    expect(loadLocalThreadComposerDraft('second', storage)).toEqual(second)
  })

  it('keeps local input after a retention failure and retries before acknowledging the save', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ changed: true })
    const save = vi.fn()
    const persistence = new PendingThreadDraftPersistence({ request: request as never }, save)
    const draft = { ...emptyLocalThreadComposerDraft('first'), body: 'unsent work' }
    await expect(persistence.persist(draft)).rejects.toThrow('offline')
    expect(save).toHaveBeenCalledWith(draft)
    await persistence.persist(draft)
    expect(request).toHaveBeenCalledTimes(2)
    save.mockImplementationOnce(() => { throw new Error('quota') })
    await expect(persistence.persist(draft)).rejects.toThrow('quota')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('keeps accepted activation across mounts without writing stale Pending presence', async () => {
    const request = vi.fn().mockRejectedValue(new Error('camp.pending_draft_unavailable'))
    const client = { request: request as never }
    const save = vi.fn()
    const persistence = new PendingThreadDraftPersistence(client, save)
    persistence.acknowledgeActivation('first')
    const remounted = new PendingThreadDraftPersistence(client, save)
    expect(remounted.isActivated('first')).toBe(true)
    const draft = { ...emptyLocalThreadComposerDraft('first'), body: 'follow-up' }
    await remounted.persist(draft)
    await remounted.persist(emptyLocalThreadComposerDraft('first'))
    expect(save).toHaveBeenCalledTimes(2)
    expect(request).not.toHaveBeenCalled()
    await expect(remounted.persist(emptyLocalThreadComposerDraft('second'))).rejects.toThrow('camp.pending_draft_unavailable')
    expect(new PendingThreadDraftPersistence({ request: request as never }, save).isActivated('first')).toBe(false)
  })
})

describe('Pending presence across independent canvas inputs', () => {
  const context: CanvasComposerContext = { host: 'host', core: '/test/core', boardId: 'board', nodeId: 'first', threadId: 'pending', conversationId: null }
  const draft = (body: string) => ({ ...emptyLocalThreadComposerDraft('pending'), body, content: { version: 2 as const, segments: [{ kind: 'text' as const, text: body }] } })
  function fixture(values = new Map<string, unknown>()) {
    const request = vi.fn(async (method: string, _params?: unknown) => method === 'app.info' ? { dataDir: context.core } : { changed: true })
    const set = vi.fn((key: string, value: unknown) => { values.set(key, value) })
    const client = { request: request as never, presentationScope: context.host, editingRecovery: { get: (key: string) => values.get(key), set } }
    const owner = (scope: CanvasComposerContext) => new PendingThreadDraftPersistence(client, input => saveLocalThreadComposerDraft(input, canvasComposerDraftStorage(client, scope)), scope)
    return { client, owner, values, request, set, presence: () => request.mock.calls.filter(([method]) => method === 'threads.pendingDraft.setPresence').map(([, params]) => params) }
  }
  it('aggregates independently saved cards and clears Core presence only when the last input clears', async () => {
    const f = fixture(), a = f.owner(context), b = f.owner({ ...context, nodeId: 'second' })
    await a.persist(draft('first'))
    await b.persist(draft('second'))
    await a.persist(draft(''))
    expect(f.presence()).toEqual([{ threadId: 'pending', present: true }])
    await b.persist(draft(''))
    expect(f.presence()).toEqual([{ threadId: 'pending', present: true }, { threadId: 'pending', present: false }])
  })
  it('serializes the shared presence receipt while another card saves or clears', async () => {
    const f = fixture(), a = f.owner(context), b = f.owner({ ...context, nodeId: 'second' })
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    f.request.mockImplementation(async method => {
      if (method === 'app.info') return { dataDir: context.core }
      await waiting
      return { changed: true }
    })
    const first = a.persist(draft('first'))
    await vi.waitFor(() => expect(f.presence()).toHaveLength(1))
    const second = b.persist(draft('second')), cleared = a.persist(draft(''))
    expect(f.presence()).toHaveLength(1)
    release()
    await Promise.all([first, second, cleared])
    expect(f.presence()).toEqual([{ threadId: 'pending', present: true }])
    expect(await hasAnyPendingThreadDraftInput(f.client, 'pending')).toBe(true)
  })
  it('does not discard a saved closed card when the main editor is empty after client reconstruction', async () => {
    const f = fixture()
    await f.owner(context).persist(draft('saved closed card'))
    const restored = fixture(f.values), main = new PendingThreadDraftPersistence(restored.client)
    await main.persist(draft(''))
    expect(restored.presence()).toEqual([{ threadId: 'pending', present: true }])
    expect(await hasAnyPendingThreadDraftInput(restored.client, 'pending')).toBe(true)
  })
  it('retains unsaved input hints after a storage failure without acknowledging a successful save', async () => {
    const f = fixture(), a = f.owner(context), b = f.owner({ ...context, nodeId: 'second' })
    f.set.mockImplementationOnce(() => { throw new Error('quota') })
    await expect(a.persist(draft('not yet stored'))).rejects.toThrow('quota')
    expect(f.presence()).toEqual([])
    await b.persist(draft(''))
    expect(f.presence()).toEqual([{ threadId: 'pending', present: true }])
    expect(await hasAnyPendingThreadDraftInput(f.client, 'pending')).toBe(true)
  })
  it('counts only remaining mounted surfaces after leave and releases each lease once', () => {
    const f = fixture(), first = retainPendingThreadDraftSurface(f.client, 'pending'), second = retainPendingThreadDraftSurface(f.client, 'pending')
    expect(hasPendingThreadDraftSurfaces(f.client, 'pending')).toBe(true)
    first(); first()
    expect(hasPendingThreadDraftSurfaces(f.client, 'pending')).toBe(true)
    second()
    expect(hasPendingThreadDraftSurfaces(f.client, 'pending')).toBe(false)
    expect(hasPendingThreadDraftSurfaces(f.client, 'other')).toBe(false)
    expect(f.request).not.toHaveBeenCalled()
  })
  it('ignores stale pending-presence failure only after an accepted activation receipt', async () => {
    const f = fixture(), a = f.owner(context)
    let reject!: (error: Error) => void
    f.request.mockImplementation(async method => {
      if (method === 'app.info') return { dataDir: context.core }
      return new Promise((_resolve, fail) => { reject = fail })
    })
    const saving = a.persist(draft('first send'))
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'))
    a.acknowledgeActivation('pending')
    reject(new Error('pending unavailable'))
    await expect(saving).resolves.toBeUndefined()
    await f.owner({ ...context, nodeId: 'second' }).persist(draft('follow-up'))
    expect(f.presence()).toHaveLength(1)
  })
})
