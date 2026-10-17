// Codeg aff1e6c278453ed8d0b96a5f664edcdca621aa3f region membership, adapted to Core Thread/private identities.
// Apache-2.0: integration/licenses/codeg/LICENSE. Business relationships remain Core-owned.
import type { AgentProfile, CanvasConversationRef, CanvasNode, CanvasThreadReference, WorkspaceWorktree } from '@contracts'
import type { CanvasFolderGroupOption, CanvasReferenceOption } from './CanvasNodeEditor'
import type { CanvasReferenceState } from './canvas-reference-controller'
import { canvasReferenceKey } from './canvas-layout'
import { uiAttribute } from './interface-language'

export interface CanvasFolderResolution {
  paths: readonly string[]; complete: boolean; parentPath?: string; issue?: string
  projectPath?: string; repositoryRoot?: string | null; mainWorktreePath?: string | null
  worktrees?: readonly WorkspaceWorktree[]
}
export interface CanvasRegionResolution { references: CanvasReferenceOption[]; complete: boolean; issue?: string }

/** Only ask the existing bounded folder reader for projects represented by these summary cards. */
export function canvasSummaryProjectPaths(nodes: readonly CanvasNode[], threads: readonly CanvasThreadReference[]): string[] {
  const ids = new Set<string>()
  for (const { data } of nodes) {
    if (data.kind === 'conversation' && data.conversation && !data.objectReference) ids.add(data.conversation.threadId)
    if (data.kind === 'custom') data.conversations.forEach(reference => ids.add(reference.threadId))
    if (data.kind === 'agent') for (const thread of threads) {
      if (thread.members.some(member => (!data.agentId || member.agentId === data.agentId) && (!data.runtimeKind || member.runtimeKind === data.runtimeKind))) ids.add(thread.threadId)
    }
  }
  return [...new Set(threads.filter(thread => ids.has(thread.threadId) && thread.projectBindingKind === 'directory').map(thread => thread.projectPath))]
}

/** Historical Run model uses the existing Core projection; current configuration is explicitly distinguished. */
export function canvasSummaryMetadata(reference: CanvasConversationRef, threads: readonly CanvasThreadReference[],
  agents: readonly Pick<AgentProfile, 'agentId' | 'displayName' | 'runtimeConfiguration' | 'presence' | 'removedAt'>[],
  folders?: ReadonlyMap<string, CanvasFolderResolution>): { model: string | null; modelTitle: string | null; project: string | null; branch: string | null; active: boolean | undefined } {
  const thread = threads.find(item => item.threadId === reference.threadId)
  const conversation = reference.conversationId ? thread?.privateConversations.find(item => item.conversationId === reference.conversationId) : null
  const members = thread?.members.filter(member => !reference.conversationId || conversation?.agentId === member.agentId) ?? []
  const configured = members.flatMap(member => {
    const historical = reference.conversationId ? conversation?.lastRunModel : member.lastRunModel
    if (historical?.modelId) return [{ name: member.displayName, model: historical.modelId, historical: true }]
    const profile = agents.find(item => item.agentId === member.agentId && item.presence !== 'removed' && item.removedAt === null)
    const config = profile?.runtimeConfiguration
    return config?.adapterKind === member.runtimeKind && config.model.mode === 'explicit' && config.model.modelId
      ? [{ name: member.displayName, model: config.model.modelId, historical: false }] : []
  })
  const models = [true, false].flatMap(historical => {
    const names = [...new Set(configured.filter(item => item.historical === historical).map(item => item.model))]
    return names.length ? [uiAttribute(historical ? '最近：{0}' : '配置：{0}', names.join(' · '))] : []
  })
  const project = thread?.projectBindingKind === 'directory' ? thread.projectPath : null
  let branch: string | null = null
  if (project && folders) {
    const exact = folders.get(project)
    // A failed exact refresh must not be masked by a different cached region.
    const candidates = exact ? [exact] : [...folders.values()].filter(value => value.worktrees?.some(item => item.projectPath === project))
    const branches = candidates.flatMap(value => {
      if (!value.complete) return []
      const checkout = value.worktrees?.find(item => item.projectPath === (value === exact ? value.projectPath : project))
      return checkout?.available && !checkout.bare && !checkout.prunable && !checkout.detached && checkout.branch ? [checkout.branch] : []
    })
    if (branches.length && new Set(branches).size === 1) branch = branches[0]
  }
  const active = reference.conversationId ? conversation?.hasActiveRun
    : thread?.publicActiveRunCount === undefined ? undefined : thread.publicActiveRunCount > 0
  return { active, model: models.length ? models.join(' · ') : null,
    modelTitle: configured.length ? configured.map(item => uiAttribute(item.historical ? '最近运行模型：{0}' : '模型配置：{0}', `${item.name}: ${item.model}`)).join('；') : null, project, branch }
}

const recency = (value: string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0
function optionsForThread(thread: CanvasThreadReference, memberIds?: ReadonlySet<string>): Array<CanvasReferenceOption & { updatedAt: string }> {
  const title = thread.missionId ? uiAttribute('使命：{0}', thread.title) : thread.title
  return [{ reference: { threadId: thread.threadId, conversationId: null }, label: title, available: true, updatedAt: thread.updatedAt },
    ...thread.privateConversations.filter(conversation => !memberIds || memberIds.has(conversation.agentId)).map(conversation => ({
      reference: { threadId: thread.threadId, conversationId: conversation.conversationId }, available: true, updatedAt: conversation.updatedAt,
      label: uiAttribute('{0} · {1} 的单聊', title, thread.members.find(member => member.agentId === conversation.agentId)?.displayName ?? uiAttribute('队员'))
    }))]
}
const byRecency = (a: CanvasReferenceOption & { updatedAt: string }, b: CanvasReferenceOption & { updatedAt: string }) => {
  const left = canvasReferenceKey(a.reference), right = canvasReferenceKey(b.reference)
  return recency(b.updatedAt) - recency(a.updatedAt) || (left < right ? -1 : left > right ? 1 : 0)
}
export function canvasReferenceOptions(items: readonly CanvasThreadReference[]): CanvasReferenceOption[] {
  return items.flatMap(thread => optionsForThread(thread)).toSorted(byRecency)
}
export function canvasSavedReference(reference: CanvasConversationRef, catalog: CanvasReferenceState): CanvasReferenceOption {
  const thread = catalog.items.find(item => item.threadId === reference.threadId)
  const option = thread && optionsForThread(thread).find(item => canvasReferenceKey(item.reference) === canvasReferenceKey(reference))
  if (option) return option
  return { reference, label: thread && reference.conversationId ? uiAttribute('{0} · 单聊不可用', thread.title)
    : uiAttribute(catalog.complete ? '对话已结束或不可用' : '尚未核对的对话'), available: catalog.complete ? false : undefined }
}

/** Every member/runtime condition applies to the same actual active membership, never the default Lead alone. */
export function resolveCanvasRegion(node: CanvasNode, catalog: CanvasReferenceState, groups: readonly CanvasFolderGroupOption[],
  folders?: ReadonlyMap<string, CanvasFolderResolution>): CanvasRegionResolution {
  const data = node.data
  let complete = catalog.complete, issue = catalog.error ? uiAttribute('对话清单读取未完成') : undefined
  if (data.kind === 'custom') {
    const options = canvasReferenceOptions(catalog.items)
    const known = new Map(options.map(option => [canvasReferenceKey(option.reference), option]))
    const ranks = new Map(options.map((option, index) => [canvasReferenceKey(option.reference), index]))
    return { references: data.conversations.map(reference => known.get(canvasReferenceKey(reference)) ?? canvasSavedReference(reference, catalog))
      .toSorted((a, b) => (ranks.get(canvasReferenceKey(a.reference)) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(canvasReferenceKey(b.reference)) ?? Number.MAX_SAFE_INTEGER)), complete, issue }
  }
  const selected: Array<CanvasReferenceOption & { updatedAt: string }> = []
  if (data.kind === 'agent') {
    for (const thread of catalog.items) {
      const members = thread.members.filter(member => (!data.agentId || member.agentId === data.agentId) && (!data.runtimeKind || member.runtimeKind === data.runtimeKind))
      if (members.length) selected.push(...optionsForThread(thread, new Set(members.map(member => member.agentId))))
    }
  } else if (data.kind === 'folder' || data.kind === 'group') {
    const group = groups.find(group => group.id === data.folderGroupId)
    const roots = data.kind === 'folder' && data.folderPath ? [data.folderPath] : group?.projectPaths
    if (!roots) return { references: [], complete: false, issue: uiAttribute('项目分组在当前工作区不可用') }
    const paths = new Set<string>()
    for (const root of roots) {
      const related = folders?.get(root)
      if (!related?.complete) { complete = false; issue = related?.issue || uiAttribute('工作树关系尚未核对') }
      if (data.kind === 'group' && related?.parentPath) continue
      for (const path of related?.paths ?? [root]) paths.add(path)
    }
    for (const thread of catalog.items) if (thread.projectBindingKind === 'directory' && paths.has(thread.projectPath)) selected.push(...optionsForThread(thread))
  }
  return { references: selected.toSorted(byRecency), complete, issue }
}
