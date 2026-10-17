import type { ActionApprovalView, AgentRunView, RovaiApi, SendThreadMessageResult, StoredCommandResult, ThreadComposerDraftView, ThreadMemberRemovalPreview, ThreadMessageView } from '@contracts'
import { campMessageSendParams, requestAuthoritativeThreadOpenProjection } from './thread-workspace-data'
import { uiAttribute } from './interface-language'

/** A transport bound to one Core client and Thread; it never consults the selected sidebar row.
 * Core retains authorization, CAS, publication and receipt authority. No retries or Runtime launch live here. */
export function threadCommands(client: Pick<RovaiApi, 'request'>, threadId: string) {
  if (!threadId) throw new Error(uiAttribute('当前会话尚未准备好。'))
  return {
    threadId,
    open(traceId: string) { return requestAuthoritativeThreadOpenProjection(client, threadId, traceId) },
    send(commandId: string, draft: ThreadComposerDraftView) {
      if (draft.threadId !== threadId) throw new Error(uiAttribute('当前会话已发生变化，请重新读取影响。'))
      return client.request<SendThreadMessageResult>('thread.messages.send', structuredClone(campMessageSendParams(commandId, threadId, draft)))
    },
    cancel(commandId: string, run: Pick<AgentRunView, 'id' | 'version'>) {
      return client.request<StoredCommandResult>('agentRuns.cancel', {
        commandId, command: { threadId, agentRunId: run.id, expectedVersion: run.version }
      })
    },
    withdraw(commandId: string, message: Pick<ThreadMessageView, 'id' | 'version'>) {
      return client.request<StoredCommandResult>('thread.messages.withdraw', {
        commandId, command: { threadId, messageId: message.id, expectedVersion: message.version }
      })
    },
    resolveApproval(commandId: string, approval: Pick<ActionApprovalView, 'id' | 'version'>, optionId: string) {
      return client.request<StoredCommandResult>('action.approvals.resolve', {
        commandId, threadId, approvalId: approval.id, expectedVersion: approval.version, optionId,
        reason: `用户选择智能体原生选项：${optionId}。`
      })
    },
    changeLead(commandId: string, successorAgentId: string, expectedVersion: number) {
      return client.request<StoredCommandResult>('threads.changeDefaultLead', {
        commandId, command: { threadId, successorAgentId, expectedVersion }
      })
    },
    addMember(commandId: string, agentId: string, expectedMembershipGeneration: number) {
      return client.request<StoredCommandResult>('threads.members.add', {
        commandId, command: { threadId, agentId, expectedMembershipGeneration }
      })
    },
    async removalPreview(agentId: string) {
      const preview = await client.request<ThreadMemberRemovalPreview | null>('threads.members.removalPreview', { threadId, agentId })
      if (preview && preview.threadId !== threadId) throw new Error(uiAttribute('当前会话已发生变化，请重新读取影响。'))
      return preview
    },
    removeMember(commandId: string, preview: ThreadMemberRemovalPreview) {
      if (preview.threadId !== threadId) throw new Error(uiAttribute('当前会话已发生变化，请重新读取影响。'))
      return client.request<StoredCommandResult>('threads.members.remove', {
        commandId, command: { threadId, agentId: preview.agentId, expectedMembershipGeneration: preview.membershipGeneration,
          expectedMembershipVersion: preview.membershipVersion, replacementDefaultLeadAgentId: preview.nextDefaultLeadAgentId, reason: 'removed_from_camp' }
      })
    }
  } as const
}
