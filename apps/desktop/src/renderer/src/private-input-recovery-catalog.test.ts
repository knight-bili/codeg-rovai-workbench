import { expect, it, vi } from 'vitest'
import type { PrivateComposerRecoveryResult, PrivateComposerScopeEntry } from '@contracts'
import { PrivateInputRecoveryCatalog } from './private-input-recovery-catalog'
import { canvasComposerContext, canvasComposerContextKey } from './canvas-composer-drafts'
import { PRIVATE_INPUT_BODY_INDEX } from './private-input-controller'
import { singleChatComposerStore } from './single-chat-composer-store'

const view = { host: 'test-host', core: 'test-core' }
const origin = { threadId: 'thread', conversationId: 'private', scope: null, contextKey: 'default' }
const context = canvasComposerContext(view, 'board', 'deleted-card', origin)
const scope: PrivateComposerScopeEntry = { scopeKey: 'canvas:board:deleted-card', composerScope: { kind: 'canvas', boardId: 'board', nodeId: 'deleted-card' },
  orphaned: true, draftRevision: 3, attachmentCount: 1, quoteCount: 1, retainedInputCount: 2, updatedAt: 'now' }
function fixture() {
  const values = new Map<string, unknown>()
  const editingRecovery = { get: vi.fn((key: string) => values.get(key)), set: vi.fn((key: string, value: unknown) => { values.set(key, structuredClone(value)) }) }
  let page: PrivateComposerRecoveryResult = { items: [{ kind: 'scope', scope }], complete: true, nextCursor: null, throughGlobalSequence: 1 }
  const request = vi.fn(async (_method: string, _params?: unknown) => structuredClone(page))
  const client = { request: request as never, editingRecovery }
  const catalog = new PrivateInputRecoveryCatalog(client, origin, view)
  const body = (ctx = context, key = 'thread:private', text = '本机正文') => {
    const store = singleChatComposerStore(client, 'thread', ctx)
    store.update(current => ({ ...current, [key]: text }))
    const old = values.get(PRIVATE_INPUT_BODY_INDEX) as { entries?: object } | undefined
    values.set(PRIVATE_INPUT_BODY_INDEX, { version: 1, entries: { ...old?.entries, [ctx.nodeId + key]: {
      origin: { ...origin, scope: { kind: 'canvas', boardId: ctx.boardId, nodeId: ctx.nodeId }, contextKey: canvasComposerContextKey(ctx) },
      bodyStorageKey: store.storageIdentity, bodyKey: key
    } } })
  }
  return { values, client, request, editingRecovery, catalog, body, page: (value: PrivateComposerRecoveryResult) => { page = value } }
}

it('合并孤立Core材料与正文，不登记scope或修改输入', async () => {
  const f = fixture(); f.body()
  const before = structuredClone([...f.values.entries()]); const writes = f.editingRecovery.set.mock.calls.length
  await f.catalog.read()
  expect(f.catalog.getSnapshot()).toMatchObject({ complete: true, locations: [{ id: canvasComposerContextKey(context), scope, bodies: [{ key: 'thread:private', body: '本机正文' }] }] })
  expect(f.request.mock.calls).toEqual([['singleChat.composerDraft.recovery', { threadId: 'thread', conversationId: 'private', cursor: null, limit: 50 }]])
  expect(f.editingRecovery.set).toHaveBeenCalledTimes(writes)
  expect([...f.values.entries()]).toEqual(before)
})
it('Core没有登记仍保留本机正文，另一Host/Core和Conversation不混入', async () => {
  const f = fixture(); f.body()
  f.body({ ...context, host: 'another-host', nodeId: 'foreign' })
  f.page({ items: [], complete: true, nextCursor: null, throughGlobalSequence: 1 })
  await f.catalog.read()
  expect(f.catalog.getSnapshot().locations).toMatchObject([{ scope: null, bodies: [{ body: '本机正文' }] }])
  expect(f.catalog.getSnapshot().locations).toHaveLength(1)
})
it('Thread卡片中的本机私聊正文保留null呈现上下文，不伪造私有pin', async () => {
  const f = fixture(); f.body({ ...context, conversationId: null })
  f.page({ items: [], complete: true, nextCursor: null, throughGlobalSequence: 1 })
  await f.catalog.read()
  expect(f.catalog.getSnapshot().locations).toMatchObject([{ context: { conversationId: null }, scope: null, bodies: [{ body: '本机正文' }] }])
  expect(f.request.mock.calls.every(([method]) => method === 'singleChat.composerDraft.recovery')).toBe(true)
})
it('呈现上下文指定另一个私聊时拒绝，不借用该位置的正文', async () => {
  const f = fixture(); f.body({ ...context, conversationId: 'another-private-chat' })
  await expect(f.catalog.read()).rejects.toThrow('recovery_invalid')
  expect(f.catalog.getSnapshot().locations).toEqual([])
  expect(f.request).not.toHaveBeenCalled()
})
it('不完整分页和失败不删除已发现项，完整重读才更新Core元数据', async () => {
  const f = fixture(); await f.catalog.read()
  f.page({ items: [], complete: false, nextCursor: 'opaque', throughGlobalSequence: 2 })
  await f.catalog.read()
  expect(f.catalog.getSnapshot().locations).toHaveLength(1)
  f.request.mockRejectedValueOnce(new Error('offline'))
  await expect(f.catalog.read(false)).rejects.toThrow('offline')
  expect(f.catalog.getSnapshot().locations).toHaveLength(1)
  f.page({ items: [], complete: true, nextCursor: null, throughGlobalSequence: 3 })
  await f.catalog.read()
  expect(f.catalog.getSnapshot().locations).toEqual([])
})
it('拒绝索引伪造存储位置或scope，不读取任意正文字典', async () => {
  const f = fixture(); f.body()
  const saved = f.values.get(PRIVATE_INPUT_BODY_INDEX) as { entries: Record<string, { bodyStorageKey: string }> }
  Object.values(saved.entries)[0].bodyStorageKey = 'single-chat:another-thread'
  await expect(f.catalog.read()).rejects.toThrow('recovery_invalid')
  expect(f.catalog.getSnapshot().locations).toEqual([])
  expect(f.request).not.toHaveBeenCalled()
})
it('当前卡片的旧working正文也能找到，不因主输入已有入口而隐藏', async () => {
  const f = fixture()
  f.body(context, 'thread:private:pending-edit:old-token', '旧编辑未保存正文')
  const catalog = new PrivateInputRecoveryCatalog(f.client, { ...origin, scope: scope.composerScope, contextKey: canvasComposerContextKey(context) }, view)
  await catalog.read()
  expect(catalog.getSnapshot().locations).toMatchObject([{ bodies: [{ key: 'thread:private:pending-edit:old-token', body: '旧编辑未保存正文' }] }])
})
it('归属在创建时冻结，迟到页只进入原目录', async () => {
  const f = fixture(), changing = structuredClone(origin)
  const catalog = new PrivateInputRecoveryCatalog(f.client, changing, view)
  changing.conversationId = 'another'
  await catalog.read()
  expect(catalog.origin.conversationId).toBe('private')
})
it('同位置多份正文每次合并只读一次字典，不按副本数重复解析', async () => {
  const f = fixture()
  for (let n = 0; n < 32; n++) f.body(context, `thread:private:returned:copy-${n}`, `保留正文${n}`)
  f.editingRecovery.get.mockClear()
  await f.catalog.read()
  expect(f.catalog.getSnapshot().locations[0].bodies).toHaveLength(32)
  const storageIdentity = `single-chat:thread:${canvasComposerContextKey(context)}`
  expect(f.editingRecovery.get.mock.calls.filter(([key]) => key === storageIdentity)).toHaveLength(2)
})
