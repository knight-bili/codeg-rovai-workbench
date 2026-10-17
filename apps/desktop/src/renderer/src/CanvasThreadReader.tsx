import { useEffect } from 'react'
import type { EventBatch } from '@contracts'
import { useThreadClient } from './camp-client'
import type { ThreadProjectionStore } from './thread-projection-store'
import { shouldRefreshActiveThreadForCoreEvent } from './thread-projection-events'

/** Exactly one mounted reader per Thread, regardless of the number of card mirrors. */
export function CanvasThreadReader({ threadId, reads }: { threadId: string; reads: ThreadProjectionStore }): null {
  const client = useThreadClient()
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | null = null
    let cursor = reads.peek(threadId)?.throughGlobalSequence ?? 0
    const refresh = async () => {
      const result = await reads.refresh(threadId)
      if (!disposed) cursor = Math.max(cursor, result.snapshot.throughGlobalSequence)
    }
    const offEvent = client.onEvent?.(event => {
      if (shouldRefreshActiveThreadForCoreEvent(event, threadId)) void refresh().catch(() => undefined)
    })
    const offInvalidation = client.onInvalidated?.(change => {
      if (!change || change.resync || !change.messages?.length || change.messages.some(item => item.threadId === threadId)) void refresh().catch(() => undefined)
    })
    const poll = async () => {
      try {
        if (document.visibilityState === 'hidden') return
        cursor = Math.max(cursor, reads.peek(threadId)?.throughGlobalSequence ?? 0)
        const batch = await client.request<EventBatch>('events.subscribe', { threadId, afterGlobalSequence: cursor, limit: 250 })
        if (disposed) return
        if (batch.schemaVersion !== 9 || batch.resetRequired || batch.events.length) await refresh()
        else cursor = Math.max(cursor, batch.nextGlobalSequence)
      } catch { /* The read owner retains its last snapshot/error; never replay event payloads. */ }
      finally { if (!disposed) timer = setTimeout(() => { void poll() }, document.visibilityState === 'hidden' ? 20_000 : 1_400) }
    }
    const foreground = () => { if (document.visibilityState !== 'hidden') void refresh().catch(() => undefined) }
    window.addEventListener('focus', foreground); document.addEventListener('visibilitychange', foreground)
    // Subscribe before reconciling the initial read/observer handoff.
    void refresh().catch(() => undefined).finally(() => { if (!disposed && !client.onInvalidated) void poll() })
    return () => {
      disposed = true; offEvent?.(); offInvalidation?.(); if (timer) clearTimeout(timer)
      window.removeEventListener('focus', foreground); document.removeEventListener('visibilitychange', foreground)
    }
  }, [client, reads, threadId])
  return null
}
