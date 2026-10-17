import type { CanvasNode, SingleChatSnapshot } from '@contracts'
import type { ThreadClient } from './camp-client'
import type { ThreadLeaveGuard, ThreadLeavePreparation } from './ThreadWorkspace'
import { canvasComposerContextKey } from './canvas-composer-drafts'
import { canvasConversationMatches, readCanvasConversation, type CanvasConversationTarget } from './canvas-conversation'
import type { CanvasConversationRecovery } from './canvas-conversation-recovery'
import { readCanvasViewScope, type CanvasViewScope } from './canvas-view-state'
import type { ThreadProjectionStore } from './thread-projection-store'
import { readErrorMessage } from './error-message'
import { uiAttribute } from './interface-language'
import type { CanvasLeavePreparation } from './canvas-leave'

export interface CanvasConversationInstance {
  key: string
  target: CanvasConversationTarget
  conversation: SingleChatSnapshot['conversation'] | null
}
export interface CanvasConversationsState { instances: CanvasConversationInstance[]; busyKeys: readonly string[]; opening: boolean; leaving: boolean; issue: string | null; restoring: { boardId: string; completed: number; total: number } | null }
export const initialCanvasConversations = (): CanvasConversationsState => ({ instances: [], busyKeys: [], opening: false, leaving: false, issue: null, restoring: null })
interface CanvasLeaveEntry {
  generation: number; keys: string[]; preparations: ThreadLeavePreparation[]
  prepared: Promise<void>; users: number; didLeave: boolean; cancelled: boolean; completing: Promise<void> | null
}

/** Presentation instances only. Core owns conversations/execution; each real card retains its input context. */
export class CanvasConversationsController {
  private state = initialCanvasConversations()
  private readonly listeners = new Set<() => void>()
  private readonly guards = new Map<string, ThreadLeaveGuard>()
  private disposed = false
  private generation = 0
  private leave: CanvasLeaveEntry | null = null
  constructor(private readonly client: Pick<ThreadClient, 'request' | 'presentationScope' | 'canvasCoreIdentity'>, private readonly reads: Pick<ThreadProjectionStore, 'open'> & Partial<Pick<ThreadProjectionStore, 'refresh'>>, private readonly afterCommit: () => Promise<void>, private readonly recovery?: CanvasConversationRecovery) {}
  getSnapshot = (): CanvasConversationsState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(change: Partial<CanvasConversationsState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...change }
    for (const listener of this.listeners) listener()
  }
  register(key: string, guard: ThreadLeaveGuard | null): void { if (guard) this.guards.set(key, guard); else this.guards.delete(key) }
  open(input: CanvasConversationTarget): Promise<boolean> { return this.openTarget(input) }
  private remember(target: CanvasConversationTarget, expanded: boolean): void {
    try { this.recovery?.remember(target, expanded) } catch (error) { this.publish({ issue: readErrorMessage(error) }) }
  }
  private async openTarget(input: CanvasConversationTarget, restoring = false, fresh = false): Promise<boolean> {
    if (this.disposed || this.state.opening || this.state.restoring && !restoring) return false
    const target = structuredClone(input), context = target.draftContext
    if (!context || context.host !== this.client.presentationScope || context.boardId !== target.boardId || context.nodeId !== target.nodeId
      || context.threadId !== target.reference.threadId || context.conversationId !== (target.reference.conversationId ?? null)) {
      this.publish({ issue: uiAttribute('画布输入的所属信息不完整，请重新读取画板。') }); return false
    }
    const key = canvasComposerContextKey(context), existing = this.state.instances.find(item => item.key === key)
    if (existing) {
      // Reordering keyed editors still detaches their DOM and loses native undo history.
      const instances = this.state.instances.map(item => item.key === key ? { ...item, target }
        : target.presentation === 'drawer' && item.target.presentation === 'drawer'
          ? { ...item, target: { ...item.target, presentation: 'inline' as const } } : item)
      this.publish({ instances, issue: null })
      if (!restoring) this.remember(target, true)
      return true
    }
    const generation = this.generation
    const current = () => !this.disposed && generation === this.generation
    this.publish({ opening: true, issue: null })
    try {
      const scope = await readCanvasViewScope(this.client)
      if (!current()) return false
      if (scope?.core !== context.core || scope.host !== context.host) throw new Error(uiAttribute('画布输入的所属信息不完整，请重新读取画板。'))
      const loaded = await readCanvasConversation(target.reference,
        conversationId => this.client.request<SingleChatSnapshot | null>('singleChat.get', { conversationId }),
        async threadId => (await (fresh && this.reads.refresh ? this.reads.refresh(threadId) : this.reads.open(threadId))).snapshot, current)
      if (!loaded || !current()) return false
      this.publish({ instances: [...this.state.instances, { key, target, conversation: loaded.conversation }] })
      if (!restoring) this.remember(target, true)
      return true
    } catch (error) { if (current()) this.publish({ issue: readErrorMessage(error) }); return false }
    finally { if (current()) this.publish({ opening: false }) }
  }
  async close(keys: readonly string[] = this.state.instances.map(item => item.key), rememberClosed = true): Promise<boolean> {
    if (this.disposed || this.state.opening || this.state.restoring) return false
    const selected = this.state.instances.filter(item => keys.includes(item.key))
    if (!selected.length) return true
    const generation = this.generation, preparations: ThreadLeavePreparation[] = []
    this.publish({ opening: true, busyKeys: selected.map(item => item.key), issue: null })
    try {
      for (const instance of selected) {
        const guard = this.guards.get(instance.key)
        if (guard) preparations.push(await guard())
        if (this.disposed || generation !== this.generation) throw new Error(uiAttribute('会话读取已失效，请重新打开。'))
      }
      const closed = new Set(selected.map(item => item.key))
      this.publish({ instances: this.state.instances.filter(item => !closed.has(item.key)) })
      await this.afterCommit()
      for (const preparation of preparations) preparation.complete(true)
      for (const key of closed) this.guards.delete(key)
      if (rememberClosed) for (const item of selected) this.remember(item.target, false)
      return true
    } catch (error) {
      for (const preparation of preparations) preparation.complete(false)
      this.publish({ issue: readErrorMessage(error) }); return false
    } finally { this.publish({ opening: false, busyKeys: [] }) }
  }
  async prepare(keys: readonly string[]): Promise<ThreadLeavePreparation> {
    if (this.disposed || this.state.opening || this.state.restoring) throw new Error(uiAttribute('当前对话输入尚未保存，请处理后重试。'))
    const selected = this.state.instances.filter(item => keys.includes(item.key)), preparations: ThreadLeavePreparation[] = []
    const generation = this.generation
    this.publish({ opening: true, busyKeys: selected.map(item => item.key), issue: null })
    try {
      for (const item of selected) {
        const guard = this.guards.get(item.key)
        if (guard) preparations.push(await guard())
        if (this.disposed || generation !== this.generation) throw new Error(uiAttribute('会话读取已失效，请重新打开。'))
      }
    } catch (error) {
      for (const item of preparations) item.complete(false)
      this.publish({ opening: false, busyKeys: [], issue: readErrorMessage(error) }); throw error
    }
    let completed = false
    return { complete: () => {
      if (completed) return
      completed = true
      // A layout operation did not leave the editor. Missing pins retain their original input in the drawer.
      for (const item of preparations) item.complete(false)
      this.publish({ opening: false, busyKeys: [] })
    } }
  }
  async prepareLeave(keys: readonly string[] = this.state.instances.map(item => item.key)): Promise<CanvasLeavePreparation> {
    const selected = this.state.instances.filter(item => keys.includes(item.key)), selectedKeys = selected.map(item => item.key).sort()
    let entry = this.leave
    if (entry) {
      if (entry.cancelled || entry.completing || JSON.stringify(entry.keys) !== JSON.stringify(selectedKeys)) throw new Error(uiAttribute('当前对话输入尚未保存，请处理后重试。'))
    } else {
      if (this.disposed || this.state.opening || this.state.restoring) throw new Error(uiAttribute('当前对话输入尚未保存，请处理后重试。'))
      const created: CanvasLeaveEntry = { generation: this.generation, keys: selectedKeys, preparations: [], prepared: Promise.resolve(), users: 0, didLeave: false, cancelled: false, completing: null }
      this.leave = created; entry = created
      this.publish({ opening: true, leaving: true, busyKeys: selectedKeys, issue: null })
      created.prepared = Promise.resolve().then(async () => {
        try {
          if (created.cancelled || this.disposed || created.generation !== this.generation) throw new Error(uiAttribute('会话读取已失效，请重新打开。'))
          for (const instance of selected) {
            const guard = this.guards.get(instance.key)
            if (guard) created.preparations.push(await guard())
            if (created.cancelled || this.disposed || created.generation !== this.generation) throw new Error(uiAttribute('会话读取已失效，请重新打开。'))
          }
        } catch (error) {
          created.cancelled = true; this.finishPreparations(created, false)
          if (this.leave === created) { this.leave = null; this.publish({ opening: false, leaving: false, busyKeys: [], issue: readErrorMessage(error) }) }
          throw error
        }
      })
    }
    const owned = entry
    owned.users += 1
    try {
      await owned.prepared
      if (owned.cancelled || this.disposed || owned.generation !== this.generation) throw new Error(uiAttribute('会话读取已失效，请重新打开。'))
    } catch (error) { owned.users -= 1; throw error }
    let released = false
    return { complete: (didLeave: boolean) => {
      if (released) return owned.completing ?? Promise.resolve()
      released = true; owned.didLeave ||= didLeave; owned.users -= 1
      if (owned.users > 0) return Promise.resolve()
      owned.completing = Promise.resolve().then(async () => {
        try {
          if (!owned.cancelled && !this.disposed && owned.generation === this.generation && owned.didLeave) {
            await this.afterCommit()
            const current = !owned.cancelled && !this.disposed && owned.generation === this.generation
            if (current) this.publish({ instances: this.state.instances.filter(item => !owned.keys.includes(item.key)) })
            this.finishPreparations(owned, current)
            if (current) for (const key of owned.keys) this.guards.delete(key)
          } else this.finishPreparations(owned, false)
        } catch (error) {
          this.finishPreparations(owned, false)
          if (this.leave === owned) this.publish({ issue: readErrorMessage(error) })
          throw error
        } finally {
          if (this.leave === owned) { this.leave = null; this.publish({ opening: false, leaving: false, busyKeys: [] }) }
        }
      })
      return owned.completing
    } }
  }
  private finishPreparations(entry: CanvasLeaveEntry, didLeave: boolean): void {
    for (const preparation of entry.preparations.splice(0)) preparation.complete(didLeave)
  }
  async restore(scope: CanvasViewScope, boardId: string, nodes: readonly CanvasNode[]): Promise<boolean> {
    if (!this.recovery || this.disposed || this.state.opening || this.state.restoring) return false
    const generation = this.generation, current = () => !this.disposed && generation === this.generation
    if (scope.host !== this.client.presentationScope) return false
    const issues: string[] = [], freshThreads = new Set<string>()
    try {
      const targets = this.recovery.load(scope, boardId, nodes)
      this.publish({ restoring: { boardId, completed: 0, total: targets.length }, issue: null })
      let completed = 0
      for (const target of targets) {
        if (!current()) return false
        if (!nodes.some(node => canvasConversationMatches(node, target))) issues.push(uiAttribute('部分展开卡片已变更，原引用记录仍保留。'))
        else if (this.state.instances.some(item => item.key === canvasComposerContextKey(target.draftContext!))) freshThreads.add(target.reference.threadId)
        else if (await this.openTarget(target, true, !freshThreads.has(target.reference.threadId))) freshThreads.add(target.reference.threadId)
        else if (current()) issues.push(this.state.issue ?? uiAttribute('部分对话未能恢复，原展开记录仍保留。'))
        if (!current()) return false
        this.publish({ restoring: { boardId, completed: ++completed, total: targets.length } })
      }
      this.recovery.flush(scope, boardId)
      if (current()) this.publish({ issue: [...new Set(issues)].join(' ') || null })
      return issues.length === 0
    } catch (error) { if (current()) this.publish({ issue: readErrorMessage(error) }); return false }
    finally { if (current()) this.publish({ restoring: null }) }
  }
  cancelRestore(): void {
    if (!this.state.restoring) return
    this.generation += 1
    this.publish({ restoring: null, opening: false, busyKeys: [], issue: uiAttribute('已停止恢复，未展开的记录仍保留。') })
  }
  dispose(): void {
    this.generation += 1; this.disposed = true
    if (this.leave) { this.leave.cancelled = true; this.finishPreparations(this.leave, false); this.leave = null }
    this.listeners.clear(); this.guards.clear()
  }
}
