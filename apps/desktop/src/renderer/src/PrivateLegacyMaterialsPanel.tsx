import { useRef, useState } from 'react'
import type { ScopedSingleChatSnapshot } from '@contracts'
import { readScopedPrivateChat } from '../../shared/private-composer-scope'
import { useThreadClient } from './camp-client'
import type { PrivateInputController } from './private-input-controller'
import { privateInputErrorMessage } from './PrivateInputRecoveryPanel'
import { UiText, uiAttribute } from './interface-language'

/** 先展示同编辑端默认材料，再由用户明确迁入；正文不参与移动。 */
export function PrivateLegacyMaterialsPanel({ controller, busy, onError }: {
  controller: PrivateInputController; busy: boolean; onError(message: string): void
}): React.JSX.Element | null {
  const client = useThreadClient()
  const [preview, setPreview] = useState<{ controller: PrivateInputController; snapshot: ScopedSingleChatSnapshot | null } | null>(null)
  const [readingOwner, setReadingOwner] = useState<PrivateInputController | null>(null)
  const reading = readingOwner === controller
  const owner = useRef({ client, controller }); owner.current = { client, controller }
  const current = () => owner.current.client === client && owner.current.controller === controller
  const source = preview?.controller === controller ? preview.snapshot : null
  if (!controller.origin.scope) return null
  const inspect = async (): Promise<void> => {
    setReadingOwner(controller)
    try { const snapshot = await readScopedPrivateChat(client, controller.origin.threadId, controller.origin.conversationId, null); if (current()) setPreview({ controller, snapshot }) }
    catch (error) { if (current()) onError(privateInputErrorMessage(error)) }
    finally { setReadingOwner(previous => previous === controller ? null : previous) }
  }
  const adopt = async (): Promise<void> => {
    if (!source) return
    try { await controller.adoptLegacyMaterials(source.draft.revision); if (current()) setPreview(null) }
    catch (error) { if (current()) onError(privateInputErrorMessage(error)) }
  }
  return <section className="single-chat-retained-inputs private-legacy-materials" data-expanded={Boolean(source)} aria-label={uiAttribute('迁入默认输入的材料')}>
    <button type="button" disabled={busy || reading} onClick={() => { void inspect() }}><UiText zh="查看默认输入的旧材料" /></button>
    {source && <>
      <p><UiText zh="只迁入附件和引用，默认输入的正文保留。当前卡片已有内容时，材料另存为一份完整输入。" /></p>
      <ul>{source.draft.attachments.map(item => <li key={item.id}>{item.displayName}</li>)}</ul>
      {source.draft.quotes.map(quote => <blockquote key={quote.quoteId}>{quote.text}</blockquote>)}
      {!source.draft.attachments.length && !source.draft.quotes.length && <p><UiText zh="未看到附件和引用；迁入时也会保留原引用记录。" /></p>}
      <button type="button" disabled={busy || reading} onClick={() => { void adopt() }}><UiText zh="确认迁入这张卡片" /></button>
    </>}
  </section>
}
