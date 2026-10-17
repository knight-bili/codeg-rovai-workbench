// Adapted from Codeg aff1e6c278453ed8d0b96a5f664edcdca621aa3f canvas-model.ts.
// Apache-2.0: integration/licenses/codeg/LICENSE. Geometry uses board units, never rem/app text zoom.
import type { CanvasConversationRef, CanvasNode, CanvasNodeData, CanvasNodeKind, CanvasNodeMove } from '@contracts'

export const CARD_WIDTH = 224, CARD_HEIGHT = 132
export const REGION_HEADER_HEIGHT = 40, REGION_PADDING = 12, CARD_GAP = 12
export const REGION_COLLAPSED_HEIGHT = 40, REGION_FOOTER_HEIGHT = 36, BOARD_DOT_GAP = 24
export const DETAIL_CARD_WIDTH = 520, DETAIL_CARD_HEIGHT = 560
export const FILE_CARD_WIDTH = 460, FILE_CARD_HEIGHT = 360, FILE_CARD_MIN_WIDTH = 240, FILE_CARD_MIN_HEIGHT = 160
export const TERMINAL_CARD_WIDTH = 480, TERMINAL_CARD_HEIGHT = 300, TERMINAL_CARD_MIN_WIDTH = 260, TERMINAL_CARD_MIN_HEIGHT = 140
export const MAX_VISIBLE_MEMBERS = 24
export interface CanvasRect { x: number; y: number; width: number; height: number }
export interface CanvasSize { width: number; height: number }
export interface CanvasLayoutItem extends CanvasRect { id: string }
export interface RegionRect extends CanvasRect { nodeId: string; kind: CanvasNodeKind }
export interface PinRect extends CanvasRect { nodeId: string; conversation: CanvasConversationRef }
export interface AlignmentGuide { axis: 'x' | 'y'; at: number; from: number; to: number }
export interface AlignmentResult { dx: number; dy: number; guides: AlignmentGuide[] }
export type CanvasDragSource = { kind: 'member'; regionId: string; conversation: CanvasConversationRef }
  | { kind: 'pin'; nodeId: string; conversation: CanvasConversationRef }
export type CanvasDropHint = { type: 'canvas'; x: number; y: number } | { type: 'same' }
  | { type: 'region'; regionId: string }
  | { type: 'merge'; targetNodeId: string; targetConversation: CanvasConversationRef; rect: CanvasRect }

export function canvasReferenceKey(reference: CanvasConversationRef): string {
  return JSON.stringify([reference.threadId, reference.conversationId ?? null])
}
export function sameCanvasReference(a: CanvasConversationRef, b: CanvasConversationRef): boolean {
  return a.threadId === b.threadId && (a.conversationId ?? null) === (b.conversationId ?? null)
}
/** Derived member IDs never become persisted node IDs. JSON tuples avoid UUID/separator collisions. */
export function canvasMemberKey(regionId: string, reference: CanvasConversationRef): string {
  const tuple = JSON.stringify([regionId, reference.threadId, reference.conversationId ?? null])
  return `member:${encodeURIComponent(tuple).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16)}`)}`
}
export function regionWidthForColumns(columns: number): number {
  const n = Math.max(1, Math.round(columns))
  return REGION_PADDING * 2 + n * CARD_WIDTH + (n - 1) * CARD_GAP
}
export function regionHeightForRows(rows: number): number {
  const n = Math.max(1, Math.round(rows))
  return REGION_HEADER_HEIGHT + REGION_PADDING * 2 + n * CARD_HEIGHT + (n - 1) * CARD_GAP
}
export function columnsForRegionWidth(width: number): number {
  return Math.max(1, Math.floor((Math.max(width - REGION_PADDING * 2, CARD_WIDTH) + CARD_GAP) / (CARD_WIDTH + CARD_GAP)))
}
export function rowsForRegionHeight(height: number): number {
  return Math.max(1, Math.floor((Math.max(height - REGION_HEADER_HEIGHT - REGION_PADDING * 2, CARD_HEIGHT) + CARD_GAP) / (CARD_HEIGHT + CARD_GAP)))
}
export function effectiveColumns(data: Pick<CanvasNodeData, 'gridColumns'>, width: number): number {
  return data.gridColumns > 0 ? data.gridColumns : columnsForRegionWidth(width)
}
export function visibleMemberCap(data: Pick<CanvasNodeData, 'gridRows'>, columns: number): number {
  return data.gridRows > 0 ? data.gridRows * columns : MAX_VISIBLE_MEMBERS
}
export function layoutRegionGrid(count: number, width: number, pinnedColumns = 0) {
  const columns = pinnedColumns > 0 ? Math.round(pinnedColumns) : columnsForRegionWidth(width)
  const positions = Array.from({ length: count }, (_, index) => ({
    x: REGION_PADDING + index % columns * (CARD_WIDTH + CARD_GAP),
    y: REGION_HEADER_HEIGHT + REGION_PADDING + Math.floor(index / columns) * (CARD_HEIGHT + CARD_GAP)
  }))
  const rows = Math.ceil(count / columns)
  const contentHeight = rows === 0 ? REGION_COLLAPSED_HEIGHT + REGION_PADDING * 2
    : REGION_HEADER_HEIGHT + REGION_PADDING * 2 + rows * CARD_HEIGHT + (rows - 1) * CARD_GAP
  return { columns, positions, contentHeight }
}

/** Arrays are in actual paint order. Core UUIDs have no numeric stacking meaning. */
export function computeDropHint(source: CanvasDragSource, position: Pick<CanvasRect, 'x' | 'y'>,
  regions: readonly RegionRect[], pins: readonly PinRect[]): CanvasDropHint {
  const cx = position.x + CARD_WIDTH / 2, cy = position.y + CARD_HEIGHT / 2
  const hits = (rect: CanvasRect) => cx >= rect.x && cx <= rect.x + rect.width && cy >= rect.y && cy <= rect.y + rect.height
  const region = regions.findLast(hits)
  if (region) {
    if (source.kind === 'member' && region.nodeId === source.regionId) return { type: 'same' }
    if (region.kind === 'custom') return { type: 'region', regionId: region.nodeId }
    return { type: 'canvas', ...position }
  }
  const pin = pins.findLast(item => !(source.kind === 'pin' && item.nodeId === source.nodeId)
    && !sameCanvasReference(item.conversation, source.conversation) && hits(item))
  if (!pin) return { type: 'canvas', ...position }
  return { type: 'merge', targetNodeId: pin.nodeId, targetConversation: pin.conversation,
    rect: { x: pin.x - REGION_PADDING, y: pin.y - REGION_HEADER_HEIGHT - REGION_PADDING,
      width: regionWidthForColumns(2), height: regionHeightForRows(1) } }
}

export function computeAlignment(moving: CanvasRect, others: readonly CanvasRect[], tolerance: number, gridGap?: number): AlignmentResult {
  if (!(tolerance > 0)) return { dx: 0, dy: 0, guides: [] }
  const edges = (rect: CanvasRect, axis: 'x' | 'y') => {
    const size = axis === 'x' ? rect.width : rect.height
    return [rect[axis], rect[axis] + size / 2, rect[axis] + size]
  }
  const closest = (axis: 'x' | 'y') => {
    let best: { delta: number; at: number; other: CanvasRect } | null = null
    for (const other of others) for (const from of edges(moving, axis)) for (const to of edges(other, axis)) {
      const delta = to - from
      if (Math.abs(delta) <= tolerance && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, at: to, other }
    }
    return best
  }
  const snapToLattice = (value: number) => {
    if (!(gridGap && gridGap > 0)) return 0
    const delta = Math.round(value / gridGap) * gridGap - value
    return Math.abs(delta) <= Math.min(tolerance, gridGap / 4) ? delta : 0
  }
  const bestX = closest('x'), bestY = closest('y')
  const dx = bestX?.delta ?? snapToLattice(moving.x), dy = bestY?.delta ?? snapToLattice(moving.y)
  const guides: AlignmentGuide[] = []
  if (bestX) guides.push({ axis: 'x', at: bestX.at, from: Math.min(moving.y + dy, bestX.other.y),
    to: Math.max(moving.y + dy + moving.height, bestX.other.y + bestX.other.height) })
  if (bestY) guides.push({ axis: 'y', at: bestY.at, from: Math.min(moving.x + dx, bestY.other.x),
    to: Math.max(moving.x + dx + moving.width, bestY.other.x + bestY.other.width) })
  return { dx, dy, guides }
}

/** Rendered footprints include expanded cards and pinned grid shapes. Stored size is only a fallback. */
export function packLayout(nodes: readonly CanvasLayoutItem[], renderedSizes: ReadonlyMap<string, CanvasSize>,
  options: { gap?: number; rowWidth?: number } = {}): CanvasNodeMove[] {
  const gap = options.gap ?? 48, rowWidth = options.rowWidth ?? 2400
  const sizeOf = (node: CanvasLayoutItem): CanvasSize => renderedSizes.get(node.id) ?? node
  const sorted = [...nodes].sort((a, b) => sizeOf(b).height - sizeOf(a).height || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const moves: CanvasNodeMove[] = []
  let x = 0, y = 0, shelfHeight = 0
  for (const node of sorted) {
    const { width, height } = sizeOf(node)
    if (x > 0 && x + width > rowWidth) { y += shelfHeight + gap; x = 0; shelfHeight = 0 }
    if (node.x !== x || node.y !== y) moves.push({ nodeId: node.id, x, y })
    x += width + gap; shelfHeight = Math.max(shelfHeight, height)
  }
  return moves
}
export function basePathName(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return (index >= 0 ? trimmed.slice(index + 1) : trimmed) || value
}
export function isRegionKind(kind: CanvasNodeKind): boolean {
  return kind === 'folder' || kind === 'group' || kind === 'agent' || kind === 'custom'
}
export function noteHoldsProse(node: CanvasNode | undefined): boolean {
  return node?.data.kind === 'note' && Boolean(node.data.content?.trim())
}
