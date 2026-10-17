import type { PrivateAttachmentPreparationOwner, PrivateAttachmentPreparationRequest as Request,
  PrivateAttachmentPreparationResult as Result, StoredCommandResult } from '@contracts'
import type { EditingRecovery } from '../../desktop/src/renderer/src/camp-client'
import { parsePrivatePreparation } from '../../desktop/src/shared/private-upload-request'

type Intent = Request & { displayName: string; byteSize: number; sha256: string }
interface Entry { version: 1; request: Request; intent: Intent; phase: 'prepared' | 'unknown' | 'recorded' | 'rejected'; receipt?: StoredCommandResult; rejectionCode?: string }
interface Transport {
  guard(): void
  digest(file: File): Promise<string>
  bind(intent: Intent, file: File): Promise<{ rejectedCode?: string }>
  receipt(intent: Intent): Promise<{ state: 'unknown' } | { state: 'recorded'; receipt: StoredCommandResult }>
  retry?(intent: Intent): Promise<{ state: 'needs_source' } | { state: 'recorded'; receipt: StoredCommandResult }>
  finish?(intent: Intent): Promise<{ state: 'unknown' } | { state: 'recorded'; receipt: StoredCommandResult }>
}
const KEY = 'private-upload-preparations:v1'
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const fields = (value: Record<string, unknown>, allowed: string[], required = allowed) =>
  Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key))
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const invalid = (): never => { throw new Error('private_upload.invalid_recovery') }
function receipt(request: Request, value: unknown): StoredCommandResult {
  if (!object(value) || value.commandId !== request.commandId || value.commandType !== 'camp.source_attachment.upload.bind'
    || !['applied', 'accepted', 'rejected'].includes(String(value.status)) || typeof value.code !== 'string'
    || typeof value.recordedAt !== 'string' || !object(value.payload)
    || (value.status !== 'rejected' && value.payload.attachmentRefId !== request.commandId)) return invalid()
  return value as unknown as StoredCommandResult
}

/** 只持久保存原意图/回执；文件对象仅留内存，刷新后必须重选并核对原字节。 */
export class BrowserPrivateUploadPreparations {
  private readonly files = new Map<string, File>()
  private readonly preparing = new Map<string, { request: Request; promise: Promise<Result> }>()
  private readonly flights = new Map<string, { promise: Promise<Result>; resolve(result: Result): void }>()
  constructor(private readonly storage: EditingRecovery, private readonly transport: Transport) {}
  private rememberFile(id: string, file: File): void {
    this.files.delete(id); this.files.set(id, file)
    let bytes = [...this.files.values()].reduce((size, item) => size + item.size, 0)
    while (this.files.size > 16 || bytes > 40 * 1024 * 1024) {
      const oldest = this.files.keys().next().value!
      bytes -= this.files.get(oldest)!.size; this.files.delete(oldest)
    }
  }
  private entries(): Record<string, Entry> {
    const value = this.storage.get(KEY)
    if (value == null) return {}
    if (!object(value) || !fields(value, ['version', 'entries']) || value.version !== 1 || !object(value.entries)) return invalid()
    const entries: Record<string, Entry> = {}
    for (const [id, raw] of Object.entries(value.entries)) {
      if (!object(raw) || !fields(raw, ['version', 'request', 'intent', 'phase', 'receipt', 'rejectionCode'], ['version', 'request', 'intent', 'phase'])
        || raw.version !== 1 || !object(raw.intent) || !['prepared', 'unknown', 'recorded', 'rejected'].includes(String(raw.phase))) return invalid()
      const request = parsePrivatePreparation(raw.request)
      const intent = raw.intent
      if (request.commandId !== id || !fields(intent, ['commandId', 'threadId', 'expectedRevision', 'target', 'displayName', 'byteSize', 'sha256'])
        || !equal(parsePrivatePreparation({ commandId: intent.commandId, threadId: intent.threadId, expectedRevision: intent.expectedRevision, target: intent.target }), request)
        || typeof intent.displayName !== 'string' || !intent.displayName || [...intent.displayName].length > 120
        || !Number.isSafeInteger(intent.byteSize) || Number(intent.byteSize) < 0 || Number(intent.byteSize) > 20 * 1024 * 1024
        || typeof intent.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(intent.sha256)) return invalid()
      const entry: Entry = { version: 1, request, intent: { ...request, displayName: intent.displayName,
        byteSize: Number(intent.byteSize), sha256: intent.sha256 }, phase: raw.phase as Entry['phase'] }
      if (entry.phase === 'recorded') entry.receipt = receipt(request, raw.receipt)
      else if (raw.receipt !== undefined) return invalid()
      if (entry.phase === 'rejected') {
        if (typeof raw.rejectionCode !== 'string' || !raw.rejectionCode) return invalid()
        entry.rejectionCode = raw.rejectionCode
      } else if (raw.rejectionCode !== undefined) return invalid()
      entries[id] = entry
    }
    return entries
  }
  private save(entry: Entry): void { this.storage.set(KEY, { version: 1, entries: { ...this.entries(), [entry.request.commandId]: entry } }) }
  private require(request: Request): Entry {
    const entry = this.entries()[request.commandId]
    if (!entry || !equal(entry.request, request)) return invalid()
    return entry
  }
  private record(entry: Entry, value: unknown): Result {
    const result = receipt(entry.request, value)
    const current = this.require(entry.request)
    if (current.receipt && !equal(current.receipt, result)) return invalid()
    const { rejectionCode: _rejection, ...previous } = current
    this.save({ ...previous, phase: 'recorded', receipt: result })
    const recorded: Result = { state: 'recorded', commandId: entry.request.commandId, receipt: result }
    this.files.delete(entry.request.commandId)
    this.flights.get(entry.request.commandId)?.resolve(recorded)
    return recorded
  }
  private async lookup(entry: Entry): Promise<Result> {
    this.transport.guard()
    const known = this.require(entry.request)
    if (known.receipt) return { state: 'recorded', commandId: entry.request.commandId, receipt: known.receipt }
    if (known.phase === 'rejected') return { state: 'rejected', commandId: entry.request.commandId, code: known.rejectionCode! }
    try {
      const result = await this.transport.receipt(structuredClone(entry.intent))
      if (result.state === 'recorded') return this.record(entry, result.receipt)
    } catch { /* 查回失败不删除原请求，也不重传。 */ }
    const current = this.require(entry.request)
    if (current.phase === 'rejected') return { state: 'rejected', commandId: entry.request.commandId, code: current.rejectionCode! }
    return current.receipt ? { state: 'recorded', commandId: entry.request.commandId, receipt: current.receipt }
      : { state: current.phase === 'prepared' ? 'prepared' : 'unknown', commandId: entry.request.commandId }
  }
  async prepareInput(value: Request, file: File): Promise<Result> {
    const request = parsePrivatePreparation(value)
    this.transport.guard()
    const existing = this.entries()[request.commandId]
    if (existing) return this.lookup(this.require(request))
    const pending = this.preparing.get(request.commandId)
    if (pending) { if (!equal(pending.request, request)) return invalid(); return pending.promise }
    const preparing = (async (): Promise<Result> => {
      if (!file.name || [...file.name].length > 120 || file.size > 20 * 1024 * 1024) return { state: 'not_prepared', commandId: request.commandId }
      let entry: Entry
      try {
        const digest = await this.transport.digest(file)
        entry = { version: 1, request, intent: { ...request, displayName: file.name, byteSize: file.size, sha256: digest }, phase: 'prepared' }
        this.transport.guard()
        this.save(entry) // 写入失败时绝不发出 HTTP 上传。
      } catch { return { state: 'not_prepared', commandId: request.commandId } }
      this.rememberFile(request.commandId, file)
      return this.dispatch(entry, file)
    })().finally(() => { this.preparing.delete(request.commandId) })
    this.preparing.set(request.commandId, { request, promise: preparing })
    return preparing
  }
  reconcileInput(value: Request): Promise<Result> { return this.lookup(this.require(parsePrivatePreparation(value))) }
  async retryInput(value: Request, originalFile?: File): Promise<Result> {
    const request = parsePrivatePreparation(value), entry = this.require(request)
    const known = await this.lookup(entry)
    if (known.state === 'recorded' || known.state === 'rejected') return known
    if (this.transport.retry) {
      try {
        const disposition = await this.transport.retry(structuredClone(entry.intent))
        if (disposition.state === 'recorded') return this.record(entry, disposition.receipt)
        if (disposition.state !== 'needs_source') return this.lookup(entry)
      } catch { return this.lookup(entry) }
    }
    const file = originalFile ?? this.files.get(request.commandId)
    if (!file) throw new Error('private_upload.reselect_required')
    if (file.name !== entry.intent.displayName || file.size !== entry.intent.byteSize
      || await this.transport.digest(file) !== entry.intent.sha256) throw new Error('private_upload.source_changed')
    this.transport.guard()
    this.rememberFile(request.commandId, file)
    return this.dispatch(entry, file)
  }
  async finishInput(value: Request): Promise<Result> {
    if (!this.transport.finish) throw new Error('private_upload.capability_required')
    const entry = this.require(parsePrivatePreparation(value))
    const known = await this.lookup(entry)
    if (known.state === 'recorded' || known.state === 'rejected') return known
    try {
      const result = await this.transport.finish(structuredClone(entry.intent))
      if (result.state === 'recorded') return this.record(entry, result.receipt)
    } catch { /* 结束请求可能已提交，原只读查回仍是最终依据。 */ }
    return this.lookup(entry)
  }
  async pendingPreparations(owner: PrivateAttachmentPreparationOwner): Promise<Array<{ request: Request; displayName: string; state: 'prepared' | 'unknown' | 'recorded' }>> {
    this.transport.guard()
    if (!object(owner) || !fields(owner, ['threadId', 'conversationId', 'composerScope'])) return invalid()
    const canonical = parsePrivatePreparation({ commandId: '00000000-0000-4000-8000-000000000000', threadId: owner.threadId,
      expectedRevision: 0, target: { kind: 'single_chat', conversationId: owner.conversationId, composerScope: owner.composerScope } })
    return Object.values(this.entries()).filter(entry => entry.phase !== 'rejected' && entry.request.threadId === canonical.threadId
      && entry.request.target.conversationId === canonical.target.conversationId
      && equal(entry.request.target.composerScope ?? null, canonical.target.composerScope ?? null))
      .map(entry => ({ request: structuredClone(entry.request), displayName: entry.intent.displayName, state: entry.phase as 'prepared' | 'unknown' | 'recorded' }))
  }
  private dispatch(entry: Entry, file: File): Promise<Result> {
    this.transport.guard()
    const id = entry.request.commandId
    const current = this.require(entry.request)
    if (current.receipt) return Promise.resolve({ state: 'recorded', commandId: id, receipt: current.receipt })
    if (current.phase === 'rejected') return Promise.resolve({ state: 'rejected', commandId: id, code: current.rejectionCode! })
    const existing = this.flights.get(id)
    if (existing) return existing.promise
    this.save({ ...current, phase: 'unknown' })
    let finish!: (result: Result) => void
    const promise = new Promise<Result>(resolve => { finish = resolve })
    const flight = { promise, resolve: finish }
    this.flights.set(id, flight)
    void Promise.resolve().then(() => this.transport.bind(structuredClone(entry.intent), file)).catch(() => undefined)
      .then(async result => {
        if (result?.rejectedCode && current.phase === 'prepared') {
          // 首次派发才有明确拒绝资格；刷新/旧未知重试失败仍查原回执。
          const latest = this.require(entry.request)
          if (latest.receipt) return this.lookup(latest)
          this.save({ ...latest, phase: 'rejected', rejectionCode: result.rejectedCode })
          this.files.delete(id)
          return { state: 'rejected' as const, commandId: id, code: result.rejectedCode }
        }
        return this.lookup(entry)
      }).then(finish, () => finish({ state: 'unknown', commandId: id }))
    void promise.finally(() => { if (this.flights.get(id) === flight) this.flights.delete(id) })
    return promise
  }
}
