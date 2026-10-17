import { describe, expect, it } from 'vitest'
import { browserEditingRecovery } from './editing-recovery'
import { emptyLocalThreadComposerDraft, saveLocalThreadComposerDraft, threadComposerDraftStorage, loadLocalThreadComposerDraft } from '../../desktop/src/renderer/src/camp-composer-local-store'
import { canvasComposerDraftStorage, canvasComposerDraftCopies, CANVAS_COMPOSER_STORAGE_PREFIX, type CanvasComposerContext } from '../../desktop/src/renderer/src/canvas-composer-drafts'
import { singleChatComposerStore } from '../../desktop/src/renderer/src/single-chat-composer-store'

class Store {
  values = new Map<string, string>()
  get length() { return this.values.size }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}
const identity = 'rovai.camp-composer-draft.v1:thread'
const draft = (body: string) => ({ ...emptyLocalThreadComposerDraft('thread'), body, content: { version: 2 as const, segments: [{ kind: 'text' as const, text: body }] } })

describe('Web body snapshots', () => {
  it('keeps same-pin private bodies and saved input positions local to each verified editor', () => {
    const archive = new Store(), tabA = new Store(), tabB = new Store()
    const context: CanvasComposerContext = { host: 'host/owner', core: '/core', boardId: 'board', nodeId: 'same-pin', threadId: 'thread', conversationId: 'private' }
    const owner = (editor: string, tab: Store) => ({ editingRecovery: browserEditingRecovery(`host/owner/${editor}`, tab, { ownerScope: 'host/owner', storage: archive }) })
    const a = owner('a', tabA), b = owner('b', tabB)
    const first = singleChatComposerStore(a, 'thread', context), second = singleChatComposerStore(b, 'thread', context)
    expect(first.update(() => ({ private: '甲未发送正文', 'private:returned:request-a': '甲保留副本' }))).toBe(true)
    a.editingRecovery.set('single-chat-input-body-index:v1', { version: 1, entries: { own: { bodyKey: 'private' } } })
    expect(second.getSnapshot().drafts).toEqual({})
    expect(b.editingRecovery.get('single-chat-input-body-index:v1')).toBeNull()
    expect(second.update(() => ({ private: '乙未发送正文' }))).toBe(true)
    expect(first.getSnapshot().drafts.private).toBe('甲未发送正文')
    expect(singleChatComposerStore(owner('a', tabA), 'thread', context).getSnapshot().drafts).toEqual(first.getSnapshot().drafts)
    expect(singleChatComposerStore(owner('b', tabB), 'thread', context).getSnapshot().drafts).toEqual({ private: '乙未发送正文' })
    const copiedTab = new Store(); copiedTab.values = new Map(tabA.values)
    expect(singleChatComposerStore(owner('new-editor', copiedTab), 'thread', context).getSnapshot().drafts).toEqual({})
    expect(archive.length).toBe(0)
  })

  it('archives per-card public snapshots after tab loss, offers exact-context copies, and excludes private edits and proofs', () => {
    const archive = new Store(), tab = new Store(), scope = 'host/owner/editor'
    const context: CanvasComposerContext = { host: 'host/owner', core: '/core', boardId: 'board', nodeId: 'first', threadId: 'thread', conversationId: null }
    const client = (editingRecovery: ReturnType<typeof browserEditingRecovery>) => ({ editingRecovery, request: (async () => ({ dataDir: '/core' })) as never, presentationScope: context.host })
    // An older tab-only record is migrated only after the durable archive write succeeds.
    const legacy = client(browserEditingRecovery(scope, tab))
    saveLocalThreadComposerDraft(draft('first'), canvasComposerDraftStorage(legacy, context))
    legacy.editingRecovery.set('single-chat:thread:canvas:private', { body: 'private-only', proof: 'proof-secret' })
    const current = client(browserEditingRecovery(scope, tab, { ownerScope: context.host, storage: archive }))
    saveLocalThreadComposerDraft(draft('second'), canvasComposerDraftStorage(current, { ...context, nodeId: 'second' }))
    expect(loadLocalThreadComposerDraft('thread', canvasComposerDraftStorage(current, context))?.body).toBe('first')
    const sameEditor = client(browserEditingRecovery(scope, new Store(), { ownerScope: context.host, storage: archive }))
    expect(loadLocalThreadComposerDraft('thread', canvasComposerDraftStorage(sameEditor, context))?.body).toBe('first')
    const reopened = client(browserEditingRecovery('host/owner/new', new Store(), { ownerScope: context.host, storage: archive }))
    expect(loadLocalThreadComposerDraft('thread', canvasComposerDraftStorage(reopened, context))).toBeNull()
    const copies = canvasComposerDraftCopies(reopened, context)
    expect(copies).toHaveLength(1)
    expect(JSON.parse(copies[0].value).body).toBe('first')
    expect(canvasComposerDraftCopies(reopened, { ...context, nodeId: 'second' }).map(copy => JSON.parse(copy.value).body)).toEqual(['second'])
    expect(canvasComposerDraftCopies(reopened, { ...context, core: '/different' })).toEqual([])
    const otherOwner = client(browserEditingRecovery('host/other/new', new Store(), { ownerScope: 'host/other', storage: archive }))
    expect(canvasComposerDraftCopies(otherOwner, context)).toEqual([])
    const stored = [...archive.values.values()].join('')
    expect(stored).not.toContain('private-only')
    expect(stored).not.toContain('proof-secret')
    saveLocalThreadComposerDraft(emptyLocalThreadComposerDraft('thread'), canvasComposerDraftStorage(sameEditor, context))
    expect(loadLocalThreadComposerDraft('thread', canvasComposerDraftStorage(sameEditor, { ...context, nodeId: 'second' }))?.body).toBe('second')
  })

  it('keeps archived canvas input on quota failure and rejects future bundles before modifying either store', () => {
    const archive = new Store(), tab = new Store(), scope = 'host/owner/editor', bundleKey = `${CANVAS_COMPOSER_STORAGE_PREFIX}thread`
    const recovery = browserEditingRecovery(scope, tab, { ownerScope: 'host/owner', storage: archive })
    const context: CanvasComposerContext = { host: 'host/owner', core: '/core', boardId: 'board', nodeId: 'first', threadId: 'thread', conversationId: null }
    const client = { editingRecovery: recovery, request: (async () => ({})) as never }
    const store = canvasComposerDraftStorage(client, context)
    saveLocalThreadComposerDraft(draft('saved'), store)
    const before = archive.getItem(`rovai.web.thread-drafts.v1:${scope}`), write = archive.setItem.bind(archive)
    archive.setItem = () => { throw new Error('quota') }
    expect(() => saveLocalThreadComposerDraft(draft('new'), store)).toThrow('quota')
    expect(archive.getItem(`rovai.web.thread-drafts.v1:${scope}`)).toBe(before)
    archive.setItem = write
    expect(() => recovery.set(bundleKey, '{"version":2,"drafts":{}}')).toThrow()
    expect(archive.getItem(`rovai.web.thread-drafts.v1:${scope}`)).toBe(before)
    expect(tab.length).toBe(0)
    const saved = JSON.parse(before!)
    saved.entries[bundleKey].value = '{"version":2,"drafts":{}}'
    archive.setItem(`rovai.web.thread-drafts.v1:${scope}`, JSON.stringify(saved))
    expect(() => loadLocalThreadComposerDraft('thread', store)).toThrow()
    expect(() => saveLocalThreadComposerDraft(draft('overwrite'), store)).toThrow()
    expect(archive.getItem(`rovai.web.thread-drafts.v1:${scope}`)).toContain('\\"version\\":2')
  })

  it('keeps editors separate after tab loss, filters Host/Owner, and retains copies after restoring or clearing another editor', () => {
    const archive = new Store()
    const a = browserEditingRecovery('host/owner/a', new Store(), { ownerScope: 'host/owner', storage: archive })
    const b = browserEditingRecovery('host/owner/b', new Store(), { ownerScope: 'host/owner', storage: archive })
    saveLocalThreadComposerDraft(draft('A'), threadComposerDraftStorage(a))
    expect(loadLocalThreadComposerDraft('thread', threadComposerDraftStorage(b))).toBeNull()
    saveLocalThreadComposerDraft(draft('B'), threadComposerDraftStorage(b))
    const reopened = browserEditingRecovery('host/owner/new', new Store(), { ownerScope: 'host/owner', storage: archive })
    expect(reopened.get(identity)).toBeNull()
    expect(reopened.draftCopies!(identity).map(copy => JSON.parse(copy.value).body).sort()).toEqual(['A', 'B'])
    expect(browserEditingRecovery('host/other/new', new Store(), { ownerScope: 'host/other', storage: archive }).draftCopies!(identity)).toEqual([])
    expect(browserEditingRecovery('another/owner/new', new Store(), { ownerScope: 'another/owner', storage: archive }).draftCopies!(identity)).toEqual([])
    const nestedOwner = browserEditingRecovery('host/owner/other/peer', new Store(), { ownerScope: 'host/owner/other', storage: archive })
    saveLocalThreadComposerDraft(draft('another owner'), threadComposerDraftStorage(nestedOwner))
    expect(reopened.draftCopies!(identity)).toHaveLength(2)
    saveLocalThreadComposerDraft(draft('copy A'), threadComposerDraftStorage(reopened))
    saveLocalThreadComposerDraft(emptyLocalThreadComposerDraft('thread'), threadComposerDraftStorage(reopened))
    expect(reopened.get(identity)).toBeNull()
    expect(reopened.draftCopies!(identity)).toHaveLength(2)
    expect(loadLocalThreadComposerDraft('thread', threadComposerDraftStorage(a))?.body).toBe('A')
  })
  it('migrates only the verified tab public snapshot and never archives proofs, pending commands, or Single Chat edits', () => {
    const tab = new Store(), archive = new Store()
    const old = browserEditingRecovery('host/owner/editor', tab)
    saveLocalThreadComposerDraft(draft('before upgrade'), threadComposerDraftStorage(old))
    old.set('single-chat:thread', { body: 'private', editToken: 'private-proof' })
    old.set('rovai.camp-composer-draft.v1:broken', '{invalid-old-record')
    tab.setItem('rovai.web.session.v1', JSON.stringify({ token: 'session-secret', editor: { proof: 'editor-proof' }, pending: ['pending-command'] }))
    const current = browserEditingRecovery('host/owner/editor', tab, { ownerScope: 'host/owner', storage: archive })
    expect(loadLocalThreadComposerDraft('thread', threadComposerDraftStorage(current))?.body).toBe('before upgrade')
    saveLocalThreadComposerDraft(draft('after upgrade'), threadComposerDraftStorage(current))
    const raw = [...archive.values.values()].join('')
    for (const secret of ['private-proof', 'session-secret', 'editor-proof', 'pending-command']) expect(raw).not.toContain(secret)
    expect(raw).not.toContain('invalid-old-record')
    expect(tab.getItem('rovai.web.edits.v1')).toContain('invalid-old-record')
    saveLocalThreadComposerDraft(emptyLocalThreadComposerDraft('thread'), threadComposerDraftStorage(current))
    expect(current.get(identity)).toBeNull()
    expect(browserEditingRecovery('host/owner/editor', tab, { ownerScope: 'host/owner', storage: archive }).get(identity)).toBeNull()
    expect(current.get('single-chat:thread')).toEqual({ body: 'private', editToken: 'private-proof' })
  })
  it('preserves the previous saved copy on quota failure and rejects corrupt own records without overwriting them', () => {
    const archive = new Store()
    const current = browserEditingRecovery('host/owner/editor', new Store(), { ownerScope: 'host/owner', storage: archive })
    saveLocalThreadComposerDraft(draft('saved'), threadComposerDraftStorage(current))
    const before = archive.getItem('rovai.web.thread-drafts.v1:host/owner/editor')
    saveLocalThreadComposerDraft(draft('saved'), threadComposerDraftStorage(current))
    expect(archive.getItem('rovai.web.thread-drafts.v1:host/owner/editor')).toBe(before)
    const write = archive.setItem.bind(archive)
    archive.setItem = () => { throw new Error('quota') }
    expect(() => saveLocalThreadComposerDraft(draft('new input'), threadComposerDraftStorage(current))).toThrow('quota')
    expect(archive.getItem('rovai.web.thread-drafts.v1:host/owner/editor')).toBe(before)
    archive.setItem = write
    archive.setItem('rovai.web.thread-drafts.v1:host/owner/editor', '{broken')
    expect(() => current.get(identity)).toThrow()
    expect(archive.getItem('rovai.web.thread-drafts.v1:host/owner/editor')).toBe('{broken')
  })
})
