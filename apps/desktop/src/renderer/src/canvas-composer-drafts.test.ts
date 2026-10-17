import { expect, it, vi } from 'vitest'
import { emptyLocalThreadComposerDraft, loadLocalThreadComposerDraft, saveLocalThreadComposerDraft, THREAD_COMPOSER_STORAGE_PREFIX, threadComposerDraftStorage } from './camp-composer-local-store'
import { canvasComposerContext, canvasComposerContextKey, parseCanvasComposerContext, canvasComposerDraftStorage, canvasComposerDraftCopies, hasCanvasComposerInput, type CanvasComposerContext } from './canvas-composer-drafts'

const context: CanvasComposerContext = { host: 'host:owner', core: '/isolated/core', boardId: 'board', nodeId: 'card', threadId: 'thread', conversationId: null }
const draft = (body: string) => ({ ...emptyLocalThreadComposerDraft('thread'), body, content: { version: 2 as const, segments: [{ kind: 'text' as const, text: body }] } })
function fixture(values = new Map<string, unknown>()) {
  const request = vi.fn(async () => ({ dataDir: context.core }))
  const set = vi.fn((key: string, value: unknown) => { values.set(key, value) })
  return { values, request, set, client: { request: request as never, presentationScope: context.host, editingRecovery: { get: (key: string) => values.get(key), set } } }
}

it('uses canonical exact references and segregates every owner, board, card and private conversation', () => {
  const key = canvasComposerContextKey(context)
  expect(parseCanvasComposerContext(key)).toEqual(context)
  expect(canvasComposerContext({ host: context.host, core: context.core }, 'board', 'card', { threadId: 'thread', conversationId: null })).toEqual(context)
  for (const change of [{ host: 'other' }, { core: 'other' }, { boardId: 'other' }, { nodeId: 'other' }, { threadId: 'other' }, { conversationId: 'private' }]) {
    expect(canvasComposerContextKey({ ...context, ...change })).not.toBe(key)
  }
  expect(parseCanvasComposerContext('canvas: ["host","core","board","card","thread",null]')).toBeNull()
  expect(parseCanvasComposerContext(key.replace('card', 'card\\u0000'))).toBeNull()
  expect(() => canvasComposerContextKey({ ...context, core: '' })).toThrow()
})

it('round-trips the established draft format independently per card and never imports the main draft', () => {
  const f = fixture(), main = threadComposerDraftStorage(f.client.editingRecovery)!
  saveLocalThreadComposerDraft(draft('main'), main)
  const a = canvasComposerDraftStorage(f.client, context), b = canvasComposerDraftStorage(f.client, { ...context, nodeId: 'second' })
  expect(loadLocalThreadComposerDraft('thread', a)).toBeNull()
  saveLocalThreadComposerDraft(draft('first'), a)
  saveLocalThreadComposerDraft(draft('second'), b)
  expect(loadLocalThreadComposerDraft('thread', a)).toEqual(draft('first'))
  expect(loadLocalThreadComposerDraft('thread', b)).toEqual(draft('second'))
  expect(loadLocalThreadComposerDraft('thread', main)).toEqual(draft('main'))
  saveLocalThreadComposerDraft(emptyLocalThreadComposerDraft('thread'), a)
  expect(loadLocalThreadComposerDraft('thread', a)).toBeNull()
  expect(loadLocalThreadComposerDraft('thread', b)).toEqual(draft('second'))
  saveLocalThreadComposerDraft(emptyLocalThreadComposerDraft('thread'), b)
  expect([...f.values.values()].filter(value => typeof value === 'string' && value.includes('"drafts"'))).toEqual([])
  expect(loadLocalThreadComposerDraft('thread', main)).toEqual(draft('main'))
})

it('writes index and content in one value, rejects wrong Thread keys and does not destroy corrupt or future bundles', () => {
  const f = fixture(), store = canvasComposerDraftStorage(f.client, context)
  saveLocalThreadComposerDraft(draft('kept'), store)
  expect(f.set).toHaveBeenCalledTimes(1)
  const [key, encoded] = f.set.mock.calls[0]
  expect(JSON.parse(encoded as string).drafts[canvasComposerContextKey(context)]).toBe(store.getItem(`${THREAD_COMPOSER_STORAGE_PREFIX}thread`))
  expect(() => store.setItem(`${THREAD_COMPOSER_STORAGE_PREFIX}wrong`, '{}')).toThrow()
  expect(() => store.setItem(`${THREAD_COMPOSER_STORAGE_PREFIX}thread`, '{}')).toThrow()
  for (const corrupt of ['not json', '{"version":2,"drafts":{}}', '{"version":1,"drafts":{"unknown":"input"}}']) {
    f.values.set(key, corrupt)
    expect(() => loadLocalThreadComposerDraft('thread', store)).toThrow()
    expect(() => saveLocalThreadComposerDraft(draft('overwrite'), store)).toThrow()
    expect(f.values.get(key)).toBe(corrupt)
  }
  expect(f.set).toHaveBeenCalledTimes(1)
  f.values.set(key, { version: 2, drafts: { important: 'retained' } })
  expect(() => saveLocalThreadComposerDraft(draft('overwrite'), store)).toThrow()
  expect(f.values.get(key)).toEqual({ version: 2, drafts: { important: 'retained' } })
})

it('keeps saved input when storage rejects a write', () => {
  const f = fixture(), store = canvasComposerDraftStorage(f.client, context)
  saveLocalThreadComposerDraft(draft('kept'), store)
  f.set.mockImplementationOnce(() => { throw new Error('quota') })
  expect(() => saveLocalThreadComposerDraft(draft('new'), store)).toThrow('quota')
  expect(loadLocalThreadComposerDraft('thread', store)).toEqual(draft('kept'))
})

it('finds persisted closed-card input after client reconstruction without adopting another Host/Core', async () => {
  const f = fixture()
  saveLocalThreadComposerDraft(draft('closed card'), canvasComposerDraftStorage(f.client, context))
  const restored = fixture(f.values)
  expect(await hasCanvasComposerInput(restored.client, 'thread')).toBe(true)
  expect(restored.request).toHaveBeenCalledExactlyOnceWith('app.info')
  const otherHost = { ...fixture(f.values).client, presentationScope: 'other-owner' }
  expect(await hasCanvasComposerInput(otherHost, 'thread')).toBe(false)
  const otherCore = fixture(f.values)
  otherCore.request.mockResolvedValue({ dataDir: '/different/core' })
  expect(await hasCanvasComposerInput(otherCore.client, 'thread')).toBe(false)
  const noSavedDrafts = fixture()
  expect(await hasCanvasComposerInput(noSavedDrafts.client, 'thread', new Map([[canvasComposerContextKey({ ...context, threadId: 'other' }), true]]))).toBe(false)
})

it('skips metadata requests without input and retries failed identity lookup without discarding drafts', async () => {
  const f = fixture()
  expect(await hasCanvasComposerInput(f.client, 'thread')).toBe(false)
  expect(f.request).not.toHaveBeenCalled()
  saveLocalThreadComposerDraft(draft('keep'), canvasComposerDraftStorage(f.client, context))
  f.request.mockRejectedValueOnce(new Error('offline'))
  await expect(hasCanvasComposerInput(f.client, 'thread')).rejects.toThrow('offline')
  expect(await hasCanvasComposerInput(f.client, 'thread')).toBe(true)
  expect(f.request).toHaveBeenCalledTimes(2)
})

it('extracts recovery copies only for this exact card and ignores invalid historical copies', () => {
  const f = fixture(), a = canvasComposerDraftStorage(f.client, context)
  saveLocalThreadComposerDraft(draft('a'), a)
  const first = [...f.values.values()][0] as string
  saveLocalThreadComposerDraft(draft('b'), canvasComposerDraftStorage(f.client, { ...context, nodeId: 'other' }))
  const second = [...f.values.values()][0] as string
  const draftCopies = vi.fn(() => [{ id: 'one', value: first, savedAt: 1 }, { id: 'two', value: second, savedAt: 2 }, { id: 'corrupt', value: '?', savedAt: 3 }])
  const client = { ...f.client, editingRecovery: { ...f.client.editingRecovery, draftCopies } }
  expect(canvasComposerDraftCopies(client, context).map(copy => copy.id)).toEqual(['one', 'two'])
  expect(canvasComposerDraftCopies(client, { ...context, nodeId: 'other' }).map(copy => copy.id)).toEqual(['two'])
  expect(canvasComposerDraftCopies(client, { ...context, conversationId: 'private' })).toEqual([])
})
