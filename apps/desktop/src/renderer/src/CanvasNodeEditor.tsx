import { useRef, useState, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { AgentProfile, CanvasConversationRef, CanvasNode, CanvasNodeInput, CanvasNodeKind, CanvasNodeMutation, CanvasObjectReference, CanvasThreadReference } from '@contracts'
import { CanvasObjectPicker } from './CanvasObjectPicker'
import { canvasObjectNames, type CanvasObjectTarget } from './canvas-object'
import { AppDialogBody, AppDialogContent, AppDialogFooter, AppDialogHeader } from './AppDialog'
import { CARD_HEIGHT, CARD_WIDTH, FILE_CARD_HEIGHT, FILE_CARD_WIDTH, TERMINAL_CARD_HEIGHT, TERMINAL_CARD_WIDTH,
  canvasReferenceKey, isRegionKind, regionHeightForRows, regionWidthForColumns } from './canvas-layout'
import { UiText, uiAttribute } from './interface-language'
import { readErrorMessage } from './error-message'

export const canvasKindNames: Record<CanvasNodeKind, string> = {
  folder: '工程区域', group: '项目分组', agent: '队员区域', conversation: '对话', custom: '自定义分组', note: '便签', file: '文件', terminal: '终端'
}
export const canvasColors = ['neutral', 'zinc', 'slate', 'stone', 'gray', 'red', 'rose', 'orange', 'green', 'blue', 'yellow', 'violet'] as const
const colorNames = ['默认', '锌灰', '蓝灰', '石灰', '灰色', '红色', '玫瑰', '橙色', '绿色', '蓝色', '黄色', '紫色']
export const canvasColorName = (color: string): string => colorNames[canvasColors.indexOf(color as typeof canvasColors[number])] ?? color
export interface CanvasReferenceOption { reference: CanvasConversationRef; label: string; available?: boolean }
export interface CanvasFolderGroupOption { id: string; label: string; color?: string | null; projectPaths?: readonly string[] }
export type CanvasEditTarget = { type: 'create'; position: { x: number; y: number }; kind?: CanvasNodeKind } | { type: 'update' | 'bind_file'; row: CanvasNode }

export function CanvasNodeEditor({ target, revision, latestRevision, agents, groups, references, referencesComplete, objectReferencesSupported = false, fileReferencesSupported = false, objectThreads = [], onRefreshReferences, blocked, pending, recovery, commandError, onClose, onSave }: {
  target: CanvasEditTarget
  revision: number
  latestRevision: number | null
  agents: AgentProfile[]
  groups: CanvasFolderGroupOption[]
  references: CanvasReferenceOption[]
  referencesComplete: boolean
  objectReferencesSupported?: boolean
  fileReferencesSupported?: boolean
  objectThreads?: readonly CanvasThreadReference[]
  onRefreshReferences?(): void
  blocked: boolean
  pending: boolean
  recovery: ReactNode
  commandError: string | null
  onClose(): void
  onSave(mutation: CanvasNodeMutation, expectedRevision: number): Promise<void>
}): React.JSX.Element {
  const original = target.type !== 'create' ? target.row : null, bindingOnly = target.type === 'bind_file'
  const [kind, setKind] = useState<CanvasNodeKind>(original?.data.kind ?? (target.type === 'create' ? target.kind : undefined) ?? 'note')
  const [objectKind, setObjectKind] = useState<CanvasObjectReference['kind'] | null>(original?.data.objectReference?.kind ?? null)
  const [objectTarget, setObjectTarget] = useState<CanvasObjectTarget | null>(null)
  const [fileThreadId, setFileThreadId] = useState('')
  const fileThread = objectThreads.find(thread => thread.threadId === fileThreadId && thread.projectBindingKind === 'directory')
  const [title, setTitle] = useState(original?.data.title ?? ''), [content, setContent] = useState(original?.data.content ?? '')
  const [color, setColor] = useState(original?.data.color ?? '')
  const [path, setPath] = useState(''), [agentId, setAgentId] = useState(''), [groupId, setGroupId] = useState('')
  const [referenceKey, setReferenceKey] = useState(''), [members, setMembers] = useState<string[]>([])
  const [columns, setColumns] = useState(original?.data.gridColumns ?? 0), [rows, setRows] = useState(original?.data.gridRows ?? 0)
  const [capturedRevision, setCapturedRevision] = useState(revision)
  const [submitting, setSubmitting] = useState(false), [error, setError] = useState<string | null>(null)
  const saving = useRef(false)
  const stale = latestRevision !== null && latestRevision !== capturedRevision
  const locked = pending || submitting
  const choices = agents.filter(agent => !agent.removedAt)
  const reference = references.find(item => canvasReferenceKey(item.reference) === referenceKey && item.available !== false)?.reference
  const availableKeys = new Set(references.filter(item => item.available !== false).map(item => canvasReferenceKey(item.reference)))
  const missingMembers = members.some(key => !availableKeys.has(key))
  const changedSelection = !original && (kind === 'custom' && missingMembers || kind === 'conversation' && !objectKind && Boolean(referenceKey) && !reference)
  const validBinding = bindingOnly ? fileReferencesSupported && Boolean(fileThread) : Boolean(original) || kind === 'note' || kind === 'custom' && !missingMembers
    || (kind === 'folder' || kind === 'terminal') && Boolean(path.trim())
    || kind === 'file' && Boolean(path) && fileReferencesSupported && Boolean(fileThread)
    || kind === 'agent' && choices.some(agent => agent.agentId === agentId)
    || kind === 'group' && groups.some(group => group.id === groupId)
    || kind === 'conversation' && (objectKind ? objectReferencesSupported && Boolean(objectTarget) : Boolean(reference))
  const close = () => { if (!locked) onClose() }
  const save = async () => {
    if (saving.current || locked || blocked || !validBinding || stale) return
    saving.current = true
    setSubmitting(true); setError(null)
    try {
      let mutation: CanvasNodeMutation
      if (bindingOnly && original) mutation = { type: 'bind_file', nodeId: original.id, threadId: fileThread!.threadId }
      else if (original) {
        // Bindings are immutable. A note edit never resubmits geometry captured before a remote move.
        mutation = { type: 'update', nodeId: original.id, patch: { title, color,
          ...(kind === 'note' ? { content } : {}), ...(isRegionKind(kind) ? { gridColumns: columns, gridRows: rows } : {}) } }
      } else {
        const size = kind === 'conversation' ? { width: CARD_WIDTH, height: CARD_HEIGHT }
          : kind === 'file' ? { width: FILE_CARD_WIDTH, height: FILE_CARD_HEIGHT }
          : kind === 'terminal' ? { width: TERMINAL_CARD_WIDTH, height: TERMINAL_CARD_HEIGHT }
          : isRegionKind(kind) ? { width: regionWidthForColumns(columns || 2), height: regionHeightForRows(rows || 1) }
          : { width: 320, height: 220 }
        if (target.type !== 'create') throw new Error(uiAttribute('节点编辑状态已改变，请重新打开。'))
        const node: CanvasNodeInput = { kind, ...target.position, ...size, title, color,
          ...(isRegionKind(kind) ? { gridColumns: columns, gridRows: rows } : {}) }
        if (kind === 'note') node.content = content
        if (kind === 'folder') node.folderPath = path
        if (kind === 'file' || kind === 'terminal') node.path = path
        if (kind === 'file') node.fileReference = { threadId: fileThread!.threadId }
        if (kind === 'agent') node.agentId = agentId
        if (kind === 'group') node.folderGroupId = groupId
        if (kind === 'conversation') {
          node.conversation = objectKind ? { threadId: objectTarget!.threadId, conversationId: null } : reference!
          if (objectKind) node.objectReference = objectTarget!.object
        }
        if (kind === 'custom') node.conversations = references.filter(item => members.includes(canvasReferenceKey(item.reference))).map(item => item.reference)
        mutation = { type: 'create', node }
      }
      await onSave(mutation, capturedRevision)
    } catch (error) { setError(readErrorMessage(error)) } finally { saving.current = false; setSubmitting(false) }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open) close() }}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay app-dialog-overlay" />
    <AppDialogContent className="canvas-node-editor" width="wide" tone="neutral"
      onEscapeKeyDown={event => { if (locked) event.preventDefault() }} onPointerDownOutside={event => event.preventDefault()}>
      <AppDialogHeader title={uiAttribute(bindingOnly ? '绑定文件来源' : original ? '编辑画布节点' : '添加到画布')}
        description={uiAttribute('画布只保存布局和引用；删除节点不会删除工程、对话或文件。')} closeDisabled={locked} />
      <form className="app-dialog-form" onSubmit={event => { event.preventDefault(); void save() }}>
        <AppDialogBody>
          <fieldset disabled={locked} className="canvas-editor-fields">
            {!bindingOnly && <>
            {!original && <label className="field-label"><UiText zh="类型" /><select value={objectKind ?? kind} onChange={event => {
              const value = event.target.value
              const nextObject = Object.hasOwn(canvasObjectNames, value) ? value as CanvasObjectReference['kind'] : null
              setObjectKind(nextObject); setObjectTarget(null); setKind(nextObject ? 'conversation' : value as CanvasNodeKind); setError(null)
            }}>
              {(Object.keys(canvasKindNames) as CanvasNodeKind[]).map(value => <option key={value} value={value} disabled={value === 'file' && !fileReferencesSupported}>{uiAttribute(canvasKindNames[value])}</option>)}
              {(Object.keys(canvasObjectNames) as CanvasObjectReference['kind'][]).map(value => <option key={value} value={value} disabled={!objectReferencesSupported}>{uiAttribute(canvasObjectNames[value])}</option>)}
            </select></label>}
            <label className="field-label"><UiText zh="标题" /><input data-dialog-autofocus value={title} onChange={event => setTitle(event.target.value)} autoComplete="off"
              onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }} /></label>
            <div className="field-label"><span id="canvas-node-color-label"><UiText zh="标记颜色" /></span>
              {/* 沿用Codeg canvas-swatches.tsx的十二色色板与再次选色清空；许可证见integration/licenses/codeg/LICENSE。 */}
              <div className="canvas-color-palette" role="group" aria-labelledby="canvas-node-color-label">
                {canvasColors.map(value => <button key={value} type="button" data-color={value} className="canvas-color-choice"
                  aria-label={uiAttribute(canvasColorName(value))} title={uiAttribute(canvasColorName(value))} aria-pressed={color === value}
                  onClick={() => setColor(color === value ? '' : value)}><span className="canvas-color-dot" /></button>)}
              </div>
            </div>
            {!original && (kind === 'folder' || kind === 'file' || kind === 'terminal') && <label className="field-label">
              <UiText zh={kind === 'file' ? '文件绝对路径' : '工作目录绝对路径'} /><input value={path} onChange={event => setPath(event.target.value)} autoComplete="off" spellCheck={false} />
            </label>}
            {!original && kind === 'agent' && <label className="field-label"><UiText zh="队员" /><select value={agentId} onChange={event => setAgentId(event.target.value)}>
              <option value="">{uiAttribute('请选择')}</option>{choices.map(agent => <option key={agent.agentId} value={agent.agentId}>{agent.displayName}</option>)}
            </select></label>}
            {!original && kind === 'group' && <label className="field-label"><UiText zh="项目分组" /><select value={groupId} onChange={event => setGroupId(event.target.value)}>
              <option value="">{uiAttribute(groups.length ? '请选择' : '暂无项目分组')}</option>{groups.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}
            </select></label>}
            {!original && kind === 'conversation' && !objectKind && <label className="field-label"><UiText zh="对话" /><select value={referenceKey} onChange={event => setReferenceKey(event.target.value)}>
              <option value="">{uiAttribute('请选择')}</option>{references.map(item => <option key={canvasReferenceKey(item.reference)} value={canvasReferenceKey(item.reference)} disabled={item.available === false}>{item.label}</option>)}
            </select></label>}
            {!original && objectKind && <CanvasObjectPicker key={objectKind} kind={objectKind} threads={objectThreads} complete={referencesComplete} onChange={setObjectTarget} />}
            {!original && kind === 'custom' && <div className="canvas-editor-members" role="group" aria-label={uiAttribute('分组内的对话')}>
              {references.map(item => { const key = canvasReferenceKey(item.reference); return <label key={key}>
                <input type="checkbox" checked={members.includes(key)} disabled={!members.includes(key) && members.length >= 200}
                  onChange={event => setMembers(current => event.target.checked ? [...current, key] : current.filter(value => value !== key))} />{item.label}
              </label> })}
            </div>}
            {kind === 'note' && <label className="field-label"><UiText zh="便签内容（支持 Markdown）" />
              <textarea rows={8} value={content} onChange={event => setContent(event.target.value)} />
            </label>}
            {original && <p className="canvas-binding-summary"><UiText zh={objectKind ? canvasObjectNames[objectKind] : canvasKindNames[kind]} /> · {original.data.path || original.data.folderPath || original.data.title || uiAttribute('保留原有绑定')}</p>}
            {isRegionKind(kind) && <div className="canvas-grid-fields">
              <label className="field-label"><UiText zh="固定列数（0 为自动）" /><input type="number" min={0} max={12} step={1} value={columns} onChange={event => setColumns(Math.max(0, Math.min(12, Math.round(Number(event.target.value) || 0))))} /></label>
              <label className="field-label"><UiText zh="固定行数（0 为自动）" /><input type="number" min={0} max={12} step={1} value={rows} onChange={event => setRows(Math.max(0, Math.min(12, Math.round(Number(event.target.value) || 0))))} /></label>
            </div>}
            </>}
            {(bindingOnly || !original && kind === 'file') && <>
              {bindingOnly && <code className="canvas-binding-summary">{original?.data.path}</code>}
              <label className="field-label"><UiText zh="所属工程对话" /><select value={fileThreadId} onChange={event => setFileThreadId(event.target.value)}>
                <option value="">{uiAttribute('请选择')}</option>{objectThreads.filter(thread => thread.projectBindingKind === 'directory').map(thread => <option key={thread.threadId} value={thread.threadId}>{thread.title}</option>)}
              </select></label>
              <p className="canvas-empty-copy"><UiText zh="来源绑定后保持不变；实际读取仍由原文件权限检查。" /></p>
              {!referencesComplete && <p className="canvas-notice"><UiText zh="对话清单尚未完整载入，当前结果仍在核对。" /></p>}
            </>}
          </fieldset>
          {changedSelection && <p role="alert"><UiText zh="所选对话已结束或不可用，请重新选择。" />
            {kind === 'custom' && <button type="button" disabled={locked} onClick={() => setMembers(current => current.filter(key => availableKeys.has(key)))}><UiText zh="移除失效选择" /></button>}
          </p>}
          {!original && (kind === 'conversation' && !objectKind || kind === 'custom') && !referencesComplete && <p className="canvas-notice"><UiText zh="对话清单尚未完整载入，当前结果仍在核对。" />
            {onRefreshReferences && <button type="button" onClick={onRefreshReferences}><UiText zh="重新载入对话" /></button>}
          </p>}
          {stale && <p className="canvas-notice"><UiText zh="画布已更新，输入仍保留。核对后可按最新画布版本保存。" />
            <button type="button" disabled={locked || blocked} onClick={() => { setCapturedRevision(latestRevision!); setError(null) }}><UiText zh="使用最新画布版本" /></button>
          </p>}
          {(commandError || error) && <p role="alert">{commandError || error}</p>}{recovery}
        </AppDialogBody>
        <AppDialogFooter>
          <button className="quiet-button" type="button" disabled={locked} onClick={close}><UiText zh="取消" /></button>
          <button className="primary-button conversation-primary-button" type="submit" disabled={blocked || locked || stale || !validBinding}>
            <UiText zh={locked ? '保存中…' : bindingOnly ? '绑定来源' : '保存'} />
          </button>
        </AppDialogFooter>
      </form>
    </AppDialogContent>
  </Dialog.Portal></Dialog.Root>
}
