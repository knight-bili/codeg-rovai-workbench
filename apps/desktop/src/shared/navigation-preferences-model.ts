import { isThreadId } from '@contracts'
import type { NavigationPin, NavigationPreferencesSnapshot, NavigationThreadReadState, RemovedNavigationProject } from '@contracts'
import { normalizeProjectDisplayName, projectDisplayNameError } from './project-display-name'
import { isNavigationProjectGroupKey, sanitizeNavigationProjectGroups } from './navigation-project-groups'
import { isProjectPath } from './navigation-project-path'
export { isProjectPath } from './navigation-project-path'

export const EMPTY_SNAPSHOT: NavigationPreferencesSnapshot = {
  schemaVersion: 7,
  projectGroups: [],
  projectGroupsRevision: 0,
  registeredProjects: [],
  legacyProjectsSynced: false,
  pins: [],
  removedProjects: [],
  projectOrder: null,
  projectNames: {},
  threadReadStates: {}
}

export function sanitizeSnapshot(source: unknown): NavigationPreferencesSnapshot {
  if (!isRecord(source)) return structuredClone(EMPTY_SNAPSHOT)
  const version = source.schemaVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 7) return structuredClone(EMPTY_SNAPSHOT)
  const pins = sanitizePins(source)
  const removedProjects = version >= 2
    ? sanitizeRemovedProjects(source.removedProjects)
    : []
  const projectOrder = version >= 3
    ? sanitizeProjectOrder(source.projectOrder, version === 7)
    : null
  const projectNames = version >= 4 ? sanitizeProjectNames(source.projectNames) : {}
  const threadReadStates = version >= 5 ? sanitizeThreadReadStates(source.threadReadStates) : {}
  const registeredProjects = version >= 6 && Array.isArray(source.registeredProjects)
    ? [...new Set(source.registeredProjects.filter(isProjectPath))] : []
  const legacyProjectsSynced = version >= 6 && source.legacyProjectsSynced === true
  const projectGroups = version === 7 ? sanitizeNavigationProjectGroups(source.projectGroups) : []
  const projectGroupsRevision = version === 7 && Number.isSafeInteger(source.projectGroupsRevision) && (source.projectGroupsRevision as number) >= 0 ? source.projectGroupsRevision as number : 0
  const groupKeys = new Set(projectGroups.map(group => `folder-group:${group.id}`))
  return { schemaVersion: 7, projectGroups, projectGroupsRevision, registeredProjects, legacyProjectsSynced, pins, removedProjects,
    projectOrder: projectOrder?.filter(key => !isNavigationProjectGroupKey(key) || groupKeys.has(key)) ?? null, projectNames, threadReadStates }
}

export function sanitizePins(source: Record<string, unknown>): NavigationPin[] {
  if (
    ![1, 2, 3, 4, 5, 6, 7].includes(source.schemaVersion as number)
    || !Array.isArray(source.pins)
  ) return []
  const seen = new Set<string>()
  const pins: NavigationPin[] = []
  for (const candidate of source.pins) {
    if (!isRecord(candidate)) continue
    const kind = candidate.kind
    const targetKey = candidate.targetKey
    if (
      (kind !== 'camp' && kind !== 'project')
      || typeof targetKey !== 'string'
      || (kind === 'camp'
        ? !isThreadId(targetKey)
        : !isProjectTargetKey(targetKey))
      || !isTimestamp(candidate.pinnedAt)
    ) continue
    const key = `${kind}:${targetKey}`
    if (seen.has(key)) continue
    seen.add(key)
    pins.push({
      kind,
      targetKey,
      pinnedAt: candidate.pinnedAt
    })
  }
  return pins.sort((left, right) =>
    left.pinnedAt.localeCompare(right.pinnedAt)
      || left.kind.localeCompare(right.kind)
      || left.targetKey.localeCompare(right.targetKey)
  )
}

export function sanitizeProjectOrder(source: unknown, allowGroups = false): string[] | null {
  if (source === null) return null
  if (!Array.isArray(source)) return null
  const seen = new Set<string>()
  const projectOrder: string[] = []
  for (const projectKey of source) {
    if ((!isProjectTargetKey(projectKey) && !(allowGroups && isNavigationProjectGroupKey(projectKey))) || seen.has(projectKey)) continue
    seen.add(projectKey)
    projectOrder.push(projectKey)
  }
  return projectOrder
}

export function sanitizeProjectNames(source: unknown): Record<string, string> {
  if (!isRecord(source)) return {}
  return Object.fromEntries(Object.entries(source).flatMap(([key, name]) =>
    isProjectTargetKey(key) && typeof name === 'string' && !projectDisplayNameError(name)
      ? [[key, normalizeProjectDisplayName(name)]]
      : []
  ))
}

export function sanitizeRemovedProjects(source: unknown): RemovedNavigationProject[] {
  if (!Array.isArray(source)) return []
  const seen = new Set<string>()
  const projects: RemovedNavigationProject[] = []
  for (const candidate of source) {
    if (
      !isRecord(candidate)
      || !isProjectTargetKey(candidate.targetKey)
      || !isTimestamp(candidate.removedAt)
      || seen.has(candidate.targetKey)
    ) continue
    seen.add(candidate.targetKey)
    projects.push({
      targetKey: candidate.targetKey,
      removedAt: candidate.removedAt
    })
  }
  return projects.sort((left, right) =>
    left.removedAt.localeCompare(right.removedAt)
      || left.targetKey.localeCompare(right.targetKey)
  )
}

export function isProjectTargetKey(value: unknown): value is string {
  return isStableId(value) && value.startsWith('directory:')
}

export function isStableId(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 8_192
}

export function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isNavigationThreadReadState(value: unknown): value is NavigationThreadReadState {
  return isRecord(value) && typeof value.manualUnread === 'boolean'
    && Number.isSafeInteger(value.readThroughGlobalSequence)
    && (value.readThroughGlobalSequence as number) >= 0
}

export function sanitizeThreadReadStates(source: unknown): Record<string, NavigationThreadReadState> {
  if (!isRecord(source)) return {}
  return Object.fromEntries(Object.entries(source).flatMap(([id, state]) =>
    isThreadId(id) && isNavigationThreadReadState(state)
      ? [[id, { manualUnread: state.manualUnread, readThroughGlobalSequence: state.readThroughGlobalSequence }]]
      : []
  ))
}

export function registerNavigationProjects(snapshot: NavigationPreferencesSnapshot, paths: string[], completeLegacy = false): NavigationPreferencesSnapshot {
  if (!Array.isArray(paths) || !paths.every(isProjectPath)) throw new Error('Invalid project directories')
  // A delayed startup result can only fill gaps; it never undoes a user removal.
  if (completeLegacy && snapshot.legacyProjectsSynced) return snapshot
  const removed = new Set(snapshot.removedProjects.map(project => project.targetKey))
  const registered = [...new Set([...snapshot.registeredProjects, ...paths.filter(path => !removed.has(`directory:${path}`))])]
  const order = snapshot.projectOrder ?? []
  const grouped = new Set(snapshot.projectGroups.flatMap(group => group.projectPaths))
  return { ...snapshot,
    projectOrder: [...new Set([...order, ...registered.filter(path => !grouped.has(path)).map(path => `directory:${path}`)])],
    registeredProjects: registered,
    legacyProjectsSynced: snapshot.legacyProjectsSynced || completeLegacy }
}

export function sourceMatchesSupportedSnapshot(source: unknown, snapshot: NavigationPreferencesSnapshot): boolean {
  if (!isRecord(source) || ![1, 2, 3, 4, 5, 6, 7].includes(source.schemaVersion as number)) return false
  const version = source.schemaVersion as number
  const expected: Record<string, unknown> = { schemaVersion: version, pins: snapshot.pins }
  if (version >= 2) expected.removedProjects = snapshot.removedProjects
  if (version >= 3) expected.projectOrder = snapshot.projectOrder
  if (version >= 4) expected.projectNames = snapshot.projectNames
  if (version >= 5) expected.threadReadStates = snapshot.threadReadStates
  if (version >= 6) {
    expected.registeredProjects = snapshot.registeredProjects
    expected.legacyProjectsSynced = snapshot.legacyProjectsSynced
  }
  if (version >= 7) {
    expected.projectGroups = snapshot.projectGroups
    expected.projectGroupsRevision = snapshot.projectGroupsRevision
  }
  return Object.keys(source).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => JSON.stringify(source[key]) === JSON.stringify(value))
}
