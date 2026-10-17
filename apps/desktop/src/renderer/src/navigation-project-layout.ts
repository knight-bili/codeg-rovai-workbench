import type { NavigationPreferencesSnapshot, NavigationProjectLayoutEntry } from '@contracts'
import { navigationProjectSidebarLayout, applyNavigationProjectLayout } from '../../shared/navigation-project-groups'
import type { CanvasFolderResolution } from './canvas-reference-model'

// Adapted from Codeg aff1e6c278453ed8d0b96a5f664edcdca621aa3f:
// src/components/conversations/sidebar-conversation-grouping.ts (Apache-2.0).
// Source license is retained at integration/licenses/codeg/LICENSE.

export type ProjectLayoutItem = { kind: 'group'; groupId: string } | { kind: 'project'; projectPath: string }
export type ProjectLayout = { top: ProjectLayoutItem[]; members: Record<string, string[]> }
export type ProjectLayoutTarget = { groupId: string | null; index: number }
export type ProjectLayoutSlot = { item: ProjectLayoutItem | null; target: ProjectLayoutTarget }

const same = (a: ProjectLayoutItem, b: ProjectLayoutItem) => a.kind === b.kind
  && (a.kind === 'group' ? a.groupId === (b as typeof a).groupId : a.projectPath === (b as typeof a).projectPath)

/** Codeg's per-container layout, using Rovai paths/UUIDs. Derived worktrees never become movable roots. */
export function createProjectLayout(snapshot: NavigationPreferencesSnapshot, folders: ReadonlyMap<string, CanvasFolderResolution>): ProjectLayout {
  const projects = snapshot.registeredProjects.filter(path => !snapshot.removedProjects.some(item => item.targetKey === `directory:${path}`)
    && !folders.get(path)?.parentPath).map(projectPath => ({ projectPath, projectKey: `directory:${projectPath}` }))
  const rows = navigationProjectSidebarLayout(projects, snapshot.projectGroups, snapshot.projectOrder)
  return { top: rows.map(row => row.kind === 'group' ? { kind: 'group', groupId: row.group.id } : { kind: 'project', projectPath: row.project.projectPath }),
    members: Object.fromEntries(rows.flatMap(row => row.kind === 'group' ? [[row.group.id, row.projects.map(project => project.projectPath)]] : [])) }
}

export function locateProjectLayoutItem(layout: ProjectLayout, item: ProjectLayoutItem): ProjectLayoutTarget | null {
  const index = layout.top.findIndex(entry => same(entry, item))
  if (index >= 0) return { groupId: null, index }
  if (item.kind === 'project') for (const [groupId, paths] of Object.entries(layout.members)) {
    const index = paths.indexOf(item.projectPath)
    if (index >= 0) return { groupId, index }
  }
  return null
}

/** Indices are measured after removal. Unknown entries/containers and nesting are never silently retargeted. */
export function moveProjectLayoutItem(layout: ProjectLayout, item: ProjectLayoutItem, target: ProjectLayoutTarget): ProjectLayout {
  const source = locateProjectLayoutItem(layout, item)
  if (!source || !Number.isSafeInteger(target.index) || target.index < 0
    || item.kind === 'group' && target.groupId !== null
    || target.groupId !== null && !Object.hasOwn(layout.members, target.groupId)) return layout
  const next = structuredClone(layout)
  if (source.groupId === null) next.top.splice(source.index, 1)
  else next.members[source.groupId].splice(source.index, 1)
  if (target.groupId === null) next.top.splice(Math.min(target.index, next.top.length), 0, item)
  else if (item.kind === 'project') next.members[target.groupId].splice(Math.min(target.index, next.members[target.groupId].length), 0, item.projectPath)
  return JSON.stringify(next) === JSON.stringify(layout) ? layout : next
}

export function projectLayoutEntries(layout: ProjectLayout): NavigationProjectLayoutEntry[] {
  return layout.top.flatMap<NavigationProjectLayoutEntry>(item => item.kind === 'project'
    ? [{ ...item, groupId: null }]
    : [item, ...(layout.members[item.groupId] ?? []).map(projectPath => ({ kind: 'project' as const, projectPath, groupId: item.groupId }))])
}

/** One fixed row per target, including collapsed/empty groups and an explicit way back to the top level. */
export function projectLayoutSlots(layout: ProjectLayout, moved: ProjectLayoutItem): ProjectLayoutSlot[] {
  const slots: ProjectLayoutSlot[] = []
  for (const [index, item] of layout.top.entries()) {
    if (moved.kind === 'group' || item.kind === 'project') slots.push({ item, target: { groupId: null, index } })
    else {
      slots.push({ item: null, target: { groupId: null, index } })
      slots.push({ item, target: { groupId: item.groupId, index: 0 } })
      for (const [index, projectPath] of (layout.members[item.groupId] ?? []).entries()) {
        slots.push({ item: { kind: 'project', projectPath }, target: { groupId: item.groupId, index: index + 1 } })
      }
    }
  }
  // A group can be placed after the last top-level row; projects can always leave a group, even when every root is grouped.
  slots.push({ item: null, target: { groupId: null, index: layout.top.length } })
  return slots
}

/** Drop slots describe an original row boundary; remove the dragged row before converting that boundary. */
export function projectLayoutSlotTarget(layout: ProjectLayout, item: ProjectLayoutItem, slot: ProjectLayoutSlot): ProjectLayoutTarget {
  const source = locateProjectLayoutItem(layout, item)
  return { ...slot.target, index: slot.target.index - (source?.groupId === slot.target.groupId && source.index < slot.target.index ? 1 : 0) }
}

export function projectLayoutPointerSlot(clientY: number, top: number, scrollTop: number, rowHeight: number, count: number): number | null {
  if (![clientY, top, scrollTop, rowHeight, count].every(Number.isFinite) || rowHeight <= 0 || count <= 0) return null
  return Math.max(0, Math.min(count - 1, Math.floor((clientY - top + scrollTop) / rowHeight)))
}

/** Relation refreshes may reveal a formerly unknown worktree while the editor is open. Never save its stale independent move. */
export function projectLayoutRelationIssue(base: ProjectLayout, next: ProjectLayout, folders: ReadonlyMap<string, CanvasFolderResolution>): boolean {
  for (const entry of projectLayoutEntries(next)) if (entry.kind === 'project') {
    const source = locateProjectLayoutItem(base, entry), destination = locateProjectLayoutItem(next, entry)
    if (folders.get(entry.projectPath)?.parentPath) return true
    if (JSON.stringify(source) !== JSON.stringify(destination)) {
      const relation = folders.get(entry.projectPath)
      if (!relation?.complete || relation.parentPath) return true
    }
  }
  return false
}

/** Only an explicit successful reread may use this comparison to resolve an uncertain preference write. */
export function projectLayoutSaved(base: NavigationPreferencesSnapshot, layout: ProjectLayout, latest: NavigationPreferencesSnapshot): boolean {
  if (latest.readError) return false
  const expected = applyNavigationProjectLayout(base, base.projectGroupsRevision, { type: 'layout', entries: projectLayoutEntries(layout) })
  return latest.projectGroupsRevision >= expected.projectGroupsRevision
    && JSON.stringify(latest.projectGroups) === JSON.stringify(expected.projectGroups)
    && JSON.stringify(latest.projectOrder) === JSON.stringify(expected.projectOrder)
}
