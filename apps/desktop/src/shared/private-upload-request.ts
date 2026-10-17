import { isThreadId } from '@contracts'
import type { PrivateAttachmentPreparationRequest, PrivateAttachmentUploadTarget } from '@contracts'

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const fields = (value: Record<string, unknown>, allowed: string[], required = allowed) =>
  Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key))
const isAttachmentId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
const fail = (): never => { throw new Error('private_upload.invalid_recovery') }

export function parsePrivatePreparation(value: unknown): PrivateAttachmentPreparationRequest {
  if (!object(value) || !fields(value, ['commandId', 'threadId', 'expectedRevision', 'target'])
    || !isAttachmentId(value.commandId) || !isThreadId(value.threadId)
    || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0 || !object(value.target)) return fail()
  const target = value.target
  const pending = target.kind === 'single_chat_pending'
  if ((target.kind !== 'single_chat' && !pending) || !isAttachmentId(target.conversationId)
    || !fields(target, ['kind', 'conversationId', 'composerScope', ...(pending ? ['pendingInputId', 'editToken'] : [])],
      ['kind', 'conversationId', ...(pending ? ['pendingInputId', 'editToken'] : [])])
    || (pending && (!isAttachmentId(target.pendingInputId) || !isAttachmentId(target.editToken)))) return fail()
  let scope: PrivateAttachmentUploadTarget['composerScope']
  if (target.composerScope != null) {
    const item = target.composerScope
    if (!object(item) || !fields(item, ['kind', 'boardId', 'nodeId']) || item.kind !== 'canvas'
      || !isAttachmentId(item.boardId) || !isAttachmentId(item.nodeId)) return fail()
    scope = { kind: 'canvas', boardId: item.boardId, nodeId: item.nodeId }
  }
  return {
    commandId: value.commandId, threadId: value.threadId, expectedRevision: Number(value.expectedRevision),
    target: { kind: target.kind, conversationId: target.conversationId,
      ...(scope ? { composerScope: scope } : {}),
      ...(pending ? { pendingInputId: target.pendingInputId as string, editToken: target.editToken as string } : {})
    } as PrivateAttachmentUploadTarget
  }
}
