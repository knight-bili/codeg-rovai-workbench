// Shared Rovai workspace projection and send formatting, moved without body changes from BusinessApp.
import type { RovaiApi, ThreadSnapshot, ThreadOpenProjection, ThreadMessageView, ThreadComposerDraftView, StoredCommandResult } from '@contracts'
import { THREAD_SNAPSHOT_SCHEMA_VERSION } from '@contracts'
import type { ThreadRuntimeRecovery } from './ThreadWorkspace'
import { composerDocumentToStructuredContent } from './composer-document'
import { uiAttribute } from './interface-language'
import { readErrorMessage } from './error-message'
import { localizeExecutionEngineTerms } from './product-copy'

export function requestAuthoritativeThreadOpenProjection(
  api: Pick<RovaiApi, 'request'>,
  threadId: string,
  traceId: string
): Promise<ThreadOpenProjection> {
  return api.request<ThreadOpenProjection>('threads.open', { traceId, threadId })
}

export type ThreadSurfaceSnapshot = ThreadSnapshot & {
  openCoverage?: ThreadOpenProjection['coverage']
}

export function campOpenProjectionAsSnapshot(
  projection: ThreadOpenProjection,
  previous: ThreadSurfaceSnapshot | null = null
): ThreadSurfaceSnapshot {
  const previousEarlierMessages = previous?.thread.id === projection.thread.id
    ? previous.messages.filter((message) =>
        projection.messages.length > 0
          && message.sequence < projection.messages[0].sequence
      )
    : []
  const messagesById = new Map<string, ThreadMessageView>()
  for (const message of previousEarlierMessages) messagesById.set(message.id, message)
  for (const message of projection.messages) messagesById.set(message.id, message)
  const messages = [...messagesById.values()]
    .map((message) => ({ ...message, timelineGlobalSequence: null }))
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
  const loadedCount = messages.length
  const totalCount = Math.max(projection.coverage.messages.totalCount, loadedCount)
  const omittedCount = Math.max(0, totalCount - loadedCount)
  return {
    schemaVersion: THREAD_SNAPSHOT_SCHEMA_VERSION,
    throughGlobalSequence: projection.throughGlobalSequence,
    thread: projection.thread,
    members: projection.members,
    membershipReconciliations: projection.membershipReconciliations,
    tasks: projection.tasks,
    memberCreations: projection.memberCreations ?? [],
    messages,
    messageDeliveries: projection.messageDeliveries,
    turns: projection.turns,
    agentRuns: projection.agentRuns,
    executionEvidence: projection.executionEvidence,
    agentRunFileChanges: projection.agentRunFileChanges,
    agentRunImages: projection.agentRunImages ?? [],
    contextManifests: [],
    approvals: projection.approvals,
    actions: [],
    timeline: [],
    openCoverage: {
      ...projection.coverage,
      messages: {
        ...projection.coverage.messages,
        loadedCount,
        totalCount,
        omittedCount,
        complete: omittedCount === 0,
        hasEarlier: omittedCount > 0,
        oldestLoadedSequence: messages[0]?.sequence ?? null,
        newestLoadedSequence: messages.at(-1)?.sequence ?? null
      }
    }
  }
}

export function optimisticThreadMessage(
  snapshot: ThreadSnapshot | null,
  commandId: string,
  draft: ThreadComposerDraftView,
  createdAt = new Date().toISOString()
): ThreadMessageView {
  const defaultLeadId = snapshot?.members.find((member) => member.isDefaultLead)?.agentId
  const explicitlyMentionedIds = [...new Set(draft.content.segments.flatMap((segment) =>
    segment.kind === 'atom' && segment.atom.type === 'member'
      ? [segment.atom.agentId]
      : []
  ))]
  const broadcast = draft.content.segments.some((segment) =>
    segment.kind === 'atom' && segment.atom.type === 'all_members'
  )
  const addressedAgentIds = broadcast
    ? snapshot?.members
        .filter((member) => member.membershipStatus === 'active' && member.profilePresence === 'present')
        .map((member) => member.agentId) ?? []
    : explicitlyMentionedIds.length > 0
      ? explicitlyMentionedIds
      : defaultLeadId ? [defaultLeadId] : []
  const sequence = Math.max(0, ...(snapshot?.messages.map((message) => message.sequence) ?? [])) + 1
  return {
    id: `optimistic:${commandId}`,
    sequence,
    timelineGlobalSequence: null,
    authorType: 'user',
    authorId: 'local_user',
    sourceAgentRunId: null,
    quotes: draft.quotes,
    body: draft.body,
    content: composerDocumentToStructuredContent(draft.content),
    attachments: draft.attachments,
    addressMode: broadcast ? 'broadcast' : explicitlyMentionedIds.length > 0 ? 'explicit' : 'default',
    addressedAgentIds,
    replyToThreadMessageId: draft.replyIntent?.replyToThreadMessageId ?? null,
    threadTurnId: null,
    presentation: null,
    createdAt,
    withdrawn: false,
    canWithdraw: false,
    version: 1
  }
}

export function campMessageSendParams(
  commandId: string,
  threadId: string,
  draft: ThreadComposerDraftView
): {
  commandId: string
  threadId: string
  content: ThreadComposerDraftView['content']
  sourceAttachments: Array<{
    id: string
    sourcePath: string
    displayName: string
    kind: 'file' | 'directory'
    mediaType: string | null
    observedByteSize: number | null
  }>
  quotes: ThreadComposerDraftView['quotes']
  replyToThreadMessageId: string | null
  execution: {
    taskId: null
    purpose: string
    completionRole: 'required'
  }
} {
  const sourceAttachments = draft.attachments.map((attachment) => {
    if (!attachment.sourcePath) throw new Error(uiAttribute('本地附件来源已不可用，请移除后重新添加。'))
    return {
      id: attachment.id,
      sourcePath: attachment.sourcePath,
      displayName: attachment.displayName,
      kind: attachment.kind,
      mediaType: attachment.mediaType,
      observedByteSize: attachment.byteSize
    }
  })
  return {
    commandId,
    threadId,
    content: draft.content,
    sourceAttachments,
    quotes: draft.quotes,
    replyToThreadMessageId: draft.replyIntent?.replyToThreadMessageId ?? null,
    execution: {
      taskId: null,
      purpose: campMessageExecutionPurpose(draft),
      completionRole: 'required'
    }
  }
}

export function campMessageExecutionPurpose(draft: ThreadComposerDraftView): string {
  return draft.body.trim() || 'Thread attachment-only message'
}

export function commandFailureMessage(result: StoredCommandResult): string {
  if (result.code === 'reply_recipient_required') {
    return uiAttribute("原作者当前不可接收，请选择其他成员。")
  }
  if (result.code === 'mention_target_unavailable') {
    return uiAttribute("消息未发送：一位收件人当前不可接收，请重新选择。")
  }
  if (result.code === 'camp_message.invalid_reply') {
    return uiAttribute("消息未发送：引用的消息当前不可用。请取消引用后重试。")
  }
  if (
    result.code === 'camp_message.no_addressable_member'
    || result.code === 'camp.default_lead_invariant'
    || result.code === 'camp.no_present_members'
  ) {
    return uiAttribute("当前无可用队员。")
  }
  if (result.code === 'agent_run.runtime_not_ready') {
    return uiAttribute("目标队员的智能体暂不可用。")
  }
  if (result.code === 'camp.last_member_required') {
    return uiAttribute("会话至少保留 1 位队员。")
  }
  if (membershipConflictCode(result.code)) {
    return uiAttribute("名册已发生变化。请重新读取最新状态后再试。")
  }
  return localizeExecutionEngineTerms(stringField(result.payload, 'message') ?? uiAttribute("操作未完成：{0}", String(result.code)))
}

export function membershipConflictCode(code: string): boolean {
  return code === 'camp.membership_generation_conflict'
    || code === 'camp.membership_version_conflict'
    || code === 'camp.member_not_found'
    || code === 'camp.member_not_active'
}

export function runtimeRecoveryFromCommandResult(
  threadId: string,
  result: StoredCommandResult
): ThreadRuntimeRecovery | null {
  if (result.status !== 'rejected' || result.code !== 'agent_run.runtime_not_ready') return null
  const agentId = stringField(result.payload, 'agentId')
  const blockerCode = stringField(result.payload, 'blockerCode')
  if (!agentId || !blockerCode) return null
  return {
    threadId,
    targets: [{ agentId, blockerCode }]
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === 'string' ? value[key] as string : null
}

export function stringArrayField(value: Record<string, unknown>, key: string): string[] {
  return Array.isArray(value[key])
    ? value[key].filter((entry): entry is string => typeof entry === 'string')
    : []
}

export function errorMessage(error: unknown): string {
  return localizeExecutionEngineTerms(readErrorMessage(error))
}
