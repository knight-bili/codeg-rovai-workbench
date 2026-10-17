import { NAVIGATION_PROJECT_GROUP_COLORS, type NavigationPreferencesSnapshot, type NavigationProjectGroup, type NavigationProjectGroupColor, type NavigationProjectLayoutMutation } from '@contracts'
import { normalizeProjectDisplayName, projectDisplayNameError } from './project-display-name'
import { isProjectPath as path } from './navigation-project-path'

// Adapts Codeg folder_group_service at aff1e6c278453ed8d0b96a5f664edcdca621aa3f (Apache-2.0).
// Persistence and revision checks use Rovai presentation preferences, not the donor database.

const groupId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
export const navigationProjectGroupKey = (id: string): string => `folder-group:${id}`
export const isNavigationProjectGroupKey = (value: unknown): value is string => typeof value === 'string' && value.startsWith('folder-group:') && groupId(value.slice(13))
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))

export function navigationProjectSidebarLayout<T extends { projectPath: string; projectKey: string }, G extends NavigationProjectGroup>(projects: readonly T[], groups: readonly G[], order: readonly string[] | null) {
  const byPath = new Map(projects.map(project => [project.projectPath, project]))
  const grouped = new Set(groups.flatMap(group => group.projectPaths))
  const entries: Array<{ kind: 'project'; key: string; project: T } | { kind: 'group'; key: string; group: G; projects: T[] }> = [
    ...projects.filter(project => !grouped.has(project.projectPath)).map(project => ({ kind: 'project' as const, key: project.projectKey, project })),
    ...groups.map(group => ({ kind: 'group' as const, key: navigationProjectGroupKey(group.id), group,
      projects: group.projectPaths.flatMap(path => byPath.has(path) ? [byPath.get(path)!] : []) }))
  ]
  const rank = new Map(order?.map((key, index) => [key, index]) ?? [])
  return entries.toSorted((a, b) => (rank.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.key) ?? Number.MAX_SAFE_INTEGER))
}

function parseGroup(value: unknown): NavigationProjectGroup {
  if (!object(value) || !keys(value, ['id', 'name', 'color', 'projectPaths']) || !groupId(value.id)
    || typeof value.name !== 'string' || projectDisplayNameError(value.name)
    || value.color !== null && !NAVIGATION_PROJECT_GROUP_COLORS.includes(value.color as NavigationProjectGroupColor)
    || !Array.isArray(value.projectPaths) || !value.projectPaths.every(path)
    || new Set(value.projectPaths).size !== value.projectPaths.length) throw new Error('项目分组配置无效。')
  return { id: value.id, name: normalizeProjectDisplayName(value.name), color: value.color as NavigationProjectGroupColor | null, projectPaths: [...value.projectPaths] }
}

export function sanitizeNavigationProjectGroups(value: unknown): NavigationProjectGroup[] {
  if (!Array.isArray(value)) return []
  try {
    const groups = value.map(parseGroup), ids = new Set<string>(), paths = new Set<string>()
    for (const group of groups) {
      if (ids.has(group.id)) return []
      ids.add(group.id)
      for (const path of group.projectPaths) { if (paths.has(path)) return []; paths.add(path) }
    }
    return groups
  } catch { return [] }
}

/** Presentation-only update on the latest JSON snapshot. No project registration or business deletion. */
export function applyNavigationProjectLayout(snapshot: NavigationPreferencesSnapshot, expectedRevision: number, input: unknown): NavigationPreferencesSnapshot {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== snapshot.projectGroupsRevision) {
    throw new Error('项目分组已有新修改，请核对后再保存。')
  }
  if (!object(input) || typeof input.type !== 'string') throw new Error('项目分组操作无效。')
  const mutation = input as unknown as NavigationProjectLayoutMutation
  let groups = structuredClone(snapshot.projectGroups), order = [...(snapshot.projectOrder ?? snapshot.registeredProjects.map(path => `directory:${path}`))]
  const active = new Set(snapshot.registeredProjects.filter(path => !snapshot.removedProjects.some(item => item.targetKey === `directory:${path}`)))
  if (mutation.type === 'create' || mutation.type === 'update') {
    if (!keys(input, ['type', 'group'])) throw new Error('项目分组操作无效。')
    const group = parseGroup(mutation.group), previous = groups.find(item => item.id === group.id)
    if (mutation.type === 'create' ? previous : !previous) throw new Error('项目分组身份已变化，请重新读取。')
    if (group.projectPaths.some(path => !active.has(path) && !previous?.projectPaths.includes(path))) throw new Error('请选择已登记且未移除的工程。')
    const selected = new Set(group.projectPaths)
    groups = groups.map(item => item.id === group.id ? group : { ...item, projectPaths: item.projectPaths.filter(path => !selected.has(path)) })
    if (!previous) { groups.push(group); order.push(navigationProjectGroupKey(group.id)) }
    else order.push(...previous.projectPaths.filter(path => active.has(path) && !selected.has(path)).map(path => `directory:${path}`))
  } else if (mutation.type === 'delete') {
    if (!keys(input, ['type', 'groupId']) || !groupId(mutation.groupId)) throw new Error('项目分组操作无效。')
    const group = groups.find(item => item.id === mutation.groupId)
    if (!group) throw new Error('项目分组身份已变化，请重新读取。')
    const members = new Set(group.projectPaths.map(path => `directory:${path}`))
    groups = groups.filter(item => item.id !== group.id)
    order = [...order.filter(key => key !== navigationProjectGroupKey(group.id) && !members.has(key)),
      ...group.projectPaths.filter(path => active.has(path)).map(path => `directory:${path}`)]
  } else if (mutation.type === 'layout') {
    if (!keys(input, ['type', 'entries']) || !Array.isArray(mutation.entries)) throw new Error('项目分组操作无效。')
    if (!mutation.entries.length) return snapshot
    const groupIds = new Set(groups.map(group => group.id)), named = new Set<string>(), top: string[] = [], members = new Map<string, string[]>()
    for (const entry of mutation.entries) {
      if (!object(entry)) throw new Error('项目布局无效。')
      if (entry.kind === 'group' && keys(entry, ['kind', 'groupId']) && typeof entry.groupId === 'string' && groupIds.has(entry.groupId)) {
        const key = navigationProjectGroupKey(entry.groupId)
        if (named.has(key)) throw new Error('项目布局有重复项。')
        named.add(key); top.push(key)
      } else if (entry.kind === 'project' && keys(entry, ['kind', 'projectPath', 'groupId']) && path(entry.projectPath) && active.has(entry.projectPath)
        && (entry.groupId === null || typeof entry.groupId === 'string' && groupIds.has(entry.groupId))) {
        const key = `directory:${entry.projectPath}`
        if (named.has(key)) throw new Error('项目布局有重复项。')
        named.add(key)
        if (entry.groupId === null) top.push(key)
        else members.set(entry.groupId, [...(members.get(entry.groupId) ?? []), entry.projectPath])
      } else throw new Error('项目布局无效。')
    }
    groups = groups.map(group => ({ ...group, projectPaths: [...(members.get(group.id) ?? []), ...group.projectPaths.filter(path => !named.has(`directory:${path}`))] }))
    order = [...top, ...order.filter(key => !named.has(key))]
  } else throw new Error('项目分组操作无效。')
  const grouped = new Set(groups.flatMap(group => group.projectPaths.map(path => `directory:${path}`)))
  order = [...new Set(order.filter(key => !grouped.has(key)))]
  if (JSON.stringify(groups) === JSON.stringify(snapshot.projectGroups) && JSON.stringify(order) === JSON.stringify(snapshot.projectOrder)) return snapshot
  if (snapshot.projectGroupsRevision >= Number.MAX_SAFE_INTEGER) throw new Error('项目分组版本已达到上限。')
  return { ...snapshot, projectGroups: groups, projectOrder: order, projectGroupsRevision: snapshot.projectGroupsRevision + 1 }
}
