import { expect, it, vi } from 'vitest'
import type { CanvasNode, MissionRecord, SingleChatSnapshot, ThreadSnapshot } from '@contracts'
import { canvasConversationGeometry, canvasConversationMatches, canvasMissionForThread, canvasMutationRemovesConversation, readCanvasConversation, type CanvasConversationTarget } from './canvas-conversation'

const reference = { threadId: 'thread', conversationId: 'private-a' }
const target: CanvasConversationTarget = { boardId: 'board', nodeId: 'pin', reference, presentation: 'inline' }
const thread = { thread: { id: 'thread' }, marker: 'authoritative' } as unknown as ThreadSnapshot & { marker: string }
const privateSnapshot = { conversation: { id: 'private-a', threadId: 'thread', agentId: 'agent', status: 'active' } } as SingleChatSnapshot
const node = { boardId: 'board', id: 'pin', data: { kind: 'conversation', conversation: reference } } as CanvasNode

it('exposes Mission actions only when both current projections agree on exact Thread and Mission identities', () => {
  const snapshot = { ...thread, thread: { ...thread.thread, missionId: 'mission-a' } }, mission = { missionId: 'mission-a', threadId: 'thread' } as MissionRecord
  expect(canvasMissionForThread(snapshot, mission)).toBe(mission)
  expect(canvasMissionForThread(snapshot, null)).toBeNull()
  expect(canvasMissionForThread(null, mission)).toBeNull()
  expect(canvasMissionForThread(thread, mission)).toBeNull()
  expect(canvasMissionForThread(snapshot, { ...mission, threadId: 'other' })).toBeNull()
  expect(canvasMissionForThread(snapshot, { ...mission, missionId: 'mission-b' })).toBeNull()
})

it('reads public references without private RPC and returns the original authoritative projection', async () => {
  const readPrivate = vi.fn(), readThread = vi.fn(async () => thread)
  const result = await readCanvasConversation({ threadId: 'thread', conversationId: null }, readPrivate, readThread, () => true)
  expect(readPrivate).not.toHaveBeenCalled()
  expect(readThread).toHaveBeenCalledExactlyOnceWith('thread')
  expect(result?.snapshot).toBe(thread)
  expect(result?.snapshot.marker).toBe('authoritative')
  expect(result?.conversation).toBeNull()
})

it('freezes the exact private reference before awaiting and never substitutes another conversation', async () => {
  const mutable = { ...reference }
  const readPrivate = vi.fn(async (id: string) => { mutable.threadId = 'other'; mutable.conversationId = 'private-b'; expect(id).toBe('private-a'); return privateSnapshot })
  const readThread = vi.fn(async () => thread)
  const result = await readCanvasConversation(mutable, readPrivate, readThread, () => true)
  expect(result?.conversation).toBe(privateSnapshot.conversation)
  expect(readThread).toHaveBeenCalledExactlyOnceWith('thread')
})

it('rejects absent, ended, foreign-Thread or substituted private reads before loading a public workspace', async () => {
  const readThread = vi.fn(async () => thread)
  for (const value of [null, { conversation: { ...privateSnapshot.conversation, status: 'ended' } },
    { conversation: { ...privateSnapshot.conversation, threadId: 'other' } }, { conversation: { ...privateSnapshot.conversation, id: 'private-b' } }]) {
    await expect(readCanvasConversation(reference, async () => value as SingleChatSnapshot | null, readThread, () => true)).rejects.toThrow()
  }
  expect(readThread).not.toHaveBeenCalled()
})

it('fences stale owners before reading and after either asynchronous read', async () => {
  const readPrivate = vi.fn(async () => privateSnapshot), readThread = vi.fn(async () => thread)
  expect(await readCanvasConversation(reference, readPrivate, readThread, () => false)).toBeNull()
  expect(readPrivate).not.toHaveBeenCalled()
  let current = true
  expect(await readCanvasConversation(reference, async () => { current = false; return privateSnapshot }, readThread, () => current)).toBeNull()
  expect(readThread).not.toHaveBeenCalled()
  current = true
  expect(await readCanvasConversation(reference, readPrivate, async () => { current = false; return thread }, () => current)).toBeNull()
})

it('propagates transport failures and rejects a mismatched Thread instead of committing a partial selection', async () => {
  const failure = new Error('read unavailable')
  await expect(readCanvasConversation(reference, async () => { throw failure }, async () => thread, () => true)).rejects.toBe(failure)
  await expect(readCanvasConversation(reference, async () => privateSnapshot, async () => ({ thread: { id: 'other' } } as ThreadSnapshot), () => true)).rejects.toThrow()
})

it('matches board, real node and exact public/private identity and protects destructive mutations only', () => {
  expect(canvasConversationMatches(node, target)).toBe(true)
  for (const other of [{ ...target, nodeId: 'mirror' }, { ...target, boardId: 'foreign' }, { ...target, reference: { threadId: 'thread', conversationId: null } }]) {
    expect(canvasConversationMatches(node, other)).toBe(false)
  }
  expect(canvasMutationRemovesConversation({ type: 'delete', nodeIds: ['pin'] }, target)).toBe(true)
  expect(canvasMutationRemovesConversation({ type: 'group', targetNodeId: 'region', newRegion: null, conversations: [reference], consumeNodeIds: ['pin'] }, target)).toBe(true)
  expect(canvasMutationRemovesConversation({ type: 'move', moves: [{ nodeId: 'pin', x: 20, y: 30 }] }, target)).toBe(false)
  expect(canvasMutationRemovesConversation({ type: 'update', nodeId: 'pin', patch: { width: 600 } }, target)).toBe(false)
  expect(canvasMutationRemovesConversation({ type: 'delete', nodeIds: ['mirror'] }, target)).toBe(false)
})

it('keeps drawer screen position and size independent of pan/zoom, and inline geometry follows a moving real node', () => {
  const stage = { width: 1200, height: 720 }
  for (const viewport of [{ x: 0, y: 0, zoom: 1 }, { x: -230, y: 77, zoom: 0.25 }, { x: 200, y: -99, zoom: 2 }]) {
    const geometry = canvasConversationGeometry(null, viewport, stage)
    expect(geometry.left * viewport.zoom + viewport.x).toBe(428)
    expect(geometry.top * viewport.zoom + viewport.y).toBe(12)
    expect(geometry.width).toBe(760)
    expect(geometry.height).toBe(696)
    expect(geometry.transform).toBe(`scale(${1 / viewport.zoom})`)
  }
  expect(canvasConversationGeometry({ x: -20, y: 40, width: 224, height: 132 }, { x: 1, y: 2, zoom: 1 }, stage))
    .toEqual({ left: -20, top: 76, width: 520, height: 524 })
  expect(canvasConversationGeometry({ x: 90, y: 120, width: 700, height: 800 }, { x: 1, y: 2, zoom: 1 }, stage))
    .toEqual({ left: 90, top: 156, width: 700, height: 764 })
})
