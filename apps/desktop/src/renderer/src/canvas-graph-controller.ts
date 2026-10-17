import type { ApplyCanvasNodesCommand, CanvasGraphSnapshot, CanvasNodeMutation, CoreEvent, EventBatch, StoredCommandResult } from '@contracts'
import { newCommandId } from '../../shared/command-id'
import type { ThreadClient } from './camp-client'
import { createNavigationRefreshCoordinator } from './navigation-refresh-coordinator'

type CanvasClient = Pick<ThreadClient, 'request' | 'onEvent' | 'onInvalidated'>
type PendingGesture = { commandId: string; command: ApplyCanvasNodesCommand; state: 'sending' | 'unknown' }
export interface CanvasGraphState {
  boardId: string
  snapshot: CanvasGraphSnapshot | null
  loading: boolean
  readError: unknown | null
  commandError: unknown | null
  pending: PendingGesture | null
  lastResult: StoredCommandResult | null
}

export function initialCanvasGraphState(boardId: string): CanvasGraphState {
  return { boardId, snapshot: null, loading: true, readError: null, commandError: null, pending: null, lastResult: null }
}

/** These are invalidation hints. Node state is only read from the Core snapshot. */
export function canvasGraphInvalidation(event: CoreEvent, boardId: string): { revision: number; sequence: number } | null {
  const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  const number = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
  const params = record(event.params)
  if (event.method === 'canvas.board.invalidated' && params.boardId === boardId) {
    return { revision: number(params.revision), sequence: 0 }
  }
  if (event.method !== 'events.batch') return null
  const batch = params as unknown as Partial<EventBatch>
  if (batch.resetRequired) return { revision: 0, sequence: number(batch.throughGlobalSequence) }
  let revision = 0, sequence = 0, changed = false
  for (const item of Array.isArray(batch.events) ? batch.events : []) {
    const payload = record(item.payload)
    if (item.eventType !== 'canvas.board.invalidated' || payload.boardId !== boardId) continue
    changed = true
    revision = Math.max(revision, number(payload.revision))
    sequence = Math.max(sequence, number(item.globalSequence))
  }
  return changed ? { revision, sequence } : null
}

/** One instance owns one mounted Host/board scope. It cannot navigate to another board. */
export class CanvasGraphController {
  private state: CanvasGraphState
  private listeners = new Set<() => void>()
  private unsubscribe: Array<() => void> = []
  private started = false
  private disposed = false
  private minimumRevision = 0
  private minimumSequence = 0
  private readonly reads: ReturnType<typeof createNavigationRefreshCoordinator>

  constructor(private readonly client: CanvasClient, readonly boardId: string) {
    this.state = initialCanvasGraphState(boardId)
    this.reads = createNavigationRefreshCoordinator(async () => {
      try {
        const snapshot = await client.request<CanvasGraphSnapshot>('canvas.nodes.snapshot', { boardId })
        if (this.disposed) return
        if (snapshot.board && snapshot.board.id !== boardId || snapshot.nodes.some(node => node.boardId !== boardId)) {
          throw new Error('画板读取归属不一致，请重新加载。')
        }
        if (snapshot.throughGlobalSequence < this.minimumSequence || snapshot.board && snapshot.board.revision < this.minimumRevision) {
          throw new Error('画布正在同步最新修改，请稍后重试。')
        }
        this.minimumSequence = Math.max(this.minimumSequence, snapshot.throughGlobalSequence)
        this.minimumRevision = Math.max(this.minimumRevision, snapshot.board?.revision ?? 0)
        this.publish({ snapshot, loading: false, readError: null })
      } catch (error) {
        if (!this.disposed) this.publish({ loading: false, readError: error })
        throw error
      }
    })
  }

  getSnapshot = (): CanvasGraphState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private publish(patch: Partial<CanvasGraphState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    // Subscribe before the first read so a mutation during that read causes a trailing snapshot.
    const raw = this.client.onEvent?.(event => {
      const hint = canvasGraphInvalidation(event, this.boardId)
      if (!hint) return
      const current = this.state.snapshot
      if (hint.revision > 0 && hint.revision <= (current?.board?.revision ?? 0)
        && hint.sequence <= (current?.throughGlobalSequence ?? 0)) return
      this.minimumRevision = Math.max(this.minimumRevision, hint.revision)
      this.minimumSequence = Math.max(this.minimumSequence, hint.sequence)
      this.invalidate()
    })
    const authorized = this.client.onInvalidated?.(() => this.invalidate())
    this.unsubscribe = [raw, authorized].filter((value): value is () => void => Boolean(value))
    void this.refresh().catch(() => undefined)
  }

  private invalidate(): void {
    this.publish({ loading: true })
    void this.reads.refresh('invalidation').catch(() => undefined)
  }
  refresh = (): Promise<void> => {
    if (this.disposed) return Promise.reject(new Error('画板已关闭。'))
    this.publish({ loading: true })
    return this.reads.refresh('explicit')
  }
  setVisible(visible: boolean): void {
    this.reads.setVisible(visible)
    if (visible && !this.disposed) void this.refresh().catch(() => undefined)
  }

  apply = (mutation: CanvasNodeMutation, expectedRevision?: number): Promise<StoredCommandResult> => {
    const { snapshot, loading, readError, pending } = this.state
    if (this.disposed || !this.started || loading || readError || !snapshot?.board || pending) {
      return Promise.reject(new Error(pending ? '原操作仍待核对，请先处理原操作。' : '画布尚未同步，暂时无法修改。'))
    }
    if ((mutation.type === 'bind_file' || mutation.type === 'create' && mutation.node.fileReference) && snapshot.fileReferenceVersion !== 1) {
      return Promise.reject(new Error('当前连接暂不支持文件节点来源绑定，请升级服务后重试。'))
    }
    if (mutation.type === 'create' && mutation.node.objectReference && snapshot.objectReferenceVersion !== 1) {
      return Promise.reject(new Error('当前连接暂不支持独立对象卡片，请升级服务后重试。'))
    }
    const gesture: PendingGesture = { commandId: newCommandId(),
      command: { boardId: this.boardId, expectedRevision: expectedRevision ?? snapshot.board.revision, mutation: structuredClone(mutation) }, state: 'sending' }
    return this.send(gesture)
  }

  retry = (): Promise<StoredCommandResult> => {
    const pending = this.state.pending
    if (!pending || pending.state !== 'unknown' || this.disposed) return Promise.reject(new Error('没有可重试的原操作。'))
    return this.send(pending)
  }

  reconcile = async (): Promise<StoredCommandResult | null> => {
    const pending = this.state.pending
    if (!pending || pending.state !== 'unknown' || this.disposed) return null
    const receipt = await this.client.request<{ state: 'unknown' | 'recorded'; result?: StoredCommandResult }>('commands.reconcile', {
      operation: 'canvas.nodes.apply', params: { commandId: pending.commandId, command: pending.command }
    })
    if (receipt.state !== 'recorded' || !receipt.result) return null
    // A manual retry may already own a new in-flight attempt of this same identity.
    if (this.state.pending === pending) this.settle(receipt.result)
    return receipt.result
  }

  private async send(pending: PendingGesture): Promise<StoredCommandResult> {
    const sending = { ...pending, state: 'sending' as const }
    this.publish({ pending: sending, commandError: null })
    try {
      const result = await this.client.request<StoredCommandResult>('canvas.nodes.apply', {
        commandId: sending.commandId, command: sending.command
      })
      if (!this.disposed && this.state.pending === sending) this.settle(result)
      return result
    } catch (error) {
      if (!this.disposed && this.state.pending === sending) this.publish({ pending: { ...sending, state: 'unknown' }, commandError: error })
      throw error
    }
  }

  private settle(result: StoredCommandResult): void {
    // The command result is terminal even if the following snapshot read fails.
    if (typeof result.payload.revision === 'number' && Number.isSafeInteger(result.payload.revision)) {
      this.minimumRevision = Math.max(this.minimumRevision, result.payload.revision)
    }
    this.publish({ pending: null, lastResult: result, commandError: null })
    void this.refresh().catch(() => undefined)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unsubscribe of this.unsubscribe) unsubscribe()
    this.reads.dispose()
    this.listeners.clear()
  }
}
