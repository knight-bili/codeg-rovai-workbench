import type { PrivateAttachmentPreparationOwner, PrivateAttachmentPreparationRequest,
  PrivateAttachmentPreparationResult, PrivateAttachmentUploadTarget, RovaiApi } from '@contracts'
import { newCommandId } from '../../shared/command-id'

type Api = RovaiApi['singleChatAttachments']
export interface PrivateUploadRow {
  request: PrivateAttachmentPreparationRequest
  displayName: string
  state: 'preparing' | 'prepared' | 'unknown' | 'rejected'
  error: Error | null
}
export interface PrivateUploadState {
  rows: readonly PrivateUploadRow[]
  loaded: boolean
  error: Error | null
  applied: number
}
const scopeKey = (scope: PrivateAttachmentUploadTarget['composerScope']) => scope ? JSON.stringify([scope.kind, scope.boardId, scope.nodeId]) : ''
const targetKey = (target: PrivateAttachmentUploadTarget) => JSON.stringify([
  target.kind, target.conversationId, scopeKey(target.composerScope),
  target.kind === 'single_chat_pending' ? target.pendingInputId : null,
  target.kind === 'single_chat_pending' ? target.editToken : null
])
export { targetKey as privateUploadTargetKey }
const failure = (code: string) => new Error(code)

/** 共享界面仅保留进度；原请求和文件由平台准备日志持有，不创建第二份模型材料。 */
export class PrivateUploadController {
  readonly owner: PrivateAttachmentPreparationOwner
  readonly target: PrivateAttachmentUploadTarget
  readonly supported: boolean
  private state: PrivateUploadState = { rows: [], loaded: false, error: null, applied: 0 }
  private readonly listeners = new Set<() => void>()
  private readonly completed = new Map<string, boolean>()
  private readonly retries = new Map<string, Promise<void>>()
  private readonly finishing = new Map<string, Promise<void>>()
  private reading: Promise<void> | null = null

  constructor(private readonly api: Api, owner: PrivateAttachmentPreparationOwner, target: PrivateAttachmentUploadTarget) {
    this.owner = structuredClone(owner)
    this.target = structuredClone(target)
    if (owner.conversationId !== target.conversationId || scopeKey(owner.composerScope) !== scopeKey(target.composerScope)) throw failure('private_upload.context_changed')
    this.supported = Boolean(api.prepareInput && api.reconcileInput && api.retryInput && api.pendingPreparations)
  }
  getSnapshot = (): PrivateUploadState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  get blocked(): boolean { return !this.state.loaded || this.state.rows.some(row => row.state !== 'rejected') }
  get canFinish(): boolean { return Boolean(this.api.finishInput) }
  private publish(change: Partial<PrivateUploadState>): void {
    this.state = { ...this.state, ...change }; this.listeners.forEach(listener => listener())
  }
  private row(id: string): PrivateUploadRow {
    const row = this.state.rows.find(item => item.request.commandId === id)
    if (!row) throw failure('private_upload.invalid_recovery')
    return row
  }
  private update(id: string, change: Partial<PrivateUploadRow>): void {
    if (!this.completed.has(id)) this.publish({ rows: this.state.rows.map(row => row.request.commandId === id ? { ...row, ...change } : row) })
  }
  private accept(request: PrivateAttachmentPreparationRequest, result: PrivateAttachmentPreparationResult): void {
    if (this.completed.has(request.commandId)) return
    if (result.commandId !== request.commandId) throw failure('private_upload.invalid_recovery')
    if (result.state === 'not_prepared' || result.state === 'rejected') {
      this.completed.set(request.commandId, false)
      this.publish({ rows: this.state.rows.map(row => row.request.commandId === request.commandId
        ? { ...row, state: 'rejected', error: failure(result.state === 'rejected' ? result.code : 'private_upload.not_prepared') } : row) })
      return
    }
    if (result.state === 'prepared' || result.state === 'unknown') { this.update(request.commandId, { state: result.state, error: null }); return }
    if (result.state !== 'recorded') throw failure('private_upload.invalid_recovery')
    const receipt = result.receipt
    if (receipt.commandId !== request.commandId || receipt.commandType !== 'camp.source_attachment.upload.bind'
      || !['applied', 'accepted', 'rejected'].includes(receipt.status)
      || (receipt.status !== 'rejected' && receipt.payload.attachmentRefId !== request.commandId)) throw failure('private_upload.invalid_recovery')
    this.completed.set(request.commandId, receipt.status !== 'rejected')
    this.publish({ rows: receipt.status === 'rejected'
      ? this.state.rows.map(row => row.request.commandId === request.commandId ? { ...row, state: 'rejected', error: failure(receipt.code) } : row)
      : this.state.rows.filter(row => row.request.commandId !== request.commandId),
      applied: this.state.applied + (receipt.status === 'rejected' ? 0 : 1) })
  }
  load(): Promise<void> {
    if (this.reading) return this.reading
    if (!this.supported) return Promise.reject(failure('private_upload.capability_required'))
    this.reading = (async () => {
      const entries = await this.api.pendingPreparations!(structuredClone(this.owner))
      const rows = new Map(this.state.rows.map(row => [row.request.commandId, row]))
      for (const entry of entries) {
        if (entry.request.threadId !== this.owner.threadId || entry.request.target.conversationId !== this.owner.conversationId
          || scopeKey(entry.request.target.composerScope) !== scopeKey(this.owner.composerScope)) throw failure('private_upload.context_changed')
        if (targetKey(entry.request.target) !== targetKey(this.target) || this.completed.has(entry.request.commandId)) continue
        // 已结清的历史日志不重新占用输入；本次仍在界面的请求查回原回执后结清。
        if (entry.state === 'recorded' && !rows.has(entry.request.commandId)) continue
        rows.set(entry.request.commandId, { request: structuredClone(entry.request), displayName: entry.displayName,
          state: entry.state === 'recorded' ? 'unknown' : entry.state, error: null })
      }
      this.publish({ rows: [...rows.values()], loaded: true, error: null })
      for (const row of this.state.rows) if (row.state !== 'rejected') await this.recover(row.request.commandId)
    })().catch(error => { this.publish({ error }); throw error }).finally(() => { this.reading = null })
    return this.reading
  }
  async prepare(expectedRevision: number, file: File): Promise<boolean> {
    if (!this.supported) throw failure('private_upload.capability_required')
    if (this.blocked) throw failure('private_upload.busy')
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw failure('private_upload.context_changed')
    const request: PrivateAttachmentPreparationRequest = { commandId: newCommandId(), threadId: this.owner.threadId,
      expectedRevision, target: structuredClone(this.target) }
    this.publish({ rows: [...this.state.rows, { request, displayName: file.name, state: 'preparing', error: null }] })
    try {
      this.accept(request, await this.api.prepareInput!(structuredClone(request), file))
      return this.completed.get(request.commandId) === true
    }
    catch (error) {
      if (this.completed.has(request.commandId)) return this.completed.get(request.commandId) === true
      this.update(request.commandId, { state: 'unknown', error: error as Error }); throw error
    }
  }
  async recover(id: string): Promise<void> {
    if (this.completed.has(id)) return
    const request = structuredClone(this.row(id).request)
    try { this.accept(request, await this.api.reconcileInput!(request)) }
    catch (error) { if (!this.completed.has(id)) { this.update(id, { state: 'unknown', error: error as Error }); throw error } }
  }
  retry(id: string, originalFile?: File): Promise<void> {
    const existing = this.retries.get(id)
    if (existing) return existing
    const operation = (async () => {
      await this.recover(id)
      if (this.completed.has(id)) return
      const request = structuredClone(this.row(id).request)
      try { this.accept(request, await this.api.retryInput!(request, originalFile)) }
      catch (error) { if (!this.completed.has(id)) { this.update(id, { state: 'unknown', error: error as Error }); throw error } }
    })().finally(() => { this.retries.delete(id) })
    this.retries.set(id, operation)
    return operation
  }
  dismiss(id: string): void {
    if (this.row(id).state !== 'rejected') throw failure('private_upload.busy')
    this.publish({ rows: this.state.rows.filter(row => row.request.commandId !== id) })
  }
  finish(id: string): Promise<void> {
    const existing = this.finishing.get(id)
    if (existing) return existing
    if (!this.api.finishInput) return Promise.reject(failure('private_upload.capability_required'))
    const operation = (async () => {
      await this.recover(id)
      if (this.completed.has(id)) return
      const request = structuredClone(this.row(id).request)
      try { this.accept(request, await this.api.finishInput!(request)) }
      catch (error) { if (!this.completed.has(id)) { this.update(id, { state: 'unknown', error: error as Error }); throw error } }
    })().finally(() => { this.finishing.delete(id) })
    this.finishing.set(id, operation)
    return operation
  }
}

const controllers = new WeakMap<Api, Map<string, PrivateUploadController>>()
export function privateUploadController(api: Api, owner: PrivateAttachmentPreparationOwner, target: PrivateAttachmentUploadTarget): PrivateUploadController {
  if (owner.conversationId !== target.conversationId || scopeKey(owner.composerScope) !== scopeKey(target.composerScope)) throw failure('private_upload.context_changed')
  let entries = controllers.get(api)
  if (!entries) { entries = new Map(); controllers.set(api, entries) }
  const key = `${owner.threadId}:${targetKey(target)}`
  let controller = entries.get(key)
  if (!controller) { controller = new PrivateUploadController(api, owner, target); entries.set(key, controller) }
  return controller
}
