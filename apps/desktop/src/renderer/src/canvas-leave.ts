import { uiAttribute } from './interface-language'

export interface CanvasLeavePreparation {
  complete(didLeave: boolean): Promise<void>
}
export interface CanvasLeaveGuard {
  canLeave(): Promise<boolean>
  isBlocked(): boolean
  prepareLeave?(): Promise<CanvasLeavePreparation>
  resume?(): void
}

/** Keep presentation instances mounted until the caller proves the transition committed. */
export async function runCanvasLeaveTransition(view: string, guard: CanvasLeaveGuard | null,
  transition: () => void | boolean | Promise<void | boolean>, didLeave: () => boolean | Promise<boolean> = () => true): Promise<boolean> {
  if (view !== 'canvas' || !guard) return await transition() !== false
  if (guard.prepareLeave) {
    const prepared = await guard.prepareLeave()
    try {
      const allowed = await transition() !== false
      await prepared.complete(allowed && await didLeave())
      return allowed
    } catch (error) { await prepared.complete(false).catch(() => undefined); throw error }
  }
  if (!await guard.canLeave()) return false
  try {
    if (await transition() === false) { guard.resume?.(); return false }
    return true
  } catch (error) { guard.resume?.(); throw error }
}

/** The caller completes this only after the other renderer quit guards have succeeded. */
export async function prepareActiveCanvasForAppQuit(view: string, guard: CanvasLeaveGuard | null): Promise<CanvasLeavePreparation | null> {
  if (view !== 'canvas' || !guard) return null
  if (guard.prepareLeave) return guard.prepareLeave()
  if (!await guard.canLeave()) throw new Error(uiAttribute('画布操作或编辑尚未处理完成'))
  return null
}
