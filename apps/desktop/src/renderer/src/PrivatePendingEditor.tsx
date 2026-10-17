import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { SingleChatPendingInputEditSessionView, SingleChatPendingInputView } from '@contracts'
import type { PrivateInputController } from './private-input-controller'
import type { SingleChatComposerStore } from './single-chat-composer-store'
import { privateInputErrorMessage } from './PrivateInputRecoveryPanel'
import { PrivateUploadRecoveryPanel, privateUploadErrorMessage } from './PrivateUploadRecoveryPanel'
import { privateUploadController } from './private-upload-controller'
import { useThreadClient } from './camp-client'
import { UiText, uiAttribute } from './interface-language'
import { AttachmentCard } from './AttachmentCard'

export function PrivatePendingEditor({ item, session, controller, bodies, busy, onError }: {
  item: SingleChatPendingInputView
  session: SingleChatPendingInputEditSessionView
  controller: PrivateInputController
  bodies: SingleChatComposerStore
  busy: boolean
  onError(message: string): void
}): React.JSX.Element {
  const client = useThreadClient()
  const fileInput = useRef<HTMLInputElement>(null)
  const uploads = useMemo(() => privateUploadController(client.singleChatAttachments,
    { threadId: controller.origin.threadId, conversationId: controller.origin.conversationId, composerScope: controller.origin.scope },
    { kind: 'single_chat_pending', conversationId: controller.origin.conversationId, pendingInputId: item.id,
      editToken: session.editToken, ...(controller.origin.scope ? { composerScope: controller.origin.scope } : {}) }),
    [client, controller, item.id, session.editToken])
  const uploadState = useSyncExternalStore(uploads.subscribe, uploads.getSnapshot, uploads.getSnapshot)
  const uploadBusy = uploads.supported && (!uploadState.loaded || uploadState.rows.some(row => row.state !== 'rejected'))
  useEffect(() => { if (uploads.supported) void uploads.load().catch(() => undefined) }, [uploads])
  useEffect(() => {
    if (uploadState.applied) void controller.refresh().catch(error => onError(privateInputErrorMessage(error)))
  }, [controller, uploadState.applied])
  const state = useSyncExternalStore(bodies.subscribe, bodies.getSnapshot, bodies.getSnapshot)
  const key = `${controller.origin.threadId}:${controller.origin.conversationId}:pending-edit:${session.editToken}`
  const body = state.drafts[key] ?? session.workingBody
  const perform = (operation: Promise<void>): void => { void operation.catch(error => onError(privateInputErrorMessage(error))) }
  return <div className="single-chat-pending-editor">
    <label><UiText zh="编辑排队消息正文" />
      <textarea value={body} readOnly={busy || session.recoveryRequired} aria-label={uiAttribute('编辑排队消息正文')}
        onChange={event => {
          if (!bodies.update(current => ({ ...current, [key]: event.target.value }))) return
          try { controller.rememberBody(key) } catch (error) { onError(privateInputErrorMessage(error)) }
        }} />
    </label>
    {session.workingAttachments.length > 0 && <div className="single-chat-pending-attachments">{session.workingAttachments.map(attachment => <AttachmentCard
      key={attachment.id} attachment={attachment} disabled={busy || uploadBusy || session.recoveryRequired}
      locator={controller.origin.scope ? { owner: 'single_chat_scoped_pending_edit', threadId: controller.origin.threadId,
        conversationId: controller.origin.conversationId, composerScope: controller.origin.scope,
        pendingInputId: item.id, editToken: session.editToken, attachmentRefId: attachment.id }
        : { owner: 'single_chat_pending_edit', threadId: controller.origin.threadId, conversationId: controller.origin.conversationId,
          pendingInputId: item.id, editToken: session.editToken, attachmentRefId: attachment.id }}
      onNotify={onError} onRemove={() => perform(controller.edit(item, { type: 'remove_attachment', attachmentRefId: attachment.id }, session.editToken))} />)}</div>}
    {session.workingQuotes.map(quote => <blockquote key={quote.quoteId}>{quote.text}</blockquote>)}
    {uploads.supported && <>
      <input ref={fileInput} className="composer-file-input" type="file" tabIndex={-1} onChange={event => {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ''
        if (!file || busy || uploads.blocked || session.recoveryRequired) return
        void uploads.prepare(item.revision, file).catch(error => onError(privateUploadErrorMessage(error)))
      }} />
      <button type="button" disabled={busy || uploadBusy || session.recoveryRequired} onClick={() => fileInput.current?.click()}><UiText zh="为排队消息添加文件" /></button>
      <PrivateUploadRecoveryPanel controller={uploads} reselect={client.attachments.kind === 'download'} />
    </>}
    <div className="pending-input-actions">
      {session.recoveryRequired
        ? <button type="button" disabled={busy || uploadBusy} onClick={() => perform(controller.edit(item, { type: 'takeover' }, session.editToken))}><UiText zh="从已保存版本接管" /></button>
        : <button type="button" disabled={busy || uploadBusy || Boolean(state.error)} onClick={() => perform(controller.edit(item, { type: 'save', body }, session.editToken))}><UiText zh="保存排队消息" /></button>}
      <button type="button" disabled={busy || uploadBusy} onClick={() => perform(controller.edit(item, { type: 'cancel' }, session.editToken))}><UiText zh="放弃本次编辑" /></button>
    </div>
  </div>
}
