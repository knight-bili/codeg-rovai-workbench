// Interaction adapted from Codeg aff1e6c278453ed8d0b96a5f664edcdca621aa3f
// canvas-conversation-surface.tsx / canvas-conversation-drawer.tsx (Apache-2.0).
// Conversation, draft and Runtime authority remain in Rovai's existing workspace.
import type { CanvasConversationRef, CanvasNode, CanvasNodeMutation, MissionRecord, SingleChatSnapshot, ThreadSnapshot } from '@contracts'
import { canvasReferenceKey, DETAIL_CARD_HEIGHT, DETAIL_CARD_WIDTH, type CanvasRect, type CanvasSize } from './canvas-layout'
import { uiAttribute } from './interface-language'
import type { CanvasComposerContext } from './canvas-composer-drafts'

/** Both current projections must identify the same Mission; a cached title or Thread alone is insufficient. */
export function canvasMissionForThread(snapshot: ThreadSnapshot | null, mission: MissionRecord | null | undefined): MissionRecord | null {
  return snapshot && mission && snapshot.thread.id === mission.threadId && snapshot.thread.missionId === mission.missionId ? mission : null
}

export interface CanvasConversationTarget {
  boardId: string
  nodeId: string
  reference: CanvasConversationRef
  presentation: 'inline' | 'drawer'
  draftContext?: CanvasComposerContext
}

// All modes share one portal child. Moving or changing modes must not unmount the Composer.
export function canvasConversationGeometry(node: CanvasRect | null, viewport: { x: number; y: number; zoom: number }, stage: CanvasSize): {
  left: number; top: number; width: number; height: number; transform?: string
} {
  if (node) return { left: node.x, top: node.y + 36, width: Math.max(DETAIL_CARD_WIDTH, node.width), height: Math.max(DETAIL_CARD_HEIGHT, node.height) - 36 }
  const width = Math.min(760, Math.max(280, stage.width - 24))
  return { left: (Math.max(12, stage.width - width - 12) - viewport.x) / viewport.zoom,
    top: (12 - viewport.y) / viewport.zoom, width, height: Math.max(240, stage.height - 24), transform: `scale(${1 / viewport.zoom})` }
}

export function canvasConversationMatches(node: CanvasNode, target: CanvasConversationTarget): boolean {
  return node.boardId === target.boardId && node.id === target.nodeId && node.data.kind === 'conversation'
    && !node.data.objectReference
    && Boolean(node.data.conversation && canvasReferenceKey(node.data.conversation) === canvasReferenceKey(target.reference))
}

export function canvasMutationRemovesConversation(mutation: CanvasNodeMutation, target: CanvasConversationTarget): boolean {
  return mutation.type === 'delete' ? mutation.nodeIds.includes(target.nodeId)
    : mutation.type === 'group' ? mutation.consumeNodeIds.includes(target.nodeId) : false
}

// No fallback to the latest private conversation, no singleChat.open, and no native session creation.
export async function readCanvasConversation<T extends ThreadSnapshot>(
  reference: CanvasConversationRef,
  readPrivate: (conversationId: string) => Promise<SingleChatSnapshot | null>,
  readThread: (threadId: string) => Promise<T>,
  isCurrent: () => boolean
): Promise<{ snapshot: T; conversation: SingleChatSnapshot['conversation'] | null } | null> {
  const frozen = { ...reference }
  if (!isCurrent()) return null
  let conversation: SingleChatSnapshot['conversation'] | null = null
  if (frozen.conversationId) {
    const result = await readPrivate(frozen.conversationId)
    if (!isCurrent()) return null
    conversation = result?.conversation ?? null
    if (!conversation || conversation.id !== frozen.conversationId || conversation.threadId !== frozen.threadId || conversation.status !== 'active') {
      throw new Error(uiAttribute('这段单聊已结束或不可用。'))
    }
  }
  const snapshot = await readThread(frozen.threadId)
  if (!isCurrent()) return null
  if (snapshot.thread.id !== frozen.threadId) throw new Error(uiAttribute('对话读取结果与所选引用不一致。'))
  return { snapshot, conversation }
}
