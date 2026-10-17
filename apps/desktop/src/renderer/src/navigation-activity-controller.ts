import type { CoreEvent, NavigationActivitySnapshot } from '@contracts'
import type { ThreadClient } from './camp-client'
import { createNavigationRefreshCoordinator, type NavigationRefreshTrigger } from './navigation-refresh-coordinator'

export type NavigationActivityCount = { count: number; sequence: number; complete: boolean }
export type NavigationActivityState = { groups: ReadonlyMap<string, NavigationActivityCount>; resolving: boolean }
export const emptyNavigationActivity = (): NavigationActivityState => ({ groups: new Map(), resolving: false })
type Client = Pick<ThreadClient, 'request' | 'onEvent' | 'onInvalidated'>
const chunks = <T,>(items: T[]): T[][] => Array.from({ length: Math.ceil(items.length / 200) }, (_, index) => items.slice(index * 200, (index + 1) * 200))
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Notifications choose a read scope only. No marker-prefix arithmetic or event-derived business counts. */
export function navigationActivityInvalidation(event: CoreEvent): { keys?: string[]; threadIds?: string[]; sequence: number } | null {
  if (event.method !== 'navigation.invalidated') return null
  const params = event.params as Record<string, unknown> | undefined
  if (!params || typeof params !== 'object') return { sequence: 0 }
  const reason = typeof params.reason === 'string' ? params.reason : ''
  if (params.scope === 'camp' && !['agent_run.started', 'agent_run.terminal', 'agentRuns.cancel', 'agentRuns.continue', 'delivery_batch.claimed'].includes(reason)) return null
  const sequence = counter(params.throughGlobalSequence) ? params.throughGlobalSequence : 0
  if (params.scope === 'all') return { sequence }
  if (Array.isArray(params.groupKeys) && params.groupKeys.length && params.groupKeys.every(key => typeof key === 'string')) return { keys: params.groupKeys, sequence }
  const id = params.threadId ?? params.campId
  return typeof id === 'string' && id ? { threadIds: [id], sequence } : { sequence }
}

/** One mounted client owner; batches only metadata and lets Core resolve window-external Thread IDs. */
export class NavigationActivityController {
  private state = emptyNavigationActivity()
  private keys = new Set<string>()
  private pendingKeys = new Set<string>()
  private pendingIds = new Set<string>()
  private listeners = new Set<() => void>()
  private unsubscribe: Array<() => void> = []
  private generation = 0
  private minimumSequence = 0
  private latestReadSequence = 0
  private started = false
  private disposed = false
  private reads: ReturnType<typeof createNavigationRefreshCoordinator>
  constructor(private readonly client: Client) {
    this.reads = createNavigationRefreshCoordinator(() => this.read(), { initiallyVisible: false })
  }
  getSnapshot = (): NavigationActivityState => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(groups = this.state.groups) {
    if (this.disposed) return
    this.state = { groups, resolving: this.pendingIds.size > 0 || this.resolving }
    this.listeners.forEach(listener => listener())
  }
  private resolving = false
  start() {
    if (this.started || this.disposed) return
    this.started = true
    this.unsubscribe = [this.client.onEvent?.(event => {
      const change = navigationActivityInvalidation(event)
      if (!change) return
      if (!this.keys.size || change.keys && !change.keys.some(key => this.keys.has(key))) return
      this.minimumSequence = Math.max(this.minimumSequence, change.sequence)
      this.invalidate(change.keys, change.threadIds)
    }), this.client.onInvalidated?.(change => { if (!change || change.resync) this.invalidate() })].filter((value): value is () => void => Boolean(value))
  }
  setGroups(keys: readonly string[]) {
    const next = new Set(keys)
    if (next.size === this.keys.size && [...next].every(key => this.keys.has(key))) return
    this.generation += 1
    this.keys = next
    this.pendingKeys = new Set([...this.pendingKeys].filter(key => next.has(key)))
    if (!next.size) { this.pendingIds.clear(); this.resolving = false }
    this.publish(new Map([...this.state.groups].filter(([key]) => next.has(key))))
    this.invalidate()
  }
  setVisible(visible: boolean) { this.reads.setVisible(visible); if (visible) this.invalidate() }
  private queue(keys: Iterable<string>) {
    const groups = new Map(this.state.groups)
    for (const key of keys) if (this.keys.has(key)) { this.pendingKeys.add(key); const old = groups.get(key); if (old) groups.set(key, { ...old, complete: false }) }
    return groups
  }
  private schedule(trigger: NavigationRefreshTrigger = 'invalidation') { void this.reads.refresh(trigger).catch(() => undefined) }
  private invalidate(keys?: string[], ids?: string[]) {
    if (this.disposed || !this.keys.size || keys && !keys.some(key => this.keys.has(key))) return
    this.generation += 1
    for (const id of ids ?? []) this.pendingIds.add(id)
    const overflow = this.pendingIds.size > 200
    if (overflow) this.pendingIds.clear()
    this.publish(this.queue(overflow ? this.keys : keys ?? (ids ? [] : this.keys)))
    if (this.keys.size) this.schedule()
  }
  refresh(trigger: NavigationRefreshTrigger = 'poll') {
    if (this.disposed) return Promise.resolve()
    this.generation += 1; this.publish(this.queue(this.keys))
    return this.reads.refresh(trigger)
  }
  private async request(keys: string[], ids?: string[]) {
    const result = await this.client.request<NavigationActivitySnapshot>('navigation.activity', { groupKeys: keys, ...(ids ? { threadIds: ids } : {}) })
    if (result.schemaVersion !== 1 || !counter(result.throughGlobalSequence) || result.throughGlobalSequence < Math.max(this.minimumSequence, this.latestReadSequence) || !Array.isArray(result.groups)) throw new Error('Invalid navigation activity snapshot')
    const seen = new Set<string>()
    for (const group of result.groups) {
      if (!keys.includes(group.groupKey) || seen.has(group.groupKey) || !counter(group.activeThreadCount)
        || result.throughGlobalSequence < (this.state.groups.get(group.groupKey)?.sequence ?? 0)) throw new Error('Invalid navigation activity group')
      seen.add(group.groupKey)
    }
    if (!ids && seen.size !== keys.length) throw new Error('Incomplete navigation activity snapshot')
    this.latestReadSequence = result.throughGlobalSequence
    return result
  }
  private restore(keys: string[], ids: string[]) {
    keys.filter(key => this.keys.has(key)).forEach(key => this.pendingKeys.add(key))
    if (this.keys.size) for (const id of ids) {
      this.pendingIds.add(id)
      if (this.pendingIds.size > 200) { this.pendingIds.clear(); this.resolving = false; this.publish(this.queue(this.keys)); return }
    }
    else { this.pendingIds.clear(); this.resolving = false; this.publish() }
  }
  private async read() {
    if (this.disposed) return
    const generation = this.generation, keys = [...this.pendingKeys], ids = [...this.pendingIds]
    this.pendingKeys.clear(); this.pendingIds.clear(); this.resolving = ids.length > 0; this.publish()
    const candidates = new Map<string, NavigationActivityCount>()
    try {
      for (const batch of chunks(keys)) {
        const result = await this.request(batch)
        for (const group of result.groups) candidates.set(group.groupKey, { count: group.activeThreadCount, sequence: result.throughGlobalSequence, complete: true })
        if (this.disposed || generation !== this.generation) break
      }
      for (const threads of chunks(ids)) for (const batch of chunks([...this.keys])) {
        if (this.disposed || generation !== this.generation) break
        const result = await this.request(batch, threads)
        for (const group of result.groups) candidates.set(group.groupKey, { count: group.activeThreadCount, sequence: result.throughGlobalSequence, complete: true })
      }
      if (this.disposed) return
      if (generation !== this.generation) {
        this.restore(keys, ids)
        return
      }
      const groups = new Map(this.state.groups)
      for (const [key, value] of candidates) if (this.keys.has(key)) groups.set(key, value)
      this.resolving = false; this.publish(groups)
    } catch (error) {
      if (this.disposed) return
      this.restore(keys, ids)
      this.resolving = false; this.publish(); throw error
    }
  }
  dispose() { this.disposed = true; this.generation += 1; this.unsubscribe.splice(0).forEach(stop => stop()); this.reads.dispose(); this.listeners.clear() }
}

export function navigationActivityForGroups(state: NavigationActivityState, keys: readonly string[], relationshipsComplete = true): { count: number | null; complete: boolean } {
  const groups = [...new Set(keys)].map(key => state.groups.get(key))
  const count = groups.every(Boolean) ? groups.reduce((sum, group) => sum + group!.count, 0) : null
  return { count: relationshipsComplete && count !== null && counter(count) ? count : null,
    complete: count !== null && counter(count) && relationshipsComplete && !state.resolving && groups.every(group => group?.complete === true) }
}
