import type { CanvasTerminalTarget } from '@contracts'
import type { ThreadClient } from './camp-client'
import { CanvasTerminalClient } from './canvas-terminal-client'
import { CanvasTerminalController } from './canvas-terminal-controller'
import { uiAttribute } from './interface-language'

const sessions = new WeakMap<Pick<ThreadClient, 'request'>, Map<string, CanvasTerminalController>>()

/** Window memory only: retain uncertain request identities across route/collapse, never raw durable input. */
export function canvasTerminalSession(client: Pick<ThreadClient, 'request'>, scope: string, target: CanvasTerminalTarget, version: number): CanvasTerminalController {
  let owned = sessions.get(client)
  if (!owned) { owned = new Map(); sessions.set(client, owned) }
  const key = JSON.stringify([scope, version, target.boardId, target.nodeId])
  const existing = owned.get(key)
  if (existing) { owned.delete(key); owned.set(key, existing); return existing }
  if (owned.size >= 64) {
    const idle = [...owned].find(([, controller]) => controller.canEvict())
    if (!idle) throw new Error(uiAttribute('当前窗口终端展示已达上限，请先收起其他终端。'))
    owned.delete(idle[0])
  }
  const controller = new CanvasTerminalController(new CanvasTerminalClient(client, target, version))
  owned.set(key, controller)
  return controller
}
