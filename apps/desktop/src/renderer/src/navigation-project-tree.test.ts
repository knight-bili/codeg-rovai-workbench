import { expect, it } from 'vitest'
import type { ProjectNavigationGroup, WorkspaceWorktree } from '@contracts'
import type { CanvasFolderResolution } from './canvas-reference-model'
import { navigationProjectTrees } from './navigation-project-tree'

const project = (projectPath: string): ProjectNavigationGroup => ({ projectPath, projectKey: `directory:${projectPath}`, name: projectPath,
  totalCount: 0, recentThreads: [], lastActivityAt: '2026-10-15T00:00:00Z', lastActivityGlobalSequence: 0 })
const worktree = (projectPath: string, isMain = false, extra: Partial<WorkspaceWorktree> = {}): WorkspaceWorktree => ({ projectPath, isMain,
  available: true, bare: false, locked: false, prunable: false, ...extra })
const topology = (path: string, children: WorkspaceWorktree[]): CanvasFolderResolution => ({ projectPath: path, repositoryRoot: path,
  mainWorktreePath: path, paths: [path, ...children.map(child => child.projectPath)], complete: true, worktrees: [worktree(path, true), ...children] })

it('nests registered and unregistered real worktrees exactly once, preserves root order, and never treats a path prefix as topology', () => {
  const projects = ['/main', '/linked', '/main-sibling', '/main/sub'].map(project)
  const folders = new Map([['/main', topology('/main', [worktree('/linked', false, { branch: 'feature/one' }),
    worktree('/missing', false, { available: false, prunable: true }), worktree('/bare', false, { bare: true })])]])
  const result = navigationProjectTrees(projects, folders)
  expect(result.map(tree => tree.project.projectPath)).toEqual(['/main', '/main-sibling', '/main/sub'])
  expect(result[0].children.map(child => child.path)).toEqual(['/linked', '/missing'])
  expect(result[0].children[0].project?.projectKey).toBe('directory:/linked')
  expect(result[0].children[1]).toMatchObject({ project: undefined, worktree: { available: false, prunable: true } })
  expect(result[0].children[0].worktree.branch).toBe('feature/one')
  expect(projects).toHaveLength(4)
})

it('keeps a linked checkout usable as a root when its main project is not registered and does not absorb sibling worktrees', () => {
  const folders = new Map<string, CanvasFolderResolution>([['/linked', { ...topology('/linked', [worktree('/sibling')]),
    mainWorktreePath: '/unregistered-main', parentPath: '/unregistered-main', paths: ['/linked'] }]])
  const [root] = navigationProjectTrees([project('/linked')], folders)
  expect(root.parentPath).toBe('/unregistered-main'); expect(root.children).toEqual([])
})

it('keeps known tree rows when a refresh fails and marks every derived child incomplete', () => {
  const relation = { ...topology('/main', [worktree('/linked', false, { detached: true, branch: null, locked: true })]), complete: false }
  const result = navigationProjectTrees(['/main', '/linked'].map(project), new Map([['/main', relation]]))
  expect(result).toHaveLength(1); expect(result[0].complete).toBe(false)
  expect(result[0].children[0]).toMatchObject({ complete: false, worktree: { detached: true, locked: true } })
})

it('does not lose registered roots with contradictory, cyclic or legacy-incomplete parent metadata', () => {
  const projects = ['/a', '/b', '/c'].map(project)
  const folders = new Map<string, CanvasFolderResolution>([
    ['/a', { ...topology('/a', [worktree('/c')]), parentPath: '/b' }],
    ['/b', { ...topology('/b', [worktree('/c')]), parentPath: '/a' }],
    ['/c', { paths: ['/c'], parentPath: '/a', complete: true }]
  ])
  const result = navigationProjectTrees(projects, folders)
  expect(result.map(tree => tree.project.projectPath)).toEqual(['/a', '/b', '/c'])
  expect(result.every(tree => !tree.complete)).toBe(true)
  expect(navigationProjectTrees(projects, new Map([['/c', { paths: ['/c'], parentPath: '/a', complete: true }]])).map(tree => tree.project.projectPath)).toEqual(['/a', '/b', '/c'])
})

it('does not promote nested directory observations into a main repository tree', () => {
  const relation = { ...topology('/main', [worktree('/linked')]), projectPath: '/main/sub', paths: ['/main/sub'] }
  const result = navigationProjectTrees(['/main/sub', '/linked'].map(project), new Map([['/main/sub', relation]]))
  expect(result.map(tree => tree.project.projectPath)).toEqual(['/main/sub', '/linked'])
  expect(result.flatMap(tree => tree.children)).toEqual([])
})
