import { isThreadId, type LocalAttachmentOwnerLocator, type SingleChatComposerScope } from '@contracts'

export type PrivateAttachmentLocator = Extract<LocalAttachmentOwnerLocator, {
  owner: 'single_chat_scoped_composer' | 'single_chat_scoped_pending_edit' | 'single_chat_retained'
}>
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const id = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const fields = (value: Record<string, unknown>, names: string[]): boolean => Object.keys(value).sort().join(',') === names.sort().join(',')
const invalid = (): never => { throw new Error('Unsupported private attachment locator') }
function scope(value: unknown): SingleChatComposerScope {
  if (!object(value) || !fields(value, ['kind', 'boardId', 'nodeId']) || value.kind !== 'canvas' || !id(value.boardId) || !id(value.nodeId)) return invalid()
  return { kind: 'canvas', boardId: value.boardId, nodeId: value.nodeId }
}

/** 只解析位置；可信编辑端和实际材料归属仍由 Core 核对。旧 owner 不在此升级或改写。 */
export function parsePrivateAttachmentLocator(value: unknown): PrivateAttachmentLocator | null {
  if (object(value) && ['single_chat_composer', 'single_chat_pending_edit', 'single_chat_pending', 'single_chat_message'].includes(String(value.owner))
    && ['composerScope', 'scopeKey', 'clientId'].some(key => Object.hasOwn(value, key))) return invalid()
  if (!object(value) || !['single_chat_scoped_composer', 'single_chat_scoped_pending_edit', 'single_chat_retained'].includes(String(value.owner))) return null
  const common = ['owner', 'threadId', 'conversationId', 'composerScope', 'attachmentRefId']
  if (!isThreadId(value.threadId) || !id(value.conversationId) || !id(value.attachmentRefId)) return invalid()
  const base = { threadId: value.threadId, conversationId: value.conversationId, attachmentRefId: value.attachmentRefId }
  if (value.owner === 'single_chat_scoped_composer') {
    if (!fields(value, common)) return invalid()
    return { ...base, owner: value.owner, composerScope: scope(value.composerScope) }
  }
  if (value.owner === 'single_chat_scoped_pending_edit') {
    if (!fields(value, [...common, 'pendingInputId', 'editToken']) || !id(value.pendingInputId) || !id(value.editToken)) return invalid()
    return { ...base, owner: value.owner, composerScope: scope(value.composerScope), pendingInputId: value.pendingInputId, editToken: value.editToken }
  }
  if (!fields(value, [...common, 'retainedInputId']) || !id(value.retainedInputId)) return invalid()
  return { ...base, owner: 'single_chat_retained', composerScope: value.composerScope === null ? null : scope(value.composerScope), retainedInputId: value.retainedInputId }
}

export function privateAttachmentOwnerKey(locator: LocalAttachmentOwnerLocator): string | null {
  if (locator.owner !== 'single_chat_scoped_composer' && locator.owner !== 'single_chat_scoped_pending_edit' && locator.owner !== 'single_chat_retained') return null
  const position = locator.composerScope ? [locator.composerScope.boardId, locator.composerScope.nodeId] : null
  return JSON.stringify([locator.owner, locator.threadId, locator.conversationId, position,
    locator.owner === 'single_chat_retained' ? locator.retainedInputId : locator.owner === 'single_chat_scoped_pending_edit' ? [locator.pendingInputId, locator.editToken] : null])
}
