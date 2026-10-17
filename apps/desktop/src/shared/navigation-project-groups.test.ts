import { expect, it } from 'vitest'
import type { NavigationProjectGroup, NavigationPreferencesSnapshot } from '@contracts'
import { EMPTY_SNAPSHOT, sanitizeSnapshot, sourceMatchesSupportedSnapshot } from './navigation-preferences-model'
import { applyNavigationProjectLayout as apply, navigationProjectGroupKey as key, navigationProjectSidebarLayout } from './navigation-project-groups'

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222'
const group = (id: string, paths: string[]): NavigationProjectGroup => ({ id, name: id === A ? '工作' : '开源', color: null, projectPaths: paths })
const initial = (): NavigationPreferencesSnapshot => ({ ...structuredClone(EMPTY_SNAPSHOT), registeredProjects: ['/a', '/b', '/c'], projectOrder: ['directory:/a', 'directory:/b', 'directory:/c'] })

it('moves a project once, preserves unrelated fields, orders mixed siblings and returns deleted members without deleting directories', () => {
  const source = initial(); source.projectNames['directory:/a'] = '目录别名'
  let next = apply(source, 0, { type: 'create', group: group(A, ['/a', '/b']) })
  expect(next.projectOrder).toEqual(['directory:/c', key(A)])
  next = apply(next, 1, { type: 'create', group: group(B, ['/b']) })
  expect(next.projectGroups[0].projectPaths).toEqual(['/a'])
  next = apply(next, 2, { type: 'layout', entries: [
    { kind: 'group', groupId: B }, { kind: 'project', projectPath: '/b', groupId: B },
    { kind: 'project', projectPath: '/c', groupId: null }, { kind: 'group', groupId: A }
  ] })
  expect(next.projectOrder).toEqual([key(B), 'directory:/c', key(A)])
  next = apply(next, 3, { type: 'update', group: { ...group(A, ['/a']), name: '  改名  ', color: 'blue' } })
  expect(next.projectGroups[0]).toMatchObject({ id: A, name: '改名', color: 'blue' })
  next = apply(next, 4, { type: 'delete', groupId: B })
  expect(next.projectOrder).toEqual(['directory:/c', key(A), 'directory:/b'])
  expect(next.registeredProjects).toEqual(['/a', '/b', '/c']); expect(next.projectNames).toEqual(source.projectNames)
  const projects = next.registeredProjects.map(projectPath => ({ projectPath, projectKey: `directory:${projectPath}` }))
  const rows = navigationProjectSidebarLayout(projects, next.projectGroups, next.projectOrder)
  expect(rows.map(row => row.key)).toEqual(['directory:/c', key(A), 'directory:/b'])
  expect(rows[1]).toMatchObject({ kind: 'group', projects: [{ projectPath: '/a' }] })
  expect(source.projectGroups).toEqual([])
})

it('rejects stale, malformed and foreign layout intent while preserving unseen or removed membership and safe legacy reads', () => {
  const next = apply(initial(), 0, { type: 'create', group: group(A, ['/a']) })
  expect(apply(next, 1, { type: 'layout', entries: [] })).toBe(next)
  expect(() => apply(next, 0, { type: 'delete', groupId: A })).toThrow('已有新修改')
  for (const input of [
    { type: 'delete', groupId: A, nested: true }, { type: 'delete', groupId: B },
    { type: 'create', group: group(A, []) }, { type: 'create', group: group(B, ['/foreign']) },
    { type: 'update', group: { ...group(A, []), name: ' ' } },
    { type: 'layout', entries: [{ kind: 'group', groupId: A, parent: A }] },
    { type: 'layout', entries: [{ kind: 'project', projectPath: '/b', groupId: B }] },
    { type: 'layout', entries: [{ kind: 'group', groupId: A }, { kind: 'group', groupId: A }] }
  ]) expect(() => apply(next, 1, input)).toThrow()
  const partial = apply(next, 1, { type: 'layout', entries: [{ kind: 'project', projectPath: '/c', groupId: null }] })
  expect(partial.projectGroups[0].projectPaths).toEqual(['/a']); expect(partial.projectOrder).toContain('directory:/b')
  const removed = { ...next, registeredProjects: ['/b', '/c'], removedProjects: [{ targetKey: 'directory:/a', removedAt: '2026-10-15T00:00:00Z' }] }
  expect(apply(removed, 1, { type: 'update', group: { ...group(A, ['/a']), name: '保留历史' } }).projectGroups[0].projectPaths).toEqual(['/a'])
  const old = { schemaVersion: 6, registeredProjects: ['/a'], legacyProjectsSynced: true, pins: [], removedProjects: [], projectOrder: null, projectNames: {}, threadReadStates: {} }
  const migrated = sanitizeSnapshot(old)
  expect(migrated).toMatchObject({ schemaVersion: 7, projectGroups: [], projectGroupsRevision: 0 })
  expect(sourceMatchesSupportedSnapshot(old, migrated)).toBe(true)
  const malformed = { ...next, projectGroups: [group(A, ['/a']), group(B, ['/a'])] }
  expect(sourceMatchesSupportedSnapshot(malformed, sanitizeSnapshot(malformed))).toBe(false)
  const future = { ...next, schemaVersion: 8, future: true }
  expect(sourceMatchesSupportedSnapshot(future, sanitizeSnapshot(future))).toBe(false)
})
