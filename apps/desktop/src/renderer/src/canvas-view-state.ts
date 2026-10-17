// Codeg canvas-view-storage behavior adapted to explicit Host/Core/board identity.
// Fixed donor aff1e6c278453ed8d0b96a5f664edcdca621aa3f; Apache-2.0: integration/licenses/codeg/LICENSE.
import type { ThreadClient } from './camp-client'
export const CANVAS_MIN_ZOOM = 0.1, CANVAS_MAX_ZOOM = 2
export interface CanvasViewport { x: number; y: number; zoom: number }
export interface CanvasViewScope { host: string; core: string }
export interface CanvasViewState {
  viewport: CanvasViewport | null
  expandedCards: string[]
  expandedRegions: string[]
  minimap: boolean
}
type ViewStorage = Pick<Storage, 'getItem' | 'setItem'>
/** Access to the browser storage property itself can fail in a denied/sandboxed origin. */
export function browserCanvasStorage(): ViewStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage } catch { return undefined }
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const identity = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
const ids = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter(identity))] : []

/** The opaque identity (Native dataDir or verified Web editor) never grants file/root access. */
export function canvasViewScope(presentationScope: string | undefined, coreIdentity: unknown): CanvasViewScope | null {
  return identity(presentationScope) && identity(coreIdentity) ? { host: presentationScope, core: coreIdentity } : null
}
export async function readCanvasViewScope(client: Pick<ThreadClient, 'request' | 'presentationScope' | 'canvasCoreIdentity'>): Promise<CanvasViewScope | null> {
  const host = client.presentationScope
  const core = client.canvasCoreIdentity ? await client.canvasCoreIdentity() : (await client.request<{ dataDir?: string }>('app.info')).dataDir
  return host === client.presentationScope ? canvasViewScope(host, core) : null
}
export function initialCanvasViewState(): CanvasViewState {
  return { viewport: null, expandedCards: [], expandedRegions: [], minimap: true }
}
export function parseCanvasViewport(value: unknown): CanvasViewport | null {
  const source = record(value)
  return finite(source.x) && finite(source.y) && finite(source.zoom)
    ? { x: source.x, y: source.y, zoom: Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, source.zoom)) } : null
}
const viewKey = (scope: CanvasViewScope, board: string) => `rovai.canvas.view.v1:${JSON.stringify([scope.host, scope.core, board])}`
const mapKey = (scope: CanvasViewScope) => `rovai.canvas.minimap.v1:${JSON.stringify([scope.host, scope.core])}`
const boardKey = (scope: CanvasViewScope) => `rovai.canvas.board.v1:${JSON.stringify([scope.host, scope.core])}`
function read(storage: ViewStorage | undefined, key: string): unknown {
  try { return JSON.parse(storage?.getItem(key) ?? 'null') } catch { return null }
}
export function loadCanvasBoardSelection(storage: ViewStorage | undefined, scope: CanvasViewScope | null): string | null {
  const value = scope ? read(storage, boardKey(scope)) : null
  return identity(value) ? value : null
}
export function saveCanvasBoardSelection(storage: ViewStorage | undefined, scope: CanvasViewScope | null, boardId: string): void {
  if (!scope || !identity(boardId)) return
  try { storage?.setItem(boardKey(scope), JSON.stringify(boardId)) } catch { /* Advisory preference only. */ }
}
export function loadCanvasViewState(storage: ViewStorage | undefined, scope: CanvasViewScope | null, boardId: string): CanvasViewState {
  if (!scope || !identity(scope.host) || !identity(scope.core) || !identity(boardId)) return initialCanvasViewState()
  // Unscoped Codeg keys are not adopted: its numeric IDs belong to another database.
  const source = record(read(storage, viewKey(scope, boardId)))
  return { viewport: parseCanvasViewport(source.viewport), expandedCards: ids(source.expandedCards),
    expandedRegions: ids(source.expandedRegions), minimap: read(storage, mapKey(scope)) !== false }
}
export function saveCanvasViewState(storage: ViewStorage | undefined, scope: CanvasViewScope | null,
  boardId: string, state: CanvasViewState): boolean {
  if (!storage || !scope || !identity(scope.host) || !identity(scope.core) || !identity(boardId)) return false
  try {
    // Only advisory presentation facts are serialized; no node body, model input or PTY/session key.
    storage.setItem(viewKey(scope, boardId), JSON.stringify({ viewport: parseCanvasViewport(state.viewport),
      expandedCards: ids(state.expandedCards), expandedRegions: ids(state.expandedRegions) }))
    storage.setItem(mapKey(scope), JSON.stringify(state.minimap !== false))
    return true
  } catch { return false }
}
/** Call only after a successful graph derivation, never against a loading/error placeholder. */
export function pruneCanvasExpansions(state: CanvasViewState, cards: ReadonlySet<string>, regions: ReadonlySet<string>): CanvasViewState {
  return { ...state, expandedCards: state.expandedCards.filter(id => cards.has(id)), expandedRegions: state.expandedRegions.filter(id => regions.has(id)) }
}
