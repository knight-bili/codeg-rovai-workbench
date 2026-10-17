import { useEffect, useRef, useState } from 'react'
import type { ThreadClient } from './camp-client'
import { emptyNavigationActivity, NavigationActivityController } from './navigation-activity-controller'

export function useNavigationActivity(client: ThreadClient, keys: readonly string[], active: boolean) {
  const key = JSON.stringify([...new Set(keys)].sort())
  const scope = client.presentationScope ?? null, activeRef = useRef(active)
  activeRef.current = active
  const owner = useRef<{ client: ThreadClient; scope: string | null; controller: NavigationActivityController } | null>(null)
  const [owned, setOwned] = useState(() => ({ client, scope, state: emptyNavigationActivity() }))
  useEffect(() => {
    const controller = new NavigationActivityController(client)
    owner.current = { client, scope, controller }
    const unsubscribe = controller.subscribe(() => setOwned({ client, scope, state: controller.getSnapshot() }))
    setOwned({ client, scope, state: controller.getSnapshot() }); controller.start()
    const poll = () => { if (activeRef.current && document.visibilityState === 'visible') void controller.refresh('poll').catch(() => undefined) }
    const visible = () => controller.setVisible(document.visibilityState === 'visible' && activeRef.current)
    const focus = () => { visible(); poll() }
    const timer = setInterval(poll, 20_000)
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', visible)
    return () => { unsubscribe(); controller.dispose(); if (owner.current?.controller === controller) owner.current = null
      clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', visible) }
  }, [client, scope])
  useEffect(() => {
    if (owner.current?.client !== client || owner.current.scope !== scope) return
    owner.current.controller.setGroups(JSON.parse(key))
    owner.current.controller.setVisible(document.visibilityState === 'visible' && active)
  }, [client, scope, key, active])
  return owned.client === client && owned.scope === scope ? owned.state : emptyNavigationActivity()
}
