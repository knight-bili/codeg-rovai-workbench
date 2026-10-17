import { expect, it } from 'vitest'
import type { CanvasConversationRef } from '@contracts'
import { canvasAbsolutePosition, canvasDropMutation, canvasGroupSelection, canvasMemberMutationSupported } from './canvas-member-interaction'
import { computeDropHint, regionWidthForColumns, regionHeightForRows, canvasMemberKey } from './canvas-layout'

const publicRef: CanvasConversationRef = { threadId: 'thread-uuid', conversationId: null }
const privateRef: CanvasConversationRef = { threadId: 'thread-uuid', conversationId: 'private-uuid' }

it('moves a member to the canvas with one detach and never persists a derived member ID', () => {
  expect(canvasDropMutation({ kind: 'member', regionId: 'source-uuid', conversation: privateRef }, { type: 'canvas', x: -40, y: 17 }))
    .toEqual({ type: 'detach', regionId: 'source-uuid', conversation: privateRef, x: -40, y: 17 })
  expect(canvasDropMutation({ kind: 'member', regionId: 'source-uuid', conversation: publicRef }, { type: 'same' })).toBeNull()
})

it('transfers between custom regions and merges with a pin in one group intent carrying the exact source selector', () => {
  const source = { kind: 'member' as const, regionId: 'source-uuid', conversation: privateRef }
  expect(canvasDropMutation(source, { type: 'region', regionId: 'target-uuid' })).toEqual({ type: 'group', targetNodeId: 'target-uuid',
    newRegion: null, conversations: [privateRef], consumeNodeIds: [], sourceMembers: [{ regionId: 'source-uuid', conversation: privateRef }] })
  const merged = canvasDropMutation(source, { type: 'merge', targetNodeId: 'pin-uuid', targetConversation: publicRef, rect: { x: 0, y: 10, width: 480, height: 196 } })
  expect(merged).toMatchObject({ type: 'group', targetNodeId: null, newRegion: { kind: 'custom', x: 0, y: 10 },
    conversations: [publicRef, privateRef], consumeNodeIds: ['pin-uuid'], sourceMembers: [{ regionId: 'source-uuid', conversation: privateRef }] })
  expect(canvasMemberMutationSupported(merged!)).toBe(false)
  expect(canvasMemberMutationSupported(merged!, 1)).toBe(true)
  expect(canvasMemberMutationSupported(merged!, 2)).toBe(false)
})

it('keeps legacy pin mutations free of optional source fields and consumes only standalone pins', () => {
  const source = { kind: 'pin' as const, nodeId: 'pin-uuid', conversation: publicRef }
  expect(canvasDropMutation(source, { type: 'canvas', x: 8, y: 9 })).toEqual({ type: 'move', moves: [{ nodeId: 'pin-uuid', x: 8, y: 9 }] })
  expect(canvasDropMutation(source, { type: 'region', regionId: 'target-uuid' })).toEqual({ type: 'group', targetNodeId: 'target-uuid', newRegion: null,
    conversations: [publicRef], consumeNodeIds: ['pin-uuid'] })
  expect(canvasMemberMutationSupported(canvasDropMutation(source, { type: 'region', regionId: 'target-uuid' })!)).toBe(true)
})

it('uses real paint-order drop rules and never assigns a Thread to a folder or agent binding by dragging', () => {
  const source = { kind: 'member' as const, regionId: 'source-uuid', conversation: privateRef }
  const folder = { nodeId: 'folder-uuid', kind: 'folder' as const, x: 0, y: 0, width: 520, height: 560 }
  expect(canvasDropMutation(source, computeDropHint(source, { x: 10, y: 10 }, [folder], []))).toMatchObject({ type: 'detach' })
  expect(canvasDropMutation(source, computeDropHint(source, { x: 10, y: 10 }, [{ ...folder, kind: 'agent' }], []))).toMatchObject({ type: 'detach' })
})

it('groups mixed pins and multi-region members without collapsing private identity or removing unselected mirror instances', () => {
  const input = [
    { conversation: publicRef, nodeId: 'pin-uuid', x: 100, y: 80 },
    { conversation: publicRef, regionId: 'region-a', x: -20, y: 12 },
    { conversation: privateRef, regionId: 'region-b', x: 50, y: 90 },
    { conversation: publicRef, regionId: 'region-a', x: -20, y: 12 }
  ]
  const before = structuredClone(input), group = canvasGroupSelection(input)
  expect(group).toEqual({ type: 'group', targetNodeId: null, newRegion: { kind: 'custom', x: -32, y: -40,
    width: regionWidthForColumns(2), height: regionHeightForRows(1) }, conversations: [publicRef, privateRef], consumeNodeIds: ['pin-uuid'],
    sourceMembers: [{ regionId: 'region-a', conversation: publicRef }, { regionId: 'region-b', conversation: privateRef }] })
  expect(input).toEqual(before)
})

it('bounds custom-group intent by existing 200 reference/source-selector limits', () => {
  expect(canvasGroupSelection([])).toBeNull()
  expect(canvasGroupSelection(Array.from({ length: 201 }, (_, index) => ({ conversation: { threadId: `thread-${index}`, conversationId: null }, x: 0, y: 0 })))).toBeNull()
  expect(canvasGroupSelection(Array.from({ length: 201 }, (_, index) => ({ conversation: publicRef, regionId: `region-${index}`, x: 0, y: 0 })))).toBeNull()
  expect(canvasGroupSelection(Array.from({ length: 200 }, (_, index) => ({ conversation: publicRef, regionId: `region-${index}`, x: 0, y: 0 })))).toMatchObject({ type: 'group', conversations: [publicRef] })
})

it('converts relative member positions through the live parent without changing persisted parent data', () => {
  const parent = { id: 'region-uuid', position: { x: 500, y: -200 } }
  const child = { id: 'member-display-id', parentId: parent.id, position: { x: 12, y: 52 } }
  expect(canvasAbsolutePosition(child, [parent, child])).toEqual({ x: 512, y: -148 })
  expect(canvasAbsolutePosition(parent, [parent, child])).toEqual(parent.position)
  expect(canvasAbsolutePosition(child, [child])).toEqual(child.position)
  const displayId = canvasMemberKey('region:one', { threadId: 'a"b', conversationId: "c'd\\e" })
  expect(displayId).not.toMatch(/["'\\]/)
  expect(decodeURIComponent(displayId.slice('member:'.length))).toBe(JSON.stringify(['region:one', 'a"b', "c'd\\e"]))
})
