import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type {
  PrivateAttachmentPreparationOwner, PrivateAttachmentPreparationRequest,
  PrivateAttachmentPreparationResult, StoredCommandResult
} from '@contracts'
import { isAttachmentId } from './attachment-desktop'
import { parsePrivatePreparation } from '../shared/private-upload-request'
export { parsePrivatePreparation } from '../shared/private-upload-request'

type HostMethod = 'host.upload.observe' | 'host.upload.bind' | 'host.upload.receipt' | 'host.upload.retry' | 'host.upload.finish'
interface Core { request<T>(method: HostMethod, params: unknown): Promise<T> }
type Input = { displayName: string; mediaType: string | null } & (
  { sourcePath: string } | { bytes: Uint8Array }
)
interface Source {
  id: string; sourcePath: string; displayName: string; kind: 'file' | 'directory'
  mediaType: string | null; observedByteSize: number | null
}
interface Observation {
  intent: PrivateAttachmentPreparationRequest & { displayName: string; byteSize: number; sha256: string; sourceKind?: 'directory' }
  source: Source
}
interface Entry extends Observation {
  version: 1
  request: PrivateAttachmentPreparationRequest
  original: { displayName: string; mediaType: string | null; owned: boolean }
  phase: 'prepared' | 'unknown' | 'recorded'
  receipt?: StoredCommandResult
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const fields = (value: Record<string, unknown>, allowed: string[], required = allowed) =>
  Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key))
const fail = (): never => { throw new Error('private_upload.invalid_recovery') }
function recordedReceipt(entry: Pick<Entry, 'request'>, value: unknown): StoredCommandResult {
  if (!object(value) || value.commandId !== entry.request.commandId || value.commandType !== 'camp.source_attachment.upload.bind'
    || !['applied', 'accepted', 'rejected'].includes(String(value.status)) || !object(value.payload)
    || typeof value.code !== 'string' || typeof value.recordedAt !== 'string'
    || (value.status !== 'rejected' && value.payload.attachmentRefId !== entry.request.commandId)) return fail()
  return value as unknown as StoredCommandResult
}


function observation(value: unknown, request: PrivateAttachmentPreparationRequest): Observation {
  if (!object(value) || !object(value.intent) || !object(value.source)) return fail()
  const intent = value.intent
  const source = value.source
  if (!isDeepStrictEqual(parsePrivatePreparation({ commandId: intent.commandId, threadId: intent.threadId,
    expectedRevision: intent.expectedRevision, target: intent.target }), request)
    || !fields(intent, ['commandId', 'threadId', 'expectedRevision', 'target', 'displayName', 'byteSize', 'sha256', 'sourceKind'],
      ['commandId', 'threadId', 'expectedRevision', 'target', 'displayName', 'byteSize', 'sha256'])
    || typeof intent.displayName !== 'string' || !intent.displayName || [...intent.displayName].length > 120
    || !Number.isSafeInteger(intent.byteSize) || Number(intent.byteSize) < 0
    || typeof intent.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(intent.sha256)
    || !fields(source, ['id', 'sourcePath', 'displayName', 'kind', 'mediaType', 'observedByteSize'])
    || source.id !== request.commandId || (source.kind !== 'file' && source.kind !== 'directory')
    || typeof source.sourcePath !== 'string' || !isAbsolute(source.sourcePath)
    || source.displayName !== intent.displayName
    || (source.kind === 'directory'
      ? intent.sourceKind !== 'directory' || source.observedByteSize !== null || source.mediaType !== null
      : intent.sourceKind !== undefined || source.observedByteSize !== intent.byteSize)
    || (source.mediaType !== null && typeof source.mediaType !== 'string')) return fail()
  return value as unknown as Observation
}

// 每个 Core 数据目录独立保存；本机文件路径不返回 Renderer，不存认证凭据或完整聊天快照。
export class PrivateAttachmentPreparations {
  readonly #root: string
  #locks = new Map<string, Promise<unknown>>()
  #flights = new Map<string, { promise: Promise<PrivateAttachmentPreparationResult>; resolve(value: PrivateAttachmentPreparationResult): void }>()
  constructor(root: string, private readonly core: Core) {
    if (!isAbsolute(root)) throw new Error('private_upload.absolute_root_required')
    this.#root = resolve(root)
  }
  #path(id: string): string { return join(this.#root, `${id}.json`) }
  #source(id: string, name: string): string {
    const extension = extname(name).toLowerCase()
    return join(this.#root, 'sources', id, `source${/^\.[a-z0-9]{1,16}$/.test(extension) ? extension : ''}`)
  }
  async #locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (this.#locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(action)
    this.#locks.set(id, next)
    try { return await next } finally { if (this.#locks.get(id) === next) this.#locks.delete(id) }
  }
  async #write(entry: Entry): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 })
    const temporary = `${this.#path(entry.request.commandId)}.${randomUUID()}.writing`
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(entry)); await file.sync() } finally { await file.close() }
    await rename(temporary, this.#path(entry.request.commandId))
  }
  async #read(id: string): Promise<Entry | null> {
    let value: unknown
    try { value = JSON.parse(await readFile(this.#path(id), 'utf8')) } catch (error) {
      if (object(error) && error.code === 'ENOENT') return null
      throw error
    }
    if (!object(value) || value.version !== 1 || !object(value.original)
      || typeof value.original.displayName !== 'string' || typeof value.original.owned !== 'boolean'
      || (value.original.mediaType !== null && typeof value.original.mediaType !== 'string')
      || !['prepared', 'unknown', 'recorded'].includes(String(value.phase))) return fail()
    const request = parsePrivatePreparation(value.request)
    if (request.commandId !== id) return fail()
    const observed = observation(value, request)
    if (value.original.owned && (observed.source.kind !== 'file' || observed.source.sourcePath !== this.#source(id, value.original.displayName))) return fail()
    const entry = { ...value, ...observed, request } as Entry
    if (entry.phase === 'recorded') entry.receipt = recordedReceipt(entry, value.receipt)
    else if (value.receipt !== undefined) return fail()
    return entry
  }
  async #require(request: PrivateAttachmentPreparationRequest): Promise<Entry> {
    const entry = await this.#read(request.commandId)
    if (!entry || !isDeepStrictEqual(entry.request, request)) return fail()
    return entry
  }
  async prepare(value: unknown, original: unknown): Promise<PrivateAttachmentPreparationResult> {
    const request = parsePrivatePreparation(value)
    if (!object(original) || !fields(original, ['displayName', 'mediaType', ...('bytes' in original ? ['bytes'] : ['sourcePath'])])
      || (typeof original.sourcePath !== 'string' && !(original.bytes instanceof Uint8Array))) return fail()
    const data = original as Input
    const input = 'bytes' in data ? { ...data, bytes: new Uint8Array(data.bytes) } : { ...data }
    if (typeof input.displayName !== 'string' || !input.displayName || input.displayName.length > 4096
      || (input.mediaType !== null && typeof input.mediaType !== 'string')) return fail()
    if ('sourcePath' in input ? !isAbsolute(input.sourcePath) : input.bytes.byteLength > 25 * 1024 * 1024) return fail()
    const prepared = await this.#locked(request.commandId, async () => {
      const existing = await this.#read(request.commandId)
      if (existing) {
        if (!isDeepStrictEqual(existing.request, request) || existing.original.displayName !== input.displayName
          || existing.original.mediaType !== input.mediaType || existing.original.owned !== ('bytes' in input)
          || ('sourcePath' in input ? existing.source.sourcePath !== input.sourcePath
            : existing.intent.sha256 !== createHash('sha256').update(input.bytes).digest('hex'))) return fail()
        return { entry: existing, created: false }
      }
      try {
        let sourcePath: string
        if ('sourcePath' in input) sourcePath = input.sourcePath
        else {
          sourcePath = this.#source(request.commandId, input.displayName)
          await mkdir(join(this.#root, 'sources', request.commandId), { recursive: true, mode: 0o700 })
          // 写入及落盘完成后才观察；从未发给 Core 的同编号残留也不能静默覆盖。
          try {
            const file = await open(sourcePath, 'wx', 0o600)
            try { await file.writeFile(input.bytes); await file.sync() } finally { await file.close() }
          } catch (error) {
            // 崩溃可能留下已完整落盘但尚未登记的同编号文件；只复用逐字相同的原输入。
            if (!object(error) || error.code !== 'EEXIST'
              || !isDeepStrictEqual(new Uint8Array(await readFile(sourcePath)), input.bytes)) throw error
          }
        }
        const observed = observation(await this.core.request('host.upload.observe', {
          ...request, sourcePath, displayName: input.displayName, mediaType: input.mediaType
        }), request)
        if (observed.source.sourcePath !== sourcePath) return fail()
        if ('bytes' in input && observed.source.kind !== 'file') return fail()
        const entry: Entry = { version: 1, ...observed, request,
          original: { displayName: input.displayName, mediaType: input.mediaType, owned: 'bytes' in input }, phase: 'prepared' }
        await this.#write(entry)
        return { entry, created: true }
      } catch {
        // 此锁内已确认没有旧日志，且尚未调用 bind；只读 observe 的失败不会产生业务结果。
        return null
      }
    })
    if (!prepared) return { state: 'not_prepared', commandId: request.commandId }
    // 已存在的请求只核对，不把重复 prepare 调用解释为重试。
    return prepared.created ? this.#dispatch(prepared.entry) : this.#lookup(prepared.entry)
  }
  async reconcile(value: unknown): Promise<PrivateAttachmentPreparationResult> {
    return this.#lookup(await this.#require(parsePrivatePreparation(value)))
  }
  async retry(value: unknown): Promise<PrivateAttachmentPreparationResult> {
    const entry = await this.#require(parsePrivatePreparation(value))
    const result = await this.#lookup(entry)
    if (result.state === 'recorded') return result
    try {
      const disposition = await this.core.request<{ receipt: unknown }>('host.upload.retry', entry.intent)
      if (!object(disposition) || !fields(disposition, ['receipt'])) return this.#lookup(entry)
      if (disposition.receipt != null) return await this.#record(entry, disposition.receipt)
    } catch { return this.#lookup(entry) }
    const observed = observation(await this.core.request('host.upload.observe', {
      ...entry.request, sourcePath: entry.source.sourcePath,
      displayName: entry.source.displayName, mediaType: entry.source.mediaType
    }), entry.request)
    if (!isDeepStrictEqual(observed, { intent: entry.intent, source: entry.source })) throw new Error('private_upload.source_changed')
    return this.#dispatch(entry)
  }
  async finish(value: unknown): Promise<PrivateAttachmentPreparationResult> {
    const entry = await this.#require(parsePrivatePreparation(value))
    const known = await this.#lookup(entry)
    if (known.state === 'recorded') return known
    try {
      const result = await this.core.request<{ receipt: unknown }>('host.upload.finish', entry.intent)
      return await this.#record(entry, result.receipt)
    } catch { return this.#lookup(entry) }
  }
  async list(value: unknown): Promise<Array<{
    request: PrivateAttachmentPreparationRequest; displayName: string; state: Entry['phase']
  }>> {
    if (!object(value) || !fields(value, ['threadId', 'conversationId', 'composerScope'])) return fail()
    const owner = value as unknown as PrivateAttachmentPreparationOwner
    const identity = parsePrivatePreparation({ commandId: '00000000-0000-4000-8000-000000000000',
      threadId: owner.threadId, expectedRevision: 0,
      target: { kind: 'single_chat', conversationId: owner.conversationId, composerScope: owner.composerScope } })
    let names: string[]
    try { names = await readdir(this.#root) } catch (error) {
      if (object(error) && error.code === 'ENOENT') return []
      throw error
    }
    const results: Array<{ request: PrivateAttachmentPreparationRequest; displayName: string; state: Entry['phase'] }> = []
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -5)
      if (!isAttachmentId(id)) return fail()
      const entry = await this.#read(id)
      if (entry?.request.threadId === identity.threadId && entry.request.target.conversationId === identity.target.conversationId
        && isDeepStrictEqual(entry.request.target.composerScope, identity.target.composerScope)) {
        results.push({ request: entry.request, displayName: entry.source.displayName, state: entry.phase })
      }
    }
    return results
  }
  async #record(entry: Entry, value: unknown): Promise<PrivateAttachmentPreparationResult> {
    const receipt = recordedReceipt(entry, value)
    await this.#locked(entry.request.commandId, async () => {
      const current = await this.#require(entry.request)
      if (current.receipt && !isDeepStrictEqual(current.receipt, receipt)) return fail()
      if (current.phase === 'recorded' && current.receipt) return
      await this.#write({ ...current, phase: 'recorded', receipt })
    })
    const result = { state: 'recorded' as const, commandId: entry.request.commandId, receipt }
    this.#flights.get(entry.request.commandId)?.resolve(result)
    return result
  }
  async #lookup(entry: Entry): Promise<PrivateAttachmentPreparationResult> {
    if (entry.phase === 'recorded' && entry.receipt) return { state: 'recorded', commandId: entry.request.commandId, receipt: entry.receipt }
    try {
      const result = await this.core.request<{ receipt: unknown }>('host.upload.receipt', entry.intent)
      if (result.receipt != null) return await this.#record(entry, result.receipt)
    } catch { /* 查回失败或结果未知，均保留原记录及文件。 */ }
    return { state: entry.phase === 'prepared' ? 'prepared' : 'unknown', commandId: entry.request.commandId }
  }
  #dispatch(entry: Entry): Promise<PrivateAttachmentPreparationResult> {
    const id = entry.request.commandId
    const existing = this.#flights.get(id)
    if (existing) return existing.promise
    let complete!: (value: PrivateAttachmentPreparationResult) => void
    const promise = new Promise<PrivateAttachmentPreparationResult>(resolve => { complete = resolve })
    const flight = { promise, resolve: complete }
    this.#flights.set(id, flight)
    const send = async () => {
      const alreadyRecorded = await this.#locked(id, async () => {
        const current = await this.#require(entry.request)
        if (current.phase === 'recorded') return true
        await this.#write({ ...current, phase: 'unknown' })
        return false
      })
      if (alreadyRecorded) return this.#lookup(entry)
      try {
        const reply = await this.core.request<{ receipt: unknown }>('host.upload.bind', { intent: entry.intent, source: entry.source })
        return await this.#record(entry, reply.receipt)
      } catch { return this.#lookup({ ...entry, phase: 'unknown' }) }
    }
    // 回执查回能独立结清原调用，不被原运输连接的长等待锁住。
    void send().then(complete, () => complete({ state: 'unknown', commandId: id }))
    void promise.finally(() => { if (this.#flights.get(id) === flight) this.#flights.delete(id) })
    return promise
  }
}
