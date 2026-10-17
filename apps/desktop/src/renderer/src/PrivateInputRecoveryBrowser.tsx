import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { AppDialogBody, AppDialogContent, AppDialogHeader } from './AppDialog'
import { useThreadClient } from './camp-client'
import { readCanvasViewScope } from './canvas-view-state'
import type { PrivateInputController } from './private-input-controller'
import { PrivateInputRecoveryCatalog, type PrivateRecoveryLocation } from './private-input-recovery-catalog'
import { privateInputErrorMessage } from './PrivateInputRecoveryPanel'
import type { ThreadLeavePreparation } from './ThreadWorkspace'
import { UiText, uiAttribute } from './interface-language'

type Guard = () => ThreadLeavePreparation
function Locations({ catalog, controller, busy, onSelect, onError }: {
  catalog: PrivateInputRecoveryCatalog; controller: PrivateInputController; busy: boolean
  onSelect(location: PrivateRecoveryLocation): void; onError(error: unknown): void
}): React.JSX.Element {
  const state = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot)
  const [copied, setCopied] = useState(false)
  const read = (restart: boolean): void => { void catalog.read(restart).catch(onError) }
  return <>
    {state.error && <p role="alert">{privateInputErrorMessage(state.error)}</p>}
    {!state.locations.length && !state.loading && <p><UiText zh="尚未找到其他位置的输入。原记录不会因此删除。" /></p>}
    {state.locations.map((location, index) => <section className="single-chat-retained-inputs private-input-recovery-location" key={location.id}>
      <strong><UiText zh={location.scope?.orphaned ? '原卡片已删除的输入' : location.context ? '卡片输入' : '默认输入'} /> {index + 1}</strong>
      {location.scope && <>
        <p>{uiAttribute('附件 {0} · 引用 {1} · 保留输入 {2}', String(location.scope.attachmentCount), String(location.scope.quoteCount), String(location.scope.retainedInputCount))}</p>
        <button type="button" disabled={busy} onClick={() => onSelect(location)}><UiText zh="在原位置继续编辑" /></button>
      </>}
      {!location.scope && <p><UiText zh="这里只找到本机正文。原卡片尚未登记或暂不可用，可重新固定卡片，或保留正文副本。" /></p>}
      {location.bodies.map(copy => <details key={copy.key}>
        <summary><UiText zh="本机正文副本（不含附件和引用）" /></summary>
        <pre className="single-chat-pending-copy">{copy.body}</pre>
        <button type="button" disabled={busy} onClick={() => {
          try { controller.retainBodyCopy(copy.body); setCopied(true) } catch (error) { onError(error) }
        }}><UiText zh="在当前输入中保留正文副本" /></button>
      </details>)}
    </section>)}
    {copied && <p role="status"><UiText zh="正文副本已保留，原输入未改动。" /></p>}
    {!state.complete && <p><UiText zh="列表尚未读完整，未显示的输入仍保留。" /></p>}
    <button type="button" disabled={busy || state.loading} onClick={() => read(true)}><UiText zh="重新读取恢复列表" /></button>
    {state.nextCursor && <button type="button" disabled={busy || state.loading} onClick={() => read(false)}><UiText zh="继续读取恢复列表" /></button>}
  </>
}

export function PrivateInputRecoveryBrowser({ controller, busy, enabled, onLeaveGuardChange, renderEditor }: {
  controller: PrivateInputController; busy: boolean; enabled: boolean
  onLeaveGuardChange(guard: Guard | null): void
  renderEditor(location: PrivateRecoveryLocation, close: () => void, bindGuard: (guard: Guard | null) => void, leaving: boolean): ReactNode
}): React.JSX.Element {
  const client = useThreadClient()
  const [session, setSession] = useState<{ client: typeof client; controller: PrivateInputController; catalog: PrivateInputRecoveryCatalog } | null>(null)
  const [open, setOpen] = useState(false)
  const [readingOwner, setReadingOwner] = useState<PrivateInputController | null>(null)
  const reading = readingOwner === controller
  const [selection, setSelection] = useState<PrivateRecoveryLocation | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const childGuard = useRef<Guard | null>(null)
  const owner = useRef({ client, controller }); owner.current = { client, controller }
  const isCurrent = () => owner.current.client === client && owner.current.controller === controller
  const current = session?.client === client && session.controller === controller ? session : null
  const selected = current && open ? selection : null
  const bindGuard = useCallback((guard: Guard | null) => { childGuard.current = guard }, [])
  const prepare = useCallback((): ThreadLeavePreparation => {
    if (selected && !childGuard.current) throw new Error('private_input.busy')
    const child = selected ? childGuard.current!() : null
    setLeaving(true)
    let finished = false
    return { complete(didLeave) { if (finished) return; finished = true; child?.complete(didLeave); if (!didLeave) setLeaving(false) } }
  }, [selected])
  useLayoutEffect(() => { onLeaveGuardChange(prepare); return () => onLeaveGuardChange(null) }, [onLeaveGuardChange, prepare])
  const showError = (value: unknown): void => { if (isCurrent()) setError(privateInputErrorMessage(value)) }
  const close = (): void => {
    try { const preparation = prepare(); setOpen(false); setSelection(null); preparation.complete(true); setLeaving(false) }
    catch (error) { showError(error) }
  }
  const launch = async (): Promise<void> => {
    setReadingOwner(controller); setError(null)
    try {
      const view = await readCanvasViewScope(client)
      if (!isCurrent()) return
      if (!view) throw new Error('private_input.context_changed')
      const catalog = new PrivateInputRecoveryCatalog(client, controller.origin, view)
      setSelection(null); setSession({ client, controller, catalog }); setOpen(true)
      await catalog.read()
    } catch (error) { showError(error) }
    finally { setReadingOwner(previous => previous === controller ? null : previous) }
  }
  return <>
    <button type="button" className="single-chat-recovery-trigger" disabled={!enabled || busy || reading || leaving} onClick={() => { void launch() }}><UiText zh="查找保留的其他输入" /></button>
    {error && <p role="alert">{error}</p>}
    <Dialog.Root open={Boolean(open && current && enabled)} onOpenChange={value => { if (!value) close() }}>
      <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><AppDialogContent width="large" tone="neutral">
        <AppDialogHeader title={<UiText zh="恢复保留的输入" />} description={<UiText zh="按原位置恢复完整输入。正文副本单独保留，不借用其他卡片的材料。" />} closeDisabled={leaving} />
        <AppDialogBody>
          {error && <p role="alert">{error}</p>}
          {selected ? <>
            <button type="button" disabled={leaving} onClick={() => {
              try { const preparation = prepare(); setSelection(null); preparation.complete(true); setLeaving(false) } catch (error) { showError(error) }
            }}><UiText zh="返回恢复列表" /></button>
            <div className="private-input-recovery-editor" inert={leaving}>{renderEditor(selected, close, bindGuard, leaving)}</div>
          </> : current && <Locations catalog={current.catalog} controller={controller} busy={busy || leaving} onSelect={setSelection} onError={showError} />}
        </AppDialogBody>
      </AppDialogContent></Dialog.Portal>
    </Dialog.Root>
  </>
}
