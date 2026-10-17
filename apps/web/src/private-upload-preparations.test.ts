import { describe, expect, it, vi } from 'vitest'
import type { PrivateAttachmentPreparationRequest } from '@contracts'
import { ConsoleClient } from './client'

const ids = Array.from({ length: 7 }, (_, n) => `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`)
const request = (): PrivateAttachmentPreparationRequest => ({ commandId: ids[0], threadId: 'rvcamp_0000000000e008000000000001', expectedRevision: 7,
  target: { kind: 'single_chat', conversationId: ids[1], composerScope: { kind: 'canvas', boardId: ids[2], nodeId: ids[3] } } })
const owner = () => ({ threadId: request().threadId, conversationId: ids[1], composerScope: request().target.composerScope! })
const file = (body = 'input', name = 'input.txt') => new File([body], name)
async function fixture(capability = true, lifecycle = false) {
  const values = new Map<string, unknown>()
  let writeFailure = false, recorded = false, malformed = false, rejected = false
  let mode: 'lost' | 'success' | 'reject' | 'hung' = 'lost'
  let finish!: (response: Response) => void
  const posts: Array<{ intent: Record<string, unknown>; text: string }> = []
  const lookups: unknown[] = []
  const resolutions: Array<{ path: string; intent: unknown }> = []
  let retryReject = false, finishCode = false, resolutionFailure = false
  const storage = { get: (key: string) => structuredClone(values.get(key) ?? null), set: (key: string, value: unknown) => {
    if (writeFailure) throw new Error('storage denied')
    values.set(key, structuredClone(value))
  } }
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    if (String(url).endsWith('/login')) return Response.json({ protocolVersion: 4, token: 'a'.repeat(64), clientId: 'b'.repeat(64), editorProof: 'c'.repeat(64), ownerId: 'owner', ...(capability ? { privateUploadRecoveryVersion: 1 } : {}), ...(lifecycle ? { privateUploadLifecycleVersion: 1 } : {}) })
    expect(options?.credentials).toBe('omit')
    expect(new Headers(options?.headers).get('Authorization')).toBe(`Bearer ${'a'.repeat(64)}`)
    if (String(url).endsWith('/uploads')) {
      const data = options!.body as FormData
      const intent = JSON.parse(String(data.get('intent')))
      expect((values.get('private-upload-preparations:v1') as { entries: Record<string, { intent: unknown }> }).entries[String(intent.commandId)].intent).toEqual(intent)
      posts.push({ intent, text: await (data.get('file') as Blob).text() })
      if (mode === 'lost') throw new TypeError('response lost')
      if (mode === 'reject') return Response.json({ error: { code: 'draft_changed' } }, { status: 409 })
      if (mode === 'hung') return new Promise(resolve => { finish = resolve })
      recorded = true
      return Response.json({ draft: null })
    }
    if (['/uploads/receipt', '/uploads/retry', '/uploads/finish'].some(path => String(url).endsWith(path))) {
      const intent = JSON.parse(String(options!.body))
      const path = String(url).split('/').at(-1)!
      if (path === 'receipt') lookups.push(intent)
      else {
        resolutions.push({ path, intent })
        if (resolutionFailure) throw new TypeError('connection lost')
        if (!recorded && (path === 'finish' || retryReject)) {
          recorded = true; rejected = true; finishCode = path === 'finish'
        }
        if (!recorded && path === 'retry') return Response.json({ state: 'needs_source' })
      }
      return Response.json(recorded ? { state: 'recorded', receipt: {
        commandId: malformed ? ids[6] : intent.commandId, commandType: 'camp.source_attachment.upload.bind', status: rejected ? 'rejected' : 'applied', code: finishCode ? 'attachment.upload_preparation_ended' : rejected ? 'single_chat.draft_changed' : 'attachment.upload_bound',
        payload: rejected ? {} : { attachmentRefId: intent.commandId, revision: 8 }, resultEntity: null, recordedAt: '2026-10-16T00:00:00Z'
      } } : { state: 'unknown' })
    }
    throw new Error(`unexpected ${url}`)
  })
  const client = new ConsoleClient('http://localhost:4317', fetcher)
  await client.login('d'.repeat(64))
  return { client, values, storage, posts, lookups, fetcher, resolutions,
    retryReject: () => { retryReject = true }, resolutionFailure: () => { resolutionFailure = true },
    mode: (value: typeof mode) => { mode = value }, recorded: () => { recorded = true }, malformed: () => { recorded = true; malformed = true },
    rejected: () => { recorded = true; rejected = true },
    writeFailure: () => { writeFailure = true }, finish: () => finish(Response.json({ draft: null })) }
}

describe('Web 私聊文件原请求与重选', () => {
  it('新能力先用原意图判断失效，无字节也能取得真实拒绝', async () => {
    const f = await fixture(true, true), api = f.client.privateUploadPreparations(f.storage)
    await api.prepareInput(request(), file())
    f.retryReject()
    const restored = f.client.privateUploadPreparations(f.storage)
    expect(await restored.retryInput(request())).toMatchObject({ state: 'recorded', receipt: { status: 'rejected' } })
    expect(f.resolutions).toEqual([{ path: 'retry', intent: f.posts[0].intent }])
    expect(f.posts).toHaveLength(1)
    f.client.clear()
  })
  it('原意图仍可提交时只要求重选，明确结束不发送文件或伪造本地完成', async () => {
    const f = await fixture(true, true), api = f.client.privateUploadPreparations(f.storage)
    await api.prepareInput(request(), file())
    const restored = f.client.privateUploadPreparations(f.storage)
    await expect(restored.retryInput(request())).rejects.toThrow('reselect_required')
    expect(await restored.finishInput(request())).toMatchObject({ state: 'recorded', receipt: { status: 'rejected', code: 'attachment.upload_preparation_ended' } })
    expect(f.resolutions.map(item => item.intent)).toEqual([f.posts[0].intent, f.posts[0].intent])
    expect(await restored.pendingPreparations(owner())).toMatchObject([{ state: 'recorded' }])
    expect(f.posts).toHaveLength(1)
    f.client.clear()
  })
  it('结束失败仍保留未知记录；已提交材料只回放原成功', async () => {
    const f = await fixture(true, true), api = f.client.privateUploadPreparations(f.storage)
    await api.prepareInput(request(), file())
    f.resolutionFailure()
    expect(await api.finishInput(request())).toMatchObject({ state: 'unknown' })
    expect(await api.pendingPreparations(owner())).toHaveLength(1)
    f.recorded()
    expect(await api.finishInput(request())).toMatchObject({ state: 'recorded', receipt: { status: 'applied' } })
    expect(f.resolutions).toHaveLength(1)
    expect(f.posts).toHaveLength(1)
    f.client.clear()
  })
  it('旧 Host 不声明能力时不创建新准备接口', async () => {
    const f = await fixture(false)
    expect(f.client.supportsPrivateUploadRecovery).toBe(false)
    expect(() => f.client.privateUploadPreparations(f.storage)).toThrow('context_changed')
    expect(f.posts).toEqual([])
    f.client.clear()
  })
  it('派发前落盘冻结位置与原摘要，只保存元数据', async () => {
    const f = await fixture(), api = f.client.privateUploadPreparations(f.storage), input = request()
    const original = structuredClone(input)
    const waiting = api.prepareInput(input, file())
    input.target.composerScope!.nodeId = ids[4]
    expect(await waiting).toMatchObject({ state: 'unknown' })
    expect(f.posts[0].intent).toMatchObject(original)
    expect(f.posts[0].text).toBe('input')
    const saved = JSON.stringify([...f.values.values()])
    expect(saved).not.toContain('"bytes"'); expect(saved).not.toContain('sourcePath'); expect(saved).not.toContain('a'.repeat(64))
    expect(saved).toContain('"sha256"')
    f.client.clear()
  })
  it('刷新只查原结果，重选错误名称/同长度内容不上传，正确原字节沿用原意图', async () => {
    const f = await fixture(), api = f.client.privateUploadPreparations(f.storage)
    await api.prepareInput(request(), file())
    const original = structuredClone(f.posts[0].intent)
    const restored = f.client.privateUploadPreparations(f.storage)
    expect(await restored.pendingPreparations(owner())).toHaveLength(1)
    expect(await restored.reconcileInput(request())).toMatchObject({ state: 'unknown' })
    expect(await restored.prepareInput(request(), file('other'))).toMatchObject({ state: 'unknown' })
    await expect(restored.retryInput(request())).rejects.toThrow('reselect_required')
    await expect(restored.retryInput(request(), file('input', 'wrong.txt'))).rejects.toThrow('source_changed')
    await expect(restored.retryInput(request(), file('other'))).rejects.toThrow('source_changed')
    expect(f.posts).toHaveLength(1)
    f.mode('success')
    expect(await restored.retryInput(request(), file())).toMatchObject({ state: 'recorded' })
    expect(f.posts.map(post => post.intent)).toEqual([original, original])
    f.client.clear()
  })
  it('原上传挂起时独立查回结清，迟到连接响应不改变已保存回执', async () => {
    const f = await fixture(), api = f.client.privateUploadPreparations(f.storage)
    f.mode('hung')
    const waiting = api.prepareInput(request(), file())
    await vi.waitFor(() => expect(f.posts).toHaveLength(1))
    f.recorded()
    const known = await api.reconcileInput(request())
    expect(known.state).toBe('recorded')
    await expect(waiting).resolves.toEqual(known)
    f.finish()
    expect(await api.reconcileInput(request())).toEqual(known)
    expect(f.posts).toHaveLength(1)
    f.client.clear()
  })
  it('本机保存失败不上传，首次明确拒绝可结清且不伪造 Core 回执', async () => {
    const f = await fixture(), api = f.client.privateUploadPreparations(f.storage)
    f.writeFailure()
    expect(await api.prepareInput(request(), file())).toMatchObject({ state: 'not_prepared' })
    expect(f.posts).toEqual([])
    const second = await fixture(), next = second.client.privateUploadPreparations(second.storage)
    second.mode('reject')
    expect(await next.prepareInput(request(), file())).toEqual({ state: 'rejected', commandId: ids[0], code: 'draft_changed' })
    expect(await next.retryInput(request(), file())).toMatchObject({ state: 'rejected' })
    expect(second.posts).toHaveLength(1)
    expect(JSON.stringify([...second.values.values()])).not.toContain('recordedAt')
    expect(await next.pendingPreparations(owner())).toEqual([])
    f.client.clear(); second.client.clear()
  })
  it('既有未知请求的重试拒绝仍保留原结果未知', async () => {
    const f = await fixture(), api = f.client.privateUploadPreparations(f.storage)
    await api.prepareInput(request(), file())
    f.mode('reject')
    expect(await api.retryInput(request(), file())).toMatchObject({ state: 'unknown' })
    expect((await api.pendingPreparations(owner()))[0].state).toBe('unknown')
    expect(f.posts).toHaveLength(2)
    f.client.clear()
  })
  it('原未知请求查到真实 Core 拒绝后结清，不要求原字节或再次上传', async () => {
    const f = await fixture(), api = f.client.privateUploadPreparations(f.storage)
    await api.prepareInput(request(), file())
    f.rejected()
    const restored = f.client.privateUploadPreparations(f.storage)
    const known = await restored.retryInput(request())
    expect(known).toMatchObject({ state: 'recorded', commandId: request().commandId, receipt: { status: 'rejected', code: 'single_chat.draft_changed' } })
    expect(f.posts).toHaveLength(1)
    expect(await restored.reconcileInput(request())).toEqual(known)
    f.client.clear()
  })
  it('错编号回执不采纳，损坏元数据/原请求改位置不派发', async () => {
    const f = await fixture(), api = f.client.privateUploadPreparations(f.storage)
    await api.prepareInput(request(), file()); f.malformed()
    expect(await api.reconcileInput(request())).toMatchObject({ state: 'unknown' })
    const wrong = request(); wrong.target.composerScope!.nodeId = ids[4]
    await expect(api.retryInput(wrong, file())).rejects.toThrow('invalid_recovery')
    const saved = f.values.get('private-upload-preparations:v1') as { entries: Record<string, { intent: Record<string, unknown> }> }
    saved.entries[ids[0]].intent.sourcePath = 'forbidden'
    await expect(api.pendingPreparations(owner())).rejects.toThrow('invalid_recovery')
    expect(f.posts).toHaveLength(1)
    f.client.clear()
  })
  it('排队原租约与另一卡片隔离，退出登录后旧接口不可继续使用', async () => {
    const f = await fixture(), api = f.client.privateUploadPreparations(f.storage), input = request()
    input.target = { ...input.target, kind: 'single_chat_pending', pendingInputId: ids[4], editToken: ids[5] }
    await api.prepareInput(input, file())
    expect((await api.pendingPreparations(owner()))[0].request.target).toEqual(input.target)
    expect(await api.pendingPreparations({ ...owner(), composerScope: { ...owner().composerScope, nodeId: ids[6] } })).toEqual([])
    await expect(api.pendingPreparations({ ...owner(), clientId: 'forged' } as never)).rejects.toThrow('invalid_recovery')
    f.client.clear()
    await expect(api.reconcileInput(input)).rejects.toThrow('context_changed')
    expect(f.posts).toHaveLength(1)
  })
  it('文件内存缓存有界，淘汰只要求重选，不丢原意图或自动上传', async () => {
    const f = await fixture(), api = f.client.privateUploadPreparations(f.storage)
    const inputs = Array.from({ length: 17 }, (_, n) => ({ ...request(), commandId: `00000000-0000-4000-8000-${String(100 + n).padStart(12, '0')}` }))
    for (const input of inputs) await api.prepareInput(input, file())
    expect(await api.pendingPreparations(owner())).toHaveLength(17)
    await expect(api.retryInput(inputs[0])).rejects.toThrow('reselect_required')
    expect(f.posts).toHaveLength(17)
    f.client.clear()
  })
})
