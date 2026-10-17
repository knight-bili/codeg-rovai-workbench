// Codeg aff1e6c278453ed8d0b96a5f664edcdca621aa3f keeps canvas-draft:<contextKey>
// per card in canvas-conversation-surface.tsx (Apache-2.0, integration/licenses/codeg/LICENSE).
import type { CanvasConversationRef, ThreadComposerDraftView } from '@contracts'
import type { SavedDraftCopy, ThreadClient } from './camp-client'
import { readCanvasViewScope, type CanvasViewScope } from './canvas-view-state'
import { parseLocalThreadComposerDraft, THREAD_COMPOSER_STORAGE_PREFIX, threadComposerDraftStorage } from './camp-composer-local-store'
import { uiAttribute } from './interface-language'

type Client = Pick<ThreadClient, 'request' | 'editingRecovery' | 'presentationScope' | 'canvasCoreIdentity'>
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export interface CanvasComposerContext extends CanvasViewScope {
  boardId: string
  nodeId: string
  threadId: string
  conversationId: string | null
}
interface Bundle { version: 1; drafts: Record<string, string> }
export const CANVAS_COMPOSER_STORAGE_PREFIX = 'rovai.canvas-composer-drafts.v1:'
const valid = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && !value.includes('\0')
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
export function canvasComposerContext(scope: CanvasViewScope, boardId: string, nodeId: string, reference: CanvasConversationRef): CanvasComposerContext {
  return { ...scope, boardId, nodeId, threadId: reference.threadId, conversationId: reference.conversationId ?? null }
}
export function canvasComposerContextKey(context: CanvasComposerContext): string {
  const tuple = [context.host, context.core, context.boardId, context.nodeId, context.threadId, context.conversationId]
  if (!tuple.slice(0, 5).every(valid) || !(context.conversationId === null || valid(context.conversationId))) throw new Error(uiAttribute('画布输入的所属信息不完整，请重新读取画板。'))
  return `canvas:${JSON.stringify(tuple)}`
}
export function parseCanvasComposerContext(key: string): CanvasComposerContext | null {
  try {
    if (!key.startsWith('canvas:')) return null
    const value: unknown = JSON.parse(key.slice(7))
    if (!Array.isArray(value) || value.length !== 6 || !value.slice(0, 5).every(valid) || !(value[5] === null || valid(value[5]))) return null
    const [host, core, boardId, nodeId, threadId, conversationId] = value as [string, string, string, string, string, string | null]
    const context = { host, core, boardId, nodeId, threadId, conversationId }
    return canvasComposerContextKey(context) === key ? context : null
  } catch { return null }
}
export function hasPendingThreadDraftInput(draft: ThreadComposerDraftView): boolean {
  return Boolean(draft.body.trim() || draft.attachments.length || draft.quotes.length || draft.replyIntent)
}
export function localComposerBaseStorage(client: Pick<ThreadClient, 'editingRecovery'>): DraftStorage | undefined {
  const recovery = threadComposerDraftStorage(client.editingRecovery)
  if (recovery) return recovery
  try { return typeof window === 'undefined' ? undefined : window.localStorage } catch { return undefined }
}
function storage(client: Client): DraftStorage {
  const result = localComposerBaseStorage(client)
  if (!result) throw new Error(uiAttribute('本机输入存储暂不可用，请恢复后重试。'))
  return result
}
export function parseCanvasComposerDraftBundle(value: string | null, threadId: string): Bundle {
  if (value === null) return { version: 1, drafts: {} }
  try {
    const parsed: unknown = JSON.parse(value)
    if (!object(parsed) || parsed.version !== 1 || !object(parsed.drafts)) throw new Error()
    for (const [key, encoded] of Object.entries(parsed.drafts)) {
      const context = parseCanvasComposerContext(key)
      if (!context || context.threadId !== threadId || typeof encoded !== 'string' || !parseLocalThreadComposerDraft(encoded, threadId)) throw new Error()
    }
    return parsed as unknown as Bundle
  } catch { throw new Error(uiAttribute('画布输入记录无法读取，请先恢复后再离开会话。')) }
}
function readBundle(client: Client, threadId: string): Bundle {
  const key = `${CANVAS_COMPOSER_STORAGE_PREFIX}${threadId}`
  const value = client.editingRecovery ? client.editingRecovery.get(key) : localComposerBaseStorage(client)?.getItem(key)
  if (value != null && typeof value !== 'string') throw new Error(uiAttribute('画布输入记录无法读取，请先恢复后再离开会话。'))
  return parseCanvasComposerDraftBundle(value ?? null, threadId)
}
/** One synchronous read/modify/write keeps each Thread's context index and content in the same value. */
export function canvasComposerDraftStorage(client: Client, context: CanvasComposerContext): DraftStorage {
  const identity = canvasComposerContextKey(context), rootKey = `${THREAD_COMPOSER_STORAGE_PREFIX}${context.threadId}`
  const check = (key: string) => { if (key !== rootKey) throw new Error(uiAttribute('画布输入与当前会话不一致。')) }
  const change = (encoded: string | null) => {
    const target = storage(client), key = `${CANVAS_COMPOSER_STORAGE_PREFIX}${context.threadId}`
    const bundle = readBundle(client, context.threadId), drafts = { ...bundle.drafts }
    if (encoded === null) delete drafts[identity]
    else {
      if (!parseLocalThreadComposerDraft(encoded, context.threadId)) throw new Error(uiAttribute('画布输入与当前会话不一致。'))
      drafts[identity] = encoded
    }
    if (Object.keys(drafts).length) target.setItem(key, JSON.stringify({ version: 1, drafts }))
    else target.removeItem(key)
  }
  return {
    getItem(key) { check(key); storage(client); return readBundle(client, context.threadId).drafts[identity] ?? null },
    setItem(key, value) { check(key); change(value) },
    removeItem(key) { check(key); change(null) }
  }
}
export function canvasComposerDraftCopies(client: Client, context: CanvasComposerContext): SavedDraftCopy[] {
  const identity = canvasComposerContextKey(context)
  return (client.editingRecovery?.draftCopies?.(`${CANVAS_COMPOSER_STORAGE_PREFIX}${context.threadId}`) ?? []).flatMap(copy => {
    try {
      const value = parseCanvasComposerDraftBundle(copy.value, context.threadId).drafts[identity]
      return value ? [{ ...copy, value }] : []
    } catch { return [] } // An invalid historical copy never replaces a valid current draft.
  })
}
const coreScopes = new WeakMap<object, Promise<CanvasViewScope>>()
async function currentScope(client: Client): Promise<CanvasViewScope> {
  let pending = coreScopes.get(client)
  if (!pending) {
    pending = readCanvasViewScope(client).then(scope => {
      if (!scope) throw new Error(uiAttribute('画布输入的所属信息不完整，请重新读取画板。'))
      return scope
    }).catch(error => { coreScopes.delete(client); throw error })
    coreScopes.set(client, pending)
  }
  return pending
}
export async function hasCanvasComposerInput(client: Client, threadId: string, hints: ReadonlyMap<string, boolean> = new Map()): Promise<boolean> {
  const candidates = new Set<string>()
  for (const [key, encoded] of Object.entries(readBundle(client, threadId).drafts)) {
    if (hasPendingThreadDraftInput(parseLocalThreadComposerDraft(encoded, threadId)!)) candidates.add(key)
  }
  for (const [key, present] of hints) if (present && key !== 'main') candidates.add(key)
  if (!candidates.size) return false
  const scope = await currentScope(client)
  return [...candidates].some(key => {
    const context = parseCanvasComposerContext(key)
    return context?.threadId === threadId && context.host === scope.host && context.core === scope.core
  })
}
