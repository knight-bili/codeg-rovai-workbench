import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { PrivateAttachmentPreparationOwner, PrivateAttachmentUploadTarget, RovaiApi } from '@contracts'
import { privateUploadController, privateUploadTargetKey } from './private-upload-controller'
import { PrivateUploadRecoveryPanel, privateUploadErrorMessage } from './PrivateUploadRecoveryPanel'
import { UiText, uiAttribute } from './interface-language'

type Api = RovaiApi['singleChatAttachments']
type Entry = Awaited<ReturnType<NonNullable<Api['pendingPreparations']>>>[number]
export function inactiveUploadTargets(entries: readonly Entry[], owner: PrivateAttachmentPreparationOwner,
  active: readonly PrivateAttachmentUploadTarget[]): PrivateAttachmentUploadTarget[] {
  const current = new Set(active.map(privateUploadTargetKey))
  const targets = new Map<string, PrivateAttachmentUploadTarget>()
  for (const entry of entries) {
    if (entry.request.threadId !== owner.threadId || entry.request.target.conversationId !== owner.conversationId
      || privateUploadTargetKey({ kind: 'single_chat', conversationId: owner.conversationId, composerScope: entry.request.target.composerScope })
        !== privateUploadTargetKey({ kind: 'single_chat', conversationId: owner.conversationId, composerScope: owner.composerScope })) throw new Error('private_upload.context_changed')
    const key = privateUploadTargetKey(entry.request.target)
    if (entry.state !== 'recorded' && !current.has(key)) targets.set(key, structuredClone(entry.request.target))
  }
  return [...targets.values()]
}

function HistoryTarget({ api, owner, target, reselect, onApplied, onSettled }: {
  api: Api; owner: PrivateAttachmentPreparationOwner; target: PrivateAttachmentUploadTarget; reselect: boolean
  onApplied(): void; onSettled(): void
}): React.JSX.Element {
  const controller = useMemo(() => privateUploadController(api, owner, target), [api, owner, target])
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  useEffect(() => { void controller.load().catch(() => undefined) }, [controller])
  useEffect(() => { if (state.applied) onApplied() }, [state.applied])
  useEffect(() => { if (state.loaded && !state.rows.length && !state.error) onSettled() }, [state.loaded, state.rows.length, state.error])
  return <div>
    <p><UiText zh="之前编辑的排队消息文件，仍按原来的位置核对。" /></p>
    <PrivateUploadRecoveryPanel controller={controller} reselect={reselect} />
  </div>
}

export function PrivateUploadHistoryPanel({ api, owner, activeTargets, enabled, reselect, onApplied }: {
  api: Api; owner: PrivateAttachmentPreparationOwner; activeTargets: readonly PrivateAttachmentUploadTarget[]
  enabled: boolean; reselect: boolean; onApplied(): void
}): React.JSX.Element | null {
  const ownerKey = JSON.stringify([owner.threadId, owner.conversationId, owner.composerScope?.boardId, owner.composerScope?.nodeId])
  const frozen = useMemo(() => structuredClone(owner), [ownerKey])
  const activeKey = activeTargets.map(privateUploadTargetKey).join('|')
  const [targets, setTargets] = useState<PrivateAttachmentUploadTarget[]>([])
  const [error, setError] = useState<unknown>(null)
  const [loadedFor, setLoadedFor] = useState<{ api: Api; key: string } | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let current = true
    setTargets([]); setError(null)
    if (enabled && api.pendingPreparations && api.prepareInput && api.reconcileInput && api.retryInput) {
      void api.pendingPreparations(frozen).then(entries => {
        if (current) {
          setTargets(inactiveUploadTargets(entries, frozen, activeTargets))
          setLoadedFor({ api, key: `${ownerKey}:${activeKey}` })
        }
      }).catch(error => { if (current) { setError(error); setLoadedFor({ api, key: `${ownerKey}:${activeKey}` }) } })
    }
    return () => { current = false }
  }, [api, ownerKey, activeKey, enabled, revision])
  if (!enabled || loadedFor?.api !== api || loadedFor.key !== `${ownerKey}:${activeKey}` || (!targets.length && !error)) return null
  return <section className="single-chat-retained-inputs" aria-label={uiAttribute('之前的文件准备')}>
    {error != null && <p role="alert">{privateUploadErrorMessage(error)} <button type="button" onClick={() => setRevision(value => value + 1)}><UiText zh="重新读取文件准备记录" /></button></p>}
    {targets.map(target => <HistoryTarget key={`${ownerKey}:${privateUploadTargetKey(target)}`} api={api} owner={frozen} target={target}
      reselect={reselect} onApplied={onApplied} onSettled={() => setTargets(current => current.filter(item => privateUploadTargetKey(item) !== privateUploadTargetKey(target)))} />)}
  </section>
}
