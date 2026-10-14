import type { ThreadComposerDraftView, ThreadSnapshot } from '@contracts'
import { describe, expect, it } from 'vitest'
import {
  clearLocalThreadComposerDraft,
  copyLegacyThreadComposerDraft,
  emptyLocalThreadComposerDraft,
  loadLocalThreadComposerDraft,
  materializeLocalContinuation,
  nextLocalThreadComposerDraftAfterSend,
  saveLocalThreadComposerDraft,
  threadComposerDraftStorage
} from './camp-composer-local-store'

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

const members = [
  {
    agentId: 'lead', displayName: '队长', isDefaultLead: true,
    membershipStatus: 'active', profilePresence: 'present'
  },
  {
    agentId: 'reviewer', displayName: '审查员', isDefaultLead: false,
    membershipStatus: 'active', profilePresence: 'present'
  }
] as ThreadSnapshot['members']

describe('local Thread Composer drafts', () => {
  it('copies legacy input only into an empty matching editor and retains the original without trusting old source paths', () => {
    const original = new MemoryStorage(), current = new MemoryStorage()
    const legacy: ThreadComposerDraftView = { ...emptyLocalThreadComposerDraft('thread'), body: 'legacy', content: { version: 2, segments: [{ kind: 'text', text: 'legacy' }] },
      attachments: [{ id: '11111111-1111-4111-8111-111111111111', displayName: 'old.txt', kind: 'file', fileCount: 1, mediaType: 'text/plain', byteSize: 10, previewKind: 'none', availability: 'available', sourcePath: '/old/private/source.txt' }] }
    saveLocalThreadComposerDraft(legacy, original)
    const before = original.getItem('rovai.camp-composer-draft.v1:thread')
    const copied = copyLegacyThreadComposerDraft(emptyLocalThreadComposerDraft('thread'), loadLocalThreadComposerDraft('thread', original)!, current)!
    expect(copied.body).toBe('legacy')
    expect(copied.attachments[0].availability).toBe('unknown')
    expect(copied.attachments[0].sourcePath).toBeUndefined()
    expect(original.getItem('rovai.camp-composer-draft.v1:thread')).toBe(before)
    expect(copyLegacyThreadComposerDraft(copied, legacy, current)).toBeNull()
    expect(copyLegacyThreadComposerDraft(emptyLocalThreadComposerDraft('other'), legacy, current)).toBeNull()
    const scopedBefore = current.getItem('rovai.camp-composer-draft.v1:thread')
    const quota = { ...current, getItem: current.getItem.bind(current), removeItem: current.removeItem.bind(current), setItem() { throw new Error('quota') } }
    expect(() => copyLegacyThreadComposerDraft(emptyLocalThreadComposerDraft('thread'), legacy, quota)).toThrow('quota')
    expect(current.getItem('rovai.camp-composer-draft.v1:thread')).toBe(scopedBefore)
    expect(original.getItem('rovai.camp-composer-draft.v1:thread')).toBe(before)
  })
  it('restores the same editor snapshot without reading another editor or deleting its draft', () => {
    const entriesA = new Map<string, unknown>(), entriesB = new Map<string, unknown>()
    const recovery = (entries: Map<string, unknown>) => ({ get: (key: string) => entries.get(key), set: (key: string, value: unknown) => value === null ? entries.delete(key) : entries.set(key, value) })
    const a = threadComposerDraftStorage(recovery(entriesA))!
    const b = threadComposerDraftStorage(recovery(entriesB))!
    const draft = { ...emptyLocalThreadComposerDraft('same-thread'), body: 'private A', content: { version: 2 as const, segments: [{ kind: 'text' as const, text: 'private A' }] } }
    saveLocalThreadComposerDraft(draft, a)
    expect(loadLocalThreadComposerDraft('same-thread', b)).toBeNull()
    const restoredA = threadComposerDraftStorage(recovery(entriesA))!
    expect(loadLocalThreadComposerDraft('same-thread', restoredA)).toEqual(draft)
    clearLocalThreadComposerDraft('same-thread', b)
    expect(loadLocalThreadComposerDraft('same-thread', restoredA)).toEqual(draft)
    expect(threadComposerDraftStorage()).toBeUndefined()
  })
  it('keeps independent unsent state for each Thread and clears only the selected Thread', () => {
    const storage = new MemoryStorage()
    const campA: ThreadComposerDraftView = {
      ...emptyLocalThreadComposerDraft('camp-a'),
      body: '@审查员 检查迁移',
      content: {
        version: 2,
        segments: [
          { kind: 'atom', atom: { type: 'member', agentId: 'reviewer' } },
          { kind: 'text', text: ' 检查迁移' },
          { kind: 'atom', atom: { type: 'skill', skillId: 'review', nameAtSend: 'review' } }
        ]
      },
      attachments: [{
        id: '11111111-1111-4111-8111-111111111111', displayName: 'schema.png', kind: 'file', fileCount: 1,
        mediaType: 'image/png', byteSize: 12, previewKind: 'image',
        availability: 'available', sourcePath: '/tmp/schema.png'
      }],
      quotes: [{
        version: 1,
        quoteId: 'quote-a',
        source: { scope: 'camp', campId: 'camp-a', messageId: 'message-quote' },
        authorAtCapture: { type: 'agent', agentId: 'reviewer', displayName: '审查员' },
        text: '先检查这一段',
        format: 'plain_text',
        capturedAt: '2026-09-19T08:00:00Z',
        sourceContentDigest: 'sha256:source',
        snapshotDigest: 'sha256:snapshot'
      }],
      replyIntent: {
        replyToThreadMessageId: 'message-old', targetState: 'available',
        author: { authorType: 'agent', authorId: 'reviewer', displayName: '审查员', recipientAvailability: 'available' },
        excerpt: '旧消息', recipientSelectionRequired: false
      }
    }
    const campB = {
      ...emptyLocalThreadComposerDraft('camp-b'),
      body: '另一个会话',
      content: { version: 2 as const, segments: [{ kind: 'text' as const, text: '另一个会话' }] }
    }
    saveLocalThreadComposerDraft(campA, storage)
    saveLocalThreadComposerDraft(campB, storage)

    expect(loadLocalThreadComposerDraft('camp-a', storage)).toEqual(campA)
    expect(loadLocalThreadComposerDraft('camp-b', storage)).toEqual(campB)

    clearLocalThreadComposerDraft('camp-a', storage)
    expect(loadLocalThreadComposerDraft('camp-a', storage)).toBeNull()
    expect(loadLocalThreadComposerDraft('camp-b', storage)).toEqual(campB)
  })

  it('rejects malformed local records instead of partially restoring them', () => {
    const storage = new MemoryStorage()
    storage.setItem('rovai.camp-composer-draft.v1:camp-a', JSON.stringify({
      ...emptyLocalThreadComposerDraft('camp-a'),
      content: { version: 2, segments: [{ kind: 'atom', atom: { type: 'member' } }] }
    }))
    expect(loadLocalThreadComposerDraft('camp-a', storage)).toBeNull()
  })

  it('continues only the last accepted unique explicit non-Lead route', () => {
    const sent: ThreadComposerDraftView = {
      ...emptyLocalThreadComposerDraft('camp-a', 4),
      body: '@审查员 检查迁移',
      content: {
        version: 2,
        segments: [
          { kind: 'atom', atom: { type: 'member', agentId: 'reviewer' } },
          { kind: 'text', text: ' 检查迁移' }
        ]
      }
    }
    const next = nextLocalThreadComposerDraftAfterSend({
      sent,
      threadMessageId: 'message-1',
      addressedAgentIds: ['reviewer'],
      members
    })
    expect(next.continuationIntent).toMatchObject({
      sourceThreadMessageId: 'message-1',
      recipient: { agentId: 'reviewer', displayName: '审查员' }
    })

    const typed = {
      ...next,
      body: '还有数据库迁移也看看',
      content: { version: 2 as const, segments: [{ kind: 'text' as const, text: '还有数据库迁移也看看' }] }
    }
    const continued = materializeLocalContinuation(typed, members)
    expect(continued).toMatchObject({
      body: '@审查员 还有数据库迁移也看看',
    })
    expect(continued.content.segments[0]).toEqual({
      kind: 'atom', atom: { type: 'member', agentId: 'reviewer' }
    })

    const lead = {
      ...sent,
      content: { version: 2 as const, segments: [{ kind: 'atom' as const, atom: { type: 'member' as const, agentId: 'lead' } }] }
    }
    expect(nextLocalThreadComposerDraftAfterSend({
      sent: lead, threadMessageId: 'message-2', addressedAgentIds: ['lead'], members
    }).continuationIntent).toBeNull()
  })

  it('preserves an accepted invitation route until the membership projection arrives', () => {
    const pendingMembers = members.filter((member) => member.isDefaultLead)
    const next = nextLocalThreadComposerDraftAfterSend({
      sent: {
        ...emptyLocalThreadComposerDraft('camp-a'),
        content: { version: 2, segments: [
          { kind: 'atom', atom: { type: 'member', agentId: 'reviewer', labelFallback: '审查员' } }
        ] }
      },
      threadMessageId: 'first-message',
      addressedAgentIds: ['reviewer'],
      members: pendingMembers
    })
    expect(next.continuationIntent).toEqual({
      sourceThreadMessageId: 'first-message',
      recipient: { agentId: 'reviewer', displayName: '审查员', recipientAvailability: 'available' },
      recipientSelectionRequired: false
    })
    const storage = new MemoryStorage()
    saveLocalThreadComposerDraft(next, storage)
    expect(loadLocalThreadComposerDraft('camp-a', storage)).toEqual(next)
    const typed: ThreadComposerDraftView = {
      ...next, body: '继续', content: { version: 2, segments: [{ kind: 'text', text: '继续' }] }
    }
    expect(materializeLocalContinuation(typed, pendingMembers)).toEqual(typed)
    expect(materializeLocalContinuation(typed, members).body).toBe('@审查员 继续')
  })
})
