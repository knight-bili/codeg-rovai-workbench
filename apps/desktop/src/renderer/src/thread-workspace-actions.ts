import type { Dispatch, SetStateAction } from 'react'
import type { ActionApprovalView, AgentRunView, StoredCommandResult, ThreadComposerDraftView, ThreadMemberRemovalPreview, ThreadMessageView } from '@contracts'
import type { ThreadClient } from './camp-client'
import { newCommandId } from '../../shared/command-id'
import { composerHasSendablePayload, type ThreadMessageSendReceipt, type ThreadRuntimeRecovery, type ThreadMemberAddOutcome, type ThreadMemberRemoveOutcome } from './ThreadWorkspace'
import { threadCommands } from './thread-commands'
import { optimisticThreadMessage, runtimeRecoveryFromCommandResult, commandFailureMessage, membershipConflictCode, stringField, stringArrayField, asRecord, errorMessage, type ThreadSurfaceSnapshot } from './thread-workspace-data'
import { applyCancellationResult, reconcileRunCancellationIds } from './thread-run-cancellation'
import type { NavigationWindowReader } from './navigation-window-reader'
import { uiAttribute } from './interface-language'

export interface ThreadActionToast { message: string; tone: 'neutral' | 'danger'; action?: { label: string; onSelect(): void }; persistent?: boolean }
export interface ThreadOptimisticEntry { threadId: string; commandId: string; message: ThreadMessageView }
type Setter<T> = Dispatch<SetStateAction<T>>
interface ActionContext {
  client: Pick<ThreadClient, 'request'>
  activeThreadId: string | null
  activeThreadCommands: ReturnType<typeof threadCommands> | null
  campSnapshot: ThreadSurfaceSnapshot | null
  campSnapshotRef: { current: ThreadSurfaceSnapshot | null }
  activeThreadIdRef: { current: string | null }
  campSelectionGeneration: { current: number }
  threadClientOwner: { current: Pick<ThreadClient, 'request'> }
  campEventSequenceMarker: { current: number }
  setThreadSnapshot(snapshot: ThreadSurfaceSnapshot | null): void
  setBusy: Setter<string | null>
  setError: Setter<string | null>
  setToast: Setter<ThreadActionToast | null>
  setRuntimeRecovery: Setter<ThreadRuntimeRecovery | null>
  setOptimisticThreadMessages: Setter<ThreadOptimisticEntry[]>
  setCancellingRunIds: Setter<Set<string>>
  setConfirmingRunIds: Setter<Set<string>>
  refreshActiveThreadSnapshot(threadId: string): Promise<void>
  requestThreadProjection(threadId: string, mode: 'open' | 'enter'): Promise<{ snapshot: ThreadSurfaceSnapshot }>
  navigationRefreshCoordinator: Pick<NavigationWindowReader, 'refreshThreads' | 'invalidate'>
  forgetMemberCreationDraft(threadId: string): void
  notify(message: string): void
}

// Existing Rovai handlers are shared by the main workspace and independent canvas cards.
// Function bodies and model-facing request construction are retained from BusinessApp.
export function threadWorkspaceActions({ client, activeThreadId, activeThreadCommands, campSnapshot, campSnapshotRef, activeThreadIdRef, campSelectionGeneration, threadClientOwner, campEventSequenceMarker, setThreadSnapshot, setBusy, setError, setToast, setRuntimeRecovery, setOptimisticThreadMessages, setCancellingRunIds, setConfirmingRunIds, refreshActiveThreadSnapshot, requestThreadProjection, navigationRefreshCoordinator, forgetMemberCreationDraft, notify }: ActionContext) {


  const cancelAgentRun = async (run: AgentRunView): Promise<void> => {
    const threadId = activeThreadCommands?.threadId
    if (!threadId || campSnapshotRef.current?.thread.id !== threadId) return
    setError(null)
    setConfirmingRunIds((current) => {
      const next = new Set(current)
      next.delete(run.id)
      return next
    })
    setCancellingRunIds((current) => new Set(current).add(run.id))

    let result: StoredCommandResult
    try {
      result = await activeThreadCommands!.cancel(newCommandId(), run)
    } catch {
      setCancellingRunIds((current) => {
        const next = new Set(current)
        next.delete(run.id)
        return next
      })
      setConfirmingRunIds((current) => new Set(current).add(run.id))
      try {
        const { snapshot } = await requestThreadProjection(threadId, 'open')
        if (activeThreadIdRef.current === threadId) {
          campEventSequenceMarker.current = Math.max(
            campEventSequenceMarker.current,
            snapshot.throughGlobalSequence
          )
          setThreadSnapshot(snapshot)
        }
        setConfirmingRunIds((current) => reconcileRunCancellationIds(current, snapshot))
      } catch {
        // Keep the uncertainty projection until a later authoritative Thread refresh converges it.
      }
      return
    }

    if (result.status === 'rejected') {
      setCancellingRunIds((current) => {
        const next = new Set(current)
        next.delete(run.id)
        return next
      })
      setConfirmingRunIds((current) => {
        const next = new Set(current)
        next.delete(run.id)
        return next
      })
      try {
        await refreshActiveThreadSnapshot(threadId)
      } catch {
        // The deterministic command result remains authoritative even if this refresh fails.
      }
      setError(commandFailureMessage(result))
      return
    }

    if (campSnapshotRef.current?.thread.id === threadId) {
      setThreadSnapshot(applyCancellationResult(campSnapshotRef.current, result))
    }
    setCancellingRunIds((current) => new Set([...current].filter((id) => id !== run.id)))
    setConfirmingRunIds((current) => new Set([...current].filter((id) => id !== run.id)))
    try {
      await refreshActiveThreadSnapshot(threadId)
    } catch {
      // Core's terminal response already clears stopping; the next poll fills in the rest.
    }
  }


  const changeDefaultLead = async (agentId: string): Promise<void> => {
    if (!activeThreadId || campSnapshot?.thread.id !== activeThreadId) return
    setBusy('change-default-lead')
    setError(null)
    try {
      const result = await activeThreadCommands!.changeLead(newCommandId(), agentId, campSnapshot.thread.version)
      if (result.status === 'rejected') throw new Error(commandFailureMessage(result))
      await Promise.all([
        refreshActiveThreadSnapshot(activeThreadId),
        navigationRefreshCoordinator.refreshThreads([activeThreadId], 'explicit')
      ])
    } catch (nextError) {
      setError(errorMessage(nextError))
      throw nextError
    } finally {
      setBusy(null)
    }
  }


  const addThreadMembers = async (agentIds: string[]): Promise<ThreadMemberAddOutcome> => {
    const threadId = activeThreadCommands?.threadId
    const currentSnapshot = campSnapshotRef.current
    if (!threadId || currentSnapshot?.thread.id !== threadId) {
      throw new Error(uiAttribute('当前会话尚未准备好。'))
    }
    setBusy('camp-membership')
    setError(null)
    const outcome: ThreadMemberAddOutcome = {
      addedAgentIds: [],
      unchangedAgentIds: [],
      failures: []
    }
    let membershipGeneration = currentSnapshot.thread.membershipGeneration
    try {
      for (let index = 0; index < agentIds.length; index += 1) {
        const agentId = agentIds[index]
        try {
          const result = await activeThreadCommands!.addMember(newCommandId(), agentId, membershipGeneration)
          if (result.status === 'rejected') {
            const message = commandFailureMessage(result)
            outcome.failures.push({ agentId, message })
            if (membershipConflictCode(result.code)) {
              for (const remainingAgentId of agentIds.slice(index + 1)) {
                outcome.failures.push({
                  agentId: remainingAgentId,
                  message:uiAttribute("名册已发生变化，请在刷新后重试。")
                })
              }
              break
            }
            continue
          }
          const payload = asRecord(result.payload)
          if (typeof payload.membershipGeneration === 'number') {
            membershipGeneration = payload.membershipGeneration
          }
          if (payload.changed === false) outcome.unchangedAgentIds.push(agentId)
          else outcome.addedAgentIds.push(agentId)
        } catch (error) {
          outcome.failures.push({ agentId, message: errorMessage(error) })
        }
      }
      try {
        await Promise.all([
          refreshActiveThreadSnapshot(threadId),
          navigationRefreshCoordinator.refreshThreads([threadId], 'explicit')
        ])
      } catch {
        // The per-command outcomes are authoritative; normal event refresh will converge the surface.
      }
      return outcome
    } finally {
      setBusy(null)
    }
  }


  const previewThreadMemberRemoval = async (agentId: string): Promise<ThreadMemberRemovalPreview> => {
    const threadId = activeThreadCommands?.threadId
    if (!threadId || campSnapshotRef.current?.thread.id !== threadId) {
      throw new Error(uiAttribute('当前会话尚未准备好。'))
    }
    const preview = await activeThreadCommands!.removalPreview(agentId)
    if (!preview) throw new Error(uiAttribute('这位队员已不在当前会话中。'))
    return preview
  }


  const removeThreadMember = async (
    preview: ThreadMemberRemovalPreview
  ): Promise<ThreadMemberRemoveOutcome> => {
    const threadId = activeThreadCommands?.threadId
    if (!threadId || preview.threadId !== threadId || campSnapshotRef.current?.thread.id !== threadId) {
      return { status: 'conflict', message:uiAttribute("当前会话已发生变化，请重新读取影响。") }
    }
    setBusy('camp-membership')
    setError(null)
    try {
      const result = await activeThreadCommands!.removeMember(newCommandId(), preview)
      if (result.status === 'rejected') {
        try {
          await refreshActiveThreadSnapshot(threadId)
        } catch {
          // Keep the deterministic command result when the follow-up projection is unavailable.
        }
        return {
          status: membershipConflictCode(result.code) ? 'conflict' : 'failed',
          message: commandFailureMessage(result)
        }
      }
      try {
        await Promise.all([
          refreshActiveThreadSnapshot(threadId),
          navigationRefreshCoordinator.refreshThreads([threadId], 'explicit')
        ])
      } catch {
        // The accepted cutover is authoritative; reconciliation events will refresh the surface.
      }
      const reconciliationStatus = stringField(asRecord(result.payload), 'reconciliationStatus')
      return {
        status: 'removed',
        reconciliationStatus: reconciliationStatus === 'reconciling' ? 'reconciling' : 'settled'
      }
    } catch (error) {
      return { status: 'failed', message: errorMessage(error) }
    } finally {
      setBusy(null)
    }
  }


  const sendThreadMessage = async (
    draft: ThreadComposerDraftView
  ): Promise<ThreadMessageSendReceipt | void> => {
    const hasReadyAttachment = draft.attachments.length > 0
    const hasSendablePayload = composerHasSendablePayload(draft.body, hasReadyAttachment)
    const threadId = activeThreadCommands?.threadId
    if (!threadId || draft.threadId !== threadId || !hasSendablePayload || draft.revision < 1) return
    const commandId = newCommandId()
    const selectionGeneration = campSelectionGeneration.current
    const optimisticMessage = optimisticThreadMessage(
      campSnapshotRef.current?.thread.id === threadId ? campSnapshotRef.current : null,
      commandId,
      draft
    )
    // Core decides direct publication versus private queue admission. Never expose
    // a pending input as an optimistic public ThreadMessage before that decision.
    setBusy('camp-message')
    setError(null)
    setToast((current) => current?.persistent ? current : null)
    setRuntimeRecovery((current) => current?.threadId === threadId ? null : current)
    let rejectedForRuntime = false
    try {
      const result = await activeThreadCommands!.send(commandId, draft)
      if (!result.commandResult) {
        throw new Error(uiAttribute('消息提交结果暂时不可用，请稍后重试。'))
      }
      if (result.commandResult.status === 'rejected') {
        const recovery = runtimeRecoveryFromCommandResult(threadId, result.commandResult)
        if (recovery) {
          rejectedForRuntime = true
          setRuntimeRecovery(recovery)
        }
        throw new Error(commandFailureMessage(result.commandResult))
      }
      forgetMemberCreationDraft(threadId)
      const threadMessageId = stringField(result.commandResult.payload, 'threadMessageId')
      const deliveryIds = stringArrayField(result.commandResult.payload, 'deliveryIds')
      const agentRunIds = stringArrayField(result.commandResult.payload, 'agentRunIds')
      const sequence = typeof result.commandResult.payload.sequence === 'number'
        ? result.commandResult.payload.sequence
        : optimisticMessage.sequence
      if (threadMessageId) {
        setOptimisticThreadMessages((current) => [...current, {
          threadId, commandId,
          message: { ...optimisticMessage, id: threadMessageId, sequence, threadTurnId: null }
        }])
        void refreshActiveThreadSnapshot(threadId)
          .then(async () => {
            if (selectionGeneration !== campSelectionGeneration.current) return
            setOptimisticThreadMessages((current) =>
              current.filter((entry) => entry.commandId !== commandId)
            )
            if (selectionGeneration === campSelectionGeneration.current) await navigationRefreshCoordinator.invalidate({ scope: 'group', threadId })
          })
          .catch((nextError) => setError(errorMessage(nextError)))
      }
      return {
        ...(threadMessageId ? { threadMessageId } : {}),
        ...(threadMessageId && typeof result.commandResult.payload.sequence === 'number'
          ? { publishedMessageSequence: sequence } : {}),
        deliveryIds,
        agentRunIds,
        addressedAgentIds: optimisticMessage.addressedAgentIds
      }
    } catch (nextError) {
      setOptimisticThreadMessages((current) =>
        current.filter((entry) => entry.commandId !== commandId)
      )
      if (!rejectedForRuntime) notify(errorMessage(nextError))
      throw nextError
    } finally {
      setBusy(null)
    }
  }


  const withdrawThreadMessage = async (message: ThreadMessageView): Promise<void> => {
    const threadId = activeThreadCommands?.threadId
    if (!threadId || message.id.startsWith('optimistic:') || !message.canWithdraw) return
    const result = await activeThreadCommands!.withdraw(newCommandId(), message)
    if (result.status === 'rejected') throw new Error(commandFailureMessage(result))
    setOptimisticThreadMessages((current) => current.filter((entry) => entry.message.id !== message.id))
    await refreshActiveThreadSnapshot(threadId)
  }


  const resolveActionApproval = async (
    approval: ActionApprovalView,
    optionId: string
  ): Promise<void> => {
    const threadId = activeThreadCommands?.threadId, generation = campSelectionGeneration.current, requestOwner = client
    if (!threadId || campSnapshotRef.current?.thread.id !== threadId) return
    setBusy(`action-approval-${approval.id}`)
    setError(null)
    try {
      const result = await activeThreadCommands!.resolveApproval(newCommandId(), approval, optionId)
      if (result.status === 'rejected') throw new Error(commandFailureMessage(result))
      const { snapshot } = await requestThreadProjection(threadId, 'open')
      if (requestOwner !== threadClientOwner.current || generation !== campSelectionGeneration.current || activeThreadIdRef.current !== threadId
        || snapshot.throughGlobalSequence < campEventSequenceMarker.current) return
      campEventSequenceMarker.current = snapshot.throughGlobalSequence
      setThreadSnapshot(snapshot)
    } catch (nextError) {
      if (requestOwner === threadClientOwner.current && generation === campSelectionGeneration.current && activeThreadIdRef.current === threadId) setError(errorMessage(nextError))
    } finally {
      setBusy(current => current === `action-approval-${approval.id}` ? null : current)
    }
  }
  return { cancelAgentRun, changeDefaultLead, addThreadMembers, previewThreadMemberRemoval, removeThreadMember, sendThreadMessage, withdrawThreadMessage, resolveActionApproval }
}
