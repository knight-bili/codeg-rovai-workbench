import type { CanvasViewScope } from './canvas-view-state'

export interface CanvasNoteDraft { text: string; baseline: string; revision: number }
export type CanvasNoteStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const validId = (value: string) => Boolean(value.trim()) && !value.includes('\0')
function key(scope: CanvasViewScope | null, boardId: string, nodeId: string): string | null {
  return scope && [scope.host, scope.core, boardId, nodeId].every(validId)
    ? `rovai.canvas.note-draft.v1:${JSON.stringify([scope.host, scope.core, boardId, nodeId])}` : null
}
/** Unsaved local text only; the Core snapshot remains the saved note authority. */
export function loadCanvasNoteDraft(storage: CanvasNoteStorage | undefined, scope: CanvasViewScope | null, boardId: string, nodeId: string): CanvasNoteDraft | null {
  const identity = key(scope, boardId, nodeId)
  if (!identity) return null
  try {
    const draft: unknown = JSON.parse(storage?.getItem(identity) ?? 'null')
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return null
    const value = draft as Record<string, unknown>
    return typeof value.text === 'string' && typeof value.baseline === 'string' && typeof value.revision === 'number'
      && Number.isSafeInteger(value.revision) && value.revision >= 0
      ? { text: value.text, baseline: value.baseline, revision: value.revision } : null
  } catch { return null }
}
export function saveCanvasNoteDraft(storage: CanvasNoteStorage | undefined, scope: CanvasViewScope | null, boardId: string, nodeId: string, draft: CanvasNoteDraft | null): boolean {
  const identity = key(scope, boardId, nodeId)
  if (!storage || !identity) return false
  try {
    if (draft) storage.setItem(identity, JSON.stringify(draft))
    else storage.removeItem(identity)
    return true
  } catch { return false }
}
