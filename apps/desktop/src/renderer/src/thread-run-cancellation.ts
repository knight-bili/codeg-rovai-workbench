import type { ThreadSnapshot, AgentRunView, StoredCommandResult } from '@contracts'



const CANCELLABLE_TURN_STATUSES = new Set<ThreadSnapshot['turns'][number]['status']>([
  'running',
  'waiting'
])

const CANCELLABLE_RUN_STATUSES = new Set<ThreadSnapshot['agentRuns'][number]['status']>([
  'queued',
  'running',
  'waiting'
])


export function cancellableTurnIds(snapshot: {
  turns: Pick<ThreadSnapshot['turns'][number], 'id' | 'status'>[]
  agentRuns: Pick<ThreadSnapshot['agentRuns'][number], 'threadTurnId' | 'status'>[]
}, scope: 'current_execution' | 'camp_cleanup' = 'current_execution'): string[] {
  if (scope === 'camp_cleanup') {
    return snapshot.turns
      .filter((turn) => CANCELLABLE_TURN_STATUSES.has(turn.status))
      .map((turn) => turn.id)
  }
  const executingTurnIds = new Set(snapshot.agentRuns
    .filter((run) => CANCELLABLE_RUN_STATUSES.has(run.status))
    .map((run) => run.threadTurnId))
  return snapshot.turns
    .filter((turn) =>
      CANCELLABLE_TURN_STATUSES.has(turn.status) && executingTurnIds.has(turn.id))
    .map((turn) => turn.id)
}


export function reconcileCancellingTurnIds(
  current: ReadonlySet<string>,
  snapshot: Pick<ThreadSnapshot, 'turns'>
): Set<string> {
  const terminalTurnIds = new Set(snapshot.turns
    .filter((turn) => !CANCELLABLE_TURN_STATUSES.has(turn.status))
    .map((turn) => turn.id))
  if (![...current].some((turnId) => terminalTurnIds.has(turnId))) {
    return current instanceof Set ? current : new Set(current)
  }
  return new Set([...current].filter((turnId) => !terminalTurnIds.has(turnId)))
}


export function effectiveCancellingTurnIds(
  local: ReadonlySet<string>,
  snapshot: Pick<ThreadSnapshot, 'turns'>
): Set<string> {
  const activeIds = new Set(snapshot.turns
    .filter((item) => CANCELLABLE_TURN_STATUSES.has(item.status))
    .map((item) => item.id))
  return new Set([...local].filter((id) => activeIds.has(id)))
}


export function reconcileRunCancellationIds(
  current: ReadonlySet<string>,
  snapshot: {
    agentRuns: Pick<AgentRunView, 'id' | 'status' | 'cancelRequestedAt'>[]
  }
): Set<string> {
  const runById = new Map(snapshot.agentRuns.map((run) => [run.id, run]))
  const next = new Set([...current].filter((runId) => {
    const run = runById.get(runId)
    return Boolean(
      run
      && CANCELLABLE_RUN_STATUSES.has(run.status)
      && run.cancelRequestedAt === null
    )
  }))
  if (next.size === current.size && [...next].every((runId) => current.has(runId))) {
    return current instanceof Set ? current : next
  }
  return next
}


export function effectiveCancellingRunIds(
  local: ReadonlySet<string>,
  snapshot: { agentRuns: Pick<AgentRunView, 'id' | 'status' | 'cancelRequestedAt'>[] }
): Set<string> {
  const activeIds = new Set(snapshot.agentRuns
    .filter((item) => CANCELLABLE_RUN_STATUSES.has(item.status))
    .map((item) => item.id))
  return new Set([...local].filter((id) => activeIds.has(id)))
}


// Apply only terminal facts returned by Core, then refresh the complete projection.
// Cleanup ACK is deliberately absent from this presentation boundary.
export function applyCancellationResult(
  snapshot: ThreadSnapshot,
  result: StoredCommandResult
): ThreadSnapshot {
  if (result.status !== 'applied') return snapshot
  const payload = result.payload
  const runs = new Map<string, {
    status: AgentRunView['status']
    unknown: boolean
    cancelledByRequest: boolean
  }>()
  const addRun = (id: unknown, status: unknown, code: unknown): void => {
    if (typeof id === 'string' && (status === 'failed' || status === 'cancelled' || status === 'succeeded')) {
      runs.set(id, {
        status,
        unknown: code === 'agent_run.accepted_input_outcome_unknown',
        cancelledByRequest: status === 'cancelled' && code === 'agent_run.cancelled'
      })
    }
  }
  addRun(payload.agentRunId, payload.status, result.code)
  if (Array.isArray(payload.runs)) {
    for (const item of payload.runs) {
      if (item && typeof item === 'object' && 'agentRunId' in item && 'terminalStatus' in item) {
        addRun(item.agentRunId, item.terminalStatus, 'terminalCode' in item ? item.terminalCode : null)
      }
    }
  }
  const turnStatus = payload.threadTurnStatus
  return {
    ...snapshot,
    agentRuns: snapshot.agentRuns.map((run) => {
      const settled = runs.get(run.id)
      return settled ? {
        ...run,
        status: settled.status,
        waitReason: null,
        hasUnsettledExternalEffects: settled.cancelledByRequest
          ? false
          : run.hasUnsettledExternalEffects || settled.unknown
      } : run
    }),
    turns: snapshot.turns.map((turn) => turn.id === payload.threadTurnId
      && (turnStatus === 'completed' || turnStatus === 'failed' || turnStatus === 'cancelled')
      ? { ...turn, status: turnStatus } : turn)
  }
}
