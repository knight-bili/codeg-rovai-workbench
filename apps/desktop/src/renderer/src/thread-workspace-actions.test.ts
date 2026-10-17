import { expect, it, vi } from 'vitest'
import type { SetStateAction } from 'react'
import type { CoreMethod, ThreadComposerDraftView } from '@contracts'
import { threadWorkspaceActions, type ThreadOptimisticEntry, type ThreadActionToast } from './thread-workspace-actions'
import type { ThreadRuntimeRecovery } from './ThreadWorkspace'
import { threadCommands } from './thread-commands'
import { emptyLocalThreadComposerDraft } from './camp-composer-local-store'
import type { ThreadSurfaceSnapshot } from './thread-workspace-data'

function box<T>(initial: T) {
  let value = initial
  return { get value() { return value }, set(next: SetStateAction<T>) { value = typeof next === 'function' ? (next as (current: T) => T)(value) : next } }
}
function fixture(threadId: string, handler: (method: CoreMethod, params?: unknown) => Promise<unknown>) {
  const calls: Array<{ method: CoreMethod; params: unknown }> = []
  const client = { request<T>(method: CoreMethod, params?: unknown): Promise<T> { calls.push({ method, params }); return handler(method, params) as Promise<T> } }
  const snapshot = { thread: { id: threadId, version: 1, membershipGeneration: 1 }, messages: [], turns: [], agentRuns: [],
    members: [{ agentId: 'lead', isDefaultLead: true, membershipStatus: 'active', profilePresence: 'present' }] } as unknown as ThreadSurfaceSnapshot
  const optimistic = box<ThreadOptimisticEntry[]>([])
  const context: Parameters<typeof threadWorkspaceActions>[0] = {
    client, activeThreadId: threadId, activeThreadCommands: threadCommands(client, threadId), campSnapshot: snapshot,
    campSnapshotRef: { current: snapshot }, activeThreadIdRef: { current: threadId }, campSelectionGeneration: { current: 0 },
    threadClientOwner: { current: client }, campEventSequenceMarker: { current: 0 }, setThreadSnapshot: vi.fn(),
    setBusy: box<string | null>(null).set, setError: box<string | null>(null).set, setToast: box<ThreadActionToast | null>(null).set,
    setRuntimeRecovery: box<ThreadRuntimeRecovery | null>(null).set, setOptimisticThreadMessages: optimistic.set,
    setCancellingRunIds: box(new Set<string>()).set, setConfirmingRunIds: box(new Set<string>()).set,
    refreshActiveThreadSnapshot: vi.fn(async () => undefined), requestThreadProjection: async () => ({ snapshot }),
    navigationRefreshCoordinator: { refreshThreads: vi.fn(async () => undefined), invalidate: vi.fn(async () => undefined) },
    forgetMemberCreationDraft: vi.fn(), notify: vi.fn()
  }
  return { actions: threadWorkspaceActions(context), context, calls, optimistic }
}
const draft = (threadId: string, body = 'input'): ThreadComposerDraftView => ({ ...emptyLocalThreadComposerDraft(threadId), body,
  content: { version: 2, segments: [{ kind: 'text', text: body }] } })

it('freezes the original send bytes and does not expose a private pending admission as an optimistic public message', async () => {
  let release!: (value: unknown) => void
  const f = fixture('a', async () => new Promise(resolve => { release = resolve })), input = draft('a', 'original')
  const sending = f.actions.sendThreadMessage(input)
  expect(f.optimistic.value).toEqual([])
  input.body = 'later edit'; input.content.segments = [{ kind: 'text', text: 'later edit' }]
  const params = f.calls[0].params as { threadId: string; content: unknown; execution: { purpose: string } }
  expect(params).toMatchObject({ threadId: 'a', content: { version: 2, segments: [{ kind: 'text', text: 'original' }] }, execution: { purpose: 'original' } })
  release({ commandResult: { status: 'applied', payload: { pendingInputId: 'private-pending' } } })
  const receipt = await sending
  expect(receipt).not.toHaveProperty('threadMessageId')
  expect(f.optimistic.value).toEqual([])
})

it('keeps interleaved workspace operations attached to their original Thread while another card is used', async () => {
  const a = fixture('a', async () => ({ status: 'applied', payload: {} })), b = fixture('b', async () => ({ status: 'applied', payload: {} }))
  await Promise.all([a.actions.changeDefaultLead('member-a'), b.actions.withdrawThreadMessage({ id: 'message-b', version: 2, canWithdraw: true } as never)])
  expect(a.calls[0]).toMatchObject({ method: 'threads.changeDefaultLead', params: { command: { threadId: 'a', successorAgentId: 'member-a', expectedVersion: 1 } } })
  expect(b.calls[0]).toMatchObject({ method: 'thread.messages.withdraw', params: { command: { threadId: 'b', messageId: 'message-b', expectedVersion: 2 } } })
})

it('preserves input responsibility on unknown transport and rejected admission without publishing an optimistic row', async () => {
  const unknown = fixture('a', async () => { throw new Error('transport unavailable') })
  await expect(unknown.actions.sendThreadMessage(draft('a'))).rejects.toThrow('transport unavailable')
  expect(unknown.calls).toHaveLength(1); expect(unknown.optimistic.value).toEqual([])
  const rejected = fixture('b', async () => ({ commandResult: { status: 'rejected', code: 'rejected', message: 'rejected', payload: {} } }))
  await expect(rejected.actions.sendThreadMessage(draft('b'))).rejects.toThrow()
  expect(rejected.optimistic.value).toEqual([])
  expect(rejected.context.forgetMemberCreationDraft).not.toHaveBeenCalled()
})

it('does not address a send to the current card when its draft belongs to another Thread', async () => {
  const f = fixture('a', async () => { throw new Error('must not send') })
  await expect(f.actions.sendThreadMessage(draft('b'))).resolves.toBeUndefined()
  expect(f.calls).toEqual([])
})
