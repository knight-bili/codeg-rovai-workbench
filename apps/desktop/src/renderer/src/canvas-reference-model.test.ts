import { expect, it } from 'vitest'
import type { AdapterKind, AgentProfile, CanvasNode, CanvasNodeData, CanvasThreadReference } from '@contracts'
import type { CanvasReferenceState } from './canvas-reference-controller'
import { canvasReferenceOptions, canvasSavedReference, canvasSummaryMetadata, canvasSummaryProjectPaths, resolveCanvasRegion, type CanvasFolderResolution } from './canvas-reference-model'

const thread = (threadId: string, projectPath = '/project'): CanvasThreadReference => ({ threadId, projectPath, projectBindingKind: 'directory',
  title: threadId, updatedAt: '2026-10-15T00:00:00Z', version: 1, missionId: null,
  members: [{ agentId: 'a', displayName: 'A', runtimeKind: 'codex-cli' }, { agentId: 'b', displayName: 'B', runtimeKind: 'gemini-cli' }],
  privateConversations: [{ conversationId: `${threadId}-private-a`, agentId: 'a', updatedAt: '2026-10-15T00:00:01Z' },
    { conversationId: `${threadId}-private-b`, agentId: 'b', updatedAt: '2026-10-15T00:00:02Z' }] })
const catalog = (...items: CanvasThreadReference[]): CanvasReferenceState => ({ items, complete: true, loading: false, error: null, pagesRead: 1 })
const node = (patch: Partial<CanvasNodeData>): CanvasNode => ({ id: 'node', boardId: 'board', createdAt: 'time', updatedAt: 'time', data: {
  kind: 'agent', agentId: null, runtimeKind: null, conversation: null, conversations: [], folderPath: null, folderGroupId: null, path: null,
  title: null, content: null, color: null, collapsed: false, gridColumns: 0, gridRows: 0, x: 0, y: 0, width: 400, height: 300, ...patch } })

it('keeps public, private and Mission-backed references distinct and only declares a missing identity unavailable after a full read', () => {
  const state = catalog(thread('same'), { ...thread('mission'), missionId: 'm' }), before = structuredClone(state)
  const options = canvasReferenceOptions(state.items)
  expect(options).toHaveLength(6)
  expect(options.filter(item => item.reference.threadId === 'same').map(item => item.reference.conversationId)).toEqual(['same-private-b', 'same-private-a', null])
  expect(options.some(item => item.label === '使命：mission')).toBe(true)
  const missing = { threadId: 'same', conversationId: 'ended-private' }
  expect(canvasSavedReference(missing, state)).toMatchObject({ reference: missing, available: false })
  expect(canvasSavedReference(missing, { ...state, complete: false }).available).toBeUndefined()
  expect(state).toEqual(before)
})

it('matches the same active teammate for identity and runtime, including only that teammate’s private conversations', () => {
  const state = catalog(thread('same'))
  expect(resolveCanvasRegion(node({ agentId: 'a', runtimeKind: 'gemini-cli' }), state, []).references).toEqual([])
  const references = resolveCanvasRegion(node({ agentId: 'a', runtimeKind: 'codex-cli' }), state, []).references
  expect(references.map(item => item.reference.conversationId)).toEqual(['same-private-a', null])
  expect(resolveCanvasRegion(node({ runtimeKind: 'gemini-cli' }), state, []).references.map(item => item.reference.conversationId)).toEqual(['same-private-b', null])
})

it('uses explicit parent/worktree relations for folders and groups and does not mistake missing relations for a complete empty region', () => {
  const state = catalog(thread('root'), thread('child', '/linked'), thread('other', '/elsewhere'))
  const folders = new Map<string, { paths: string[]; complete: boolean; parentPath?: string }>([['/project', { paths: ['/project', '/linked'], complete: true }], ['/linked', { paths: ['/linked'], complete: true }]])
  const folder = node({ kind: 'folder', folderPath: '/project' })
  expect(new Set(resolveCanvasRegion(folder, state, [], folders).references.map(item => item.reference.threadId))).toEqual(new Set(['root', 'child']))
  expect(new Set(resolveCanvasRegion(node({ kind: 'folder', folderPath: '/linked' }), state, [], folders).references.map(item => item.reference.threadId))).toEqual(new Set(['child']))
  expect(resolveCanvasRegion(folder, state, []).complete).toBe(false)
  const group = node({ kind: 'group', folderGroupId: 'group' })
  expect(resolveCanvasRegion(group, state, []).complete).toBe(false)
  expect(resolveCanvasRegion(group, state, [{ id: 'group', label: 'group', projectPaths: ['/project', '/linked'] }], folders).references).toHaveLength(6)
  folders.set('/linked', { paths: ['/linked'], complete: true, parentPath: '/project' })
  expect(resolveCanvasRegion(group, state, [{ id: 'group', label: 'child-only', projectPaths: ['/linked'] }], folders).references).toEqual([])
  expect(resolveCanvasRegion(node({ kind: 'folder', folderPath: '/linked' }), state, [], folders).references).toHaveLength(3)
})

it('retains unavailable curated references without silently deleting them or replacing a private reference with a public Thread', () => {
  const state = catalog(thread('same'))
  const selected = [{ threadId: 'same', conversationId: null }, { threadId: 'same', conversationId: 'same-private-a' }, { threadId: 'missing', conversationId: 'private' }]
  const region = node({ kind: 'custom', conversations: selected }), before = structuredClone(region)
  const resolved = resolveCanvasRegion(region, state, [])
  expect(resolved.references.map(item => item.reference)).toEqual([selected[1], selected[0], selected[2]])
  expect(resolved.references[2].available).toBe(false); expect(region).toEqual(before)
})

const summaryProfile = (agentId: string, modelId: string, adapterKind: AdapterKind): Pick<AgentProfile, 'agentId' | 'displayName' | 'runtimeConfiguration' | 'presence' | 'removedAt'> => ({
  agentId, displayName: agentId, presence: 'present', removedAt: null,
  runtimeConfiguration: { adapterKind, model: { mode: 'explicit', modelId, options: {} }, permissions: { adapterKind, schemaVersion: 1, values: {} } }
})

it('shows only the exact private teammate configuration and never invents an observed model for defaults, removed or mismatched runtimes', () => {
  const threads = [thread('one')], a = summaryProfile('a', 'model-a', 'codex-cli'), b = summaryProfile('b', 'model-b', 'gemini-cli')
  const privateRef = { threadId: 'one', conversationId: 'one-private-b' }
  expect(canvasSummaryMetadata(privateRef, threads, [a, b])).toMatchObject({ model: '配置：model-b', modelTitle: '模型配置：B: model-b' })
  expect(canvasSummaryMetadata({ threadId: 'one', conversationId: null }, threads, [a, b]).model).toBe('配置：model-a · model-b')
  expect(canvasSummaryMetadata({ threadId: 'one', conversationId: 'ended' }, threads, [a, b]).model).toBeNull()
  expect(canvasSummaryMetadata(privateRef, threads, [a, { ...b, presence: 'removed' }]).model).toBeNull()
  expect(canvasSummaryMetadata(privateRef, threads, [a, summaryProfile('b', 'wrong', 'codex-cli')]).model).toBeNull()
  expect(canvasSummaryMetadata(privateRef, threads, [a, { ...b, runtimeConfiguration: { ...b.runtimeConfiguration!, model: { mode: 'runtime_default' } } }]).model).toBeNull()
})

it('keeps public and exact private activity separate and leaves old Host activity unknown', () => {
  const reference = { threadId: 'one', conversationId: null }, original = thread('one')
  expect(canvasSummaryMetadata(reference, [original], []).active).toBeUndefined()
  const current = { ...original, publicActiveRunCount: 3, privateConversations: original.privateConversations.map((item, n) => ({ ...item, hasActiveRun: n === 0 })) }
  expect(canvasSummaryMetadata(reference, [current], []).active).toBe(true)
  expect(canvasSummaryMetadata({ ...reference, conversationId: 'one-private-b' }, [current], []).active).toBe(false)
  expect(canvasSummaryMetadata({ ...reference, conversationId: 'one-private-a' }, [{ ...current, publicActiveRunCount: 0 }], []).active).toBe(true)
  expect(canvasSummaryMetadata({ ...reference, conversationId: 'ended' }, [current], []).active).toBeUndefined()
})

it('uses the exact last Run model before current configuration and never substitutes public or another private history', () => {
  const original = thread('one'), lastRunModel = { runId: 'public-run', adapterKind: 'codex-cli', modelId: 'public-observed', reasoningEffort: null }
  const current = { ...original, members: original.members.map(member => member.agentId === 'a' ? { ...member, lastRunModel } : member),
    privateConversations: original.privateConversations.map(item => item.agentId === 'a' ? { ...item, lastRunModel: { ...lastRunModel, runId: 'private-run', modelId: 'private-frozen' } } : item) }
  const profiles = [summaryProfile('a', 'changed-current-config', 'codex-cli'), summaryProfile('b', 'model-b', 'gemini-cli')]
  const reference = { threadId: 'one', conversationId: null }
  expect(canvasSummaryMetadata(reference, [current], profiles)).toMatchObject({ model: '最近：public-observed · 配置：model-b', modelTitle: '最近运行模型：A: public-observed；模型配置：B: model-b' })
  expect(canvasSummaryMetadata({ ...reference, conversationId: 'one-private-a' }, [current], profiles).model).toBe('最近：private-frozen')
  expect(canvasSummaryMetadata({ ...reference, conversationId: 'one-private-b' }, [current], profiles).model).toBe('配置：model-b')
  const unknown = { ...current, privateConversations: current.privateConversations.map(item => ({ ...item, lastRunModel: { ...lastRunModel, modelId: null } })) }
  expect(canvasSummaryMetadata({ ...reference, conversationId: 'one-private-a' }, [unknown], [{ ...profiles[0], runtimeConfiguration: null }]).model).toBeNull()
  expect(canvasSummaryMetadata({ ...reference, conversationId: 'missing' }, [current], profiles).model).toBeNull()
})

it('reads branch only from the exact verified checkout including aliases and hides it after failed refresh, detached HEAD or missing old Host metadata', () => {
  const threads = [thread('one', '/alias')], reference = { threadId: 'one', conversationId: null }
  const relation: CanvasFolderResolution = { paths: ['/alias', '/checkout'], complete: true, projectPath: '/checkout', worktrees: [{ projectPath: '/checkout', isMain: false, bare: false, locked: false, prunable: false, available: true, branch: '功能/中文', detached: false }] }
  const metadata = (value: CanvasFolderResolution) => canvasSummaryMetadata(reference, threads, [], new Map([['/alias', value]]))
  expect(metadata(relation)).toMatchObject({ project: '/alias', branch: '功能/中文' })
  expect(metadata({ ...relation, complete: false }).branch).toBeNull()
  for (const patch of [{ detached: true, branch: null }, { branch: undefined }, { available: false }, { prunable: true }, { projectPath: '/other' }]) {
    expect(metadata({ ...relation, worktrees: [{ ...relation.worktrees![0], ...patch }] }).branch).toBeNull()
  }
  expect(canvasSummaryMetadata(reference, [{ ...threads[0], projectBindingKind: 'quick_chat' }], [], new Map([['/alias', relation]]))).toMatchObject({ project: null, branch: null })
})

it('adds summary project reads only for represented references and matching agent/runtime memberships, without treating object pins or quick chats as checkouts', () => {
  const threads = [thread('one'), thread('two', '/other'), { ...thread('quick', '/quick'), projectBindingKind: 'quick_chat' as const }]
  expect(canvasSummaryProjectPaths([node({ kind: 'conversation', conversation: { threadId: 'one', conversationId: null } }), node({ kind: 'custom', conversations: [{ threadId: 'quick', conversationId: null }] })], threads)).toEqual(['/project'])
  expect(canvasSummaryProjectPaths([node({ kind: 'conversation', conversation: { threadId: 'one', conversationId: null }, objectReference: { kind: 'mission', missionId: 'mission' } })], threads)).toEqual([])
  expect(canvasSummaryProjectPaths([node({ kind: 'agent', agentId: 'a', runtimeKind: 'gemini-cli' })], threads)).toEqual([])
  expect(canvasSummaryProjectPaths([node({ kind: 'agent', agentId: 'a', runtimeKind: 'codex-cli' })], threads)).toEqual(['/project', '/other'])
})
