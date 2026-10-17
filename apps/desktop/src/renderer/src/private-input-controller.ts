import type {
  EditSingleChatPendingInputCommand, PrivateComposerAction, PrivateComposerRecoveryResult,
  RetainedPrivateInput, ScopedSingleChatSnapshot, SingleChatComposerScope,
  SingleChatPendingInputEditAction, SingleChatPendingInputView, SingleChatSnapshot, StoredCommandResult
} from '@contracts'
import { readScopedPrivateChat, matchesPrivateComposerScope } from '../../shared/private-composer-scope'
import { newCommandId } from '../../shared/command-id'
import type { EditingRecovery, ThreadClient } from './camp-client'
import { singleChatRecoveryStorage, type SingleChatComposerStore, type SingleChatMutationLease, type SingleChatSendLease } from './single-chat-composer-store'

type Client = Pick<ThreadClient, 'request' | 'editingRecovery' | 'privateInputRecovery' | 'onInvalidated'> & {
  retryPendingCommand?: (method: 'singleChat.composerDraft.mutate' | 'singleChat.pendingInputs.edit' | 'singleChat.send', params: unknown) => Promise<void>
}
export interface PrivateInputOrigin {
  threadId: string
  conversationId: string
  scope: SingleChatComposerScope | null
  contextKey: string
}
type Method = 'singleChat.composerDraft.mutate' | 'singleChat.pendingInputs.edit' | 'singleChat.send'
type Kind = 'return' | 'swap' | 'mutation' | 'edit' | 'send'
interface Intent {
  version: 1
  origin: PrivateInputOrigin
  kind: Kind
  method: Method
  params: { commandId: string; command: Record<string, unknown> }
  originalBody: string
  result?: StoredCommandResult
}
export interface PrivateInputState {
  snapshot: ScopedSingleChatSnapshot | null
  retained: readonly RetainedPrivateInput[]
  nextCursor: string | null
  complete: boolean
  pending: boolean
  unknown: boolean
  error: Error | null
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const failure = (code: string) => new Error(code)
const bodyKey = (origin: PrivateInputOrigin) => `${origin.threadId}:${origin.conversationId}`
const scopeKey = (scope: SingleChatComposerScope | null) => scope ? `canvas:${scope.boardId}:${scope.nodeId}` : ''
const locksBody = (kind: Kind, action?: unknown) => kind === 'return' || kind === 'swap' || (kind === 'mutation' && object(action) && action.type === 'adopt_legacy_materials')
export const PRIVATE_INPUT_BODY_INDEX = 'single-chat-input-body-index:v1'
export interface PrivateInputBodyEntry { origin: PrivateInputOrigin; bodyStorageKey: string; bodyKey: string }

export function privateInputBodyIndex(client: Pick<ThreadClient, 'editingRecovery' | 'privateInputRecovery'>): Readonly<Record<string, PrivateInputBodyEntry>> {
  const value = singleChatRecoveryStorage(client).get(PRIVATE_INPUT_BODY_INDEX)
  if (value == null) return {}
  if (!object(value) || value.version !== 1 || !object(value.entries)
    || Object.values(value.entries).some(item => !object(item) || !object(item.origin) || typeof item.bodyStorageKey !== 'string' || typeof item.bodyKey !== 'string')) throw failure('private_input.recovery_invalid')
  return value.entries as unknown as Record<string, PrivateInputBodyEntry>
}

function parseIntent(value: unknown, origin: PrivateInputOrigin): Intent | null {
  if (value == null) return null
  if (!object(value) || value.version !== 1 || !equal(value.origin, origin)
    || !['return', 'swap', 'mutation', 'edit', 'send'].includes(String(value.kind))
    || !object(value.params) || typeof value.params.commandId !== 'string'
    || typeof value.originalBody !== 'string' || !object(value.params.command)) throw failure('private_input.recovery_invalid')
  const command = value.params.command
  if (command.threadId !== origin.threadId || command.conversationId !== origin.conversationId
    || !equal(command.composerScope ?? null, origin.scope)) throw failure('private_input.recovery_invalid')
  if (value.result !== undefined && (!object(value.result) || !['applied', 'rejected', 'accepted'].includes(String(value.result.status)) || !object(value.result.payload))) throw failure('private_input.recovery_invalid')
  if (value.kind === 'send') {
    if (value.method !== 'singleChat.send' || typeof command.body !== 'string' || !Number.isSafeInteger(command.draftRevision)) throw failure('private_input.recovery_invalid')
    return value as unknown as Intent
  }
  if (!object(command.action)) throw failure('private_input.recovery_invalid')
  const action = String(command.action.type)
  const pending = value.method === 'singleChat.pendingInputs.edit'
  const mutation = value.method === 'singleChat.composerDraft.mutate'
  if ((!pending && !mutation) || (value.kind === 'return' && (!pending || action !== 'return_to_composer'))
    || (value.kind === 'swap' && (!mutation || action !== 'swap_retained'))
    || (value.kind === 'edit' && (!pending || !['begin', 'takeover', 'save', 'cancel', 'delete', 'quote', 'remove_attachment', 'reorder_attachments'].includes(action)))
    || (value.kind === 'mutation' && (!mutation || !['register_scope', 'remove_attachment', 'reorder_attachments', 'quote', 'discard_retained', 'adopt_legacy_materials'].includes(action)))) throw failure('private_input.recovery_invalid')
  return value as unknown as Intent
}

/** 一个可信编辑端/Conversation/卡片的输入交接；从不创建私聊、执行模型或伪造编辑端。 */
export class PrivateInputController {
  readonly origin: PrivateInputOrigin
  private state: PrivateInputState = { snapshot: null, retained: [], nextCursor: null, complete: false, pending: false, unknown: false, error: null }
  private readonly listeners = new Set<() => void>()
  private readonly storage: EditingRecovery
  private readonly storageKey: string
  private intent: Intent | null = null
  private lease: SingleChatMutationLease | null = null
  private sendLease: SingleChatSendLease | null = null
  private reading: Promise<ScopedSingleChatSnapshot | null> | null = null
  private readingPage: Promise<void> | null = null
  private enumerated = new Map<string, RetainedPrivateInput>()
  private registered = false
  private completing: Promise<void> | null = null
  private remembered = false
  private registrationAttempted = false
  private completion: { id: string; promise: Promise<void>; resolve(): void; reject(error: unknown): void } | null = null

  constructor(private readonly client: Client, origin: PrivateInputOrigin, private readonly bodies: SingleChatComposerStore) {
    this.origin = structuredClone(origin)
    this.storage = singleChatRecoveryStorage(client)
    this.storageKey = `single-chat-input-intent:v1:${JSON.stringify(this.origin)}`
    try {
      this.intent = parseIntent(this.storage.get(this.storageKey), this.origin)
      if (this.intent) { this.claim(this.intent.kind, this.intent.params.command.action); this.state.pending = true }
    } catch (error) { this.state.error = error as Error; this.state.pending = true; this.lease = this.bodies.tryBeginMutation(bodyKey(this.origin)) }
  }
  getSnapshot = (): PrivateInputState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private publish(change: Partial<PrivateInputState>): void { this.state = { ...this.state, ...change }; this.listeners.forEach(listener => listener()) }
  private claim(kind: Kind, action?: unknown): void {
    if (kind === 'send') {
      this.sendLease = this.bodies.tryBeginSend(bodyKey(this.origin))
      if (!this.sendLease) throw failure('private_input.busy')
      return
    }
    if (!locksBody(kind, action)) return
    this.lease = this.bodies.tryBeginMutation(bodyKey(this.origin))
    if (!this.lease) throw failure('private_input.busy')
  }
  private save(intent: Intent | null): void { this.storage.set(this.storageKey, intent === null ? null : structuredClone(intent)) }
  private same(intent: Intent): boolean { return this.intent?.params.commandId === intent.params.commandId }

  refresh(): Promise<ScopedSingleChatSnapshot | null> {
    if (this.reading) return this.reading
    this.reading = readScopedPrivateChat(this.client, this.origin.threadId, this.origin.conversationId, this.origin.scope)
      .then(snapshot => { this.publish({ snapshot, error: this.state.pending ? this.state.error : null }); return snapshot })
      .catch(error => { this.publish({ snapshot: null, error }); throw error })
      .finally(() => { this.reading = null })
    return this.reading
  }
  async readRetained(restart = true): Promise<void> {
    if (this.readingPage) return this.readingPage
    this.readingPage = (async () => {
      const cursor = restart ? null : this.state.nextCursor
      if (!restart && !cursor) return
      if (restart) this.enumerated = new Map()
      const page = await this.client.request<PrivateComposerRecoveryResult>('singleChat.composerDraft.recovery', {
        threadId: this.origin.threadId, conversationId: this.origin.conversationId, cursor, limit: 50
      })
      for (const item of page.items) {
        if (item.kind === 'scope' && item.scope.scopeKey === scopeKey(this.origin.scope)) this.registered = true
        if (item.kind !== 'retained' || item.input.conversationId !== this.origin.conversationId || item.input.scopeKey !== scopeKey(this.origin.scope)) continue
        this.enumerated.set(item.input.id, item.input)
      }
      const merged = page.complete ? new Map() : new Map(this.state.retained.map(input => [input.id, input]))
      for (const [id, input] of this.enumerated) if (!merged.has(id) || merged.get(id)!.revision <= input.revision) merged.set(id, input)
      this.publish({ retained: [...merged.values()], nextCursor: page.nextCursor, complete: page.complete })
    })().catch(error => { this.publish({ error }); throw error }).finally(() => { this.readingPage = null })
    return this.readingPage
  }

  async returnPending(item: SingleChatPendingInputView, editToken: string | null): Promise<void> {
    await this.start('return', 'singleChat.pendingInputs.edit', snapshot => ({
      threadId: this.origin.threadId, conversationId: this.origin.conversationId, composerScope: this.origin.scope,
      pendingInputId: item.id, expectedRevision: item.revision, editToken,
      action: { type: 'return_to_composer', expectedDraftRevision: snapshot.draft.revision, targetBody: this.bodies.getSnapshot().drafts[bodyKey(this.origin)] ?? '' }
    }))
  }
  async send(originalBody: string): Promise<void> {
    await this.start('send', 'singleChat.send', snapshot => ({ threadId: this.origin.threadId, conversationId: this.origin.conversationId,
      body: originalBody.trim(), draftRevision: snapshot.draft.revision, ...(this.origin.scope ? { composerScope: this.origin.scope } : {}) }), undefined, originalBody)
  }
  async swap(input: RetainedPrivateInput): Promise<void> {
    if (input.conversationId !== this.origin.conversationId || input.scopeKey !== scopeKey(this.origin.scope)) throw failure('private_input.context_changed')
    await this.start('swap', 'singleChat.composerDraft.mutate', snapshot => ({
      threadId: this.origin.threadId, conversationId: this.origin.conversationId, composerScope: this.origin.scope,
      expectedDraftRevision: snapshot.draft.revision,
      action: { type: 'swap_retained', retainedInputId: input.id, expectedRetainedRevision: input.revision, currentBody: this.bodies.getSnapshot().drafts[bodyKey(this.origin)] ?? '' }
    }))
  }
  edit(item: SingleChatPendingInputView, action: Exclude<SingleChatPendingInputEditAction, { type: 'return_to_composer' }>, editToken: string | null): Promise<void> {
    const command: EditSingleChatPendingInputCommand = { threadId: this.origin.threadId, conversationId: this.origin.conversationId, composerScope: this.origin.scope,
      pendingInputId: item.id, expectedRevision: item.revision, editToken, action }
    return this.start('edit', 'singleChat.pendingInputs.edit', () => command as unknown as Record<string, unknown>)
  }
  mutate(action: Exclude<PrivateComposerAction, { type: 'swap_retained' }>): Promise<void> {
    return this.start('mutation', 'singleChat.composerDraft.mutate', snapshot => ({ threadId: this.origin.threadId, conversationId: this.origin.conversationId,
      composerScope: this.origin.scope, expectedDraftRevision: snapshot.draft.revision, action }), action)
  }
  adoptLegacyMaterials(expectedSourceRevision: number): Promise<void> {
    if (!this.origin.scope || !Number.isSafeInteger(expectedSourceRevision) || expectedSourceRevision < 0) return Promise.reject(failure('private_input.context_changed'))
    return this.start('mutation', 'singleChat.composerDraft.mutate', snapshot => ({
      threadId: this.origin.threadId, conversationId: this.origin.conversationId, composerScope: this.origin.scope,
      expectedDraftRevision: snapshot.draft.revision,
      action: { type: 'adopt_legacy_materials', expectedSourceRevision, targetBody: this.bodies.getSnapshot().drafts[bodyKey(this.origin)] ?? '' }
    }), { type: 'adopt_legacy_materials' })
  }
  retainBodyCopy(body: string): void {
    if (this.state.pending || !this.bodies.canLeave(bodyKey(this.origin))) throw failure('private_input.busy')
    const key = `${bodyKey(this.origin)}:returned:${newCommandId()}`
    if (!this.bodies.update(current => ({ ...current, [key]: body }))) throw failure('private_input.body_not_saved')
    this.rememberBody(key)
  }
  rememberBody(localKey = bodyKey(this.origin)): void {
    const primary = localKey === bodyKey(this.origin)
    if (primary && this.remembered) return
    if (!this.bodies.getSnapshot().ready || this.bodies.getSnapshot().error) throw failure('private_input.body_not_saved')
    const entries = privateInputBodyIndex(this.client)
    this.storage.set(PRIVATE_INPUT_BODY_INDEX, { version: 1, entries: { ...entries, [primary ? this.storageKey : JSON.stringify([this.storageKey, localKey])]: {
      origin: this.origin, bodyStorageKey: this.bodies.storageIdentity, bodyKey: localKey
    } } })
    if (primary) this.remembered = true
  }
  async ensureRegistered(): Promise<ScopedSingleChatSnapshot | null> {
    this.rememberBody()
    if (this.origin.scope && !this.registered) await this.mutate({ type: 'register_scope' })
    return this.refresh()
  }
  async prepareBody(): Promise<void> {
    this.rememberBody()
    if (!this.origin.scope || this.registered || this.registrationAttempted || this.state.pending) return
    this.registrationAttempted = true
    await this.ensureRegistered()
  }

  private async start(kind: Kind, method: Method, command: (snapshot: SingleChatSnapshot) => Record<string, unknown>, action?: unknown, originalBody?: string): Promise<void> {
    if (this.state.pending || !this.bodies.getSnapshot().ready || this.bodies.getSnapshot().error) throw failure('private_input.busy')
    this.claim(kind, action)
    this.publish({ pending: true, unknown: false, error: null })
    let prepared: Intent | null = null
    try {
      this.rememberBody()
      const snapshot = kind === 'send' && !this.origin.scope
        ? await this.client.request<SingleChatSnapshot | null>('singleChat.get', { conversationId: this.origin.conversationId })
        : await this.refresh()
      if (!snapshot || snapshot.conversation.status !== 'active') throw failure('private_input.context_changed')
      if (snapshot.conversation.id !== this.origin.conversationId || snapshot.conversation.threadId !== this.origin.threadId) throw failure('private_input.context_changed')
      prepared = { version: 1, origin: this.origin, kind, method,
        params: structuredClone({ commandId: newCommandId(), command: command(snapshot) }), originalBody: originalBody ?? this.bodies.getSnapshot().drafts[bodyKey(this.origin)] ?? '' }
      this.save(prepared)
      this.intent = prepared
    } catch (error) {
      this.lease?.release(); this.lease = null; this.sendLease?.release(); this.sendLease = null
      this.publish({ pending: false, error: error as Error })
      throw error
    }
    await this.dispatch(prepared)
  }
  private settle(commandId: string, error?: unknown): void {
    const completion = this.completion
    if (completion?.id !== commandId) return
    this.completion = null
    if (error === undefined) completion.resolve()
    else completion.reject(error)
  }
  private dispatch(intent: Intent): Promise<void> {
    let completion = this.completion
    if (!completion) {
      let resolve!: () => void, reject!: (error: unknown) => void
      const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail })
      completion = { id: intent.params.commandId, promise, resolve, reject }
      this.completion = completion
    }
    void Promise.resolve().then(() => this.client.request<StoredCommandResult>(intent.method, structuredClone(intent.params)))
      .then(async result => { if (this.same(intent)) await this.accept(intent, result) })
      .catch(error => {
        if (this.same(intent)) this.publish({ error })
        this.settle(intent.params.commandId, error)
      })
    return completion.promise
  }
  private accept(intent: Intent, result: StoredCommandResult): Promise<void> {
    if (!this.same(intent)) return Promise.resolve()
    const expectedType = intent.method === 'singleChat.send' ? 'single_chat.send' : intent.method === 'singleChat.pendingInputs.edit' ? 'single_chat.pending_input.edit' : 'single_chat.composer_draft.mutate'
    if (result.commandId !== intent.params.commandId || result.commandType !== expectedType) return Promise.reject(failure('private_input.context_changed'))
    if (this.completing) return this.completing
    this.completing = Promise.resolve().then(async () => {
      if (!this.same(intent)) return
      const recorded = { ...intent, result }
      this.save(recorded)
      this.intent = recorded
      await this.finish(recorded)
    }).finally(() => { this.completing = null })
    return this.completing
  }
  private async finish(intent: Intent): Promise<void> {
    const result = intent.result!
    if (result.status !== 'rejected' && intent.kind === 'send' && !this.sendLease?.applyReceipt(intent.params.commandId, intent.originalBody)) throw failure('private_input.body_not_saved')
    if (result.status !== 'rejected' && (intent.kind === 'return' || intent.kind === 'swap')) {
      const payload = result.payload
      if (!matchesPrivateComposerScope({ conversation: { id: this.origin.conversationId, threadId: this.origin.threadId }, draft: payload.draft },
        this.origin.threadId, this.origin.conversationId, this.origin.scope)) throw failure('private_input.context_changed')
      const changesBody = intent.kind === 'swap' || payload.placement === 'active'
      if (intent.kind === 'return' && !['active', 'retained'].includes(String(payload.placement))) throw failure('private_input.recovery_invalid')
      if (changesBody && typeof payload.body !== 'string') throw failure('private_input.recovery_invalid')
      const marker = `${bodyKey(this.origin)}:returned:${intent.params.commandId}`
      if (changesBody && !Object.hasOwn(this.bodies.getSnapshot().drafts, marker)) {
        const current = await this.refresh()
        if (!current || current.draft.revision !== (payload.draft as { revision: number }).revision) throw failure('private_input.context_changed')
      }
      if (!this.lease?.applyReceipt(intent.params.commandId, intent.originalBody, changesBody ? payload.body as string : undefined)) throw failure('private_input.body_not_saved')
    }
    this.save(null)
    this.intent = null
    if (intent.kind === 'mutation' && (intent.params.command.action as { type: string }).type === 'register_scope' && result.status !== 'rejected') this.registered = true
    let refreshError: Error | null = null
    try { await this.refresh(); await this.readRetained() } catch (error) { refreshError = error as Error }
    finally {
      this.lease?.release(); this.lease = null; this.sendLease?.release(); this.sendLease = null
      this.publish({ pending: false, unknown: false, error: result.status === 'rejected' ? failure(result.code) : refreshError })
    }
    const rejected = result.status === 'rejected' ? failure(result.code) : undefined
    this.settle(intent.params.commandId, rejected)
    if (rejected) throw rejected
  }
  async recover(): Promise<void> {
    const intent = this.intent
    if (!intent) { if (this.state.pending) throw failure('private_input.recovery_invalid'); return }
    try {
      if (locksBody(intent.kind, intent.params.command.action) && !this.lease) this.claim(intent.kind, intent.params.command.action)
      if (intent.kind === 'send' && !this.sendLease) this.claim(intent.kind)
      if (intent.result) { await this.accept(intent, intent.result); return }
      const reply = await this.client.request<{ state: string; result?: StoredCommandResult }>('commands.reconcile', { operation: intent.method, params: structuredClone(intent.params) })
      if (!this.same(intent)) return
      if (reply.state === 'recorded' && reply.result) await this.accept(intent, reply.result)
      else this.publish({ unknown: reply.state === 'unknown', error: failure('private_input.result_unknown') })
    } catch (error) { this.publish({ error: error as Error }); throw error }
  }
  async retry(): Promise<void> {
    await this.recover()
    const intent = this.intent
    if (!intent || intent.result || !this.state.unknown) return
    this.save(intent)
    this.publish({ unknown: false, error: null })
    if (this.client.retryPendingCommand) { await this.client.retryPendingCommand(intent.method, structuredClone(intent.params)); await this.recover() }
    else await this.dispatch(intent)
  }
}

const owners = new WeakMap<object, Map<string, PrivateInputController>>()
export function privateInputController(client: Client, origin: PrivateInputOrigin, bodies: SingleChatComposerStore): PrivateInputController {
  let contexts = owners.get(client)
  if (!contexts) { contexts = new Map(); owners.set(client, contexts) }
  const key = JSON.stringify(origin)
  let controller = contexts.get(key)
  if (!controller) { controller = new PrivateInputController(client, origin, bodies); contexts.set(key, controller) }
  return controller
}
