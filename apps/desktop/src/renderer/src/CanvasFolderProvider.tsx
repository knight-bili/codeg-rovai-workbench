import { createContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ThreadClient } from './camp-client'
import { CanvasFolderController, createCanvasFolderRequestScope } from './canvas-folder-controller'
import type { CanvasFolderResolution } from './canvas-reference-model'

const EMPTY: ReadonlyMap<string, CanvasFolderResolution> = new Map()
export const CanvasFolderContext = createContext<{
  resolutions: ReadonlyMap<string, CanvasFolderResolution>
  register(token: symbol, paths: readonly string[]): () => void
  refresh(): Promise<void>
} | null>(null)

export function CanvasFolderProvider({ client, children }: { client: ThreadClient; children: ReactNode }): React.JSX.Element {
  const scope = useMemo(createCanvasFolderRequestScope, [client])
  const [owned, setOwned] = useState(() => ({ client, resolutions: EMPTY }))
  useEffect(() => {
    const current = new CanvasFolderController(client)
    const unsubscribe = current.subscribe(() => setOwned({ client, resolutions: current.getSnapshot() }))
    setOwned({ client, resolutions: current.getSnapshot() }); scope.bind(current)
    const refresh = () => { if (document.visibilityState === 'visible') void current.refresh().catch(() => undefined) }
    const poll = setInterval(refresh, 20_000)
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh)
    return () => {
      unsubscribe(); scope.unbind(current); current.dispose()
      clearInterval(poll); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh)
    }
  }, [client, scope])
  const value = useMemo(() => ({ resolutions: owned.client === client ? owned.resolutions : EMPTY,
    register: scope.register, refresh: scope.refresh }), [owned, client, scope])
  return <CanvasFolderContext.Provider value={value}>{children}</CanvasFolderContext.Provider>
}
