import { useId, useState } from 'react'
import type { PrivateInputController, PrivateInputState } from './private-input-controller'
import { UiText, uiAttribute } from './interface-language'
import { AttachmentCard } from './AttachmentCard'
import { readErrorMessage } from './error-message'

export function privateInputErrorMessage(error: unknown): string {
  const code = readErrorMessage(error, '')
  if (code === 'attachment_missing' || code === 'single_chat.attachment_missing') return uiAttribute('附件文件已被移动或删除，请重新选择文件；当前输入已保留。')
  if (code === 'single_chat.draft_changed' || code === 'single_chat.retained_changed') return uiAttribute('输入材料刚刚发生变化，请重新读取后再试。')
  if (code === 'single_chat.pending_input_changed') return uiAttribute('这条排队消息刚刚发生变化，请重试。')
  if (code === 'single_chat.no_legacy_materials') return uiAttribute('默认输入中没有可迁入的材料，原输入已保留。')
  if (code === 'single_chat.attachment_source_changed') return uiAttribute('原材料文件已变化或不可读，请重新选择；当前输入已保留。')
  if (code === 'single_chat.pending_input_edit_open') return uiAttribute('请先保存或放弃这次编辑，再移回输入框。')
  if (code === 'single_chat.scope_capability_required' || code === 'single_chat.capability_required') return uiAttribute('当前版本暂不支持完整输入恢复，请升级后重试。')
  if (code === 'private_input.body_not_saved') return uiAttribute('输入尚未完成本机保存，原请求结果已保留。')
  if (code === 'private_input.recovery_invalid') return uiAttribute('本机恢复记录暂不可用，原内容已保留。')
  if (code === 'private_input.context_changed' || code === 'single_chat.scope_unavailable') return uiAttribute('原单聊暂不可用，请重新读取，不能新建替代对话。')
  return uiAttribute('输入操作未完成，内容已保留。请恢复原请求或重新读取。')
}

export function PrivateInputRecoveryPanel({ controller, state, busy, onError }: {
  controller: PrivateInputController
  state: PrivateInputState
  busy: boolean
  onError(message: string): void
}): React.JSX.Element | null {
  const selectId = useId()
  const [selection, setSelection] = useState('')
  const selected = state.retained.find(input => input.id === selection) ?? state.retained[0]
  const perform = (operation: Promise<void>): void => { void operation.catch(error => onError(privateInputErrorMessage(error))) }
  if (!state.pending && !state.retained.length && !state.nextCursor && state.complete) return null
  return <section className="single-chat-retained-inputs" aria-label={uiAttribute('完整输入恢复')}>
    {state.pending && <div className="single-chat-error" role="status">
      <span><UiText zh="输入正在交接，正文、附件和引用均已保留。" /></span>
      <button type="button" onClick={() => perform(controller.recover())}><UiText zh="恢复原请求" /></button>
      {state.unknown && <button type="button" onClick={() => perform(controller.retry())}><UiText zh="明确重试原请求" /></button>}
    </div>}
    {state.error && <p role="alert">{privateInputErrorMessage(state.error)}</p>}
    {selected && <div>
      <label htmlFor={selectId}><UiText zh="保留的完整输入" /></label>
      <select id={selectId} value={selected.id} disabled={busy || state.pending} onChange={event => setSelection(event.target.value)}>
        {state.retained.map(input => <option key={input.id} value={input.id}>{input.body.slice(0, 36) || uiAttribute('附件消息 · {0}', String(input.attachments.length))}</option>)}
      </select>
      <button type="button" disabled={busy || state.pending || !state.snapshot} onClick={() => perform(controller.swap(selected))}><UiText zh="切换完整输入" /></button>
      <details>
        <summary><UiText zh="查看保留的正文、附件和引用" /></summary>
        <pre className="single-chat-pending-copy">{selected.body}</pre>
        {selected.attachments.length > 0 && <div className="single-chat-pending-attachments">{selected.attachments.map(attachment => <AttachmentCard
          key={attachment.id} attachment={attachment} presentation="user-timeline" disabled={busy || state.pending}
          locator={{ owner: 'single_chat_retained', threadId: controller.origin.threadId,
            conversationId: controller.origin.conversationId, composerScope: controller.origin.scope,
            retainedInputId: selected.id, attachmentRefId: attachment.id }} onNotify={onError} />)}</div>}
        {selected.quotes.map(quote => <blockquote key={quote.quoteId}>{quote.text}</blockquote>)}
      </details>
    </div>}
    {state.nextCursor && <button type="button" disabled={state.pending} onClick={() => perform(controller.readRetained(false))}><UiText zh="继续读取保留输入" /></button>}
    {!state.complete && !state.nextCursor && <button type="button" disabled={state.pending} onClick={() => perform(controller.readRetained())}><UiText zh="重新读取保留输入" /></button>}
  </section>
}
