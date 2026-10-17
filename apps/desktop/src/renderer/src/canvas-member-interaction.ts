import type { CanvasConversationRef, CanvasNodeMutation } from '@contracts'
import { canvasReferenceKey, regionWidthForColumns, regionHeightForRows, type CanvasDragSource, type CanvasDropHint } from './canvas-layout'

// Adapted from Codeg aff1e6c278453ed8d0b96a5f664edcdca621aa3f canvas-view.tsx applyDrop/selection.
// Apache-2.0 source license is retained at integration/licenses/codeg/LICENSE.

export type CanvasConversationSelection = { conversation: CanvasConversationRef; x: number; y: number; nodeId?: string; regionId?: string }

export function canvasMemberMutationSupported(mutation: CanvasNodeMutation, memberTransferVersion?: number): boolean {
  return mutation.type !== 'group' || !mutation.sourceMembers?.length || memberTransferVersion === 1
}

/** Codeg member cards are presentation references, not persisted node IDs or business moves. */
export function canvasDropMutation(source: CanvasDragSource, hint: CanvasDropHint): CanvasNodeMutation | null {
  if (hint.type === 'same') return null
  if (hint.type === 'canvas') return source.kind === 'member'
    ? { type: 'detach', regionId: source.regionId, conversation: source.conversation, x: hint.x, y: hint.y }
    : { type: 'move', moves: [{ nodeId: source.nodeId, x: hint.x, y: hint.y }] }
  const sourceMembers = source.kind === 'member' ? [{ regionId: source.regionId, conversation: source.conversation }] : []
  return { type: 'group', targetNodeId: hint.type === 'region' ? hint.regionId : null,
    newRegion: hint.type === 'merge' ? { kind: 'custom', ...hint.rect } : null,
    conversations: hint.type === 'merge' ? [hint.targetConversation, source.conversation] : [source.conversation],
    consumeNodeIds: [...(hint.type === 'merge' ? [hint.targetNodeId] : []), ...(source.kind === 'pin' ? [source.nodeId] : [])],
    ...(sourceMembers.length ? { sourceMembers } : {}) }
}

/** Pins and members from multiple custom/derived regions enter one atomic group intent; only pins are consumed. */
export function canvasGroupSelection(items: readonly CanvasConversationSelection[]): CanvasNodeMutation | null {
  if (!items.length) return null
  const conversations = [...new Map(items.map(item => [canvasReferenceKey(item.conversation), item.conversation])).values()]
  const sourceMembers = [...new Map(items.filter(item => item.regionId).map(item => [JSON.stringify([item.regionId, canvasReferenceKey(item.conversation)]),
    { regionId: item.regionId!, conversation: item.conversation }])).values()]
  if (conversations.length > 200 || sourceMembers.length > 200) return null
  return { type: 'group', targetNodeId: null, newRegion: { kind: 'custom', x: Math.min(...items.map(item => item.x)) - 12,
    y: Math.min(...items.map(item => item.y)) - 52, width: regionWidthForColumns(2), height: regionHeightForRows(Math.ceil(conversations.length / 2)) }, conversations,
    consumeNodeIds: [...new Set(items.flatMap(item => item.nodeId ? [item.nodeId] : []))], ...(sourceMembers.length ? { sourceMembers } : {}) }
}

export function canvasAbsolutePosition<T extends { id: string; parentId?: string; position: { x: number; y: number } }>(node: T, nodes: readonly T[]) {
  const parent = node.parentId ? nodes.find(item => item.id === node.parentId) : undefined
  return parent ? { x: parent.position.x + node.position.x, y: parent.position.y + node.position.y } : node.position
}
