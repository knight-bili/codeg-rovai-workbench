import type { RovaiApi, ThreadMessagePage, ThreadOpenProjection } from '@contracts'
import { newCommandId } from '../../shared/command-id'
import { threadCommands } from './thread-commands'
import { campOpenProjectionAsSnapshot, type ThreadSurfaceSnapshot } from './thread-workspace-data'
import { uiAttribute } from './interface-language'

export interface ThreadProjectionRead {
  snapshot: ThreadSurfaceSnapshot
  traceId: string
  startedAt: number
  receivedAt: number
}
export interface ThreadProjectionState {
  snapshot: ThreadSurfaceSnapshot | null
  loading: boolean
  error: Error | null
}
interface Entry {
  threadId: string
  state: ThreadProjectionState
  listeners: Set<() => void>
  leases: number
  opening: Promise<ThreadProjectionRead> | null
  paging: Promise<ThreadSurfaceSnapshot | null> | null
  dirty: boolean
}
const errorValue = (value: unknown) => value instanceof Error ? value : new Error(String(value))
export class ThreadProjectionSupersededError extends Error {
  constructor() { super(uiAttribute('会话读取已失效，请重新打开。')) }
}

/** Client-owned read projections. A card owns its input; mirrors may share this Thread's read state.
 * The five idle entries match the existing UI cache budget; mounted and in-flight entries are not evicted.
 * This store never enters a Thread, starts a Runtime, publishes input, or acknowledges a notification. */
export class ThreadProjectionStore {
  private readonly entries = new Map<string, Entry>()
  private generation = 0
  constructor(private readonly client: Pick<RovaiApi, 'request'>) {}
  get epoch(): number { return this.generation }

  private entry(threadId: string): Entry {
    if (!threadId) throw new Error(uiAttribute('当前会话尚未准备好。'))
    let entry = this.entries.get(threadId)
    if (!entry) {
      entry = { threadId, state: { snapshot: null, loading: false, error: null }, listeners: new Set(), leases: 0, opening: null, paging: null, dirty: false }
      this.entries.set(threadId, entry)
    } else {
      this.entries.delete(threadId); this.entries.set(threadId, entry)
    }
    return entry
  }
  private current(entry: Entry, epoch = this.generation): boolean { return this.generation === epoch && this.entries.get(entry.threadId) === entry }
  private ensureCurrent(entry: Entry, epoch = this.generation): void {
    if (!this.current(entry, epoch)) throw new ThreadProjectionSupersededError()
  }
  private publish(entry: Entry, change: Partial<ThreadProjectionState>): void {
    if (!this.current(entry)) return
    entry.state = { ...entry.state, ...change }
    for (const listener of entry.listeners) listener()
  }
  private prune(): void {
    const idle = [...this.entries.values()].filter(entry => !entry.leases && !entry.listeners.size && !entry.opening && !entry.paging)
    for (const entry of idle.slice(0, Math.max(0, idle.length - 5))) this.entries.delete(entry.threadId)
  }
  getSnapshot(threadId: string): ThreadProjectionState { return this.entry(threadId).state }
  peek(threadId: string): ThreadSurfaceSnapshot | null {
    return this.entries.has(threadId) ? this.entry(threadId).state.snapshot : null
  }
  retain(threadId: string): () => void {
    const entry = this.entry(threadId)
    entry.leases += 1
    let released = false
    return () => { if (!released) { released = true; entry.leases -= 1; this.prune() } }
  }
  subscribe(threadId: string, listener: () => void): () => void {
    const entry = this.entry(threadId)
    entry.listeners.add(listener)
    return () => { entry.listeners.delete(listener); this.prune() }
  }
  /** Accepted enter/full-snapshot and pagination paths converge here without another request. */
  remember(snapshot: ThreadSurfaceSnapshot): ThreadSurfaceSnapshot {
    const entry = this.entry(snapshot.thread.id), previous = entry.state.snapshot
    if (previous && previous.throughGlobalSequence > snapshot.throughGlobalSequence) return previous
    if (snapshot !== previous || entry.state.error) this.publish(entry, { snapshot, error: null })
    this.prune()
    return snapshot
  }
  accept(threadId: string, projection: ThreadOpenProjection): ThreadSurfaceSnapshot {
    if (projection.schemaVersion !== 8) throw new Error(uiAttribute('会话打开数据版本不兼容。'))
    if (projection.thread.id !== threadId) throw new Error(uiAttribute('对话读取结果与所选引用不一致。'))
    const previous = this.entry(threadId).state.snapshot
    if (previous && previous.throughGlobalSequence > projection.throughGlobalSequence) return previous
    return this.remember(campOpenProjectionAsSnapshot(projection, previous))
  }
  open(threadId: string): Promise<ThreadProjectionRead> { return this.read(threadId, false) }
  refresh(threadId: string): Promise<ThreadProjectionRead> { return this.read(threadId, true) }
  private async readOnce(entry: Entry, epoch: number): Promise<ThreadProjectionRead> {
    this.ensureCurrent(entry, epoch)
    const traceId = newCommandId(), startedAt = performance.now(), threadId = entry.threadId
    console.info(`[camp-open] trace=${traceId} stage=renderer_request method=threads.open`)
    const projection = await threadCommands(this.client, threadId).open(traceId)
    this.ensureCurrent(entry, epoch)
    const snapshot = this.accept(threadId, projection), receivedAt = performance.now()
    console.info(`[camp-open] trace=${traceId} stage=renderer_received method=threads.open `
      + `elapsed_ms=${(receivedAt - startedAt).toFixed(1)} schema=${projection.schemaVersion} high_water=${projection.throughGlobalSequence} `
      + `messages=${projection.messages.length} runs=${projection.agentRuns.length} evidence=${projection.executionEvidence.length}`)
    return { snapshot, traceId, startedAt, receivedAt }
  }
  private read(threadId: string, fresh: boolean): Promise<ThreadProjectionRead> {
    const entry = this.entry(threadId)
    if (entry.opening) { if (fresh) entry.dirty = true; return entry.opening }
    const epoch = this.generation
    const pending = Promise.resolve().then(async () => {
      this.ensureCurrent(entry, epoch)
      this.publish(entry, { loading: true, error: null })
      try {
        let result: ThreadProjectionRead | undefined, lastError: Error | null
        do {
          entry.dirty = false; lastError = null
          try { result = await this.readOnce(entry, epoch) } catch (error) { lastError = errorValue(error) }
        } while (entry.dirty && this.current(entry, epoch))
        if (lastError !== null) throw lastError
        return result!
      } catch (value) {
        const error = this.current(entry, epoch) ? errorValue(value) : new ThreadProjectionSupersededError()
        if (this.current(entry, epoch)) this.publish(entry, { error })
        throw error
      } finally {
        if (entry.opening === pending) {
          entry.opening = null
          if (this.current(entry, epoch)) this.publish(entry, { loading: false })
        }
        this.prune()
      }
    })
    entry.opening = pending
    return pending
  }
  loadEarlier(threadId: string): Promise<ThreadSurfaceSnapshot | null> {
    const entry = this.entry(threadId)
    if (entry.paging) return entry.paging
    const requested = entry.state.snapshot, coverage = requested?.openCoverage?.messages
    const beforeSequence = coverage?.oldestLoadedSequence ?? null
    if (!requested || !coverage?.hasEarlier || beforeSequence === null) return Promise.resolve(null)
    const epoch = this.generation
    const pending = Promise.resolve().then(async () => {
      this.ensureCurrent(entry, epoch)
      try {
        const page = await this.client.request<ThreadMessagePage>('thread.messages.page', {
          threadId, beforeSequence, throughGlobalSequence: requested.throughGlobalSequence, limit: 50
        })
        this.ensureCurrent(entry, epoch)
        if (page.schemaVersion !== 1 || page.threadId !== threadId || page.throughGlobalSequence !== requested.throughGlobalSequence
          || page.requestedBeforeSequence !== beforeSequence || page.hasMore !== (page.nextBeforeSequence !== null)
          || page.messages.some(message => message.sequence >= beforeSequence)) {
          throw new Error(uiAttribute('较早消息数据不兼容，请重新打开会话。'))
        }
        const current = entry.state.snapshot
        // A newer read may have withdrawn/deleted these messages; old pages must not restore their text.
        if (!current || current.throughGlobalSequence !== requested.throughGlobalSequence) return null
        const byId = new Map(current.messages.map(message => [message.id, message]))
        for (const message of page.messages) byId.set(message.id, message)
        const messages = [...byId.values()].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))
        const loadedCount = messages.length, totalCount = page.hasMore ? Math.max(current.openCoverage?.messages.totalCount ?? 0, loadedCount + 1) : loadedCount
        return this.remember({ ...current, messages, openCoverage: current.openCoverage ? { ...current.openCoverage,
          messages: { ...current.openCoverage.messages, loadedCount, totalCount, omittedCount: Math.max(0, totalCount - loadedCount),
            complete: !page.hasMore, hasEarlier: page.hasMore, oldestLoadedSequence: messages[0]?.sequence ?? null,
            newestLoadedSequence: messages.at(-1)?.sequence ?? null } } : undefined })
      } catch (value) {
        const error = this.current(entry, epoch) ? errorValue(value) : new ThreadProjectionSupersededError()
        if (this.current(entry, epoch)) this.publish(entry, { error })
        throw error
      } finally {
        if (entry.paging === pending) entry.paging = null
        this.prune()
      }
    })
    entry.paging = pending
    return pending
  }
  forget(threadId: string): void {
    const entry = this.entries.get(threadId)
    if (!entry) return
    // Notify existing consumers that the old resource is gone, then fence all its pending results.
    this.publish(entry, { snapshot: null, loading: false, error: null })
    this.entries.delete(threadId)
  }
  reset(): void {
    this.generation += 1
    for (const entry of [...this.entries.values()]) {
      entry.opening = null; entry.paging = null; entry.dirty = false
      this.publish(entry, { snapshot: null, loading: false, error: null })
      if (!entry.leases && !entry.listeners.size) this.entries.delete(entry.threadId)
    }
  }
}
