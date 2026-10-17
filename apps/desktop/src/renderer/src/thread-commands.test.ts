import { expect, it } from 'vitest'
import type { CoreMethod, ThreadComposerDraftView, ThreadMemberRemovalPreview } from '@contracts'
import { threadCommands } from './thread-commands'
import { campMessageSendParams } from './thread-workspace-data'

function fixture(handler: (method: CoreMethod, params: unknown) => Promise<unknown> = async () => ({ marker: 'Core result' })) {
  const calls: Array<{ method: CoreMethod; params: unknown }> = []
  return { calls, client: { request<T>(method: CoreMethod, params?: unknown): Promise<T> {
    calls.push({ method, params }); return handler(method, params) as Promise<T>
  } } }
}
function draft(threadId = 'thread-a'): ThreadComposerDraftView {
  return { threadId, revision: 4, body: '', content: { version: 2, segments: [] }, quotes: [],
    attachments: [{ id: 'attachment', sourcePath: '/workspace/original.txt', displayName: 'original.txt', kind: 'file', fileCount: 1,
      mediaType: 'text/plain', byteSize: 12, previewKind: 'none', availability: 'available' }],
    replyIntent: null, continuationIntent: null, updatedAt: null, expiresAt: null }
}
const preview: ThreadMemberRemovalPreview = { threadId: 'thread-a', agentId: 'member', displayName: 'Member', membershipGeneration: 7, membershipVersion: 3,
  isDefaultLead: false, nextDefaultLeadAgentId: null, nonTerminalAgentRunCount: 0, openAssignedTaskCount: 0, pendingDeliveryCount: 0, runningDeliveryCount: 0,
  removable: true, blockerCode: null }

it('keeps concurrent writes attached to their captured Thread instead of a later selected row', async () => {
  const pending: Array<() => void> = []
  const f = fixture(async (_method, params) => new Promise(resolve => pending.push(() => resolve(params))))
  const a = threadCommands(f.client, 'thread-a'), b = threadCommands(f.client, 'thread-b')
  const first = a.cancel('cancel-a', { id: 'run-a', version: 4 })
  const second = b.resolveApproval('approval-b', { id: 'approval-b', version: 9 }, 'allow-once')
  const third = a.withdraw('withdraw-a', { id: 'message-a', version: 2 })
  pending[1](); pending[0](); pending[2]()
  await Promise.all([first, second, third])
  expect(f.calls.map(call => call.params)).toEqual([
    { commandId: 'cancel-a', command: { threadId: 'thread-a', agentRunId: 'run-a', expectedVersion: 4 } },
    { commandId: 'approval-b', threadId: 'thread-b', approvalId: 'approval-b', expectedVersion: 9, optionId: 'allow-once', reason: '用户选择智能体原生选项：allow-once。' },
    { commandId: 'withdraw-a', command: { threadId: 'thread-a', messageId: 'message-a', expectedVersion: 2 } }
  ])
})

it('opens only the fixed Thread through the existing read-only projection operation', async () => {
  const projection = { marker: 'authoritative projection' }, f = fixture(async () => projection)
  expect(await threadCommands(f.client, 'thread-a').open('trace-a')).toBe(projection)
  expect(f.calls).toEqual([{ method: 'threads.open', params: { traceId: 'trace-a', threadId: 'thread-a' } }])
})

it('preserves serialized send input and snapshots it before editor content or source attachments change', async () => {
  const f = fixture(), d = draft(), expected = JSON.stringify(campMessageSendParams('send-a', 'thread-a', d))
  const sending = threadCommands(f.client, 'thread-a').send('send-a', d)
  d.content.segments.push({ kind: 'text', text: 'later editing' })
  d.attachments[0].sourcePath = '/different/file.txt'
  expect(JSON.stringify(f.calls[0].params)).toBe(expected)
  expect(f.calls[0].method).toBe('thread.messages.send')
  await sending
})

it('rejects foreign drafts, missing source paths and foreign removal scope before any transport call', () => {
  const f = fixture(), a = threadCommands(f.client, 'thread-a')
  expect(() => a.send('send-wrong', draft('thread-b'))).toThrow()
  const missing = draft(); missing.attachments[0].sourcePath = undefined
  expect(() => a.send('send-missing-source', missing)).toThrow()
  expect(() => a.removeMember('remove-wrong', { ...preview, threadId: 'thread-b' })).toThrow()
  expect(f.calls).toEqual([])
})

it('passes through Core rejection or missing receipts and never retries a transport failure', async () => {
  const denied = { commandResult: { status: 'rejected', code: 'agent_run.runtime_not_ready' }, replayed: false }
  const missing = { commandResult: null, replayed: false }, failure = new Error('response lost')
  for (const value of [denied, missing]) {
    const f = fixture(async () => value)
    expect(await threadCommands(f.client, 'thread-a').send('same-command', draft())).toBe(value)
    expect(f.calls).toHaveLength(1)
  }
  const f = fixture(async () => { throw failure })
  await expect(threadCommands(f.client, 'thread-a').send('unknown-command', draft())).rejects.toBe(failure)
  expect(f.calls).toHaveLength(1)
  expect((f.calls[0].params as { commandId: string }).commandId).toBe('unknown-command')
})

it('preserves membership cutover and replacement fields and rejects a mismatched removal read', async () => {
  const f = fixture(async method => method === 'threads.members.removalPreview' ? preview : { marker: 'receipt' }), a = threadCommands(f.client, 'thread-a')
  await a.changeLead('lead-command', 'lead-next', 11)
  await a.addMember('add-command', 'member-next', 7)
  expect(await a.removalPreview('member')).toBe(preview)
  await a.removeMember('remove-command', preview)
  expect(f.calls).toEqual([
    { method: 'threads.changeDefaultLead', params: { commandId: 'lead-command', command: { threadId: 'thread-a', successorAgentId: 'lead-next', expectedVersion: 11 } } },
    { method: 'threads.members.add', params: { commandId: 'add-command', command: { threadId: 'thread-a', agentId: 'member-next', expectedMembershipGeneration: 7 } } },
    { method: 'threads.members.removalPreview', params: { threadId: 'thread-a', agentId: 'member' } },
    { method: 'threads.members.remove', params: { commandId: 'remove-command', command: { threadId: 'thread-a', agentId: 'member', expectedMembershipGeneration: 7, expectedMembershipVersion: 3, replacementDefaultLeadAgentId: null, reason: 'removed_from_camp' } } }
  ])
  const wrong = fixture(async () => ({ ...preview, threadId: 'thread-b' }))
  await expect(threadCommands(wrong.client, 'thread-a').removalPreview('member')).rejects.toThrow()
  const absent = fixture(async () => null)
  expect(await threadCommands(absent.client, 'thread-a').removalPreview('member')).toBeNull()
})

it('keeps identical Thread IDs on different client owners isolated', async () => {
  const hostA = fixture(async () => ({ owner: 'A' })), hostB = fixture(async () => ({ owner: 'B' }))
  const a = threadCommands(hostA.client, 'same-thread'), b = threadCommands(hostB.client, 'same-thread')
  expect(await b.cancel('b', { id: 'same-run', version: 2 })).toEqual({ owner: 'B' })
  expect(hostA.calls).toHaveLength(0)
  expect(await a.cancel('a', { id: 'same-run', version: 2 })).toEqual({ owner: 'A' })
  expect(hostA.calls).toHaveLength(1)
  expect(hostB.calls).toHaveLength(1)
})
