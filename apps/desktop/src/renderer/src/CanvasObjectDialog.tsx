import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { AppDialogBody, AppDialogContent, AppDialogFooter, AppDialogHeader } from './AppDialog'
import { useThreadClient } from './camp-client'
import { MissionChanges, missionChangesVisible } from './MissionDelivery'
import { canvasObjectId, canvasObjectInvalidated, canvasObjectNames, readCanvasObject, type CanvasObjectRead, type CanvasObjectTarget } from './canvas-object'
import { readErrorMessage } from './error-message'
import { UiText, uiAttribute } from './interface-language'

/** Read-only object inspector. Editing stays in the original workspace and its existing leave/recovery guards. */
export function CanvasObjectDialog({ target, onClose, onOpenWorkspace }: {
  target: CanvasObjectTarget; onClose(): void; onOpenWorkspace?(target: CanvasObjectTarget): void
}): React.JSX.Element {
  const client = useThreadClient(), [value, setValue] = useState<CanvasObjectRead | null>(null)
  const [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(true), [retry, setRetry] = useState(0)
  const [stale, setStale] = useState(false)
  useEffect(() => {
    let current = true
    setLoading(true); setValue(null); setError(null); setStale(false)
    void readCanvasObject(client, target, () => current).then(next => { if (current) setValue(next) })
      .catch(failure => { if (current) setError(readErrorMessage(failure)) }).finally(() => { if (current) setLoading(false) })
    const invalidated = client.onInvalidated?.(() => { if (current) setStale(true) })
    const changed = client.onEvent?.(event => { if (current && canvasObjectInvalidated(event, target)) setStale(true) })
    return () => { current = false; invalidated?.(); changed?.() }
  }, [client, target, retry])
  const object = target.object
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay app-dialog-overlay" />
    <AppDialogContent className="canvas-object-dialog" width="wide" onPointerDownOutside={event => event.preventDefault()}>
      <AppDialogHeader title={uiAttribute(canvasObjectNames[object.kind])} description={canvasObjectId(object)} />
      <AppDialogBody>
        {loading && <p role="status"><UiText zh="正在读取原对象…" /></p>}
        {error && <p role="alert">{error}</p>}
        {stale && <p className="canvas-notice" role="status"><UiText zh="对象可能已变化，请重新读取后再操作。" /></p>}
        {value?.kind === 'task' && <article className="canvas-object-details" data-task-id={value.task.taskId}>
          <h2>{value.task.title}</h2><p>{value.task.description}</p>
          <p>{uiAttribute(({ pending: '待处理', in_progress: '进行中', blocked: '已阻塞', completed: '已完成', cancelled: '已取消' } as const)[value.task.status])}</p>
          {value.task.blockedReason && <p>{value.task.blockedReason}</p>}
          {value.task.completionSummary && <p>{value.task.completionSummary}</p>}
          {value.task.cancelReason && <p>{value.task.cancelReason}</p>}
        </article>}
        {value && value.kind !== 'task' && <article className="canvas-object-details" data-mission-id={value.mission.missionId}>
          <h2>{value.mission.title}</h2><p>{value.mission.description}</p>
          {object.kind === 'mission_diff' && value.kind === 'mission_diff' && (missionChangesVisible(value.delivery.git, value.delivery.workspace?.state ?? null)
            ? <MissionChanges key={`${value.delivery.workspace?.id}:${value.delivery.workspace?.baseSha}:${retry}`} mission={value.mission} baseSha={value.delivery.workspace?.baseSha ?? null}
              initiallyExpanded initialPath={object.path} />
            : <p role="status"><UiText zh="当前使命尚无可用的 Git 工作区。" /></p>)}
        </article>}
      </AppDialogBody>
      <AppDialogFooter>
        <button type="button" className="quiet-button" disabled={loading} onClick={() => setRetry(count => count + 1)}><UiText zh="重新读取" /></button>
        {onOpenWorkspace && object.kind !== 'mission_diff' && <button type="button" className="primary-button conversation-primary-button" disabled={loading || !value || stale}
          onClick={() => onOpenWorkspace(target)}><UiText zh="在工作区中操作" /></button>}
        <button type="button" className="quiet-button" onClick={onClose}><UiText zh="关闭" /></button>
      </AppDialogFooter>
    </AppDialogContent>
  </Dialog.Portal></Dialog.Root>
}
