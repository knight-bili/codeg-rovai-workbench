import { expect, it, vi } from 'vitest'
import { browserCanvasStorage, canvasViewScope, readCanvasViewScope, initialCanvasViewState, loadCanvasBoardSelection, loadCanvasViewState, parseCanvasViewport, pruneCanvasExpansions, saveCanvasBoardSelection, saveCanvasViewState } from './canvas-view-state'
import type { ThreadClient } from './camp-client'

function storage() {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}
it('requires a Native Core identity and never adopts a generic Host-only scope', async () => {
  const client = { presentationScope: 'native/owner', request: vi.fn().mockResolvedValue({ dataDir: '/native-core' }) } as Pick<ThreadClient, 'request' | 'presentationScope'>
  expect(await readCanvasViewScope(client)).toEqual({ host: 'native/owner', core: '/native-core' })
  client.request = vi.fn().mockResolvedValue({ name: 'Rovai' })
  expect(await readCanvasViewScope(client)).toBeNull()
})
it('rejects a changed Host during a live Web identity read and does not fall back after an identity failure', async () => {
  let finish: ((value: string) => void) | undefined
  const client = { presentationScope: 'A/owner', request: vi.fn(), canvasCoreIdentity: () => new Promise<string>(resolve => { finish = resolve }) } as Pick<ThreadClient, 'request' | 'presentationScope' | 'canvasCoreIdentity'>
  const pending = readCanvasViewScope(client)
  client.presentationScope = 'B/owner'; finish!('web:editor-A')
  expect(await pending).toBeNull()
  client.canvasCoreIdentity = async () => { throw new Error('connection replaced') }
  await expect(readCanvasViewScope(client)).rejects.toThrow('connection replaced')
  expect(client.request).not.toHaveBeenCalled()
})
it('scopes views to Host/Core/board while sharing the minimap preference only inside that Host/Core', () => {
  const local = storage(), scope = { host: 'server/owner', core: '/core-a' }
  const state = { viewport: { x: -2000000, y: 12, zoom: 2 }, expandedCards: ['card'], expandedRegions: ['region'], minimap: false }
  expect(saveCanvasViewState(local, scope, 'board-a', state)).toBe(true)
  expect(loadCanvasViewState(local, scope, 'board-a')).toEqual(state)
  saveCanvasBoardSelection(local, scope, 'board-a')
  expect(loadCanvasBoardSelection(local, scope)).toBe('board-a')
  expect(loadCanvasViewState(local, scope, 'board-b')).toEqual({ ...initialCanvasViewState(), minimap: false })
  for (const other of [{ ...scope, host: 'other/owner' }, { ...scope, core: '/core-b' }]) {
    expect(loadCanvasViewState(local, other, 'board-a')).toEqual(initialCanvasViewState())
    expect(loadCanvasBoardSelection(local, other)).toBeNull()
  }
  local.values.set('workspace:canvas-viewport', JSON.stringify(state.viewport))
  expect(loadCanvasViewState(local, { host: 'new', core: 'new' }, 'legacy-id')).toEqual(initialCanvasViewState())
  expect(local.values.has('workspace:canvas-viewport')).toBe(true)
})
it('validates finite viewport data, clamps zoom and serializes only advisory presentation facts', () => {
  for (const value of [null, [], { x: NaN, y: 2, zoom: 1 }, { x: 0, y: Infinity, zoom: 1 }]) expect(parseCanvasViewport(value)).toBeNull()
  expect(parseCanvasViewport({ x: 0, y: 2, zoom: -1 })).toEqual({ x: 0, y: 2, zoom: 0.1 })
  expect(parseCanvasViewport({ x: 0, y: 2, zoom: 20 })).toEqual({ x: 0, y: 2, zoom: 2 })
  const local = storage(), scope = { host: 'a:b', core: 'c' }
  const state = { ...initialCanvasViewState(), expandedCards: ['card', 'card', '', '\0invalid'], content: 'must not persist', nativeSession: 'never persist' }
  saveCanvasViewState(local, scope, 'd', state)
  expect(loadCanvasViewState(local, scope, 'd').expandedCards).toEqual(['card'])
  expect([...local.values.values()].join('')).not.toContain('persist')
  expect(loadCanvasViewState(local, { host: 'a', core: 'b:c' }, 'd')).toEqual(initialCanvasViewState())
  expect(canvasViewScope(undefined, '/core')).toBeNull(); expect(canvasViewScope('host', null)).toBeNull()
  expect(canvasViewScope('host', '/core')).toEqual({ host: 'host', core: '/core' })
})
it('prunes only expansions against a successfully derived graph and tolerates unavailable local storage', () => {
  const before = { ...initialCanvasViewState(), viewport: { x: 1, y: 2, zoom: 0.5 }, expandedCards: ['keep', 'gone'], expandedRegions: ['region', 'gone'] }
  expect(pruneCanvasExpansions(before, new Set(['keep']), new Set(['region']))).toEqual({ ...before, expandedCards: ['keep'], expandedRegions: ['region'] })
  expect(before.expandedCards).toEqual(['keep', 'gone'])
  const denied = { getItem: () => { throw Error('denied') }, setItem: () => { throw Error('quota') } }
  expect(loadCanvasViewState(denied, { host: 'host', core: 'core' }, 'board')).toEqual(initialCanvasViewState())
  expect(saveCanvasViewState(denied, { host: 'host', core: 'core' }, 'board', before)).toBe(false)
  expect(saveCanvasViewState(storage(), null, 'board', before)).toBe(false)
})
it('keeps the canvas usable when the origin denies even access to the localStorage property', () => {
  vi.stubGlobal('window', { get localStorage() { throw new DOMException('denied', 'SecurityError') } })
  try { expect(browserCanvasStorage()).toBeUndefined() } finally { vi.unstubAllGlobals() }
})
