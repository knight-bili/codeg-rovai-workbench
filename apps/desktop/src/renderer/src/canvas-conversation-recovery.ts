// Codeg aff1e6c278453ed8d0b96a5f664edcdca621aa3f remembers expanded cards,
// while drawer/ACP liveness stay session-only. See integration/licenses/codeg/LICENSE.
import type { CanvasNode } from '@contracts'
import { canvasComposerContext, canvasComposerContextKey, parseCanvasComposerContext } from './canvas-composer-drafts'
import type { CanvasConversationTarget } from './canvas-conversation'
import { loadCanvasViewState, type CanvasViewScope } from './canvas-view-state'
import { uiAttribute } from './interface-language'

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>
export const CANVAS_CONVERSATION_RECOVERY_PREFIX = 'rovai.canvas-conversations.v1:'
const key = (scope: CanvasViewScope, boardId: string) => `${CANVAS_CONVERSATION_RECOVERY_PREFIX}${JSON.stringify([scope.host, scope.core, boardId])}`
const valid = (value: string) => typeof value === 'string' && Boolean(value.trim()) && !value.includes('\0')
const sameScope = (context: NonNullable<ReturnType<typeof parseCanvasComposerContext>>, scope: CanvasViewScope, boardId: string) =>
  context.host === scope.host && context.core === scope.core && context.boardId === boardId

/** Presentation metadata only. No draft bodies, private proofs, tokens or Runtime/session keys. */
export class CanvasConversationRecovery {
  private readonly boards = new Map<string, Set<string>>()
  constructor(private readonly storage?: Storage) {}
  load(scope: CanvasViewScope, boardId: string, nodes: readonly CanvasNode[] = []): CanvasConversationTarget[] {
    if (![scope.host, scope.core, boardId].every(valid)) throw new Error(uiAttribute('画布输入的所属信息不完整，请重新读取画板。'))
    const storageKey = key(scope, boardId)
    let contexts = this.boards.get(storageKey)
    if (!contexts) {
      let raw: string | null
      try { raw = this.storage?.getItem(storageKey) ?? null }
      catch { throw new Error(uiAttribute('画布展开记录无法读取，原记录已保留。')) }
      try {
        if (raw === null) {
          const legacy = new Set(loadCanvasViewState(this.storage, scope, boardId).expandedCards)
          contexts = new Set(nodes.filter(node => node.boardId === boardId && node.data.kind === 'conversation' && !node.data.objectReference && node.data.conversation && legacy.has(node.id))
            .map(node => canvasComposerContextKey(canvasComposerContext(scope, boardId, node.id, node.data.conversation!))))
        } else {
          const value = JSON.parse(raw)
          if (!value || value.version !== 1 || !Array.isArray(value.contexts)) throw new Error()
          contexts = new Set(value.contexts.map((item: unknown) => {
            const context = typeof item === 'string' ? parseCanvasComposerContext(item) : null
            if (!context || !sameScope(context, scope, boardId)) throw new Error()
            return item as string
          }))
        }
      } catch { throw new Error(uiAttribute('画布展开记录无法读取，原记录已保留。')) }
      this.boards.set(storageKey, contexts)
    }
    return [...contexts].map(item => {
      const context = parseCanvasComposerContext(item)!
      return { boardId, nodeId: context.nodeId, reference: { threadId: context.threadId, conversationId: context.conversationId },
        presentation: 'inline', draftContext: context }
    })
  }
  remember(target: CanvasConversationTarget, expanded: boolean): void {
    const context = target.draftContext
    if (!context || context.boardId !== target.boardId || context.nodeId !== target.nodeId || context.threadId !== target.reference.threadId
      || context.conversationId !== (target.reference.conversationId ?? null)) throw new Error(uiAttribute('画布输入的所属信息不完整，请重新读取画板。'))
    this.load(context, context.boardId)
    const contexts = this.boards.get(key(context, context.boardId))!, identity = canvasComposerContextKey(context)
    if (expanded) contexts.add(identity); else contexts.delete(identity)
    this.flush(context, context.boardId)
  }
  flush(scope: CanvasViewScope, boardId: string): void {
    const contexts = this.boards.get(key(scope, boardId))
    if (!contexts) return
    try {
      if (!this.storage) throw new Error()
      this.storage.setItem(key(scope, boardId), JSON.stringify({ version: 1, contexts: [...contexts] }))
    } catch { throw new Error(uiAttribute('展开状态未能保存，本次输入仍保留，请恢复本机存储后重试。')) }
  }
}
