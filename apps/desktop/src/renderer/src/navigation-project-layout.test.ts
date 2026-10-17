import { expect, it } from 'vitest'
import type { NavigationPreferencesSnapshot } from '@contracts'
import { EMPTY_SNAPSHOT } from '../../shared/navigation-preferences-model'
import { applyNavigationProjectLayout as apply } from '../../shared/navigation-project-groups'
import type { CanvasFolderResolution } from './canvas-reference-model'
import { createProjectLayout, locateProjectLayoutItem, moveProjectLayoutItem, projectLayoutEntries, projectLayoutPointerSlot,
  projectLayoutRelationIssue, projectLayoutSaved, projectLayoutSlots, projectLayoutSlotTarget, type ProjectLayoutItem } from './navigation-project-layout'

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222'
const project = (projectPath: string): ProjectLayoutItem => ({ kind: 'project', projectPath })
const group = (groupId: string): ProjectLayoutItem => ({ kind: 'group', groupId })
const snapshot = (): NavigationPreferencesSnapshot => ({ ...structuredClone(EMPTY_SNAPSHOT),
  registeredProjects: ['/a', '/b', '/c', '/linked', '/gone'], projectOrder: [`folder-group:${A}`, 'directory:/b', `folder-group:${B}`, 'directory:/c'],
  projectGroups: [{ id: A, name: '工作', color: 'blue', projectPaths: ['/a', '/linked', '/gone'] }, { id: B, name: '空组', color: null, projectPaths: [] }],
  removedProjects: [{ targetKey: 'directory:/gone', removedAt: '2026-10-15T00:00:00Z' }], projectGroupsRevision: 4,
  pins: [{ kind: 'project', targetKey: 'directory:/b', pinnedAt: '2026-10-15T00:00:00Z' }], projectNames: { 'directory:/b': '别名' } })
const folders = (): Map<string, CanvasFolderResolution> => new Map([
  ['/a', { paths: ['/a', '/linked'], complete: true }], ['/linked', { paths: ['/linked'], parentPath: '/a', complete: true }],
  ['/b', { paths: ['/b'], complete: true }], ['/c', { paths: ['/c'], complete: true }]
])

it('builds mixed sibling order including pinned roots, excludes actual linked worktrees and preserves unseen membership when saved', () => {
  const source = snapshot(), layout = createProjectLayout(source, folders())
  expect(layout).toEqual({ top: [group(A), project('/b'), group(B), project('/c')], members: { [A]: ['/a'], [B]: [] } })
  const next = moveProjectLayoutItem(layout, project('/b'), { groupId: B, index: 0 })
  const saved = apply(source, 4, { type: 'layout', entries: projectLayoutEntries(next) })
  expect(saved.projectGroups[0].projectPaths).toEqual(['/a', '/linked', '/gone'])
  expect(saved.projectGroups[1].projectPaths).toEqual(['/b'])
  expect(saved.pins).toEqual(source.pins); expect(saved.projectNames).toEqual(source.projectNames)
  expect(saved.registeredProjects).toEqual(source.registeredProjects); expect(saved.removedProjects).toEqual(source.removedProjects)
})

it('moves groups with their members, moves roots between containers, and offers explicit top-level boundaries even when every root is grouped', () => {
  const initial = createProjectLayout(snapshot(), folders())
  const moved = moveProjectLayoutItem(initial, group(A), { groupId: null, index: 99 })
  expect(moved.top).toEqual([project('/b'), group(B), project('/c'), group(A)])
  expect(moved.members).toEqual(initial.members)
  let layout = moveProjectLayoutItem(initial, project('/b'), { groupId: A, index: 1 })
  layout = moveProjectLayoutItem(layout, project('/c'), { groupId: B, index: 0 })
  const slots = projectLayoutSlots(layout, project('/b'))
  expect(slots.some(slot => slot.item === null && slot.target.groupId === null && slot.target.index === 1)).toBe(true)
  const out = moveProjectLayoutItem(layout, project('/b'), projectLayoutSlotTarget(layout, project('/b'), slots.at(-1)!))
  expect(out.top).toEqual([group(A), group(B), project('/b')]); expect(out.members[A]).toEqual(['/a'])
  const empty = projectLayoutSlots(initial, project('/b')).find(slot => slot.item?.kind === 'group' && slot.item.groupId === B)!
  expect(moveProjectLayoutItem(initial, project('/b'), empty.target).members[B]).toEqual(['/b'])
})

it('converts original slot boundaries after removing the source, rejects unknown/nested intent and does not mutate the drag snapshot', () => {
  const layout = createProjectLayout(snapshot(), folders()), before = structuredClone(layout)
  const slot = projectLayoutSlots(layout, group(A)).find(slot => slot.item?.kind === 'group' && slot.item.groupId === B)!
  expect(moveProjectLayoutItem(layout, group(A), projectLayoutSlotTarget(layout, group(A), slot)).top).toEqual([project('/b'), group(A), group(B), project('/c')])
  for (const [item, target] of [
    [group(A), { groupId: B, index: 0 }], [project('/missing'), { groupId: A, index: 0 }],
    [project('/b'), { groupId: 'missing', index: 0 }], [project('/b'), { groupId: A, index: NaN }],
    [project('/b'), { groupId: A, index: -1 }]
  ] as const) expect(moveProjectLayoutItem(layout, item, target)).toBe(layout)
  expect(moveProjectLayoutItem(layout, project('/b'), { groupId: null, index: 1 })).toBe(layout)
  expect(locateProjectLayoutItem(layout, project('/a'))).toEqual({ groupId: A, index: 0 })
  expect(layout).toEqual(before)
})

it('retains every identity exactly once through every root/group drop slot and the persisted preference revision rejects stale saves', () => {
  const source = snapshot(), initial = createProjectLayout(source, folders())
  const identity = (entries: ReturnType<typeof projectLayoutEntries>) => entries.map(item => item.kind === 'group' ? `g:${item.groupId}` : `p:${item.projectPath}`).sort()
  const expected = identity(projectLayoutEntries(initial))
  for (const item of [...initial.top, project('/a')]) for (const slot of projectLayoutSlots(initial, item)) {
    const layout = moveProjectLayoutItem(initial, item, projectLayoutSlotTarget(initial, item, slot))
    expect(identity(projectLayoutEntries(layout))).toEqual(expected)
    const result = apply(source, source.projectGroupsRevision, { type: 'layout', entries: projectLayoutEntries(layout) })
    expect(result.projectGroups.flatMap(group => group.projectPaths).sort()).toEqual(projectLayoutEntries(layout).filter(item => item.kind === 'project' && item.groupId !== null).map(item => (item as { projectPath: string }).projectPath).concat('/linked', '/gone').sort())
    expect(result.projectGroups.map(group => group.id)).toEqual([A, B])
    expect(() => apply(result, result.projectGroupsRevision - 1, { type: 'layout', entries: projectLayoutEntries(initial) })).toThrow('已有新修改')
  }
})

it('blocks partial/newly linked relations and resolves unknown saves only against a readable matching result', () => {
  const source = snapshot(), relations = folders(), initial = createProjectLayout(source, relations)
  const next = moveProjectLayoutItem(initial, project('/b'), { groupId: A, index: 0 })
  expect(projectLayoutRelationIssue(initial, next, relations)).toBe(false)
  relations.set('/b', { paths: ['/b'], complete: false })
  expect(projectLayoutRelationIssue(initial, next, relations)).toBe(true)
  relations.set('/b', { paths: ['/b'], complete: true, parentPath: '/a' })
  expect(projectLayoutRelationIssue(initial, initial, relations)).toBe(true)
  const saved = apply(source, 4, { type: 'layout', entries: projectLayoutEntries(next) })
  expect(projectLayoutSaved(source, next, saved)).toBe(true)
  expect(projectLayoutSaved(source, next, source)).toBe(false)
  expect(projectLayoutSaved(source, next, { ...saved, readError: 'unavailable' })).toBe(false)
  const changed = apply(saved, 5, { type: 'update', group: { ...saved.projectGroups[0], name: '另一窗口的新名称' } })
  expect(projectLayoutSaved(source, next, changed)).toBe(false)
})

it('maps scrolled fixed-height pointer rows and rejects non-finite or empty geometry', () => {
  expect(projectLayoutPointerSlot(100, 100, 0, 40, 9)).toBe(0)
  expect(projectLayoutPointerSlot(139.9, 100, 80, 40, 9)).toBe(2)
  expect(projectLayoutPointerSlot(140, 100, 80, 40, 9)).toBe(3)
  expect(projectLayoutPointerSlot(-50, 100, 0, 40, 9)).toBe(0)
  expect(projectLayoutPointerSlot(9999, 100, 0, 40, 9)).toBe(8)
  expect(projectLayoutPointerSlot(NaN, 100, 0, 40, 9)).toBeNull()
  expect(projectLayoutPointerSlot(100, 100, 0, 0, 9)).toBeNull()
  expect(projectLayoutPointerSlot(100, 100, 0, 40, 0)).toBeNull()
})
