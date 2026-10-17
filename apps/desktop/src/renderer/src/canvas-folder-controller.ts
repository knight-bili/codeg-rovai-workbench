import type { WorkspaceWorktrees } from '@contracts'
import type { ThreadClient } from './camp-client'
import type { CanvasFolderResolution } from './canvas-reference-model'
import { createNavigationRefreshCoordinator } from './navigation-refresh-coordinator'
import { uiAttribute } from './interface-language'

/** Metadata proves folder relations only. It grants no file, terminal or execution access. */
export function canvasFolderResolution(path: string, value: WorkspaceWorktrees): CanvasFolderResolution {
  if (value.schemaVersion !== 1 || value.requestedPath !== path || typeof value.projectPath !== 'string' || !value.projectPath
    || !Array.isArray(value.worktrees) || value.worktrees.length > 4096
    || value.repositoryRoot !== null && typeof value.repositoryRoot !== 'string'
    || value.mainWorktreePath !== null && typeof value.mainWorktreePath !== 'string') throw new Error('工程工作树关系不一致。')
  const seen = new Set<string>()
  for (const [index, entry] of value.worktrees.entries()) {
    if (typeof entry.projectPath !== 'string' || !entry.projectPath || seen.has(entry.projectPath)
      || typeof entry.available !== 'boolean' || typeof entry.bare !== 'boolean' || typeof entry.locked !== 'boolean'
      || typeof entry.prunable !== 'boolean' || entry.isMain !== (index === 0)
      || entry.branch !== undefined && entry.branch !== null && (typeof entry.branch !== 'string' || !entry.branch.length)
      || entry.detached !== undefined && typeof entry.detached !== 'boolean'
      || entry.detached && entry.branch != null) throw new Error('工程工作树关系不一致。')
    seen.add(entry.projectPath)
  }
  if (value.repositoryRoot === null) {
    if (value.worktrees.length || value.mainWorktreePath !== null) throw new Error('工程工作树关系不一致。')
  } else if (!value.worktrees.some(entry => entry.projectPath === value.repositoryRoot && entry.available && !entry.bare)
    || value.mainWorktreePath !== (value.worktrees[0]?.bare ? null : value.worktrees[0]?.projectPath)) throw new Error('工程工作树关系不一致。')
  const paths = new Set([path, value.projectPath])
  // A subdirectory or linked checkout is not the parent repository region.
  if (value.projectPath === value.repositoryRoot && value.repositoryRoot === value.mainWorktreePath) {
    for (const entry of value.worktrees) if (!entry.bare) paths.add(entry.projectPath)
  }
  return { paths: [...paths], complete: true, projectPath: value.projectPath, repositoryRoot: value.repositoryRoot,
    mainWorktreePath: value.mainWorktreePath, worktrees: value.worktrees.map(entry => ({ ...entry })),
    ...(value.projectPath === value.repositoryRoot && value.mainWorktreePath && value.mainWorktreePath !== value.repositoryRoot ? { parentPath: value.mainWorktreePath } : {}) }
}

/** One mounted Host, four concurrent reads, coalesced refreshes and no business writes. */
export class CanvasFolderController {
  private paths: string[] = []
  private state: ReadonlyMap<string, CanvasFolderResolution> = new Map()
  private listeners = new Set<() => void>()
  private generation = 0
  private disposed = false
  private reads: ReturnType<typeof createNavigationRefreshCoordinator>
  constructor(private readonly client: Pick<ThreadClient, 'request'>) {
    this.reads = createNavigationRefreshCoordinator(() => this.readFolders())
  }
  getSnapshot = (): ReadonlyMap<string, CanvasFolderResolution> => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(path: string, resolution: CanvasFolderResolution): void {
    if (this.disposed) return
    this.state = new Map(this.state).set(path, resolution); this.listeners.forEach(listener => listener())
  }
  setPaths(paths: readonly string[]): void {
    const next = [...new Set(paths.filter(Boolean))].sort()
    if (this.disposed || JSON.stringify(next) === JSON.stringify(this.paths)) return
    this.paths = next
    this.state = new Map(next.map(path => [path, this.state.get(path) ?? { paths: [path], complete: false }]))
    void this.refresh().catch(() => undefined)
  }
  refresh = (): Promise<void> => {
    if (this.disposed) return Promise.reject(new Error('工程关系目录已关闭。'))
    ++this.generation
    this.state = new Map(this.paths.map(path => [path, { ...this.state.get(path), paths: this.state.get(path)?.paths ?? [path], complete: false }]))
    this.listeners.forEach(listener => listener())
    return this.reads.refresh('explicit')
  }
  private async readFolders(): Promise<void> {
    const generation = this.generation, paths = [...this.paths]
    let index = 0
    const worker = async () => {
      while (!this.disposed && generation === this.generation && index < paths.length) {
        const path = paths[index++]
        try {
          const value = await this.client.request<WorkspaceWorktrees>('workspaces.worktrees', { path })
          if (!this.disposed && generation === this.generation) this.publish(path, canvasFolderResolution(path, value))
        } catch {
          if (!this.disposed && generation === this.generation) this.publish(path, {
            ...this.state.get(path), paths: this.state.get(path)?.paths ?? [path], complete: false, issue: uiAttribute('工作树关系读取失败，已保留已知对话。')
          })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, paths.length) }, worker))
  }
  dispose(): void { this.disposed = true; this.reads.dispose(); this.listeners.clear() }
}

/** One BusinessApp owner combines sidebar, canvas and dialog demands before the bounded reader. */
export function createCanvasFolderRequestScope() {
  const requests = new Map<symbol, readonly string[]>()
  let controller: CanvasFolderController | null = null
  const sync = () => controller?.setPaths([...requests.values()].flat())
  return {
    bind(next: CanvasFolderController) { controller = next; sync() },
    unbind(current: CanvasFolderController) { if (controller === current) controller = null },
    register(token: symbol, paths: readonly string[]) {
      const entry = [...paths]; requests.set(token, entry); sync()
      return () => { if (requests.get(token) === entry) { requests.delete(token); sync() } }
    },
    refresh: () => controller?.refresh() ?? Promise.resolve()
  }
}
