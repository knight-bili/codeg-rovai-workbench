import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PrivateAttachmentPreparationRequest, StoredCommandResult } from '@contracts'
import { parsePrivatePreparation, PrivateAttachmentPreparations } from './private-attachment-preparation'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(dirname(root)).toBe(resolve(tmpdir()))
    expect(basename(root)).toMatch(/^rovai-private-upload-test-/)
    await rm(root, { recursive: true, force: true })
  }
})
const ids = Array.from({ length: 6 }, (_, n) => `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`)
const request = (): PrivateAttachmentPreparationRequest => ({
  commandId: ids[0], threadId: 'rvcamp_0000000000e008000000000001', expectedRevision: 0,
  target: { kind: 'single_chat', conversationId: ids[1], composerScope: { kind: 'canvas', boardId: ids[2], nodeId: ids[3] } }
})
class Core {
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  receipts = new Map<string, StoredCommandResult>()
  mode: 'applied' | 'unknown' | 'lost' | 'hung' = 'applied'
  binds = 0
  retryCode: string | null = null
  finishFailure: 'before' | 'after' | null = null
  directoryDigest = 'd'.repeat(64)
  async request<T>(method: 'host.upload.observe' | 'host.upload.bind' | 'host.upload.receipt' | 'host.upload.retry' | 'host.upload.finish', input: unknown): Promise<T> {
    const params = structuredClone(input) as Record<string, unknown>
    this.calls.push({ method, params })
    if (method === 'host.upload.observe') {
      if ((await lstat(String(params.sourcePath))).isDirectory()) {
        // 此 owner 只拥有 Main 的运输/恢复边界；实际目录摘要由 Core owner 验证。
        return { intent: {
          commandId: params.commandId, threadId: params.threadId, expectedRevision: params.expectedRevision,
          target: params.target, displayName: params.displayName, byteSize: 5, sha256: this.directoryDigest, sourceKind: 'directory'
        }, source: {
          id: params.commandId, sourcePath: params.sourcePath, displayName: params.displayName,
          kind: 'directory', mediaType: null, observedByteSize: null
        } } as T
      }
      const bytes = await readFile(String(params.sourcePath))
      return { intent: {
        commandId: params.commandId, threadId: params.threadId, expectedRevision: params.expectedRevision,
        target: params.target, displayName: params.displayName, byteSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex')
      }, source: {
        id: params.commandId, sourcePath: params.sourcePath, displayName: params.displayName,
        kind: 'file', mediaType: params.mediaType, observedByteSize: bytes.length
      } } as T
    }
    if (method === 'host.upload.receipt') return { receipt: this.receipts.get(String(params.commandId)) ?? null } as T
    if (method === 'host.upload.retry' || method === 'host.upload.finish') {
      if (method === 'host.upload.finish' && this.finishFailure === 'before') throw new Error('connection lost')
      const id = String(params.commandId)
      let receipt = this.receipts.get(id) ?? null
      const code = method === 'host.upload.finish' ? 'attachment.upload_preparation_ended' : this.retryCode
      if (!receipt && code) {
        receipt = { commandId: id, commandType: 'camp.source_attachment.upload.bind', status: 'rejected', code,
          payload: {}, resultEntity: null, recordedAt: '2026-10-16T00:00:00Z' }
        this.receipts.set(id, receipt)
      }
      if (method === 'host.upload.finish' && this.finishFailure === 'after') throw new Error('response lost')
      return { receipt } as T
    }
    this.binds++
    if (this.mode === 'unknown') throw new Error('连接中断，是否提交未知')
    const intent = params.intent as PrivateAttachmentPreparationRequest
    const receipt: StoredCommandResult = {
      commandId: intent.commandId, commandType: 'camp.source_attachment.upload.bind', status: 'applied',
      code: 'attachment.upload_bound', payload: { attachmentRefId: intent.commandId },
      resultEntity: null, recordedAt: '2026-10-16T00:00:00Z'
    }
    this.receipts.set(intent.commandId, receipt)
    if (this.mode === 'lost') throw new Error('已提交但回执丢失')
    if (this.mode === 'hung') return new Promise<T>(() => undefined)
    return { receipt } as T
  }
}
async function fixture() {
  const root = resolve(await mkdtemp(join(tmpdir(), 'rovai-private-upload-test-')))
  roots.push(root)
  const sourcePath = join(root, 'input.txt')
  await writeFile(sourcePath, 'input')
  const directory = join(root, 'journal')
  const core = new Core()
  return { root, directory, sourcePath, core, service: new PrivateAttachmentPreparations(directory, core) }
}
const metadata = { displayName: 'input.txt', mediaType: 'text/plain' }
const owner = (item: PrivateAttachmentPreparationRequest) => ({
  threadId: item.threadId, conversationId: item.target.conversationId, composerScope: item.target.composerScope ?? null
})

describe('Native 私聊上传原请求恢复', () => {
  it('没有原文件也能查明旧意图拒绝，不再观察或绑定文件', async () => {
    const f = await fixture(), input = request()
    f.core.mode = 'unknown'
    await f.service.prepare(input, { ...metadata, sourcePath: f.sourcePath })
    await unlink(f.sourcePath)
    const before = f.core.calls.length
    f.core.retryCode = 'single_chat.pending_input_edit_fenced'
    expect(await f.service.retry(input)).toMatchObject({ state: 'recorded', receipt: { status: 'rejected', code: f.core.retryCode } })
    expect(f.core.calls.slice(before).map(call => call.method)).toEqual(['host.upload.receipt', 'host.upload.retry'])
    expect(f.core.binds).toBe(1)
  })

  it('明确结束只有真实首次回执才结清，丢回执可查回且保留源文件', async () => {
    for (const failure of ['before', 'after'] as const) {
      const f = await fixture(), input = request()
      f.core.mode = 'unknown'
      await f.service.prepare(input, { ...metadata, sourcePath: f.sourcePath })
      f.core.finishFailure = failure
      const result = await f.service.finish(input)
      if (failure === 'before') {
        expect(result).toMatchObject({ state: 'unknown' })
        expect(f.core.receipts.size).toBe(0)
        f.core.finishFailure = null
      } else expect(result).toMatchObject({ state: 'recorded', receipt: { status: 'rejected', code: 'attachment.upload_preparation_ended' } })
      expect(await f.service.finish(input)).toMatchObject({ state: 'recorded', receipt: { status: 'rejected' } })
      expect(await readFile(f.sourcePath, 'utf8')).toBe('input')
      expect(f.core.binds).toBe(1)
    }
  })

  it('结束准备时原提交已完成，只返回首次成功结果', async () => {
    const f = await fixture(), input = request()
    const known = await f.service.prepare(input, { ...metadata, sourcePath: f.sourcePath })
    const before = f.core.calls.length
    expect(await f.service.finish(input)).toEqual(known)
    expect(f.core.calls).toHaveLength(before)
    expect(await readFile(f.sourcePath, 'utf8')).toBe('input')
  })
  it('在观察前冻结归属，原请求可重启查询且不返回本机文件路径', async () => {
    const f = await fixture()
    const input = request()
    const frozen = structuredClone(input)
    const preparing = f.service.prepare(input, { ...metadata, sourcePath: f.sourcePath })
    input.target.composerScope!.nodeId = ids[5]
    expect(await preparing).toMatchObject({ state: 'recorded', commandId: frozen.commandId })
    expect(f.core.calls[0].params.target).toEqual(frozen.target)
    const entries = await new PrivateAttachmentPreparations(f.directory, f.core).list(owner(frozen))
    expect(entries).toEqual([{ request: frozen, displayName: 'input.txt', state: 'recorded' }])
    expect(JSON.stringify(entries)).not.toContain(f.sourcePath)
    expect(await f.service.list(owner(input))).toEqual([])
    const before = f.core.binds
    const callsBefore = f.core.calls.length
    await unlink(f.sourcePath)
    expect(await f.service.reconcile(frozen)).toMatchObject({ state: 'recorded' })
    expect(f.core.binds).toBe(before)
    expect(f.core.calls).toHaveLength(callsBefore)
  })

  it('未知结果保留原字节文件，重启和重复准备不自动派发，重试拒绝内容变化', async () => {
    const f = await fixture()
    f.core.mode = 'unknown'
    const input = request()
    const bytes = new TextEncoder().encode('input')
    expect(await f.service.prepare(input, { ...metadata, bytes })).toMatchObject({ state: 'unknown' })
    const journal = JSON.parse(await readFile(join(f.directory, `${input.commandId}.json`), 'utf8'))
    expect(basename(journal.source.sourcePath)).toBe('source.txt')
    expect(await readFile(journal.source.sourcePath, 'utf8')).toBe('input')
    const restored = new PrivateAttachmentPreparations(f.directory, f.core)
    expect(await restored.reconcile(input)).toMatchObject({ state: 'unknown' })
    expect(await restored.prepare(input, { ...metadata, bytes })).toMatchObject({ state: 'unknown' })
    expect(f.core.binds).toBe(1)
    await writeFile(journal.source.sourcePath, 'other')
    await expect(restored.retry(input)).rejects.toThrow('source_changed')
    expect(f.core.binds).toBe(1)
    await writeFile(journal.source.sourcePath, 'input')
    f.core.mode = 'applied'
    expect(await restored.retry(input)).toMatchObject({ state: 'recorded', commandId: input.commandId })
    const submitted = f.core.calls.filter(call => call.method === 'host.upload.bind')
    expect(submitted).toHaveLength(2)
    expect(submitted[0].params).toEqual(submitted[1].params)
    expect(await readFile(journal.source.sourcePath, 'utf8')).toBe('input')
  })

  it('查回已提交结果独立结清原运输等待，丢回执也不删除源文件', async () => {
    for (const mode of ['lost', 'hung'] as const) {
      const f = await fixture()
      f.core.mode = mode
      const input = request()
      const pending = f.service.prepare(input, { ...metadata, sourcePath: f.sourcePath })
      await vi.waitFor(() => expect(f.core.binds).toBe(1))
      expect(await f.service.reconcile(input)).toMatchObject({ state: 'recorded' })
      expect(await pending).toMatchObject({ state: 'recorded' })
      expect(f.core.binds).toBe(1)
      expect(await readFile(f.sourcePath, 'utf8')).toBe('input')
    }
  })

  it('准备或查询前拒绝伪造归属，并将排队令牌留在原位置', async () => {
    const f = await fixture()
    const input = request()
    for (const bad of [
      { ...input, clientId: 'forged' },
      { ...input, expectedRevision: -1 },
      { ...input, commandId: '../outside' },
      { ...input, target: { ...input.target, scopeKey: 'forged' } },
      { ...input, target: { ...input.target, composerScope: { kind: 'canvas', boardId: ids[2], nodeId: 'bad' } } }
    ]) await expect(f.service.prepare(bad, { ...metadata, sourcePath: f.sourcePath })).rejects.toThrow()
    expect(f.core.calls).toHaveLength(0)
    expect(parsePrivatePreparation({ ...input, target: { ...input.target, composerScope: null } }).target).not.toHaveProperty('composerScope')
    input.target = { ...input.target, kind: 'single_chat_pending', pendingInputId: ids[4], editToken: ids[5] }
    f.core.mode = 'unknown'
    await f.service.prepare(input, { ...metadata, sourcePath: f.sourcePath })
    expect(await f.service.list(owner(input))).toHaveLength(1)
    const other = { ...owner(input), composerScope: null }
    expect(await f.service.list(other)).toEqual([])
    await expect(f.service.reconcile({ ...input, target: { ...input.target, editToken: ids[0] } })).rejects.toThrow()
    expect(f.core.binds).toBe(1)
  })

  it('已准备记录恢复只读，损坏记录保留并报告错误', async () => {
    const f = await fixture()
    const input = request()
    f.core.mode = 'unknown'
    await f.service.prepare(input, { ...metadata, sourcePath: f.sourcePath })
    const path = join(f.directory, `${input.commandId}.json`)
    const journal = JSON.parse(await readFile(path, 'utf8'))
    journal.phase = 'prepared'
    await writeFile(path, JSON.stringify(journal))
    const restored = new PrivateAttachmentPreparations(f.directory, f.core)
    expect(await restored.reconcile(input)).toEqual({ state: 'prepared', commandId: input.commandId })
    expect(f.core.binds).toBe(1)
    journal.intent.target.composerScope.nodeId = ids[5]
    await writeFile(path, JSON.stringify(journal))
    await expect(restored.reconcile(input)).rejects.toThrow('invalid_recovery')
    expect(await readFile(path, 'utf8')).toBe(JSON.stringify(journal))
    expect(f.core.binds).toBe(1)
  })

  it('只复用崩溃遗留的相同原字节，另一个Core目录不采纳原请求', async () => {
    const f = await fixture()
    const input = request()
    const bytes = new TextEncoder().encode('input')
    f.core.mode = 'unknown'
    await f.service.prepare(input, { ...metadata, bytes })
    const path = join(f.directory, `${input.commandId}.json`)
    const journal = JSON.parse(await readFile(path, 'utf8'))
    await unlink(path)
    const restored = new PrivateAttachmentPreparations(f.directory, f.core)
    expect(await restored.prepare(input, { ...metadata, bytes: new TextEncoder().encode('other') })).toEqual({ state: 'not_prepared', commandId: input.commandId })
    expect(await readFile(journal.source.sourcePath, 'utf8')).toBe('input')
    expect(f.core.binds).toBe(1)
    expect(await restored.prepare(input, { ...metadata, bytes })).toMatchObject({ state: 'unknown' })
    expect(f.core.binds).toBe(2)
    expect(f.core.calls.filter(call => call.method === 'host.upload.bind').map(call => call.params)).toEqual([
      { intent: journal.intent, source: journal.source }, { intent: journal.intent, source: journal.source }
    ])
    const other = new PrivateAttachmentPreparations(join(f.root, 'another-core'), f.core)
    const before = f.core.calls.length
    await expect(other.reconcile(input)).rejects.toThrow('invalid_recovery')
    expect(f.core.calls).toHaveLength(before)
  })

  it('已落盘的原回执离线仍可恢复，损坏回执不能冒充完成', async () => {
    const f = await fixture(), input = request()
    const recorded = await f.service.prepare(input, { ...metadata, bytes: new TextEncoder().encode('input') })
    expect(recorded.state).toBe('recorded')
    f.core.receipts.clear()
    const before = f.core.calls.length
    const restored = new PrivateAttachmentPreparations(f.directory, f.core)
    expect(await restored.reconcile(input)).toEqual(recorded)
    expect(f.core.calls).toHaveLength(before)
    const path = join(f.directory, `${input.commandId}.json`)
    const journal = JSON.parse(await readFile(path, 'utf8'))
    journal.receipt.commandId = '00000000-0000-4000-8000-000000000099'
    await writeFile(path, JSON.stringify(journal))
    await expect(restored.reconcile(input)).rejects.toThrow('invalid_recovery')
  })

  it('观察失败确认未派发，修好原路径后可显式重新准备', async () => {
    const f = await fixture()
    const input = request(), sourcePath = join(f.root, 'not-created.txt')
    expect(await f.service.prepare(input, { ...metadata, sourcePath })).toEqual({ state: 'not_prepared', commandId: input.commandId })
    expect(f.core.binds).toBe(0)
    await expect(readFile(join(f.directory, `${input.commandId}.json`))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(sourcePath, 'input')
    expect(await f.service.prepare(input, { ...metadata, sourcePath })).toMatchObject({ state: 'recorded' })
    expect(f.core.binds).toBe(1)
  })

  it('目录保留原意图重启恢复，变化时不派发，不能按普通文件丢掉类型', async () => {
    const f = await fixture()
    const sourcePath = join(f.root, 'selected-folder')
    await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'child.txt'), 'input')
    const input = request()
    f.core.mode = 'unknown'
    expect(await f.service.prepare(input, { ...metadata, displayName: 'selected-folder', sourcePath })).toMatchObject({ state: 'unknown' })
    const path = join(f.directory, `${input.commandId}.json`)
    const journal = JSON.parse(await readFile(path, 'utf8'))
    expect(journal.intent.sourceKind).toBe('directory')
    expect(journal.source).toMatchObject({ kind: 'directory', observedByteSize: null, mediaType: null })
    const restored = new PrivateAttachmentPreparations(f.directory, f.core)
    expect(await restored.reconcile(input)).toMatchObject({ state: 'unknown' })
    expect(f.core.binds).toBe(1)
    f.core.directoryDigest = 'e'.repeat(64)
    await expect(restored.retry(input)).rejects.toThrow('source_changed')
    expect(f.core.binds).toBe(1)
    f.core.directoryDigest = journal.intent.sha256
    f.core.mode = 'applied'
    expect(await restored.retry(input)).toMatchObject({ state: 'recorded' })
    expect(f.core.calls.filter(call => call.method === 'host.upload.bind').map(call => call.params)).toEqual([
      { intent: journal.intent, source: journal.source }, { intent: journal.intent, source: journal.source }
    ])
    journal.intent.sourceKind = undefined
    await writeFile(path, JSON.stringify(journal))
    await expect(restored.reconcile(input)).rejects.toThrow('invalid_recovery')
    expect(f.core.binds).toBe(2)
  })
})
