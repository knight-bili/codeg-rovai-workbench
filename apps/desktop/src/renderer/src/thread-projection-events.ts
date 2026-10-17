import type { CoreEvent } from '@contracts'
import { asRecord, stringField } from './thread-workspace-data'


const ACTIVE_CAMP_INVALIDATION_EVENTS = new Set([
  'thread.messages.changed',
  'thread.memberCreated',
  'thread.member.fast.updated',
  'camp.member_added',
  'camp.member_removed',
  'camp.membership_reconciliation_started',
  'camp.membership_reconciliation_completed',
  'camp.default_lead_reconciled',
  'agent_run.cancelled',
  'agent_run.continuation_requested',
  'agent_run.recovery_blocker_resolved',
  'agent_run.runtime_model_observed',
  'agent_run.terminal',
  'agent_run.images.updated',
  'agent_run.file_changes_completed'
])


export function shouldRefreshActiveThreadForCoreEvent(
  event: CoreEvent,
  activeThreadId: string | null,
  shuttingDown = false
): boolean {
  if (shuttingDown || !activeThreadId || !ACTIVE_CAMP_INVALIDATION_EVENTS.has(event.method)) {
    return false
  }
  const eventThreadId = stringField(asRecord(event.params), 'threadId')
  if (event.method === 'agent_run.runtime_model_observed') {
    return eventThreadId === activeThreadId
  }
  return !eventThreadId || eventThreadId === activeThreadId
}
