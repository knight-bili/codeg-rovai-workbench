import { expect, it } from 'vitest'
import { resolveSidebarProjectGroups, projectGroupMembershipIssue } from './project-group-presentation'
import type { CanvasFolderResolution } from './canvas-reference-model'

it('follows actual parent worktrees once, retains partial known relations and never groups a path prefix sibling', () => {
  const groups = [{ id: 'main-group', name: '工作', color: null, projectPaths: ['/repo'] },
    { id: 'child-group', name: '旧子组', color: null, projectPaths: ['/linked'] }]
  const folders = new Map<string, CanvasFolderResolution>([
    ['/repo', { paths: ['/repo', '/linked'], complete: true }],
    ['/linked', { paths: ['/linked'], parentPath: '/repo', complete: true }]
  ])
  const result = resolveSidebarProjectGroups(groups, folders)
  expect(result[0]).toMatchObject({ projectPaths: ['/repo', '/linked'], relationshipsComplete: true })
  expect(result[1].projectPaths).toEqual([])
  expect(resolveSidebarProjectGroups([groups[1]], folders)[0].projectPaths).toEqual([])
  expect(projectGroupMembershipIssue(['/linked'], [], folders)).toBe('follows_parent')
  expect(projectGroupMembershipIssue(['/new'], [], folders)).toBe('unverified')
  expect(projectGroupMembershipIssue(['/repo'], [], folders)).toBeNull()
  expect(projectGroupMembershipIssue(['/new'], ['/new'], folders)).toBeNull()
  expect(result.flatMap(group => group.projectPaths)).not.toContain('/repo-sibling')
  folders.set('/repo', { paths: ['/repo', '/linked'], complete: false })
  expect(resolveSidebarProjectGroups(groups, folders)[0]).toMatchObject({ projectPaths: ['/repo', '/linked'], relationshipsComplete: false })
  expect(groups[0].projectPaths).toEqual(['/repo'])
})
