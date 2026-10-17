import { afterEach, expect, it, vi } from 'vitest'
import type { CoreMethod, WorkspaceWorktrees } from '@contracts'
import { CanvasFolderController, canvasFolderResolution, createCanvasFolderRequestScope } from './canvas-folder-controller'

const controllers: CanvasFolderController[] = []
afterEach(() => { controllers.splice(0).forEach(item => item.dispose()); vi.useRealTimers() })
const entry = (projectPath: string, isMain: boolean, available = true) => ({ projectPath, isMain, available, locked: false, prunable: !available, bare: false })
const topology = (path: string, root: string | null = '/main', main: string | null = '/main'): WorkspaceWorktrees => ({
  schemaVersion: 1, requestedPath: path, projectPath: path, repositoryRoot: root, mainWorktreePath: main,
  worktrees: root ? [entry('/main', true), entry('/linked', false), entry('/missing', false, false)] : []
})
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }

it('combines live consumer paths before one bounded reader and stale cleanup cannot release a newer registration', async () => {
  vi.useFakeTimers()
  const test = fixture(async path => topology(path, null, null)), scope = createCanvasFolderRequestScope()
  const a = Symbol('sidebar'), b = Symbol('canvas')
  const oldRelease = scope.register(a, ['/a', '/b'])
  scope.bind(test.controller); await vi.advanceTimersByTimeAsync(0)
  expect(test.calls).toEqual(['/a', '/b'])
  const releaseB = scope.register(b, ['/b', '/c']); await vi.advanceTimersByTimeAsync(0)
  expect(test.calls.slice(2)).toEqual(['/a', '/b', '/c'])
  const releaseA = scope.register(a, ['/d']); await vi.advanceTimersByTimeAsync(0)
  oldRelease(); expect([...test.controller.getSnapshot().keys()]).toEqual(['/b', '/c', '/d'])
  releaseB(); await vi.advanceTimersByTimeAsync(0)
  expect([...test.controller.getSnapshot().keys()]).toEqual(['/d'])
  scope.unbind(test.controller); const count = test.calls.length
  releaseA(); scope.register(Symbol('new'), ['/after-unbind']); await vi.advanceTimersByTimeAsync(0)
  expect(test.calls).toHaveLength(count)
})
function fixture(handler: (path: string) => Promise<WorkspaceWorktrees>) {
  const calls: string[] = []
  const controller = new CanvasFolderController({ request: <T,>(method: CoreMethod, params?: unknown): Promise<T> => {
    expect(method).toBe('workspaces.worktrees'); const path = (params as { path: string }).path
    calls.push(path); return handler(path) as Promise<T>
  } })
  controllers.push(controller); return { controller, calls }
}

it('uses explicit main/linked identity, retains missing checkout history and keeps nested/child/plain directories exact', () => {
  expect(canvasFolderResolution('/main', topology('/main')).paths).toEqual(['/main', '/linked', '/missing'])
  expect(canvasFolderResolution('/linked', topology('/linked', '/linked')).paths).toEqual(['/linked'])
  expect(canvasFolderResolution('/linked', topology('/linked', '/linked')).parentPath).toBe('/main')
  expect(canvasFolderResolution('/main/sub', topology('/main/sub')).paths).toEqual(['/main/sub'])
  expect(canvasFolderResolution('/plain', topology('/plain', null, null))).toEqual({ paths: ['/plain'], complete: true,
    projectPath: '/plain', repositoryRoot: null, mainWorktreePath: null, worktrees: [] })
  const withBranch = topology('/main'); withBranch.worktrees[1] = { ...withBranch.worktrees[1], branch: 'feature/测试', detached: false }
  const projected = canvasFolderResolution('/main', withBranch)
  expect(projected.worktrees?.[1].branch).toBe('feature/测试')
  withBranch.worktrees[1].branch = 'later'
  expect(projected.worktrees?.[1].branch).toBe('feature/测试')
  const alias = { ...topology('/alias'), projectPath: '/main' }
  expect(canvasFolderResolution('/alias', alias).paths).toEqual(['/alias', '/main', '/linked', '/missing'])
  const bare = topology('/linked', '/linked', null); bare.worktrees[0].bare = true; bare.worktrees[0].available = false
  expect(canvasFolderResolution('/linked', bare).paths).toEqual(['/linked'])
  for (const invalid of [
    { ...topology('/main'), requestedPath: '/other' },
    { ...topology('/main'), projectPath: 1 } as unknown as WorkspaceWorktrees,
    { ...topology('/main'), repositoryRoot: '/other' },
    { ...topology('/main'), mainWorktreePath: '/linked' },
    { ...topology('/plain', null, null), worktrees: [entry('/main', true)] },
    { ...topology('/main'), worktrees: [entry('/main', true), entry('/main', false)] },
    { ...topology('/main'), worktrees: [{ ...entry('/main', true), branch: '' }] },
    { ...topology('/main'), worktrees: [{ ...entry('/main', true), branch: 'main', detached: true }] },
    { ...topology('/main'), worktrees: [{ ...entry('/main', true), detached: 'false' }] } as unknown as WorkspaceWorktrees
  ]) expect(() => canvasFolderResolution('/main', invalid)).toThrow()
})

it('bounds concurrency, deduplicates requested paths and publishes independent outcomes without writes', async () => {
  vi.useFakeTimers()
  const waits = new Map<string, ReturnType<typeof deferred<WorkspaceWorktrees>>>()
  const test = fixture(path => { const wait = deferred<WorkspaceWorktrees>(); waits.set(path, wait); return wait.promise })
  test.controller.setPaths(['/a', '/b', '/c', '/d', '/e', '/a'])
  expect(test.calls).toHaveLength(4)
  waits.get('/a')!.resolve(topology('/a', null, null)); await vi.advanceTimersByTimeAsync(0)
  expect(test.calls).toHaveLength(5)
  for (const path of ['/b', '/c', '/d', '/e']) waits.get(path)!.resolve(topology(path, null, null))
  await vi.advanceTimersByTimeAsync(0)
  expect([...test.controller.getSnapshot().values()].every(value => value.complete)).toBe(true)
  test.controller.setPaths(['/e', '/d', '/c', '/b', '/a']); expect(test.calls).toHaveLength(5)
})

it('retains known paths on failure and suppresses stale path sets and disposed Host responses', async () => {
  vi.useFakeTimers()
  let fail = false
  const old = deferred<WorkspaceWorktrees>()
  const test = fixture(async path => {
    if (path === '/old') return old.promise
    if (fail) throw new Error('offline')
    return topology(path, path === '/main' ? '/main' : null, path === '/main' ? '/main' : null)
  })
  test.controller.setPaths(['/main']); await vi.advanceTimersByTimeAsync(0)
  expect(test.controller.getSnapshot().get('/main')?.paths).toContain('/linked')
  fail = true; await test.controller.refresh()
  expect(test.controller.getSnapshot().get('/main')).toMatchObject({ paths: ['/main', '/linked', '/missing'], complete: false })
  fail = false; test.controller.setPaths(['/old']); test.controller.setPaths(['/new'])
  old.resolve(topology('/old', null, null)); await vi.advanceTimersByTimeAsync(0)
  expect([...test.controller.getSnapshot().keys()]).toEqual(['/new'])
  expect(test.controller.getSnapshot().get('/new')?.complete).toBe(true)
  const late = deferred<WorkspaceWorktrees>(), disposed = fixture(() => late.promise)
  const changed = vi.fn(); disposed.controller.subscribe(changed); disposed.controller.setPaths(['/late', '/queued1', '/queued2', '/queued3', '/queued4'])
  disposed.controller.dispose(); const count = changed.mock.calls.length
  late.resolve(topology('/late', null, null)); await vi.advanceTimersByTimeAsync(0)
  expect(disposed.calls).toHaveLength(4); expect(changed).toHaveBeenCalledTimes(count)
})
