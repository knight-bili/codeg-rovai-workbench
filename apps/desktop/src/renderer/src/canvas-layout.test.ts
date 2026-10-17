import { describe, expect, it } from 'vitest'
import type { CanvasConversationRef } from '@contracts'
import { CARD_WIDTH, CARD_HEIGHT, REGION_HEADER_HEIGHT, REGION_PADDING, CARD_GAP, BOARD_DOT_GAP,
  regionWidthForColumns, regionHeightForRows, columnsForRegionWidth, rowsForRegionHeight, effectiveColumns,
  visibleMemberCap, layoutRegionGrid, computeDropHint, computeAlignment, packLayout, canvasMemberKey,
  canvasReferenceKey, sameCanvasReference, basePathName, isRegionKind } from './canvas-layout'

const reference: CanvasConversationRef = { threadId: 'thread-with-uuid-dashes', conversationId: null }
describe('Source canvas geometry on Core identities', () => {
  it('keeps board-unit footprints and pinned grids independent of rendered app text zoom', () => {
    expect([CARD_WIDTH, CARD_HEIGHT]).toEqual([224, 132])
    for (const n of [1, 2, 12]) {
      expect(columnsForRegionWidth(regionWidthForColumns(n))).toBe(n)
      expect(rowsForRegionHeight(regionHeightForRows(n))).toBe(n)
    }
    expect(effectiveColumns({ gridColumns: 2 }, 2000)).toBe(2)
    expect(visibleMemberCap({ gridRows: 3 }, 2)).toBe(6)
    expect(visibleMemberCap({ gridRows: 0 }, 2)).toBe(24)
    expect(layoutRegionGrid(3, 100, 2)).toEqual({ columns: 2, positions: [
      { x: 12, y: 52 }, { x: 12 + CARD_WIDTH + CARD_GAP, y: 52 }, { x: 12, y: 52 + CARD_HEIGHT + CARD_GAP }
    ], contentHeight: regionHeightForRows(2) })
    expect(layoutRegionGrid(0, 0).contentHeight).toBe(64)
    expect(layoutRegionGrid(1, 0).columns).toBe(1)
  })
  it('uses actual paint order for overlap, gives regions priority and never merges the same exact conversation', () => {
    const box = { x: 0, y: 0, width: 500, height: 300 }
    const source = { kind: 'pin' as const, nodeId: 'pin', conversation: reference }
    const a = { ...box, nodeId: 'z-uuid', kind: 'custom' as const }, b = { ...box, nodeId: 'a-uuid', kind: 'custom' as const }
    expect(computeDropHint(source, { x: 0, y: 0 }, [a, b], [])).toEqual({ type: 'region', regionId: 'a-uuid' })
    expect(computeDropHint({ kind: 'member', regionId: 'a-uuid', conversation: reference }, { x: 0, y: 0 }, [b], [])).toEqual({ type: 'same' })
    const pin = { ...box, nodeId: 'stationary', conversation: { ...reference, conversationId: 'private' } }
    expect(computeDropHint(source, { x: 0, y: 0 }, [{ ...a, kind: 'folder' }], [pin])).toEqual({ type: 'canvas', x: 0, y: 0 })
    expect(computeDropHint(source, { x: 0, y: 0 }, [], [{ ...pin, conversation: reference }])).toEqual({ type: 'canvas', x: 0, y: 0 })
    expect(computeDropHint(source, { x: 0, y: 0 }, [], [pin])).toEqual({ type: 'merge', targetNodeId: pin.nodeId,
      targetConversation: pin.conversation, rect: { x: -REGION_PADDING, y: -REGION_HEADER_HEIGHT - REGION_PADDING,
        width: regionWidthForColumns(2), height: regionHeightForRows(1) } })
    expect(sameCanvasReference(reference, pin.conversation)).toBe(false)
    expect(canvasReferenceKey(reference)).not.toBe(canvasReferenceKey(pin.conversation))
    expect(canvasMemberKey('a:b', reference)).not.toBe(canvasMemberKey('a', { threadId: 'b:' + reference.threadId, conversationId: null }))
  })
  it('aligns each axis to the closest edge or centre, using the lattice only as a capped fallback', () => {
    const moving = { x: 7, y: 23, width: 100, height: 80 }
    const aligned = computeAlignment(moving, [{ x: 10, y: 300, width: 100, height: 40 }, { x: 500, y: 21, width: 20, height: 80 }], 6)
    expect([aligned.dx, aligned.dy]).toEqual([3, -2])
    expect(aligned.guides).toEqual([{ axis: 'x', at: 10, from: 21, to: 340 }, { axis: 'y', at: 21, from: 10, to: 520 }])
    for (const tolerance of [0, -1, NaN]) expect(computeAlignment(moving, [{ ...moving, x: 10 }], tolerance).guides).toEqual([])
    expect(computeAlignment(moving, [], 100, BOARD_DOT_GAP)).toEqual({ dx: 0, dy: 1, guides: [] })
    expect(computeAlignment(moving, [], 6, BOARD_DOT_GAP)).toEqual({ dx: 0, dy: 1, guides: [] })
  })
  it('packs rendered expanded footprints and stable UUID ties, preserving inputs and emitting only changed rows', () => {
    const nodes = [{ id: 'b', x: 5, y: 5, width: 224, height: 132 }, { id: 'a', x: 0, y: 0, width: 224, height: 132 }]
    const before = structuredClone(nodes)
    const sizes = new Map([['a', { width: 520, height: 560 }]])
    expect(packLayout(nodes, sizes, { rowWidth: 700 })).toEqual([{ nodeId: 'b', x: 0, y: 608 }])
    expect(nodes).toEqual(before)
    expect(packLayout(nodes, new Map(), { rowWidth: 1000 })).toEqual([{ nodeId: 'b', x: 272, y: 0 }])
    expect(basePathName('C:\\工作\\file.ts\\')).toBe('file.ts')
    expect(basePathName('/')).toBe('/')
    expect(['folder', 'group', 'agent', 'custom'].every(value => isRegionKind(value as 'folder'))).toBe(true)
    expect(isRegionKind('file')).toBe(false); expect(isRegionKind('terminal')).toBe(false)
  })
})
