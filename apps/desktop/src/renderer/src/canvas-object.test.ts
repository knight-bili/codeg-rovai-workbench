import { expect, it, vi } from 'vitest'
import type { CanvasNode, MissionChangedFile, MissionRecord, RovaiApi, TaskView } from '@contracts'
import { canvasDiffFile, canvasObjectInvalidated, canvasObjectTarget, canvasPlainConversation, readCanvasDiffFiles, readCanvasObject, readCanvasTaskPage, type CanvasObjectTarget } from './canvas-object'
import { retainMissionDiffSession } from './mission-diff-session'
import { canvasConversationMatches } from './canvas-conversation'

const mission = { missionId: 'mission-original', threadId: 'thread', title: 'Original mission' } as MissionRecord
const task = { taskId: 'task-original', threadId: 'thread', title: 'Original task' } as TaskView
const api = (read: (...args: unknown[]) => Promise<unknown>) => ({ request: vi.fn(read) }) as unknown as Pick<RovaiApi, 'request'>
const target: CanvasObjectTarget = { threadId: 'thread', object: { kind: 'mission', missionId: mission.missionId } }

it('reads the exact Mission, Diff or Task ID without entering a Thread or starting a Runtime', async () => {
  for (const object of [target.object, { kind: 'mission_diff' as const, missionId: mission.missionId, path: ' 文档/变更.ts ' }, { kind: 'task' as const, taskId: task.taskId }]) {
    const client = api(async method => method === 'missions.delivery' ? { threadId: 'thread', workspace: null, git: false } : object.kind === 'task' ? task : mission)
    const result = await readCanvasObject(client, { threadId: 'thread', object }, () => true)
    expect(result?.kind).toBe(object.kind)
    expect(client.request).toHaveBeenCalledTimes(object.kind === 'mission_diff' ? 2 : 1)
    expect(client.request).toHaveBeenCalledWith(object.kind === 'task' ? 'tasks.get' : 'missions.get', object.kind === 'task'
      ? { threadId: 'thread', taskId: task.taskId } : { missionId: mission.missionId })
  }
})

it('uses current Mission workspace metadata for Diff and rejects mismatched delivery ownership', async () => {
  const object: CanvasObjectTarget = { ...target, object: { kind: 'mission_diff', missionId: mission.missionId } }
  const delivery = { threadId: 'thread', git: true, workspace: { missionId: mission.missionId, threadId: 'thread', baseSha: 'actual-base' } }
  const client = api(async method => method === 'missions.get' ? mission : delivery)
  expect(await readCanvasObject(client, object, () => true)).toEqual({ kind: 'mission_diff', mission, delivery })
  for (const wrong of [{ ...delivery, threadId: 'other' }, { ...delivery, workspace: { ...delivery.workspace, missionId: 'other' } }]) {
    await expect(readCanvasObject(api(async method => method === 'missions.get' ? mission : wrong), object, () => true)).rejects.toThrow('原对象')
  }
})

it('refuses missing, substituted or cross-Thread objects and never chooses a replacement', async () => {
  for (const value of [null, { ...mission, missionId: 'new-mission' }, { ...mission, threadId: 'other-thread' }]) {
    const client = api(async () => value)
    await expect(readCanvasObject(client, target, () => true)).rejects.toThrow('原对象')
    expect(client.request).toHaveBeenCalledTimes(1)
  }
  for (const value of [null, { ...task, taskId: 'other-task' }, { ...task, threadId: 'other-thread' }]) {
    await expect(readCanvasObject(api(async () => value), { threadId: 'thread', object: { kind: 'task', taskId: task.taskId } }, () => true)).rejects.toThrow('原对象')
  }
})

it('freezes the original ID and discards a late read after its surface has changed', async () => {
  let settle!: (value: MissionRecord) => void, current = true
  const client = api(() => new Promise<MissionRecord>(resolve => { settle = resolve }))
  const mutable: CanvasObjectTarget = { threadId: 'thread', object: { kind: 'mission', missionId: mission.missionId } }
  const pending = readCanvasObject(client, mutable, () => current)
  if (mutable.object.kind === 'mission') mutable.object.missionId = 'replacement'
  settle(mission)
  expect(await pending).toEqual({ kind: 'mission', mission })
  const late = readCanvasObject(client, target, () => current)
  current = false; settle(mission)
  expect(await late).toBeNull()
  expect(await readCanvasObject(client, target, () => false)).toBeNull()
  expect(client.request).toHaveBeenCalledTimes(2)
})

it('keeps business pins out of conversation matching, mirroring and member grouping inputs', () => {
  const node = { id: 'node', boardId: 'board', data: { kind: 'conversation', conversation: { threadId: 'thread', conversationId: null }, objectReference: target.object } } as CanvasNode
  expect(canvasPlainConversation(node)).toBeNull()
  expect(canvasObjectTarget(node)).toEqual(target)
  expect(canvasConversationMatches(node, { boardId: 'board', nodeId: 'node', reference: node.data.conversation!, presentation: 'inline' })).toBe(false)
  expect(canvasObjectTarget({ ...node, data: { ...node.data, conversation: { threadId: 'thread', conversationId: 'private' } } })).toBeNull()
  expect(canvasObjectTarget({ ...node, data: { ...node.data, kind: 'note' } })).toBeNull()
  const plain = { ...node, data: { ...node.data, objectReference: undefined } }
  expect(canvasPlainConversation(plain)).toEqual(node.data.conversation)
})

it('pages tasks in bounded reads and rejects stalled or malformed cursors', async () => {
  const page = { tasks: [{ taskId: task.taskId }], nextCursor: 'next', truncated: true }
  const client = api(async () => page)
  expect(await readCanvasTaskPage(client, 'thread', null)).toEqual(page)
  expect(client.request).toHaveBeenCalledWith('tasks.list', { threadId: 'thread', cursor: null, limit: 50 })
  for (const bad of [{ ...page, nextCursor: 'same' }, { ...page, nextCursor: null }, { ...page, tasks: [] }, { ...page, tasks: [page.tasks[0], page.tasks[0]] }, { ...page, tasks: Array.from({ length: 51 }, (_, index) => ({ taskId: String(index) })) }]) {
    await expect(readCanvasTaskPage(api(async () => bad), 'thread', 'same')).rejects.toThrow('任务分页')
  }
})

it('matches only an exact current path, preserving spaces and Unicode instead of falling back to another file', async () => {
  const original = { id: 'fresh-file-id', path: ' 文档/变更.ts ' } as MissionChangedFile
  const other = { id: 'other', path: '文档/变更.ts' } as MissionChangedFile
  expect(canvasDiffFile([other, original], original.path)).toBe(original)
  expect(canvasDiffFile([other], original.path)).toBeNull()
  expect(canvasDiffFile([other], undefined)).toBeNull()
  const client = api(async () => ({ files: [original], viewId: 'fresh-view', diffError: null }))
  expect(await readCanvasDiffFiles(client, mission.missionId)).toEqual([original])
  expect(client.request).toHaveBeenCalledWith('missions.changes', { missionId: mission.missionId })
  await expect(readCanvasDiffFiles(api(async () => ({ files: null, viewId: null, diffError: null })), mission.missionId)).rejects.toThrow('变更清单')
  await expect(readCanvasDiffFiles(api(async () => ({ files: [other], viewId: 'view', diffError: 'Git read failed' })), mission.missionId)).rejects.toThrow('Git read failed')
})

it('releases Mission-wide Diff snapshots only after its last reader and keeps clients and Missions separate', async () => {
  const first = api(async () => ({})), second = api(async () => ({}))
  const one = retainMissionDiffSession(first, 'mission'), two = retainMissionDiffSession(first, 'mission')
  const otherMission = retainMissionDiffSession(first, 'other'), otherClient = retainMissionDiffSession(second, 'mission')
  one(); one(); await Promise.resolve()
  expect(first.request).not.toHaveBeenCalled()
  otherClient(); await Promise.resolve()
  expect(second.request).toHaveBeenCalledTimes(1)
  two(); const remount = retainMissionDiffSession(first, 'mission'); await Promise.resolve()
  expect(first.request).not.toHaveBeenCalled()
  remount(); otherMission(); await Promise.resolve()
  expect(first.request).toHaveBeenCalledTimes(2)
  expect(first.request).toHaveBeenCalledWith('missions.diffSession.release', { missionId: 'mission' })
  expect(first.request).toHaveBeenCalledWith('missions.diffSession.release', { missionId: 'other' })
})

it('invalidates only the original object or Thread rather than disabling actions for unrelated streaming events', () => {
  expect(canvasObjectInvalidated({ method: 'agent_run.output', params: { threadId: 'thread' } }, target)).toBe(false)
  expect(canvasObjectInvalidated({ method: 'missions.invalidated', params: {} }, target)).toBe(true)
  expect(canvasObjectInvalidated({ method: 'mission.updated', params: { threadId: 'other', missionId: mission.missionId } }, target)).toBe(false)
  const item = { eventType: 'mission.updated', threadId: 'thread', entityType: 'mission', entityId: mission.missionId }
  for (const [patch, expected] of [[{}, true], [{ entityId: 'other' }, false], [{ threadId: 'other' }, false]] as const) {
    expect(canvasObjectInvalidated({ method: 'events.batch', params: { events: [{ ...item, ...patch }] } }, target)).toBe(expected)
  }
  expect(canvasObjectInvalidated({ method: 'events.batch', params: { resetRequired: true } }, target)).toBe(true)
  expect(canvasObjectInvalidated({ method: 'events.batch', params: { events: [{ eventType: 'camp.deleted', threadId: 'thread' }] } }, target)).toBe(true)
})
