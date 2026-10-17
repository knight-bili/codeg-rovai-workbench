import type { ProjectNavigationGroup, WorkspaceWorktree } from '@contracts'
import type { CanvasFolderResolution } from './canvas-reference-model'

// Codeg aff1e6c278453ed8d0b96a5f664edcdca621aa3f sidebar worktree presentation,
// adapted to Core topology and client registration. Apache-2.0: integration/licenses/codeg/LICENSE.

export type NavigationProjectTree = {
  project: ProjectNavigationGroup
  worktree?: WorkspaceWorktree
  parentPath?: string
  complete: boolean
  children: Array<{ path: string; project?: ProjectNavigationGroup; worktree: WorkspaceWorktree; complete: boolean }>
}

/** Git topology owns containment. Registration, pinning and string path prefixes never invent a parent. */
export function navigationProjectTrees(projects: readonly ProjectNavigationGroup[], folders: ReadonlyMap<string, CanvasFolderResolution>): NavigationProjectTree[] {
  const byPath = new Map(projects.map(project => [project.projectPath, project]))
  const parents = new Map<string, string>(), metadata = new Map<string, WorkspaceWorktree>()
  const ambiguous = new Set<string>()
  const parent = (path: string, owner: string) => {
    if (ambiguous.has(path)) return
    if (parents.has(path) && parents.get(path) !== owner || path === owner) { parents.delete(path); ambiguous.add(path) }
    else parents.set(path, owner)
  }
  for (const project of projects) {
    const relation = folders.get(project.projectPath)
    if (!relation) continue
    if (relation.parentPath) parent(project.projectPath, relation.parentPath)
    for (const worktree of relation.worktrees ?? []) metadata.set(worktree.projectPath, worktree)
    if (relation.projectPath !== project.projectPath || relation.repositoryRoot !== project.projectPath || relation.mainWorktreePath !== project.projectPath) continue
    for (const worktree of relation.worktrees ?? []) if (!worktree.bare && !worktree.isMain) parent(worktree.projectPath, project.projectPath)
  }
  for (const [path, owner] of parents) if (parents.has(owner)) ambiguous.add(path)
  for (const path of ambiguous) parents.delete(path)
  return projects.filter(project => !byPath.has(parents.get(project.projectPath) ?? '') || !metadata.has(project.projectPath)).map(project => {
    const relation = folders.get(project.projectPath)
    const children = [...parents].filter(([, parent]) => parent === project.projectPath).flatMap(([path]) => {
      const worktree = metadata.get(path)
      return worktree ? [{ path, worktree, project: byPath.get(path), complete: Boolean(relation?.complete && !ambiguous.has(project.projectPath)) }] : []
    })
    return { project, worktree: metadata.get(project.projectPath), parentPath: parents.get(project.projectPath), complete: Boolean(relation?.complete && !ambiguous.has(project.projectPath)), children }
  })
}
