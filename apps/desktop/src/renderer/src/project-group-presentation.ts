import type { NavigationProjectGroup } from '@contracts'
import type { CanvasFolderResolution } from './canvas-reference-model'

/** Actual main/linked relations override independent child grouping; no string-prefix inference. */
export function resolveSidebarProjectGroups(groups: readonly NavigationProjectGroup[], folders: ReadonlyMap<string, CanvasFolderResolution>) {
  const owners = new Map(groups.flatMap(group => group.projectPaths.filter(path => !folders.get(path)?.parentPath).map(path => [path, group.id] as const)))
  const expanded = groups.map(group => ({ ...group,
    projectPaths: [...new Set(group.projectPaths.flatMap(path => folders.get(path)?.paths ?? [path]))],
    relationshipsComplete: group.projectPaths.every(path => folders.get(path)?.complete)
  }))
  for (const group of groups) for (const root of group.projectPaths) {
    const relation = folders.get(root)
    if (!relation?.parentPath) for (const path of relation?.paths ?? []) if (path !== root) owners.set(path, group.id)
  }
  return expanded.map(group => ({ ...group, projectPaths: group.projectPaths.filter(path => owners.get(path) === group.id) }))
}

export function projectGroupMembershipIssue(paths: readonly string[], previous: readonly string[], folders: ReadonlyMap<string, CanvasFolderResolution>): 'follows_parent' | 'unverified' | null {
  let unverified = false
  for (const path of paths) if (!previous.includes(path)) {
    const relation = folders.get(path)
    if (relation?.parentPath) return 'follows_parent'
    if (!relation?.complete) unverified = true
  }
  return unverified ? 'unverified' : null
}
