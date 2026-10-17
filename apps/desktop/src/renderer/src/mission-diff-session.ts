import type { RovaiApi } from '@contracts'

type Client = Pick<RovaiApi, 'request'>
const readers = new WeakMap<Client, Map<string, { count: number }>>()

/** Mission-wide release must wait for every mounted change reader on the same client. */
export function retainMissionDiffSession(client: Client, missionId: string): () => void {
  let missions = readers.get(client)
  if (!missions) { missions = new Map(); readers.set(client, missions) }
  let entry = missions.get(missionId)
  if (!entry) { entry = { count: 0 }; missions.set(missionId, entry) }
  entry.count += 1
  const owned = entry, owners = missions
  let released = false
  return () => {
    if (released) return
    released = true; owned.count -= 1
    // A same-turn remount retains the existing session before its release is sent.
    queueMicrotask(() => {
      if (owned.count || owners.get(missionId) !== owned) return
      owners.delete(missionId)
      void client.request('missions.diffSession.release', { missionId }).catch(() => undefined)
    })
  }
}
