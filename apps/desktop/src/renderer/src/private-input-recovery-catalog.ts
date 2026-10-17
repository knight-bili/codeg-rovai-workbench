import type { PrivateComposerRecoveryResult, PrivateComposerScopeEntry } from '@contracts'
import type { ThreadClient } from './camp-client'
import { canvasComposerContext, canvasComposerContextKey, parseCanvasComposerContext, type CanvasComposerContext } from './canvas-composer-drafts'
import type { CanvasViewScope } from './canvas-view-state'
import { privateInputBodyIndex, type PrivateInputOrigin } from './private-input-controller'
import { singleChatComposerStore, type SingleChatComposerState } from './single-chat-composer-store'

export interface PrivateRecoveryLocation {
  id: string
  context: CanvasComposerContext | undefined
  scope: PrivateComposerScopeEntry | null
  bodies: Array<{ key: string; body: string }>
}
interface State { locations: readonly PrivateRecoveryLocation[]; nextCursor: string | null; complete: boolean; loading: boolean; error: Error | null }
type Client = Pick<ThreadClient, 'request' | 'editingRecovery' | 'onInvalidated'>
const invalid = (): never => { throw new Error('private_input.recovery_invalid') }

/** 只读合并 Core 位置与本机正文索引；分页不完整时不删除先前发现的输入。 */
export class PrivateInputRecoveryCatalog {
  private state: State = { locations: [], nextCursor: null, complete: false, loading: false, error: null }
  private readonly listeners = new Set<() => void>()
  private scopes = new Map<string, PrivateComposerScopeEntry>()
  private enumerated = new Map<string, PrivateComposerScopeEntry>()
  private reading: Promise<void> | null = null
  constructor(private readonly client: Client, readonly origin: PrivateInputOrigin, private readonly view: CanvasViewScope) {
    this.origin = structuredClone(origin); this.view = { ...view }
  }
  getSnapshot = (): State => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private publish(change: Partial<State>): void { this.state = { ...this.state, ...change }; this.listeners.forEach(listener => listener()) }
  private location(scope: PrivateComposerScopeEntry): PrivateRecoveryLocation {
    const s = scope.composerScope
    if (scope.scopeKey !== (s ? `canvas:${s.boardId}:${s.nodeId}` : '') || (s && s.kind !== 'canvas')
      || typeof scope.orphaned !== 'boolean' || [scope.draftRevision, scope.attachmentCount, scope.quoteCount, scope.retainedInputCount].some(n => !Number.isSafeInteger(n) || n < 0)) return invalid()
    const context = s ? canvasComposerContext(this.view, s.boardId, s.nodeId, this.origin) : undefined
    return { id: context ? canvasComposerContextKey(context) : 'default', context, scope, bodies: [] }
  }
  private merge(): PrivateRecoveryLocation[] {
    const entries = new Map<string, PrivateRecoveryLocation>()
    const snapshots = new Map<string, SingleChatComposerState>()
    const bodyKeys = new Map<string, Set<string>>()
    for (const scope of this.scopes.values()) { const item = this.location(scope); entries.set(item.id, item) }
    const prefix = `${this.origin.threadId}:${this.origin.conversationId}`
    for (const entry of Object.values(privateInputBodyIndex(this.client))) {
      const source = entry.origin
      if (source.threadId !== this.origin.threadId || source.conversationId !== this.origin.conversationId) continue
      const context = source.contextKey === 'default' ? undefined : parseCanvasComposerContext(source.contextKey) ?? invalid()
      if (context && (context.host !== this.view.host || context.core !== this.view.core)) continue
      if ((context && (context.threadId !== source.threadId || (context.conversationId !== null && context.conversationId !== source.conversationId)
        || source.scope?.kind !== 'canvas' || source.scope.boardId !== context.boardId || source.scope.nodeId !== context.nodeId))
        || (!context && source.scope !== null)) return invalid()
      const store = singleChatComposerStore(this.client, source.threadId, context)
      if (entry.bodyStorageKey !== store.storageIdentity || (entry.bodyKey !== prefix && !entry.bodyKey.startsWith(`${prefix}:pending-edit:`)
        && !entry.bodyKey.startsWith(`${prefix}:returned:`))) return invalid()
      let local = snapshots.get(store.storageIdentity)
      if (!local) { store.reconcile(); local = store.getSnapshot(); snapshots.set(store.storageIdentity, local) }
      if (!local.ready || local.error) throw local.error ?? new Error('private_input.body_not_saved')
      const body = local.drafts[entry.bodyKey]
      if (!body) continue
      const item = entries.get(source.contextKey) ?? { id: source.contextKey, context, scope: null, bodies: [] }
      let keys = bodyKeys.get(item.id)
      if (!keys) { keys = new Set(); bodyKeys.set(item.id, keys) }
      if (!keys.has(entry.bodyKey)) { keys.add(entry.bodyKey); item.bodies.push({ key: entry.bodyKey, body }) }
      entries.set(item.id, item)
    }
    return [...entries.values()].filter(item => item.id !== this.origin.contextKey || item.bodies.some(copy => copy.key !== prefix))
  }
  read(restart = true): Promise<void> {
    if (this.reading) return this.reading
    this.reading = (async () => {
      if (!restart && !this.state.nextCursor) return
      this.publish({ loading: true, error: null })
      if (restart) this.enumerated = new Map()
      this.publish({ locations: this.merge() })
      const page = await this.client.request<PrivateComposerRecoveryResult>('singleChat.composerDraft.recovery', {
        threadId: this.origin.threadId, conversationId: this.origin.conversationId, cursor: restart ? null : this.state.nextCursor, limit: 50
      })
      for (const item of page.items) if (item.kind === 'scope') {
        this.location(item.scope)
        this.enumerated.set(item.scope.scopeKey, structuredClone(item.scope))
      }
      if (page.complete) this.scopes = new Map(this.enumerated)
      else for (const [key, scope] of this.enumerated) this.scopes.set(key, scope)
      this.publish({ locations: this.merge(), nextCursor: page.nextCursor, complete: page.complete })
    })().catch(error => { this.publish({ error, complete: false }); throw error }).finally(() => { this.publish({ loading: false }); this.reading = null })
    return this.reading
  }
}
