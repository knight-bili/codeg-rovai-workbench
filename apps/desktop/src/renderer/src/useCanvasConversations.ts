import { useEffect, useRef, useState } from 'react'
import type { ThreadClient } from './camp-client'
import type { ThreadProjectionStore } from './thread-projection-store'
import { CanvasConversationsController, initialCanvasConversations } from './canvas-conversations-controller'
import { CanvasConversationRecovery } from './canvas-conversation-recovery'
import { browserCanvasStorage } from './canvas-view-state'

export function useCanvasConversations(client: ThreadClient, reads: ThreadProjectionStore, afterCommit: () => Promise<void>) {
  const controller = useRef<CanvasConversationsController | null>(null)
  const [owned, setOwned] = useState(() => ({ client, reads, state: initialCanvasConversations() }))
  useEffect(() => {
    const current = new CanvasConversationsController(client, reads, afterCommit, new CanvasConversationRecovery(browserCanvasStorage()))
    controller.current = current
    const stop = current.subscribe(() => setOwned({ client, reads, state: current.getSnapshot() }))
    setOwned({ client, reads, state: current.getSnapshot() })
    return () => { stop(); current.dispose(); if (controller.current === current) controller.current = null }
  }, [client, reads, afterCommit])
  return { controller, state: owned.client === client && owned.reads === reads ? owned.state : initialCanvasConversations() }
}
