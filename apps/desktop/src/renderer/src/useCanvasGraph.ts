import { useCallback, useEffect, useRef, useState } from 'react'
import type { CanvasNodeMutation } from '@contracts'
import { CanvasGraphController, initialCanvasGraphState } from './canvas-graph-controller'
import { useThreadClient } from './camp-client'

export function useCanvasGraph(boardId: string) {
  const client = useThreadClient()
  const controller = useRef<{ client: typeof client; value: CanvasGraphController } | null>(null)
  const [owned, setOwned] = useState(() => ({ client, state: initialCanvasGraphState(boardId) }))
  useEffect(() => {
    // A fresh effect-owned instance also survives StrictMode's setup/cleanup/setup cycle.
    const current = new CanvasGraphController(client, boardId)
    controller.current = { client, value: current }
    const unsubscribe = current.subscribe(() => setOwned({ client, state: current.getSnapshot() }))
    setOwned({ client, state: current.getSnapshot() })
    current.start()
    const foreground = () => current.setVisible(document.visibilityState === 'visible')
    window.addEventListener('focus', foreground)
    document.addEventListener('visibilitychange', foreground)
    const poll = setInterval(() => { if (document.visibilityState === 'visible') void current.refresh().catch(() => undefined) }, 20_000)
    return () => {
      unsubscribe(); current.dispose(); clearInterval(poll)
      if (controller.current?.value === current) controller.current = null
      window.removeEventListener('focus', foreground)
      document.removeEventListener('visibilitychange', foreground)
    }
  }, [client, boardId])
  const active = useCallback(() => {
    if (!controller.current || controller.current.client !== client || controller.current.value.boardId !== boardId) throw new Error('画板尚未准备好。')
    return controller.current.value
  }, [client, boardId])
  return { ...(owned.client === client && owned.state.boardId === boardId ? owned.state : initialCanvasGraphState(boardId)),
    apply: useCallback((mutation: CanvasNodeMutation, expectedRevision?: number) => active().apply(mutation, expectedRevision), [active]),
    hasUnsettled: useCallback(() => controller.current?.client === client && controller.current.value.boardId === boardId
      && Boolean(controller.current.value.getSnapshot().pending), [client, boardId]),
    refresh: useCallback(() => active().refresh(), [active]),
    retry: useCallback(() => active().retry(), [active]),
    reconcile: useCallback(() => active().reconcile(), [active]) }
}
