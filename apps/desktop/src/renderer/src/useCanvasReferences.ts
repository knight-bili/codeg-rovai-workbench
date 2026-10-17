import { useCallback, useEffect, useRef, useState } from 'react'
import { useThreadClient } from './camp-client'
import { CanvasReferenceController, initialCanvasReferenceState } from './canvas-reference-controller'

export function useCanvasReferences() {
  const client = useThreadClient(), owner = useRef<{ client: typeof client; controller: CanvasReferenceController } | null>(null)
  const [owned, setOwned] = useState(() => ({ client, state: initialCanvasReferenceState() }))
  useEffect(() => {
    const current = new CanvasReferenceController(client)
    owner.current = { client, controller: current }
    const unsubscribe = current.subscribe(() => setOwned({ client, state: current.getSnapshot() }))
    setOwned({ client, state: current.getSnapshot() }); current.start()
    const foreground = () => current.setVisible(document.visibilityState === 'visible')
    const poll = setInterval(() => { if (document.visibilityState === 'visible') void current.refresh().catch(() => undefined) }, 20_000)
    window.addEventListener('focus', foreground); document.addEventListener('visibilitychange', foreground)
    return () => {
      unsubscribe(); current.dispose(); if (owner.current?.controller === current) owner.current = null
      clearInterval(poll); window.removeEventListener('focus', foreground); document.removeEventListener('visibilitychange', foreground)
    }
  }, [client])
  const refresh = useCallback(() => owner.current?.client === client ? owner.current.controller.refresh() : Promise.reject(new Error('对话目录尚未准备好。')), [client])
  return { ...(owned.client === client ? owned.state : initialCanvasReferenceState()), refresh }
}
