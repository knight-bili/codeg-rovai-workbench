import type { ThreadComposerDraftView } from '@contracts'
import type { ThreadClient } from './camp-client'
import { loadLocalThreadComposerDraft, saveLocalThreadComposerDraft, threadComposerDraftStorage } from './camp-composer-local-store'
import { canvasComposerContextKey, hasCanvasComposerInput, hasPendingThreadDraftInput, localComposerBaseStorage, type CanvasComposerContext } from './canvas-composer-drafts'
export { hasPendingThreadDraftInput } from './canvas-composer-drafts'

// Accepted activation is monotonic. Retain the receipt fact across Composer
// mounts on this transport while its Pending projection is still catching up.
const activatedThreads = new WeakMap<Pick<ThreadClient, 'request'>, Set<string>>()
type Client = Pick<ThreadClient, 'request' | 'editingRecovery' | 'presentationScope'>
interface Retention { acknowledged?: boolean; hints: Map<string, boolean>; tail: Promise<void>; surfaces: number }
const retentions = new WeakMap<object, Map<string, Retention>>()
function retention(client: Client, threadId: string): Retention {
  let threads = retentions.get(client)
  if (!threads) { threads = new Map(); retentions.set(client, threads) }
  let current = threads.get(threadId)
  if (!current) { current = { hints: new Map(), tail: Promise.resolve(), surfaces: 0 }; threads.set(threadId, current) }
  return current
}
export function retainPendingThreadDraftSurface(client: Client, threadId: string): () => void {
  const current = retention(client, threadId)
  current.surfaces += 1
  let released = false
  return () => { if (!released) { released = true; current.surfaces -= 1 } }
}
export function hasPendingThreadDraftSurfaces(client: Client, threadId: string): boolean {
  return retention(client, threadId).surfaces > 0
}
export async function hasAnyPendingThreadDraftInput(client: Client, threadId: string): Promise<boolean> {
  const current = retention(client, threadId)
  if (current.hints.get('main')) return true
  const main = loadLocalThreadComposerDraft(threadId, localComposerBaseStorage(client) ?? null)
  if (main && hasPendingThreadDraftInput(main)) return true
  return hasCanvasComposerInput(client, threadId, current.hints)
}

/** The local snapshot owns content; Core presence protects its Thread from startup cleanup.
 * Coordinators save independent contexts; their Thread-level presence receipts share one serial queue.
 * An unacknowledged presence change remains retryable.
 */
export class PendingThreadDraftPersistence {
  constructor(
    private readonly client: Client,
    private readonly save = (draft: ThreadComposerDraftView): void => {
      const storage = threadComposerDraftStorage(this.client.editingRecovery) ?? window.localStorage
      if (!storage) throw new Error('Local draft storage is unavailable')
      saveLocalThreadComposerDraft(draft, storage)
    },
    private readonly context?: CanvasComposerContext
  ) {}

  acknowledgeActivation(threadId: string): void {
    let threads = activatedThreads.get(this.client)
    if (!threads) {
      threads = new Set()
      activatedThreads.set(this.client, threads)
    }
    threads.add(threadId)
    retention(this.client, threadId).acknowledged = undefined
  }

  isActivated(threadId: string): boolean {
    return activatedThreads.get(this.client)?.has(threadId) ?? false
  }

  async persist(draft: ThreadComposerDraftView): Promise<void> {
    if (this.context && this.context.threadId !== draft.threadId) throw new Error('Canvas draft belongs to another Thread.')
    const current = retention(this.client, draft.threadId)
    current.hints.set(this.context ? canvasComposerContextKey(this.context) : 'main', hasPendingThreadDraftInput(draft))
    this.save(draft)
    if (this.isActivated(draft.threadId)) return
    const saving = current.tail.then(async () => {
      if (this.isActivated(draft.threadId)) return
      try {
        const present = await hasAnyPendingThreadDraftInput(this.client, draft.threadId)
        if (this.isActivated(draft.threadId) || current.acknowledged === present) return
        await this.client.request('threads.pendingDraft.setPresence', { threadId: draft.threadId, present })
        if (!this.isActivated(draft.threadId)) current.acknowledged = present
      } catch (error) {
        if (!this.isActivated(draft.threadId)) throw error
      }
    })
    current.tail = saving.then(() => undefined, () => undefined)
    await saving
  }
}
