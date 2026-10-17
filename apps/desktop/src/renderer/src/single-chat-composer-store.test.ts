import { expect, it, vi } from 'vitest'
import { SingleChatComposerStore, singleChatComposerStore, singleChatRecoveryStorage } from './single-chat-composer-store'
import type { CanvasComposerContext } from './canvas-composer-drafts'

function fixture(initial: unknown = {}) {
  let saved = initial, failRead = false, failWrite = false
  const invalidations = new Set<() => void>()
  const get = vi.fn(() => { if (failRead) throw new Error('read denied'); return saved })
  const set = vi.fn((_key: string, value: unknown) => { if (failWrite) throw new Error('write denied'); saved = structuredClone(value) })
  const unsubscribe = vi.fn()
  const subscribe = vi.fn((listener: () => void) => { invalidations.add(listener); return () => { invalidations.delete(listener); unsubscribe() } })
  const owner = { editingRecovery: { get, set }, onInvalidated: subscribe }
  return { owner, get, set, subscribe, unsubscribe,
    saved: () => saved, changeSaved: (value: unknown) => { saved = value },
    failRead: (value: boolean) => { failRead = value }, failWrite: (value: boolean) => { failWrite = value },
    invalidate: () => { for (const callback of invalidations) callback() } }
}

const canvasContext: CanvasComposerContext = { host: 'host', core: '/test/core', boardId: 'board', nodeId: 'card', threadId: 'thread', conversationId: 'private' }
it('uses durable Native private recovery without changing the browser recovery adapter', () => {
  const values = new Map<string, unknown>(), native = { get: vi.fn((key: string) => values.has(key) ? { found: true as const, value: values.get(key) } : {found:false as const}),
    set: vi.fn((key: string, value: unknown) => { values.set(key, structuredClone(value)) }) }
  const owner = { privateInputRecovery: native }, body = singleChatComposerStore(owner, 'native', {...canvasContext, threadId:'native'})
  expect(body.update(() => ({ 'native:private': '末字' }))).toBe(true)
  expect(singleChatComposerStore({ privateInputRecovery:native }, 'native', {...canvasContext, threadId:'native'}).getSnapshot().drafts).toEqual({'native:private':'末字'})
  native.set.mockImplementationOnce(() => { throw new Error('disk full') })
  expect(body.update(() => ({ 'native:private':'保留未保存输入' }))).toBe(false)
  expect(body.getSnapshot().drafts['native:private']).toBe('保留未保存输入')
  expect(body.tryBeginSend('native:private')).toBe(null)
  const browser = fixture(), storage = singleChatRecoveryStorage({...owner, editingRecovery:browser.owner.editingRecovery})
  storage.set('single-chat:web', {})
  expect(browser.set).toHaveBeenCalledOnce()
})
it('migrates legacy private input once and never revives it after a durable clear or read error', () => {
  const key = 'single-chat:legacy', legacy = { getItem:vi.fn(() => '{"private":"旧正文"}') }
  let saved: {found:false} | {found:true;value:unknown} = {found:false}
  const native = { get:vi.fn(() => saved), set:vi.fn((_key:string, value:unknown) => { saved = {found:true,value} }) }
  vi.stubGlobal('window', {localStorage:legacy})
  try {
    const storage = singleChatRecoveryStorage({privateInputRecovery:native})
    expect(storage.get(key)).toEqual({private:'旧正文'})
    expect(native.set).toHaveBeenCalledWith(key, {private:'旧正文'})
    storage.set(key, null)
    expect(storage.get(key)).toBe(null)
    expect(legacy.getItem).toHaveBeenCalledOnce()
    native.get.mockImplementationOnce(() => { throw new Error('damaged disk record') })
    expect(() => storage.get(key)).toThrow('damaged disk record')
    expect(legacy.getItem).toHaveBeenCalledOnce()
  } finally { vi.unstubAllGlobals() }
})
it('keeps independent canvas card bodies and the legacy main dictionary in distinct persisted records', () => {
  const values = new Map<string, unknown>()
  const editingRecovery = { get: (key: string) => values.get(key), set: (key: string, value: unknown) => { values.set(key, structuredClone(value)) } }
  const owner = { editingRecovery }, a = singleChatComposerStore(owner, 'thread', canvasContext)
  const b = singleChatComposerStore(owner, 'thread', { ...canvasContext, nodeId: 'other' }), main = singleChatComposerStore(owner, 'thread')
  expect(singleChatComposerStore(owner, 'thread', { ...canvasContext })).toBe(a)
  a.update(() => ({ 'thread:private': 'first' }))
  b.update(() => ({ 'thread:private': 'second' }))
  main.update(() => ({ 'thread:private': 'main' }))
  expect(values.size).toBe(3)
  expect(values.get('single-chat:thread')).toEqual({ 'thread:private': 'main' })
  expect(singleChatComposerStore({ editingRecovery }, 'thread', canvasContext).getSnapshot().drafts).toEqual({ 'thread:private': 'first' })
  for (const change of [{ host: 'different' }, { core: 'different' }, { boardId: 'different' }, { conversationId: 'different' }]) {
    expect(singleChatComposerStore(owner, 'thread', { ...canvasContext, ...change }).getSnapshot().drafts).toEqual({})
  }
  expect(() => singleChatComposerStore(owner, 'other', canvasContext)).toThrow('another Thread')
})

it('persists scoped Native canvas bodies through the local storage bridge and reconstructs only that context', () => {
  const values = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } } })
  try {
    const owner = Object.defineProperty({}, 'unrelatedDesktopBridge', { enumerable: true, get() { throw new Error('unrelated bridge must stay lazy') } })
    const store = singleChatComposerStore(owner, 'thread', canvasContext)
    expect(store.update(() => ({ body: 'retained' }))).toBe(true)
    expect(singleChatComposerStore({}, 'thread', canvasContext).getSnapshot().drafts).toEqual({ body: 'retained' })
    expect(singleChatComposerStore({}, 'thread', { ...canvasContext, nodeId: 'other' }).getSnapshot().drafts).toEqual({})
    expect(values.has('single-chat:thread')).toBe(false)
    const main = singleChatComposerStore({}, 'thread')
    expect(main.update(() => ({ body: 'native main' }))).toBe(true)
    expect(singleChatComposerStore({}, 'thread').getSnapshot().drafts).toEqual({ body: 'native main' })
  } finally { vi.unstubAllGlobals() }
})

it('blocks scoped input when Native storage is unavailable and retains newest text when a later write fails', () => {
  vi.stubGlobal('window', {})
  try {
    const unavailable = singleChatComposerStore({}, 'thread', canvasContext)
    expect(unavailable.getSnapshot().ready).toBe(false)
    expect(unavailable.canLeave()).toBe(false)
    expect(unavailable.tryBeginSend('body')).toBeNull()
    let saved: string | null = null, fail = false
    vi.stubGlobal('window', { localStorage: { getItem: () => saved, setItem: (_key: string, value: string) => { if (fail) throw new Error('quota'); saved = value } } })
    expect(unavailable.retry()).toBe(true)
    unavailable.update(() => ({ body: 'saved' }))
    fail = true
    expect(unavailable.update(() => ({ body: 'newest' }))).toBe(false)
    expect(unavailable.getSnapshot().drafts.body).toBe('newest')
    expect(unavailable.canLeave()).toBe(false)
    fail = false
    expect(unavailable.retry()).toBe(true)
    expect(JSON.parse(saved!)).toEqual({ body: 'newest' })
  } finally { vi.unstubAllGlobals() }
})

it('shares one store for a client/Thread and keeps different clients or Threads isolated', () => {
  const a = fixture(), b = fixture()
  const first = singleChatComposerStore(a.owner, 'thread-a')
  expect(singleChatComposerStore(a.owner, 'thread-a')).toBe(first)
  expect(singleChatComposerStore(a.owner, 'thread-b')).not.toBe(first)
  expect(singleChatComposerStore(b.owner, 'thread-a')).not.toBe(first)
  first.update(current => ({ ...current, a: 'first' }))
  expect(singleChatComposerStore(b.owner, 'thread-a').getSnapshot().drafts).toEqual({})
})

it('merges mirror edits into the latest dictionary and persists the existing key and string-map shape only', () => {
  const f = fixture({ old: 'retained', corrupt: 9 }), store = new SingleChatComposerStore(f.owner, 'thread')
  const first = vi.fn(), second = vi.fn(), stopFirst = store.subscribe(first), stopSecond = store.subscribe(second)
  const before = store.getSnapshot()
  store.update(current => ({ ...current, 'thread:private-a': 'A' }))
  store.update(current => ({ ...current, 'thread:private-b': 'B' }))
  expect(store.getSnapshot().drafts).toEqual({ old: 'retained', 'thread:private-a': 'A', 'thread:private-b': 'B' })
  expect(before.drafts).toEqual({ old: 'retained' })
  expect(first).toHaveBeenCalledTimes(2); expect(second).toHaveBeenCalledTimes(2)
  expect(f.set).toHaveBeenLastCalledWith('single-chat:thread', { old: 'retained', 'thread:private-a': 'A', 'thread:private-b': 'B' })
  const stable = store.getSnapshot()
  store.update(current => current)
  expect(store.getSnapshot()).toBe(stable)
  expect(f.set).toHaveBeenCalledTimes(2)
  stopFirst(); stopSecond()
})

it('retains the newest input on write failure, refuses send/leave and retries persistence without a message request', () => {
  const f = fixture({ a: 'before' }), store = new SingleChatComposerStore(f.owner, 'thread')
  f.failWrite(true)
  expect(store.update(current => ({ ...current, a: 'unsaved' }))).toBe(false)
  expect(store.update(current => ({ ...current, a: 'newest unsaved' }))).toBe(false)
  expect(store.getSnapshot().drafts.a).toBe('newest unsaved')
  expect(store.canLeave()).toBe(false)
  expect(store.tryBeginSend('a')).toBeNull()
  f.changeSaved({ a: 'stale disk value' })
  expect(store.reconcile()).toBe(false)
  expect(store.getSnapshot().drafts.a).toBe('newest unsaved')
  f.failWrite(false)
  expect(store.retry()).toBe(true)
  expect(f.saved()).toEqual({ a: 'newest unsaved' })
  expect(store.canLeave()).toBe(true)
  expect(store.getSnapshot().error).toBeNull()
})

it('does not overwrite unread recovery after initial load failure and can explicitly reload', () => {
  const f = fixture({ a: 'recover me' }); f.failRead(true)
  const store = new SingleChatComposerStore(f.owner, 'thread')
  expect(store.getSnapshot().ready).toBe(false)
  expect(store.update(() => ({ a: 'accidental empty editor' }))).toBe(false)
  expect(store.tryBeginSend('a')).toBeNull()
  expect(store.canLeave()).toBe(false)
  expect(f.set).not.toHaveBeenCalled()
  f.failRead(false)
  expect(store.retry()).toBe(true)
  expect(store.getSnapshot().drafts).toEqual({ a: 'recover me' })
  expect(f.set).not.toHaveBeenCalled()
})

it('serializes a conversation send across mirrors without blocking another conversation and fences old releases', () => {
  const f = fixture(), store = new SingleChatComposerStore(f.owner, 'thread')
  const a = store.tryBeginSend('private-a')!, b = store.tryBeginSend('private-b')!
  expect(store.tryBeginSend('private-a')).toBeNull()
  expect(store.getSnapshot().sendingKeys).toEqual(['private-a', 'private-b'])
  expect(store.canLeave()).toBe(false)
  expect(store.canLeave('private-c')).toBe(true)
  a.release()
  const replacement = store.tryBeginSend('private-a')!
  a.release()
  expect(store.tryBeginSend('private-a')).toBeNull()
  b.release(); replacement.release()
  expect(store.canLeave()).toBe(true)
})

it('clears accepted text only when it still equals the frozen input and preserves later edits or a rejected body', () => {
  const f = fixture({ a: '  original  ', b: 'other' }), store = new SingleChatComposerStore(f.owner, 'thread')
  const lease = store.tryBeginSend('a')!
  store.update(current => ({ ...current, a: 'later user input' }))
  expect(lease.clearSentBody('  original  ')).toBe(false)
  expect(store.getSnapshot().drafts).toEqual({ a: 'later user input', b: 'other' })
  lease.release()
  const accepted = store.tryBeginSend('a')!
  expect(accepted.clearSentBody('later user input')).toBe(true)
  expect(store.getSnapshot().drafts).toEqual({ a: '', b: 'other' })
  accepted.release()
  const rejected = store.tryBeginSend('b')!; rejected.release()
  expect(store.getSnapshot().drafts.b).toBe('other')
})

it('keeps an accepted clear in memory on storage failure and retries that clear without resurrecting sent text', () => {
  const f = fixture({ a: 'sent' }), store = new SingleChatComposerStore(f.owner, 'thread'), lease = store.tryBeginSend('a')!
  f.failWrite(true)
  expect(lease.clearSentBody('sent')).toBe(false)
  lease.release()
  expect(store.getSnapshot().drafts.a).toBe('')
  expect(store.canLeave()).toBe(false)
  expect(store.reconcile()).toBe(false)
  f.failWrite(false)
  expect(store.retry()).toBe(true)
  expect(f.saved()).toEqual({ a: '' })
})

it('defers pending-to-Conversation migration while sending and does not revive accepted pending text', () => {
  const f = fixture({ pending: 'first input' }), store = new SingleChatComposerStore(f.owner, 'thread'), lease = store.tryBeginSend('pending')!
  expect(store.migratePending('pending', 'conversation')).toBe(false)
  expect(store.getSnapshot().drafts).toEqual({ pending: 'first input' })
  lease.clearSentBody('first input'); lease.release()
  expect(store.migratePending('pending', 'conversation')).toBe(true)
  expect(store.getSnapshot().drafts).toEqual({ conversation: '' })
  store.update(current => ({ ...current, pending: 'not accepted' }))
  const failed = store.tryBeginSend('pending')!; failed.release()
  store.migratePending('pending', 'another')
  expect(store.getSnapshot().drafts.another).toBe('not accepted')
})

it('shares one invalidation subscription, avoids rewriting read data and reconciles cached stores on remount', () => {
  const f = fixture({ a: 'before' }), store = new SingleChatComposerStore(f.owner, 'thread')
  const one = store.subscribe(vi.fn()), two = store.subscribe(vi.fn())
  expect(f.subscribe).toHaveBeenCalledTimes(1)
  f.changeSaved({ a: 'after', b: 'other' }); f.invalidate()
  expect(store.getSnapshot().drafts).toEqual({ a: 'after', b: 'other' })
  expect(f.set).not.toHaveBeenCalled()
  one(); expect(f.unsubscribe).not.toHaveBeenCalled()
  two(); expect(f.unsubscribe).toHaveBeenCalledOnce()
  f.changeSaved({ a: 'reopened' })
  const reopened = store.subscribe(vi.fn())
  expect(store.getSnapshot().drafts).toEqual({ a: 'reopened' })
  reopened()
})

it('preserves conflicting pending and conversation inputs, permits explicit swapping and adopts into an empty destination', () => {
  const f = fixture({ pending: 'older unsent input', conversation: 'current input' }), store = new SingleChatComposerStore(f.owner, 'thread')
  store.migratePending('pending', 'conversation')
  expect(store.getSnapshot().drafts).toEqual({ pending: 'older unsent input', conversation: 'current input' })
  const sending = store.tryBeginSend('conversation')!
  expect(store.swapBodies('pending', 'conversation')).toBe(false)
  sending.release()
  expect(store.swapBodies('pending', 'conversation')).toBe(true)
  expect(store.getSnapshot().drafts).toEqual({ pending: 'current input', conversation: 'older unsent input' })
  store.update(current => ({ ...current, conversation: '' }))
  store.migratePending('pending', 'conversation')
  expect(store.getSnapshot().drafts).toEqual({ conversation: 'current input' })
})

it('restores pending return bodies against the latest mirror input and applies each receipt once across remount', () => {
  const f = fixture({ conversation: 'typed in another mirror', other: 'other conversation' }), store = new SingleChatComposerStore(f.owner, 'thread')
  store.restoreReturnedBody('conversation', 'returned input', 'receipt-one')
  store.restoreReturnedBody('conversation', 'another returned input', 'receipt-two')
  expect(store.getSnapshot().drafts).toEqual({ conversation: 'typed in another mirror', other: 'other conversation',
    'conversation:returned:receipt-one': 'returned input', 'conversation:returned:receipt-two': 'another returned input' })
  store.swapBodies('conversation:returned:receipt-one', 'conversation')
  const reopened = new SingleChatComposerStore(f.owner, 'thread')
  reopened.restoreReturnedBody('conversation', 'returned input', 'receipt-one')
  expect(reopened.getSnapshot().drafts).toEqual(store.getSnapshot().drafts)
  const empty = new SingleChatComposerStore(fixture().owner, 'thread')
  empty.restoreReturnedBody('conversation', 'first returned input', 'receipt')
  empty.update(current => ({ ...current, conversation: 'later editing' }))
  empty.restoreReturnedBody('conversation', 'first returned input', 'receipt')
  expect(empty.getSnapshot().drafts.conversation).toBe('later editing')
})
