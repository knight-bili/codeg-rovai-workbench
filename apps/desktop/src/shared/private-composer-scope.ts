import type { RovaiApi, ScopedSingleChatSnapshot, SingleChatComposerScope } from '@contracts'

/** 只核对服务端能力与精确归属，不登记草稿或发送输入。 */
export function matchesPrivateComposerScope(
  value: unknown,
  threadId: string,
  conversationId: string,
  scope: SingleChatComposerScope | null
): value is ScopedSingleChatSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<ScopedSingleChatSnapshot>
  const draft = snapshot.draft
  if (snapshot.conversation?.id !== conversationId || snapshot.conversation.threadId !== threadId
    || draft?.scopeVersion !== 1) return false
  if (scope === null) return draft.composerScope === null && draft.scopeKey === ''
  const actual = draft.composerScope
  return actual?.kind === 'canvas' && actual.boardId === scope.boardId && actual.nodeId === scope.nodeId
    && draft.scopeKey === `canvas:${scope.boardId}:${scope.nodeId}`
}

export async function readScopedPrivateChat(
  api: Pick<RovaiApi, 'request'>,
  threadId: string,
  conversationId: string,
  scope: SingleChatComposerScope | null
): Promise<ScopedSingleChatSnapshot | null> {
  const frozen = scope === null ? null : { kind: 'canvas' as const, boardId: scope.boardId, nodeId: scope.nodeId }
  const value = await api.request<unknown>('singleChat.get', { conversationId, composerScope: frozen })
  if (value === null) return null
  if (!matchesPrivateComposerScope(value, threadId, conversationId, frozen)) {
    throw new Error('single_chat.scope_capability_required')
  }
  return value
}
