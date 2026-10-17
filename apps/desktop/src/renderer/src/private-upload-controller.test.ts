import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PrivateAttachmentPreparationRequest, PrivateAttachmentPreparationResult, PrivateAttachmentUploadTarget, RovaiApi, StoredCommandResult } from '@contracts'
import { PrivateUploadController, privateUploadController } from './private-upload-controller'
import { PrivateUploadRecoveryPanel } from './PrivateUploadRecoveryPanel'
import { inactiveUploadTargets } from './PrivateUploadHistoryPanel'

const scope = { kind: 'canvas' as const, boardId: 'board', nodeId: 'card' }
const owner = { threadId: 'thread', conversationId: 'private', composerScope: scope }
const target: PrivateAttachmentUploadTarget = { kind: 'single_chat', conversationId: 'private', composerScope: scope }
const file = () => new File(['input'], 'input.txt')
function receipt(request: PrivateAttachmentPreparationRequest, status: StoredCommandResult['status'] = 'applied'): PrivateAttachmentPreparationResult {
  return { state: 'recorded', commandId: request.commandId, receipt: {
    commandId: request.commandId, commandType: 'camp.source_attachment.upload.bind', status, code: status === 'rejected' ? 'single_chat.draft_changed' : 'attachment.upload_bound',
    payload: status === 'rejected' ? {} : { attachmentRefId: request.commandId }, resultEntity: null, recordedAt: '2026-10-16T00:00:00Z'
  } }
}
function fixture(records = new Map<string, PrivateAttachmentPreparationRequest>()) {
  let found = false
  const prepare = vi.fn(async (request: PrivateAttachmentPreparationRequest): Promise<PrivateAttachmentPreparationResult> => {
    records.set(request.commandId, structuredClone(request))
    return { state: 'unknown' as const, commandId: request.commandId }
  })
  const reconcile = vi.fn(async (request: PrivateAttachmentPreparationRequest): Promise<PrivateAttachmentPreparationResult> =>
    found ? receipt(request) : { state: 'unknown', commandId: request.commandId })
  const retry = vi.fn(async (request: PrivateAttachmentPreparationRequest) => receipt(request))
  const api = { prepareInput: prepare, reconcileInput: reconcile, retryInput: retry,
    pendingPreparations: vi.fn(async () => [...records.values()].map(request => ({ request: structuredClone(request), displayName: 'input.txt', state: 'unknown' as const })))
  } as unknown as RovaiApi['singleChatAttachments']
  return { api, prepare, reconcile, retry, records, controller: new PrivateUploadController(api, owner, target), found: () => { found = true } }
}

describe('私聊文件原请求共享控制器', () => {
  it('结束准备先查原结果，重复点击合并，只采纳真实终结回执', async () => {
    const f = fixture()
    const finish = vi.fn(async (input: PrivateAttachmentPreparationRequest) => {
      const result = receipt(input, 'rejected')
      if (result.state === 'recorded') result.receipt.code = 'attachment.upload_preparation_ended'
      return result
    })
    f.api.finishInput = finish
    await f.controller.load(); await f.controller.prepare(7, file())
    const original = f.prepare.mock.calls[0][0]
    const before = f.reconcile.mock.calls.length
    const first = f.controller.finish(original.commandId), second = f.controller.finish(original.commandId)
    expect(first).toBe(second)
    await first
    expect(f.reconcile.mock.calls.length).toBe(before + 1)
    expect(finish.mock.calls).toEqual([[original]])
    expect(f.retry).not.toHaveBeenCalled()
    expect(f.controller.blocked).toBe(false)
    expect(renderToStaticMarkup(createElement(PrivateUploadRecoveryPanel, { controller: f.controller }))).toContain('已结束文件准备，当前输入已保留。')
  })
  it('没有能力不显示结束入口，失败不能移除未知准备，查到成功不再结束', async () => {
    const f = fixture()
    await f.controller.load(); await f.controller.prepare(0, file())
    const id = f.prepare.mock.calls[0][0].commandId
    expect(renderToStaticMarkup(createElement(PrivateUploadRecoveryPanel, { controller: f.controller }))).not.toContain('结束这次文件准备')
    await expect(f.controller.finish(id)).rejects.toThrow('capability_required')
    const finish = vi.fn(async (): Promise<PrivateAttachmentPreparationResult> => { throw new Error('lost') })
    f.api.finishInput = finish
    await expect(f.controller.finish(id)).rejects.toThrow('lost')
    expect(f.controller.blocked).toBe(true)
    expect(f.controller.getSnapshot().rows).toHaveLength(1)
    f.found(); await f.controller.finish(id)
    expect(finish).toHaveBeenCalledTimes(1)
    expect(f.controller.getSnapshot()).toMatchObject({ rows: [], applied: 1 })
  })
  it('历史列表保留旧租约原位置，排除当前与已完成记录，拒绝另一卡片', () => {
    const pending: PrivateAttachmentUploadTarget = { ...target, kind: 'single_chat_pending', pendingInputId: 'pending', editToken: 'old' }
    const original: PrivateAttachmentPreparationRequest = { commandId: 'old', threadId: owner.threadId, expectedRevision: 2, target: pending }
    const entry = { request: original, displayName: 'input.txt', state: 'unknown' as const }
    expect(inactiveUploadTargets([entry, entry], owner, [target, { ...pending, editToken: 'new' }])).toEqual([pending])
    expect(inactiveUploadTargets([entry], owner, [pending])).toEqual([])
    expect(inactiveUploadTargets([{ ...entry, state: 'recorded' }], owner, [])).toEqual([])
    expect(() => inactiveUploadTargets([{ ...entry, request: { ...original, threadId: 'foreign' } }], owner, [])).toThrow('context_changed')
    expect(() => inactiveUploadTargets([entry], { ...owner, composerScope: null }, [])).toThrow('context_changed')
  })
  it('能力不齐时不开始上传；同平台同位置的镜像共用控制器', async () => {
    const f = fixture()
    const unsupported = new PrivateUploadController({ ...f.api, retryInput: undefined }, owner, target)
    expect(unsupported.supported).toBe(false)
    await expect(unsupported.prepare(2, file())).rejects.toThrow('capability_required')
    expect(f.prepare).not.toHaveBeenCalled()
    expect(privateUploadController(f.api, owner, target)).toBe(privateUploadController(f.api, structuredClone(owner), structuredClone(target)))
    expect(privateUploadController(f.api, owner, target)).toBe(privateUploadController(f.api,
      { ...owner, composerScope: { nodeId: scope.nodeId, boardId: scope.boardId, kind: scope.kind } }, target))
    expect(() => privateUploadController(f.api, { ...owner, conversationId: 'foreign' }, target)).toThrow('context_changed')
    expect(privateUploadController(f.api, owner, target)).not.toBe(privateUploadController(f.api,
      { ...owner, composerScope: { ...scope, nodeId: 'other' } }, { ...target, composerScope: { ...scope, nodeId: 'other' } }))
  })
  it('冻结原卡片和版本，未知结果不允许换编号再次添加或丢弃', async () => {
    const f = fixture(), changing = structuredClone(target)
    const controller = new PrivateUploadController(f.api, owner, changing)
    changing.composerScope!.nodeId = 'later-card'
    await controller.load(); await controller.prepare(7, file())
    expect(f.prepare.mock.calls[0][0]).toMatchObject({ threadId: 'thread', expectedRevision: 7, target })
    expect(controller.blocked).toBe(true)
    await expect(controller.prepare(8, file())).rejects.toThrow('busy')
    expect(() => controller.dismiss(f.prepare.mock.calls[0][0].commandId)).toThrow('busy')
    expect(f.prepare).toHaveBeenCalledTimes(1)
  })
  it('重建只查询平台原日志/回执，明确重试才发送原编号和原参数', async () => {
    const f = fixture(); await f.controller.load(); await f.controller.prepare(7, file())
    const original = structuredClone(f.prepare.mock.calls[0][0])
    const restored = new PrivateUploadController(f.api, owner, target)
    await restored.load()
    expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.retry).not.toHaveBeenCalled()
    await restored.retry(original.commandId)
    expect(f.retry.mock.calls[0][0]).toEqual(original)
    expect(restored.getSnapshot()).toMatchObject({ rows: [], applied: 1 })
  })
  it.each(['unknown', 'error'] as const)('原连接挂起时可独立查回，迟到 %s 不能把已完成降级', async late => {
    const f = fixture()
    let finish!: (value: PrivateAttachmentPreparationResult) => void
    let fail!: (error: Error) => void
    f.prepare.mockImplementationOnce(async request => {
      f.records.set(request.commandId, structuredClone(request))
      return new Promise((resolve, reject) => { finish = resolve; fail = reject })
    })
    await f.controller.load()
    const waiting = f.controller.prepare(0, file())
    const original = f.prepare.mock.calls[0][0]
    f.found(); await f.controller.recover(original.commandId)
    expect(f.controller.blocked).toBe(false)
    if (late === 'unknown') finish({ state: 'unknown', commandId: original.commandId })
    else fail(new Error('late connection error'))
    await expect(waiting).resolves.toBe(true)
    expect(f.controller.getSnapshot()).toMatchObject({ rows: [], applied: 1 })
  })
  it('错编号回执不结清；另一卡片的平台记录不会降级成当前位置', async () => {
    const f = fixture()
    f.prepare.mockImplementationOnce(async request => ({ state: 'unknown', commandId: `${request.commandId}-wrong` }))
    await f.controller.load()
    await expect(f.controller.prepare(0, file())).rejects.toThrow('invalid_recovery')
    expect(f.controller.blocked).toBe(true)
    const original = f.prepare.mock.calls[0][0]
    const foreign = { ...original, target: { ...target, composerScope: { ...scope, nodeId: 'foreign' } } }
    f.records.set(foreign.commandId, foreign)
    await expect(new PrivateUploadController(f.api, owner, target).load()).rejects.toThrow('context_changed')
    expect(f.retry).not.toHaveBeenCalled()
  })
  it('明确拒绝才可关闭提示，已确认未派发的准备失败允许重新选择', async () => {
    const f = fixture()
    f.prepare.mockImplementationOnce(async request => receipt(request, 'rejected'))
    await f.controller.load(); await f.controller.prepare(0, file())
    const id = f.prepare.mock.calls[0][0].commandId
    expect(f.controller.blocked).toBe(false)
    expect(renderToStaticMarkup(createElement(PrivateUploadRecoveryPanel, { controller: f.controller }))).toContain('文件未添加')
    f.controller.dismiss(id)
    f.prepare.mockImplementationOnce(async request => ({ state: 'not_prepared', commandId: request.commandId }))
    await f.controller.prepare(0, file())
    expect(f.controller.blocked).toBe(false)
    expect(f.prepare.mock.calls[1][0].commandId).not.toBe(id)
  })
  it('排队工作副本只恢复自己的原编辑租约，并合并重复点击重试', async () => {
    const f = fixture()
    const pending: PrivateAttachmentUploadTarget = { ...target, kind: 'single_chat_pending', pendingInputId: 'pending', editToken: 'lease' }
    const controller = new PrivateUploadController(f.api, owner, pending)
    await controller.load(); await controller.prepare(3, file())
    const original = f.prepare.mock.calls[0][0]
    f.records.set('old-lease', { ...original, commandId: 'old-lease', target: { ...pending, editToken: 'old-lease' } })
    await controller.load()
    expect(controller.getSnapshot().rows).toHaveLength(1)
    const selectedFile = file()
    const first = controller.retry(original.commandId, selectedFile), second = controller.retry(original.commandId)
    expect(first).toBe(second)
    await Promise.all([first, second])
    expect(f.retry).toHaveBeenCalledTimes(1)
    expect(f.retry.mock.calls[0][0].target).toEqual(pending)
    expect(f.retry.mock.calls[0]).toEqual([original, selectedFile])
  })
})
