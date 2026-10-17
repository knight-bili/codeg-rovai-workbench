import type { CanvasReferencePage, CanvasThreadReference, CoreEvent, EventBatch } from '@contracts'
import type { ThreadClient } from './camp-client'
import { createNavigationRefreshCoordinator } from './navigation-refresh-coordinator'

export interface CanvasReferenceState {
  items: readonly CanvasThreadReference[]
  loading: boolean
  complete: boolean
  error: unknown | null
  pagesRead: number
}
export const initialCanvasReferenceState = (): CanvasReferenceState => ({ items: [], loading: true, complete: false, error: null, pagesRead: 0 })
type Client = Pick<ThreadClient, 'request' | 'onEvent' | 'onInvalidated'>
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
const counter = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
const validRunModel = (value: unknown): boolean => {
  if (value === null || value === undefined) return true
  const model = record(value)
  return typeof model.runId === 'string' && Boolean(model.runId.trim())
    && typeof model.adapterKind === 'string' && Boolean(model.adapterKind.trim())
    && (model.modelId === null || typeof model.modelId === 'string' && Boolean(model.modelId.trim()))
    && (model.reasoningEffort === null || typeof model.reasoningEffort === 'string')
}
export function canvasReferencesInvalidation(event: CoreEvent): number | null {
  if (['navigation.invalidated', 'members.invalidated', 'missions.invalidated', 'single_chat.changed'].includes(event.method)) return 0
  if (event.method !== 'events.batch') return null
  const batch = record(event.params) as unknown as Partial<EventBatch>
  if (batch.resetRequired) return counter(batch.throughGlobalSequence)
  let sequence: number | null = null
  for (const item of Array.isArray(batch.events) ? batch.events : []) {
    if (/^(camp[._]|camp_member[._]|agent_profile[._]|agent_run[._]|conversation[._]|single_chat[._]|mission[._])/.test(item.eventType)) {
      sequence = Math.max(sequence ?? 0, counter(item.globalSequence))
    }
  }
  return sequence
}

/** One mounted Host/editor directory. Pages contain metadata, never transcript or draft bodies. */
export class CanvasReferenceController {
  private state = initialCanvasReferenceState()
  private listeners = new Set<() => void>()
  private unsubscribe: Array<() => void> = []
  private generation = 0
  private minimumSequence = 0
  private scanned = false
  private started = false
  private disposed = false
  private reads: ReturnType<typeof createNavigationRefreshCoordinator>
  constructor(private readonly client: Client) {
    this.reads = createNavigationRefreshCoordinator(() => this.readDirectory())
  }
  getSnapshot = (): CanvasReferenceState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<CanvasReferenceState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener())
  }
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.unsubscribe = [this.client.onEvent?.(event => {
      const sequence = canvasReferencesInvalidation(event)
      if (sequence === null) return
      this.minimumSequence = Math.max(this.minimumSequence, sequence)
      this.invalidate()
    }), this.client.onInvalidated?.(() => this.invalidate())].filter((value): value is () => void => Boolean(value))
    void this.refresh().catch(() => undefined)
  }
  private invalidate(): void {
    ++this.generation; this.publish({ loading: true, complete: false })
    void this.reads.refresh('invalidation').catch(() => undefined)
  }
  refresh = (): Promise<void> => {
    if (this.disposed) return Promise.reject(new Error('画布对话目录已关闭。'))
    ++this.generation; this.publish({ loading: true, complete: false })
    return this.reads.refresh('explicit')
  }
  setVisible(visible: boolean): void {
    this.reads.setVisible(visible)
    if (visible && !this.disposed) void this.refresh().catch(() => undefined)
  }
  private async readDirectory(): Promise<void> {
    const generation = this.generation, items: CanvasThreadReference[] = []
    let after: string | null = null, upper: string | null = null, pagesRead = 0
    this.publish({ loading: true, complete: false, error: null, pagesRead })
    try {
      do {
        const page: CanvasReferencePage = await this.client.request('canvas.references.page', { afterThreadId: after, upperThreadId: upper, limit: 200 })
        if (this.disposed) return
        if (page.schemaVersion !== 1 || !Number.isSafeInteger(page.throughGlobalSequence) || page.throughGlobalSequence < this.minimumSequence
          || !Array.isArray(page.items) || page.items.length > 200
          || page.upperThreadId !== null && (typeof page.upperThreadId !== 'string' || !page.upperThreadId)
          || pagesRead > 0 && page.upperThreadId !== upper) throw new Error('对话目录版本或分页范围不一致，请重新读取。')
        upper = page.upperThreadId
        let previous: string = after ?? ''
        for (const item of page.items) {
          if (typeof item.threadId !== 'string' || item.threadId <= previous || upper === null || item.threadId > upper
            || typeof item.title !== 'string' || typeof item.projectPath !== 'string'
            || !Array.isArray(item.members) || !Array.isArray(item.privateConversations)) throw new Error('对话目录分页未前进或归属不一致。')
          const members = new Set(item.members.map(member => member.agentId))
          if (item.members.some(member => !validRunModel(member.lastRunModel))) throw new Error('会话模型来源无效。')
          if (item.publicActiveRunCount !== undefined && (!Number.isSafeInteger(item.publicActiveRunCount) || item.publicActiveRunCount < 0)) throw new Error('会话运行数量无效。')
          if (item.privateConversations.some(conversation => !conversation.conversationId || !members.has(conversation.agentId)
            || conversation.hasActiveRun !== undefined && typeof conversation.hasActiveRun !== 'boolean'
            || !validRunModel(conversation.lastRunModel))) throw new Error('单聊与队员归属不一致。')
          previous = item.threadId
        }
        if (page.nextAfterThreadId !== null && (!page.items.length || page.nextAfterThreadId !== previous || page.nextAfterThreadId === after)) {
          throw new Error('对话目录分页未前进或归属不一致。')
        }
        this.minimumSequence = page.throughGlobalSequence
        items.push(...page.items); ++pagesRead; after = page.nextAfterThreadId
        if (!this.scanned) this.publish({ items: [...items], pagesRead })
        else this.publish({ pagesRead })
      } while (after !== null)
      this.scanned = true
      const complete = generation === this.generation
      this.publish({ items, pagesRead, loading: !complete, complete, error: null })
    } catch (error) { this.publish({ loading: false, complete: false, error }); throw error }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.unsubscribe.forEach(unsubscribe => unsubscribe()); this.reads.dispose(); this.listeners.clear()
  }
}
