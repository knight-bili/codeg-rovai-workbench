import { expect, it, vi } from 'vitest'
import type { RetainedPrivateInput, ScopedSingleChatSnapshot, SingleChatPendingInputView, StoredCommandResult } from '@contracts'
import { PRIVATE_INPUT_BODY_INDEX, privateInputBodyIndex, PrivateInputController, type PrivateInputOrigin } from './private-input-controller'
import { SingleChatComposerStore } from './single-chat-composer-store'
import { canvasComposerContextKey } from './canvas-composer-drafts'

const origin: PrivateInputOrigin = { threadId: 'thread', conversationId: 'private', scope: null, contextKey: 'default' }
const item = { id: 'pending', revision: 3 } as SingleChatPendingInputView
const draft = (revision = 2) => ({ revision, quotes: [], attachments: [], updatedAt: null, scopeVersion: 1 as const, scopeKey: '', composerScope: null })
const snapshot = (): ScopedSingleChatSnapshot => ({ conversation: { id: 'private', threadId: 'thread', agentId: 'agent', status: 'active', version: 1,
  lastMessageSequence: 0, lastAcceptedPublicBoundarySequence: 0, activeAgentRunId: null, createdAt: 'now', updatedAt: 'now', endedAt: null },
  draft: draft(), pendingInputs: { items: [], executionActive: false, editSession: null, editingElsewhere: false }, messages: [], agentRuns: [], approvals: [], executionEvidence: [] })
const result = (placement: 'active' | 'retained'): StoredCommandResult => ({ status: 'applied', code: 'single_chat.pending_input_returned_to_composer',
  payload: { placement, body: '排队问题', draft: draft(placement === 'active' ? 3 : 2), ...(placement === 'retained' ? { retainedInput: retained } : {}) },
  commandId: 'fixture', commandType: 'single_chat.pending_input.edit', resultEntity: null, recordedAt: 'now' })
const retained: RetainedPrivateInput = { id: 'saved', conversationId: 'private', scopeKey: '', revision: 1, body: '排队问题', attachments: [], quotes: [], updatedAt: 'now' }

function fixture(body = '', values = new Map<string, unknown>()) {
  let failPrepare = false, loseReply = false, recorded: StoredCommandResult | null = null
  let response = result(body ? 'retained' : 'active')
  let currentDraft = draft()
  let continuation: ((value: StoredCommandResult) => void) | null = null
  let delay = false, page = { items: [{ kind: 'retained', input: retained }], complete: true, nextCursor: null, throughGlobalSequence: 1 }
  const editingRecovery = {
    get: (key: string) => structuredClone(values.get(key)),
    set: vi.fn((key: string, value: unknown) => { if (failPrepare && key.startsWith('single-chat-input-intent:')) throw new Error('storage denied'); values.set(key, structuredClone(value)) })
  }
  const identify = (value: StoredCommandResult, params?: unknown) => {
    const saved = [...values.entries()].find(([key]) => key.startsWith('single-chat-input-intent:'))?.[1] as { method?: string; params?: { commandId: string } } | undefined
    return { ...value, commandId: (params as { commandId?: string } | undefined)?.commandId ?? saved?.params?.commandId ?? value.commandId,
      commandType: saved?.method === 'singleChat.send' ? 'single_chat.send' : saved?.method === 'singleChat.composerDraft.mutate' ? 'single_chat.composer_draft.mutate' : value.commandType }
  }
  const request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    if (method === 'singleChat.get') return { ...snapshot(), draft: currentDraft }
    if (method === 'singleChat.composerDraft.recovery') return page
    if (method === 'commands.reconcile') return recorded ? { state: 'recorded', result: recorded } : { state: 'unknown' }
    if (method === 'singleChat.pendingInputs.edit' || method === 'singleChat.composerDraft.mutate' || method === 'singleChat.send') {
      if (delay) return new Promise(resolve => { continuation = value => { if (value.payload.draft) currentDraft = value.payload.draft as ReturnType<typeof draft>; resolve(identify(value, params)) } })
      if (loseReply) throw new Error('reply lost')
      if (response.payload.draft) currentDraft = response.payload.draft as ReturnType<typeof draft>
      return identify(response, params)
    }
    throw new Error(`unexpected ${method} ${JSON.stringify(params)}`)
  })
  const client = { request: request as never, editingRecovery }
  const bodies = new SingleChatComposerStore(client, 'thread')
  if (body && !values.has('single-chat:thread')) bodies.update(() => ({ 'thread:private': body }))
  const controller = new PrivateInputController(client, origin, bodies)
  return { controller, bodies, client, values, request, editingRecovery,
    failPrepare: (value: boolean) => { failPrepare = value }, loseReply: (value: boolean) => { loseReply = value },
    recorded: (value: StoredCommandResult) => { recorded = identify(value); if (value.payload.draft) currentDraft = value.payload.draft as ReturnType<typeof draft> }, response: (value: StoredCommandResult) => { response = value },
    delay: () => { delay = true }, release: (value: StoredCommandResult) => { continuation!(value) },
    page: (value: typeof page) => { page = value } }
}
const writes = (f: ReturnType<typeof fixture>) => f.request.mock.calls.filter(([method]) => method === 'singleChat.pendingInputs.edit' || method === 'singleChat.composerDraft.mutate' || method === 'singleChat.send')

it('迁入默认材料锁定当前正文和双版本，既有正文与默认正文均不移动', async () => {
  const f = fixture('默认问题')
  const scope = { kind: 'canvas' as const, boardId: 'board', nodeId: 'card' }
  const contextKey = canvasComposerContextKey({ host: 'host', core: 'core', boardId: 'board', nodeId: 'card', threadId: 'thread', conversationId: 'private' })
  const bodies = new SingleChatComposerStore(f.client, 'thread', contextKey)
  bodies.update(() => ({ 'thread:private': '卡片当前问题' }))
  const controller = new PrivateInputController(f.client, { ...origin, scope, contextKey }, bodies)
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async (method, params) => {
    const value = await original(method, params)
    return method === 'singleChat.get' ? { ...value as ScopedSingleChatSnapshot, draft: { ...(value as ScopedSingleChatSnapshot).draft, composerScope: scope, scopeKey: 'canvas:board:card' } } : value
  })
  f.delay()
  const waiting = controller.adoptLegacyMaterials(7)
  expect(bodies.update(current => ({ ...current, 'thread:private': '镜像迟到覆盖' }))).toBe(false)
  await vi.waitFor(() => expect(writes(f)).toHaveLength(1))
  expect(writes(f)[0][1]).toMatchObject({ command: { expectedDraftRevision: 2, composerScope: scope,
    action: { type: 'adopt_legacy_materials', expectedSourceRevision: 7, targetBody: '卡片当前问题' } } })
  f.release({ ...result('retained'), payload: { draft: { ...draft(3), composerScope: scope, scopeKey: 'canvas:board:card' } } })
  await waiting
  expect(bodies.getSnapshot().drafts['thread:private']).toBe('卡片当前问题')
  expect(f.bodies.getSnapshot().drafts['thread:private']).toBe('默认问题')
  expect(bodies.canLeave()).toBe(true)
})

it('正文恢复只新增明确标注的本机副本，不覆盖当前正文或提交模型材料', async () => {
  const f = fixture('当前问题')
  f.controller.retainBodyCopy('旧卡片的未保存正文')
  expect(f.bodies.getSnapshot().drafts['thread:private']).toBe('当前问题')
  const copies = Object.entries(f.bodies.getSnapshot().drafts).filter(([key]) => key.startsWith('thread:private:returned:'))
  expect(copies.map(([, body]) => body)).toEqual(['旧卡片的未保存正文'])
  expect(Object.values(privateInputBodyIndex(f.client)).map(entry => entry.bodyKey)).toContain(copies[0][0])
  expect(writes(f)).toHaveLength(0)
  await expect(f.controller.adoptLegacyMaterials(1)).rejects.toThrow('context_changed')
})

it.each(['active', 'retained'] as const)('freezes target body and keeps complete %s placement distinct', async placement => {
  const f = fixture(placement === 'active' ? '' : '当前问题')
  f.delay()
  const pending = f.controller.returnPending(item, null)
  await vi.waitFor(() => expect(writes(f)).toHaveLength(1))
  const command = writes(f)[0][1] as { commandId: string; command: { action: { targetBody: string } } }
  expect(command.command.action.targetBody).toBe(placement === 'active' ? '' : '当前问题')
  expect(f.values.get(`single-chat-input-intent:v1:${JSON.stringify(origin)}`)).toMatchObject({ params: command })
  expect(f.bodies.update(current => ({ ...current, 'thread:private': '另一镜像迟到输入' }))).toBe(false)
  expect(f.bodies.tryBeginSend('thread:private')).toBeNull()
  expect(f.bodies.update(current => ({ ...current, 'thread:other': '别处继续' }))).toBe(true)
  f.release(result(placement)); await pending
  expect(f.bodies.getSnapshot().drafts['thread:private']).toBe(placement === 'active' ? '排队问题' : '当前问题')
  expect(f.controller.getSnapshot().retained).toEqual([retained])
  expect(f.bodies.getSnapshot().mutatingKeys).toEqual([])
})

it('reconstructs an unknown original request, only looks up its receipt, and applies the body once', async () => {
  const f = fixture(); f.loseReply(true)
  await expect(f.controller.returnPending(item, null)).rejects.toThrow('reply lost')
  const original = structuredClone(writes(f)[0][1])
  const restored = fixture('', f.values)
  await restored.controller.recover()
  expect(writes(restored)).toHaveLength(0)
  expect(restored.controller.getSnapshot().unknown).toBe(true)
  expect(restored.bodies.canLeave('thread:private')).toBe(false)
  restored.recorded(result('active'))
  await restored.controller.recover()
  expect(restored.request.mock.calls.find(([method]) => method === 'commands.reconcile')?.[1]).toEqual({ operation: 'singleChat.pendingInputs.edit', params: original })
  expect(restored.bodies.getSnapshot().drafts['thread:private']).toBe('排队问题')
  restored.bodies.update(current => ({ ...current, 'thread:private': '之后的新问题' }))
  await restored.controller.recover()
  expect(restored.bodies.getSnapshot().drafts['thread:private']).toBe('之后的新问题')
  expect(writes(restored)).toHaveLength(0)
})

it('only explicit retry resends the same UUID and frozen target body', async () => {
  const f = fixture('当前问题'); f.loseReply(true)
  await expect(f.controller.returnPending(item, null)).rejects.toThrow()
  const original = structuredClone(writes(f)[0][1])
  await f.controller.recover()
  expect(writes(f)).toHaveLength(1)
  f.loseReply(false)
  await f.controller.retry()
  expect(writes(f).map(call => call[1])).toEqual([original, original])
  expect(f.bodies.getSnapshot().drafts['thread:private']).toBe('当前问题')
})

it('does not dispatch if the original request cannot be saved and retains the body', async () => {
  const f = fixture('输入'); f.failPrepare(true)
  await expect(f.controller.returnPending(item, null)).rejects.toThrow('storage denied')
  expect(writes(f)).toHaveLength(0)
  expect(f.bodies.getSnapshot().drafts['thread:private']).toBe('输入')
  expect(f.bodies.canLeave('thread:private')).toBe(true)
})

it('keeps corrupt or future recovery data and blocks writes rather than replacing it', async () => {
  const values = new Map<string, unknown>([[`single-chat-input-intent:v1:${JSON.stringify(origin)}`, { version: 2, body: '不可丢弃' }]])
  const f = fixture('原正文', values)
  await expect(f.controller.returnPending(item, null)).rejects.toThrow('busy')
  expect(writes(f)).toHaveLength(0)
  expect([...values.values()]).toContainEqual({ version: 2, body: '不可丢弃' })
})

it('retains incomplete recovery entries and prunes only after a complete enumeration', async () => {
  const f = fixture()
  await f.controller.readRetained()
  f.page({ items: [], complete: false, nextCursor: null, throughGlobalSequence: 2 })
  await f.controller.readRetained()
  expect(f.controller.getSnapshot().retained).toEqual([retained])
  f.page({ items: [], complete: true, nextCursor: null, throughGlobalSequence: 3 })
  await f.controller.readRetained()
  expect(f.controller.getSnapshot().retained).toEqual([])
})

it('deduplicates an in-flight reply and a simultaneous recorded lookup', async () => {
  const f = fixture(); f.delay()
  const pending = f.controller.returnPending(item, null)
  await vi.waitFor(() => expect(writes(f)).toHaveLength(1))
  f.recorded(result('active'))
  const recovered = f.controller.recover()
  f.release(result('active'))
  await Promise.all([pending, recovered])
  expect(f.controller.getSnapshot().pending).toBe(false)
  expect(f.bodies.getSnapshot().drafts['thread:private']).toBe('排队问题')
  expect(writes(f)).toHaveLength(1)
})

it('keeps the original send identity across reload and clears only its original body', async () => {
  const f = fixture(' 原问题 '); f.loseReply(true)
  await expect(f.controller.send(' 原问题 ')).rejects.toThrow('reply lost')
  const original = structuredClone(writes(f)[0][1])
  expect(original).toMatchObject({ command: { body: '原问题', draftRevision: 2 } })
  expect((original as { command: object }).command).not.toHaveProperty('composerScope')
  const restored = fixture('', f.values)
  await restored.controller.recover()
  expect(writes(restored)).toHaveLength(0)
  restored.bodies.update(current => ({ ...current, 'thread:private': '重连后的新问题' }))
  restored.recorded({ ...result('active'), payload: {}, commandType: 'single_chat.send' })
  await restored.controller.recover()
  expect(restored.bodies.getSnapshot().drafts['thread:private']).toBe('重连后的新问题')
  expect(restored.bodies.getSnapshot().sendingKeys).toEqual([])
  expect(restored.request.mock.calls.find(([method]) => method === 'commands.reconcile')?.[1]).toEqual({ operation: 'singleChat.send', params: original })
})

it('clears a successfully accepted send once and preserves later typing on receipt replay', async () => {
  const f = fixture('原问题')
  f.response({ ...result('active'), payload: {}, commandType: 'single_chat.send' })
  await f.controller.send('原问题')
  expect(f.bodies.getSnapshot().drafts['thread:private']).toBe('')
  f.bodies.update(current => ({ ...current, 'thread:private': '下一题' }))
  await f.controller.recover()
  expect(f.bodies.getSnapshot().drafts['thread:private']).toBe('下一题')
  expect(writes(f)).toHaveLength(1)
})

it('rejects a reply bound to another UUID and keeps the original request recoverable', async () => {
  const f = fixture()
  const originalRequest = f.request.getMockImplementation()!
  f.request.mockImplementation(async (method, params) => {
    const value = await originalRequest(method, params)
    return method === 'singleChat.pendingInputs.edit' ? { ...value as object, commandId: 'wrong-command' } : value
  })
  await expect(f.controller.returnPending(item, null)).rejects.toThrow('context_changed')
  expect(f.controller.getSnapshot().pending).toBe(true)
  expect(f.bodies.getSnapshot().drafts['thread:private']).toBeUndefined()
  expect(writes(f)).toHaveLength(1)
})

it('indexes primary and working bodies without storing their text in the index, and never registers on a read', async () => {
  const f = fixture('输入正文')
  await f.controller.refresh(); await f.controller.readRetained(); await f.controller.recover()
  expect(writes(f)).toHaveLength(0)
  expect(f.values.has(PRIVATE_INPUT_BODY_INDEX)).toBe(false)
  f.controller.rememberBody()
  f.bodies.update(current => ({ ...current, 'thread:private:pending-edit:token': '尚未保存的排队编辑' }))
  f.controller.rememberBody('thread:private:pending-edit:token')
  const entries = Object.values(privateInputBodyIndex(f.client))
  expect(entries.map(entry => entry.bodyKey)).toEqual(['thread:private', 'thread:private:pending-edit:token'])
  expect(JSON.stringify(entries)).not.toContain('输入正文')
  expect(JSON.stringify(entries)).not.toContain('尚未保存的排队编辑')
  expect(writes(f)).toHaveLength(0)
})

it('preserves an unknown body-index version and refuses to overwrite it', async () => {
  const f = fixture('输入正文')
  f.values.set(PRIVATE_INPUT_BODY_INDEX, { version: 2, entries: { future: 'preserve' } })
  expect(() => f.controller.rememberBody()).toThrow('recovery_invalid')
  expect(f.values.get(PRIVATE_INPUT_BODY_INDEX)).toEqual({ version: 2, entries: { future: 'preserve' } })
  expect(writes(f)).toHaveLength(0)
})

it('keeps a recorded receipt if clearing local intent fails, then never overwrites the already restored body', async () => {
  const f = fixture()
  const save = f.editingRecovery.set.getMockImplementation()!
  let failClear = true
  f.editingRecovery.set.mockImplementation((key, value) => {
    if (failClear && key.startsWith('single-chat-input-intent:') && value === null) throw new Error('clear failed')
    save(key, value)
  })
  await expect(f.controller.returnPending(item, null)).rejects.toThrow('clear failed')
  expect(f.controller.getSnapshot().pending).toBe(true)
  const dictionary = f.values.get('single-chat:thread') as Record<string, string>
  expect(dictionary['thread:private']).toBe('排队问题')
  f.values.set('single-chat:thread', { ...dictionary, 'thread:private': '之后保存的新问题' })
  const restored = fixture('', f.values)
  await restored.controller.recover()
  expect(restored.bodies.getSnapshot().drafts['thread:private']).toBe('之后保存的新问题')
  expect(writes(restored)).toHaveLength(0)
  failClear = false
})

it('does not reconstruct a returned body against newer Core materials after a lost receipt', async () => {
  const f = fixture(); f.loseReply(true)
  await expect(f.controller.returnPending(item, null)).rejects.toThrow()
  f.recorded(result('active'))
  const request = f.request.getMockImplementation()!
  f.request.mockImplementation((method, params) => method === 'singleChat.get'
    ? Promise.resolve({ ...snapshot(), draft: draft(99) }) : request(method, params))
  await expect(f.controller.recover()).rejects.toThrow('context_changed')
  expect(f.bodies.getSnapshot().drafts['thread:private']).toBeUndefined()
  expect(f.controller.getSnapshot().pending).toBe(true)
  expect(writes(f)).toHaveLength(1)
})

it('filters other cards from a recovery page without registering them', async () => {
  const f = fixture()
  f.page({ items: [{ kind: 'retained', input: { ...retained, scopeKey: 'canvas:board:other' } }], complete: true, nextCursor: null, throughGlobalSequence: 2 })
  await f.controller.readRetained()
  expect(f.controller.getSnapshot().retained).toEqual([])
  expect(writes(f)).toHaveLength(0)
})

it.each(['return', 'send'] as const)('settles the original %s caller after a recorded lookup even when the original transport never returns', async kind => {
  const f = fixture(kind === 'send' ? '原问题' : '')
  f.delay()
  const operation = kind === 'send' ? f.controller.send('原问题') : f.controller.returnPending(item, null)
  await vi.waitFor(() => expect(writes(f)).toHaveLength(1))
  f.recorded(kind === 'send' ? { ...result('active'), payload: {}, commandType: 'single_chat.send' } : result('active'))
  await f.controller.recover()
  await expect(operation).resolves.toBeUndefined()
  expect(f.controller.getSnapshot().pending).toBe(false)
  expect(f.bodies.canLeave('thread:private')).toBe(true)
  expect(writes(f)).toHaveLength(1)
})
