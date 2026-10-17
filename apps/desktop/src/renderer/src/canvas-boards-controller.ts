import type { CanvasBoardsSnapshot, CoreEvent, CreateCanvasBoardCommand, DeleteCanvasBoardCommand,
  EventBatch, StoredCommandResult, UpdateCanvasBoardCommand } from '@contracts'
import { newCommandId } from '../../shared/command-id'
import type { ThreadClient } from './camp-client'
import { createNavigationRefreshCoordinator } from './navigation-refresh-coordinator'

export type CanvasBoardIntent = { operation: 'canvas.boards.create'; command: CreateCanvasBoardCommand }
  | { operation: 'canvas.boards.update'; command: UpdateCanvasBoardCommand }
  | { operation: 'canvas.boards.delete'; command: DeleteCanvasBoardCommand }
type PendingBoardCommand = CanvasBoardIntent & { commandId: string; state: 'sending' | 'unknown' }
export interface CanvasBoardsState {
  snapshot: CanvasBoardsSnapshot | null
  loading: boolean
  readError: unknown | null
  commandError: unknown | null
  pending: PendingBoardCommand | null
  lastResult: StoredCommandResult | null
}
export const initialCanvasBoardsState = (): CanvasBoardsState => ({ snapshot: null, loading: true,
  readError: null, commandError: null, pending: null, lastResult: null })
type Client = Pick<ThreadClient, 'request' | 'onEvent' | 'onInvalidated'>
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
const counter = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0

/** Metadata and nodes share board revisions. List hints never become a second board store. */
export class CanvasBoardsController {
  private state = initialCanvasBoardsState()
  private listeners = new Set<() => void>()
  private unsubscribe: Array<() => void> = []
  private disposed = false
  private started = false
  private minimumSequence = 0
  private revisions = new Map<string, number>()
  private readonly reads: ReturnType<typeof createNavigationRefreshCoordinator>
  constructor(private readonly client: Client) {
    this.reads = createNavigationRefreshCoordinator(async () => {
      try {
        const snapshot = await client.request<CanvasBoardsSnapshot>('canvas.boards.list', {})
        if (this.disposed) return
        if (snapshot.summaries !== undefined) {
          const boards = new Map(snapshot.boards.map(board => [board.id, board.revision]))
          const seen = new Set<string>()
          if (snapshot.summaries.length !== boards.size || snapshot.summaries.some(summary => {
            const duplicate = seen.has(summary.boardId); seen.add(summary.boardId)
            return duplicate || boards.get(summary.boardId) !== summary.revision
              || !Number.isSafeInteger(summary.nodeCount) || summary.nodeCount < 0
              || !Number.isSafeInteger(summary.terminalCount) || summary.terminalCount < 0 || summary.terminalCount > summary.nodeCount
              || !Array.isArray(summary.preview) || summary.preview.length !== Math.min(summary.nodeCount, 200)
              || summary.preview.some(rect => ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
                || Math.abs(rect.x) > 1_000_000 || Math.abs(rect.y) > 1_000_000 || rect.width < 48 || rect.width > 20_000 || rect.height < 48 || rect.height > 20_000
                || !['folder', 'group', 'agent', 'conversation', 'custom', 'note', 'file', 'terminal'].includes(rect.kind))
          })) throw new Error('画板统计与列表不一致，请重新读取。')
        }
        if (snapshot.throughGlobalSequence < this.minimumSequence
          || snapshot.boards.some(board => board.revision < (this.revisions.get(board.id) ?? 0))) {
          throw new Error('画板列表正在同步最新修改，请稍后重试。')
        }
        this.minimumSequence = snapshot.throughGlobalSequence
        for (const board of snapshot.boards) this.noteRevision(board.id, board.revision)
        this.publish({ snapshot, loading: false, readError: null })
      } catch (error) { this.publish({ loading: false, readError: error }); throw error }
    })
  }
  getSnapshot = (): CanvasBoardsState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<CanvasBoardsState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener())
  }
  private noteRevision(id: unknown, revision: unknown): void {
    if (typeof id === 'string' && counter(revision)) this.revisions.set(id, Math.max(this.revisions.get(id) ?? 0, counter(revision)))
  }
  private invalidate(event?: CoreEvent): void {
    if (event) {
      const params = record(event.params), batch = params as unknown as Partial<EventBatch>
      const changes = event.method === 'canvas.board.invalidated' ? [{ globalSequence: 0, payload: params }]
        : event.method === 'events.batch' ? (Array.isArray(batch.events) ? batch.events : []).filter(item => item.eventType === 'canvas.board.invalidated') : []
      if (!changes.length && !(event.method === 'events.batch' && batch.resetRequired)) return
      for (const change of changes) {
        const data = record(change.payload)
        this.noteRevision(data.boardId, data.revision)
        this.minimumSequence = Math.max(this.minimumSequence, counter(change.globalSequence))
      }
      if (batch.resetRequired) this.minimumSequence = Math.max(this.minimumSequence, counter(batch.throughGlobalSequence))
    }
    this.publish({ loading: true })
    void this.reads.refresh('invalidation').catch(() => undefined)
  }
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.unsubscribe = [this.client.onEvent?.(event => this.invalidate(event)), this.client.onInvalidated?.(() => this.invalidate())]
      .filter((value): value is () => void => Boolean(value))
    void this.refresh().catch(() => undefined)
  }
  refresh = (): Promise<void> => {
    if (this.disposed) return Promise.reject(new Error('画板页面已关闭。'))
    this.publish({ loading: true }); return this.reads.refresh('explicit')
  }
  setVisible(visible: boolean): void {
    this.reads.setVisible(visible)
    if (visible && !this.disposed) void this.refresh().catch(() => undefined)
  }
  apply = (intent: CanvasBoardIntent): Promise<StoredCommandResult> => {
    if (!this.started || this.disposed || this.state.loading || this.state.readError || !this.state.snapshot || this.state.pending) {
      return Promise.reject(new Error(this.state.pending ? '原画板操作仍待核对。' : '画板列表尚未同步，暂时无法修改。'))
    }
    return this.send({ ...structuredClone(intent), commandId: newCommandId(), state: 'sending' })
  }
  retry = (): Promise<StoredCommandResult> => {
    if (this.disposed || this.state.pending?.state !== 'unknown') return Promise.reject(new Error('没有可重试的原画板操作。'))
    return this.send(this.state.pending)
  }
  reconcile = async (): Promise<StoredCommandResult | null> => {
    const pending = this.state.pending
    if (this.disposed || pending?.state !== 'unknown') return null
    const receipt = await this.client.request<{ state: 'unknown' | 'recorded'; result?: StoredCommandResult }>('commands.reconcile', {
      operation: pending.operation, params: { commandId: pending.commandId, command: pending.command }
    })
    if (receipt.state !== 'recorded' || !receipt.result) return null
    if (this.state.pending === pending) this.settle(receipt.result, pending)
    return receipt.result
  }
  private async send(pending: PendingBoardCommand): Promise<StoredCommandResult> {
    const sending = { ...pending, state: 'sending' as const }
    this.publish({ pending: sending, commandError: null })
    try {
      const result = await this.client.request<StoredCommandResult>(sending.operation, { commandId: sending.commandId, command: sending.command })
      if (!this.disposed && this.state.pending === sending) this.settle(result, sending)
      return result
    } catch (error) {
      if (!this.disposed && this.state.pending === sending) this.publish({ pending: { ...sending, state: 'unknown' }, commandError: error })
      throw error
    }
  }
  private settle(result: StoredCommandResult, pending: PendingBoardCommand): void {
    const board = record(result.payload.board)
    this.noteRevision(board.id, board.revision)
    if ('boardId' in pending.command) this.noteRevision(pending.command.boardId, result.payload.revision)
    this.publish({ lastResult: result, pending: null, commandError: null })
    void this.refresh().catch(() => undefined)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.unsubscribe.forEach(unsubscribe => unsubscribe()); this.reads.dispose(); this.listeners.clear()
  }
}
