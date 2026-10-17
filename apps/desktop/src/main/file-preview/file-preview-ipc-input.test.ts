import { describe, expect, it } from 'vitest'
import {
  parseOpenFilePreviewRequest,
  parseRestoreFilePreviewRequest,
  parseRetentionState
} from './file-preview-ipc-input'

const missionAttachmentRequest = {
  kind: 'attachment' as const,
  threadId: 'rvcamp_01m1s4cranehs9cdc9r7ayj5d3',
  locator: {
    owner: 'mission' as const,
    threadId: 'rvcamp_01m1s4cranehs9cdc9r7ayj5d3',
    missionId: 'rvm_01m2wq5xn6eg8ama698dbgwyk8',
    attachmentRefId: '8b85752a-76a5-4b9d-92d8-a70b6285a0d0'
  }
}

const privateBase = {
  threadId: missionAttachmentRequest.threadId,
  conversationId: '11111111-1111-4111-8111-111111111111',
  attachmentRefId: missionAttachmentRequest.locator.attachmentRefId,
  composerScope: { kind: 'canvas', boardId: '22222222-2222-4222-8222-222222222222', nodeId: '33333333-3333-4333-8333-333333333333' }
}
it.each([
  { ...privateBase, owner: 'single_chat_scoped_composer' },
  { ...privateBase, owner: 'single_chat_scoped_pending_edit', pendingInputId: '44444444-4444-4444-8444-444444444444', editToken: '55555555-5555-4555-8555-555555555555' },
  { ...privateBase, owner: 'single_chat_retained', retainedInputId: '44444444-4444-4444-8444-444444444444' },
  { ...privateBase, owner: 'single_chat_retained', composerScope: null, retainedInputId: '44444444-4444-4444-8444-444444444444' }
])('preserves the full $owner identity through open and restore parsing', locator => {
  const request = { kind: 'attachment', threadId: privateBase.threadId, locator }
  expect(parseOpenFilePreviewRequest(request)).toEqual(request)
  expect(parseRestoreFilePreviewRequest(request)).toEqual(request)
  expect(() => parseOpenFilePreviewRequest({ ...request, locator: { ...locator, clientId: 'desktop' } })).toThrow()
  expect(() => parseOpenFilePreviewRequest({ ...request, threadId: 'rvcamp_01m1jkkpkzfvgraw1p4r9zfb7v' })).toThrow()
})

it('rejects malformed scope, forged owners and attempted legacy scope stripping', () => {
  const request = { kind: 'attachment', threadId: privateBase.threadId, locator: { ...privateBase, owner: 'single_chat_scoped_composer' } }
  for (const composerScope of [null, undefined, { ...privateBase.composerScope, nodeId: 'node' }, { ...privateBase.composerScope, scopeKey: '' }]) {
    expect(() => parseOpenFilePreviewRequest({ ...request, locator: { ...request.locator, composerScope } })).toThrow()
  }
  expect(() => parseOpenFilePreviewRequest({ ...request, locator: { ...request.locator, owner: 'single_chat_composer' } })).toThrow()
})

describe('parseOpenFilePreviewRequest', () => {
  it('accepts a Mission attachment locator', () => {
    expect(parseOpenFilePreviewRequest(missionAttachmentRequest)).toEqual(missionAttachmentRequest)
  })

  it('accepts only the Skill entry file for a Skill reference', () => {
    const request = { kind: 'skill_reference', threadId: missionAttachmentRequest.threadId, skillId: 'native:abc', rawReference: 'SKILL.md' }
    expect(parseOpenFilePreviewRequest(request)).toEqual(request)
    expect(() => parseOpenFilePreviewRequest({ ...request, rawReference: '../private.txt' })).toThrow('Unsupported Skill entry')
  })
})

describe('parseRestoreFilePreviewRequest', () => {
  it.each([
    {
      kind: 'message_reference',
      threadId: 'rvcamp_01m1s4cranehs9cdc9r7ayj5d3',
      messageId: 'message-1',
      rawReference: 'docs/README.md'
    },
    {
      kind: 'skill_reference',
      threadId: 'rvcamp_01m1s4cranehs9cdc9r7ayj5d3',
      skillId: 'native:abc',
      rawReference: 'SKILL.md'
    },
    {
      kind: 'camp_workspace',
      threadId: 'rvcamp_01m1s4cranehs9cdc9r7ayj5d3',
      rawReference: 'README.md'
    },
    {
      kind: 'attachment',
      threadId: 'rvcamp_01m1s4cranehs9cdc9r7ayj5d3',
      locator: {
        owner: 'message',
        threadId: 'rvcamp_01m1s4cranehs9cdc9r7ayj5d3',
        messageId: 'message-1',
        attachmentRefId: '8b85752a-76a5-4b9d-92d8-a70b6285a0d0'
      }
    },
    missionAttachmentRequest,
    {
      kind: 'run_evidence',
      threadId: 'rvcamp_01m1s4cranehs9cdc9r7ayj5d3',
      agentRunId: 'run-1',
      executionEpoch: 1,
      evidenceFileId: 'file-1',
      action: 'open_current'
    },
    {
      kind: 'run_activity_file',
      threadId: 'rvcamp_01m1s4cranehs9cdc9r7ayj5d3',
      agentRunId: 'run-1',
      executionEpoch: 1,
      evidenceId: 'evidence-1',
      rawReference: 'src/generated.ts'
    }
  ])('accepts a revalidatable $kind source', (request) => {
    expect(parseRestoreFilePreviewRequest(request)).toEqual(request)
  })

  it.each([
    {
      kind: 'child_of_handle',
      parentHandleId: 'handle-1',
      rawReference: 'child.md'
    },
    {
      kind: 'authorized_root',
      threadId: 'rvcamp_01m1s4cranehs9cdc9r7ayj5d3',
      rootGrantId: 'grant-1',
      rawReference: 'child.md'
    }
  ])('rejects transient $kind capabilities', (request) => {
    expect(() => parseRestoreFilePreviewRequest(request)).toThrow(
      'Unsupported file preview restore source'
    )
  })
})


it('rejects unbounded or malformed retention hints before reaching the window ledger', () => {
  const session = { threadId: 'rvcamp_01m1s4cranehs9cdc9r7ayj5d3', previewSessionId: 'session' }
  const handle = { handleId: 'handle', previewSessionId: 'session', tabId: 'tab', lastUsed: 1, visible: true, busy: false, recoverable: true }
  expect(parseRetentionState({ sessions: [session], handles: [handle] })).toEqual({ sessions: [session], handles: [handle] })
  expect(() => parseRetentionState({ sessions: Array(25).fill(session), handles: [] })).toThrow()
  expect(() => parseRetentionState({ sessions: [session], handles: [{ ...handle, lastUsed: Infinity }] })).toThrow()
  expect(() => parseRetentionState({ sessions: [session], handles: [{ ...handle, visible: 'false' }] })).toThrow()
})
