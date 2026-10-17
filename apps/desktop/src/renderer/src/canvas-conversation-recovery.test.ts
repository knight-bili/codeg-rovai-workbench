import { expect, it } from 'vitest'
import type { CanvasNode } from '@contracts'
import { CanvasConversationRecovery, CANVAS_CONVERSATION_RECOVERY_PREFIX } from './canvas-conversation-recovery'
import { canvasComposerContextKey } from './canvas-composer-drafts'
import { saveCanvasViewState, initialCanvasViewState } from './canvas-view-state'
import type { CanvasConversationTarget } from './canvas-conversation'

const scope = { host: 'host/owner', core: '/core' }, board = 'board'
function local() { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } } }
function target(nodeId = 'pin', conversationId: string | null = null): CanvasConversationTarget {
  return { boardId: board, nodeId, reference: { threadId: 'thread', conversationId }, presentation: 'drawer',
    draftContext: { ...scope, boardId: board, nodeId, threadId: 'thread', conversationId } }
}
it('reconstructs exact expanded card contexts across owners without restoring drawer or Runtime state', () => {
  const storage = local(), store = new CanvasConversationRecovery(storage), first = target(), mirror = target('mirror', 'private')
  store.remember(first, true); store.remember(mirror, true)
  const serialized = [...storage.values.values()].join('')
  expect(JSON.parse([...storage.values.values()][0])).toEqual({ version: 1, contexts: [canvasComposerContextKey(first.draftContext!), canvasComposerContextKey(mirror.draftContext!)] })
  expect(serialized).not.toContain('drawer'); expect(serialized).not.toContain('Runtime')
  expect(new CanvasConversationRecovery(storage).load(scope, board)).toEqual([{ ...first, presentation: 'inline' }, { ...mirror, presentation: 'inline' }])
})
it('separates Host Owner Core and Board, rejects tuple collisions and ignores unscoped donor records', () => {
  const storage = local(), store = new CanvasConversationRecovery(storage)
  store.remember(target(), true); storage.values.set('workspace:canvas-expanded-cards', '["pin"]')
  for (const other of [{ ...scope, host: 'other/owner' }, { ...scope, core: '/other' }]) expect(new CanvasConversationRecovery(storage).load(other, board)).toEqual([])
  expect(store.load(scope, 'other-board')).toEqual([])
  expect(storage.values.has('workspace:canvas-expanded-cards')).toBe(true)
})
it('collapses only the selected context while preserving mirrors and inaccessible historical bindings', () => {
  const storage = local(), store = new CanvasConversationRecovery(storage)
  store.remember(target(), true); store.remember(target('mirror'), true); store.remember(target('pin', 'old-private'), true)
  store.remember(target(), false)
  expect(new CanvasConversationRecovery(storage).load(scope, board).map(item => item.draftContext!.conversationId ?? item.nodeId)).toEqual(['mirror', 'old-private'])
})
it('refuses corrupt or future records and retains their bytes when a new expansion tries to save', () => {
  for (const value of ['{', '{"version":2,"contexts":[]}', JSON.stringify({ version: 1, contexts: ['canvas:["another","/core","board","pin","thread",null]'] })]) {
    const storage = local(), key = `${CANVAS_CONVERSATION_RECOVERY_PREFIX}${JSON.stringify([scope.host, scope.core, board])}`
    storage.values.set(key, value); const store = new CanvasConversationRecovery(storage)
    expect(() => store.load(scope, board)).toThrow(); expect(() => store.remember(target(), true)).toThrow()
    expect(storage.values.get(key)).toBe(value)
  }
})
it('keeps the latest intent in memory after quota failure and flushes it without changing draft data', () => {
  const storage = local(), write = storage.setItem; let denied = true
  storage.setItem = (key, value) => { if (denied) throw new Error('quota'); write(key, value) }
  const store = new CanvasConversationRecovery(storage)
  expect(() => store.remember(target(), true)).toThrow()
  expect(store.load(scope, board)).toEqual([{ ...target(), presentation: 'inline' }])
  denied = false; store.flush(scope, board)
  expect(new CanvasConversationRecovery(storage).load(scope, board)).toHaveLength(1)
})
it('migrates only old Host Core Board scoped expanded IDs through an actual matching graph', () => {
  const storage = local(), node = { boardId: board, id: 'pin', data: { kind: 'conversation', conversation: target().reference } } as CanvasNode
  saveCanvasViewState(storage, scope, board, { ...initialCanvasViewState(), expandedCards: ['pin', 'missing'] })
  const store = new CanvasConversationRecovery(storage)
  expect(store.load(scope, board, [node])).toEqual([{ ...target(), presentation: 'inline' }])
  store.flush(scope, board); expect(new CanvasConversationRecovery(storage).load(scope, board)).toHaveLength(1)
})
it('does not write or cache an empty replacement when storage reads are denied', () => {
  let writes = 0
  const store = new CanvasConversationRecovery({ getItem: () => { throw new Error('denied') }, setItem: () => { writes++ } })
  expect(() => store.load(scope, board)).toThrow('原记录已保留')
  expect(() => store.remember(target(), true)).toThrow('原记录已保留')
  expect(writes).toBe(0)
})
