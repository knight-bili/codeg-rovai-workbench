import type { CanvasConversationRef, CanvasNode, CanvasObjectReference, CoreEvent, MissionChangedFile, MissionDelivery, MissionRecord, MissionWorkspaceChangesView, RovaiApi, TaskListPage, TaskView } from '@contracts'
import { uiAttribute } from './interface-language'

export type CanvasObjectTarget = { threadId: string; object: CanvasObjectReference }
export type CanvasObjectRead = { kind: 'task'; task: TaskView } | { kind: 'mission'; mission: MissionRecord }
  | { kind: 'mission_diff'; mission: MissionRecord; delivery: MissionDelivery }
export const canvasObjectNames = { mission: '使命', task: '任务', mission_diff: '累计文件变更' } as const

/** Business pins have a public Thread anchor, but never participate in conversation expansion or grouping. */
export function canvasPlainConversation(node: CanvasNode): CanvasConversationRef | null {
  return node.data.kind === 'conversation' && !node.data.objectReference ? node.data.conversation : null
}
export function canvasObjectTarget(node: CanvasNode): CanvasObjectTarget | null {
  const anchor = node.data.conversation, object = node.data.objectReference
  return node.data.kind === 'conversation' && object && anchor && anchor.conversationId == null
    ? { threadId: anchor.threadId, object: { ...object } } : null
}
export function canvasObjectId(object: CanvasObjectReference): string {
  return object.kind === 'task' ? object.taskId : object.missionId
}

export function canvasObjectInvalidated(event: CoreEvent, target: CanvasObjectTarget): boolean {
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const params = record(event.params), kind = target.object.kind === 'task' ? 'task' : 'mission', id = canvasObjectId(target.object)
  if (event.method === 'events.batch') {
    if (params.resetRequired) return true
    return Array.isArray(params.events) && params.events.some(value => {
      const item = record(value)
      return item.threadId === target.threadId && (item.eventType === 'camp.deleted'
        || item.entityType === kind && item.entityId === id)
    })
  }
  if (params.threadId && params.threadId !== target.threadId) return false
  if (event.method === 'camp.deleted') return params.threadId === target.threadId
  if (event.method === `${kind}s.invalidated`) return true
  return event.method.startsWith(`${kind}.`) && (params[`${kind}Id`] === id)
}

/** Resolve the saved ID. No list fallback, Thread-current Mission derivation, enter, or Runtime action. */
export async function readCanvasObject(client: Pick<RovaiApi, 'request'>, target: CanvasObjectTarget,
  isCurrent: () => boolean): Promise<CanvasObjectRead | null> {
  const { threadId } = target, object = { ...target.object }
  if (!isCurrent()) return null
  if (object.kind === 'task') {
    const task = await client.request<TaskView | null>('tasks.get', { threadId, taskId: object.taskId })
    if (!isCurrent()) return null
    if (!task || task.taskId !== object.taskId || task.threadId !== threadId) throw new Error(uiAttribute('原对象已删除或归属已变化，卡片引用仍保留。'))
    return { kind: 'task', task }
  }
  const mission = await client.request<MissionRecord | null>('missions.get', { missionId: object.missionId })
  if (!isCurrent()) return null
  if (!mission || mission.missionId !== object.missionId || mission.threadId !== threadId) throw new Error(uiAttribute('原对象已删除或归属已变化，卡片引用仍保留。'))
  if (object.kind === 'mission') return { kind: 'mission', mission }
  const delivery = await client.request<MissionDelivery>('missions.delivery', { missionId: object.missionId })
  if (!isCurrent()) return null
  if (delivery.threadId !== threadId || delivery.workspace && (delivery.workspace.threadId !== threadId || delivery.workspace.missionId !== object.missionId)) {
    throw new Error(uiAttribute('原对象已删除或归属已变化，卡片引用仍保留。'))
  }
  return { kind: 'mission_diff', mission, delivery }
}

export async function readCanvasTaskPage(client: Pick<RovaiApi, 'request'>, threadId: string, cursor: string | null): Promise<TaskListPage> {
  const page = await client.request<TaskListPage>('tasks.list', { threadId, cursor, limit: 50 })
  if (!Array.isArray(page.tasks) || page.tasks.length > 50 || page.tasks.some(task => !task.taskId)
    || new Set(page.tasks.map(task => task.taskId)).size !== page.tasks.length
    || page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor === cursor)
    || page.truncated && !page.nextCursor || !page.tasks.length && page.nextCursor) {
    throw new Error(uiAttribute('任务分页未前进，请重新读取。'))
  }
  return page
}

/** A path is only an exact hint within the freshly read Mission change list, never a filesystem grant. */
export function canvasDiffFile(files: readonly MissionChangedFile[] | null, path: string | null | undefined): MissionChangedFile | null {
  if (path == null) return null
  return files?.find(file => file.path === path) ?? null
}

export async function readCanvasDiffFiles(client: Pick<RovaiApi, 'request'>, missionId: string): Promise<MissionChangedFile[]> {
  const view = await client.request<MissionWorkspaceChangesView>('missions.changes', { missionId })
  if (view.diffError) throw new Error(view.diffError)
  if (!view.viewId || !Array.isArray(view.files) || view.files.some(file => !file.id || typeof file.path !== 'string' || !file.path)) {
    throw new Error(uiAttribute('当前变更清单暂不可用，请重新读取。'))
  }
  return view.files
}
