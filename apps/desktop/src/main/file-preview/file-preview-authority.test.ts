import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type { CoreMethod } from '@contracts'
import { CoreFilePreviewSourceAuthority, parseCoreFilePreviewAuthorityResult } from './file-preview-authority'

it('forwards the complete private locator to Core and separates authority identities across scopes', async () => {
  const target = { attachmentId: '8b85752a-76a5-4b9d-92d8-a70b6285a0d0', displayName: 'file.txt', kind: 'file',
    mediaType: 'text/plain', path: resolve('fixture.txt'), openRisk: 'normal', canShowPath: true }
  const request = vi.fn<(method: CoreMethod, params?: unknown) => void>()
  const authority = new CoreFilePreviewSourceAuthority({ async request<T>(method: CoreMethod, params?: unknown): Promise<T> {
    request(method, params)
    return target as T
  } })
  const locator = { owner: 'single_chat_scoped_composer' as const, threadId: 'thread', conversationId: 'conversation',
    composerScope: { kind: 'canvas' as const, boardId: 'board', nodeId: 'card-a' }, attachmentRefId: target.attachmentId }
  const a = await authority.resolve({ kind: 'attachment', threadId: 'thread', locator })
  expect(request).toHaveBeenLastCalledWith('thread.attachments.desktopOpenTarget', locator)
  const b = await authority.resolve({ kind: 'attachment', threadId: 'thread', locator: { ...locator, composerScope: { ...locator.composerScope, nodeId: 'card-b' } } })
  if (a?.kind !== 'file_target' || b?.kind !== 'file_target') throw new Error('Missing attachment authority')
  expect(a.sourceIdentity).not.toBe(b.sourceIdentity)
  expect(a).toMatchObject({ candidatePath: target.path, displayName: 'file.txt' })
})

describe('parseCoreFilePreviewAuthorityResult', () => {
  it('accepts a matching authority receipt', () => {
    const request = {
      kind: 'camp_workspace' as const,
      threadId: 'camp-1',
      rawReference: 'docs/guide.md'
    }
    expect(parseCoreFilePreviewAuthorityResult({
      kind: 'file_target',
      threadId: 'camp-1',
      sourceKind: 'camp_workspace',
      sourceIdentity: 'thread:camp-1',
      rootPath: '/repo',
      basePath: '/repo',
      rawReference: 'docs/guide.md',
      allowChildren: true
    }, request)).toMatchObject({ kind: 'file_target', rootPath: '/repo' })
  })

  it('fails closed when the receipt changes source identity or request data', () => {
    const request = {
      kind: 'message_reference' as const,
      threadId: 'camp-1',
      messageId: 'message-1',
      rawReference: './secret.txt'
    }
    expect(parseCoreFilePreviewAuthorityResult({
      kind: 'file_target',
      threadId: 'camp-2',
      sourceKind: 'message_reference',
      sourceIdentity: 'message:other',
      rootPath: '/repo',
      basePath: '/repo',
      rawReference: './secret.txt',
      allowChildren: true
    }, request)).toBeNull()
  })

  it('accepts only the exact path returned for a Run activity file', () => {
    const request = {
      kind: 'run_activity_file' as const,
      threadId: 'camp-1',
      agentRunId: 'run-1',
      executionEpoch: 2,
      evidenceId: 'evidence-1',
      rawReference: 'src/generated.ts'
    }
    const receipt = {
      kind: 'file_target',
      threadId: 'camp-1',
      sourceKind: 'run_activity_file',
      sourceIdentity: 'run-activity-file:run-1:2:evidence-1',
      rootPath: '/mission-worktree',
      basePath: '/mission-worktree',
      rawReference: 'src/generated.ts',
      allowChildren: true
    }
    expect(parseCoreFilePreviewAuthorityResult(receipt, request)).toMatchObject({
      kind: 'file_target',
      rootPath: '/mission-worktree',
      rawReference: 'src/generated.ts'
    })
    expect(parseCoreFilePreviewAuthorityResult({
      ...receipt,
      rawReference: 'src/other.ts'
    }, request)).toBeNull()
  })
})
