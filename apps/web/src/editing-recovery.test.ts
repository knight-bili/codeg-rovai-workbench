import { describe, expect, it } from 'vitest'
import { browserEditingRecovery } from './editing-recovery'
import { emptyLocalThreadComposerDraft, saveLocalThreadComposerDraft, threadComposerDraftStorage, loadLocalThreadComposerDraft } from '../../desktop/src/renderer/src/camp-composer-local-store'

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
