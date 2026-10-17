import { useRef, useSyncExternalStore } from 'react'
import type { PrivateUploadController } from './private-upload-controller'
import { UiText, uiAttribute } from './interface-language'

export function privateUploadErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  if (code === 'private_upload.source_changed') return uiAttribute('原文件或文件夹已变化，不能作为原请求重试。原输入仍保留。')
  if (code === 'private_upload.reselect_required') return uiAttribute('原文件字节当前不可用，请重选原文件并核对后重试。')
  if (code === 'private_upload.capability_required') return uiAttribute('当前连接尚不支持文件上传恢复，请升级后重试。')
  if (code === 'private_upload.context_changed') return uiAttribute('文件仍属于原来的输入位置，请回到原位置恢复。')
  return uiAttribute('文件准备结果尚未确认。请先核对原请求，确认后再继续。')
}

export function PrivateUploadRecoveryPanel({ controller, reselect = false }: { controller: PrivateUploadController; reselect?: boolean }): React.JSX.Element | null {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const fileInput = useRef<HTMLInputElement>(null)
  const selection = useRef<{ controller: PrivateUploadController; id: string } | null>(null)
  if (!state.rows.length && !state.error) return null
  const perform = (operation: Promise<void>): void => { void operation.catch(() => undefined) }
  return <section className="single-chat-retained-inputs" aria-label={uiAttribute('文件上传恢复')}>
    {reselect && <input ref={fileInput} type="file" className="composer-file-input" tabIndex={-1} onChange={event => {
      const file = event.currentTarget.files?.[0], original = selection.current
      event.currentTarget.value = ''; selection.current = null
      if (file && original) perform(original.controller.retry(original.id, file))
    }} />}
    {state.error && <p role="alert">{privateUploadErrorMessage(state.error)} <button type="button" onClick={() => perform(controller.load())}><UiText zh="重新读取文件准备记录" /></button></p>}
    {state.rows.map(row => <div key={row.request.commandId} className="single-chat-scoped-file">
      <span title={row.displayName}>{row.displayName}</span>
      {row.state === 'rejected' ? <>
        <span role="status"><UiText zh={row.error?.message === 'attachment.upload_preparation_ended' ? '已结束文件准备，当前输入已保留。' : '文件未添加，当前输入已保留。'} /></span>
        <button type="button" onClick={() => controller.dismiss(row.request.commandId)}><UiText zh="关闭提示" /></button>
      </> : <>
        <span role="status"><UiText zh={row.state === 'preparing' ? '正在准备文件…' : '正在保留原文件准备请求。'} /></span>
        <button type="button" onClick={() => perform(controller.recover(row.request.commandId))}><UiText zh="核对原上传结果" /></button>
        {row.state !== 'preparing' && <button type="button" onClick={() => perform(controller.retry(row.request.commandId))}><UiText zh="明确重试原文件" /></button>}
        {controller.canFinish && row.state !== 'preparing' && <button type="button" onClick={() => perform(controller.finish(row.request.commandId))}><UiText zh="结束这次文件准备" /></button>}
        {reselect && row.state !== 'preparing' && <button type="button" onClick={() => {
          selection.current = { controller, id: row.request.commandId }; fileInput.current?.click()
        }}><UiText zh="重选原文件并重试" /></button>}
      </>}
      {row.error && row.state !== 'rejected' && <p role="alert">{privateUploadErrorMessage(row.error)}</p>}
    </div>)}
  </section>
}
