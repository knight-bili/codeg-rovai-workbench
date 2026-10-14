import type { EditingRecovery } from '../../desktop/src/renderer/src/camp-client'
import type { RecoveryStorage } from './tab-recovery'
import { parseLocalThreadComposerDraft, THREAD_COMPOSER_STORAGE_PREFIX } from '../../desktop/src/renderer/src/camp-composer-local-store'

type ArchiveOptions = { ownerScope: string; storage: Pick<Storage, 'getItem' | 'setItem' | 'length' | 'key'> }
type Archive = { version: 1; scope: string; ownerScope: string; entries: Record<string, { value: string; savedAt: number }> }

export function browserEditingRecovery(scope: string, storage: RecoveryStorage = sessionStorage, archive?: ArchiveOptions): EditingRecovery {
  const key = 'rovai.web.edits.v1'
  const read = (): Record<string, unknown> => {
    const raw = storage.getItem(key)
    if (!raw) return {}
    const saved = JSON.parse(raw) as { scope?: unknown; entries?: Record<string, unknown> }
    return saved.scope === scope && saved.entries && typeof saved.entries === 'object' ? saved.entries : {}
  }
  if (archive && !scope.startsWith(`${archive.ownerScope}/`)) throw new Error('草稿归属与当前连接不一致。')
  const archivePrefix = `rovai.web.thread-drafts.v1:${archive?.ownerScope}/`
  const archiveKey = `rovai.web.thread-drafts.v1:${scope}`
  const encodeDraft = (identity: string, value: unknown): string => {
    const draft = typeof value === 'string' ? parseLocalThreadComposerDraft(value, identity.slice(THREAD_COMPOSER_STORAGE_PREFIX.length)) : null
    if (!draft) throw new Error('草稿快照格式不可恢复。')
    return JSON.stringify({ threadId: draft.threadId, body: draft.body, content: draft.content, revision: draft.revision,
      attachments: draft.attachments, quotes: draft.quotes, replyIntent: draft.replyIntent, continuationIntent: draft.continuationIntent,
      updatedAt: draft.updatedAt, expiresAt: draft.expiresAt })
  }
  const readArchive = (): Archive | null => {
    const raw = archive?.storage.getItem(archiveKey)
    if (!raw) return null
    const saved = JSON.parse(raw) as Archive
    if (!saved || saved.version !== 1 || saved.scope !== scope || saved.ownerScope !== archive?.ownerScope
      || !saved.entries || typeof saved.entries !== 'object' || Array.isArray(saved.entries)
      || Object.entries(saved.entries).some(([identity, entry]) => !identity.startsWith(THREAD_COMPOSER_STORAGE_PREFIX)
        || !entry || typeof entry.value !== 'string' || !Number.isFinite(entry.savedAt)
        || !parseLocalThreadComposerDraft(entry.value, identity.slice(THREAD_COMPOSER_STORAGE_PREFIX.length)))) throw new Error('已保存草稿暂时无法读取，原记录仍保留。')
    return saved
  }
  return {
    get(identity) {
      if (!archive || !identity.startsWith(THREAD_COMPOSER_STORAGE_PREFIX)) return read()[identity] ?? null
      const saved = readArchive()
      return saved ? saved.entries[identity]?.value ?? null : read()[identity] ?? null
    },
    set(identity, value) {
      if (archive && identity.startsWith(THREAD_COMPOSER_STORAGE_PREFIX)) {
        const existing = readArchive()
        const saved = existing ?? { version: 1, scope, ownerScope: archive.ownerScope, entries: Object.fromEntries(Object.entries(read())
          .filter(([key, entry]) => key.startsWith(THREAD_COMPOSER_STORAGE_PREFIX) && typeof entry === 'string'
            && parseLocalThreadComposerDraft(entry, key.slice(THREAD_COMPOSER_STORAGE_PREFIX.length)))
          .map(([key, entry]) => [key, { value: encodeDraft(key, entry), savedAt: Date.now() }])) } as Archive
        if (value === null) {
          if (existing && !saved.entries[identity]) return
          delete saved.entries[identity]
        } else {
          const encoded = encodeDraft(identity, value)
          if (existing && saved.entries[identity]?.value === encoded) return
          saved.entries[identity] = { value: encoded, savedAt: Date.now() }
        }
        // This one atomic store owns public body snapshots. Session proofs,
        // Single Chat edits and pending commands remain in the existing tab store.
        archive.storage.setItem(archiveKey, JSON.stringify(saved))
        return
      }
      const entries = read()
      if (value === null) delete entries[identity]
      else entries[identity] = value
      storage.setItem(key, JSON.stringify({ scope, entries }))
    },
    draftCopies: archive ? identity => {
      if (!identity.startsWith(THREAD_COMPOSER_STORAGE_PREFIX)) return []
      const copies = []
      for (let index = 0; index < archive.storage.length; index++) {
        const key = archive.storage.key(index)
        if (!key?.startsWith(archivePrefix) || key === archiveKey) continue
        try {
          const saved = JSON.parse(archive.storage.getItem(key) ?? 'null') as Archive
          const entry = saved?.entries?.[identity]
          if (saved?.version === 1 && saved.ownerScope === archive.ownerScope && key === `rovai.web.thread-drafts.v1:${saved.scope}` && entry && Number.isFinite(entry.savedAt)) {
            copies.push({ id: saved.scope, value: encodeDraft(identity, entry.value), savedAt: entry.savedAt })
          }
        } catch { /* Keep malformed copies untouched; do not import partial content. */ }
      }
      return copies.sort((a, b) => b.savedAt - a.savedAt || a.id.localeCompare(b.id))
    } : undefined
  }
}
