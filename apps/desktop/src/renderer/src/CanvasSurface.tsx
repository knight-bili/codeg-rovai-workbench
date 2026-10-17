import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Background, BackgroundVariant, Panel, NodeResizer, ReactFlow, ReactFlowProvider,
  SelectionMode, ViewportPortal, applyNodeChanges, useReactFlow, useViewport, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { AgentProfile, CanvasConversationRef, CanvasNode, CanvasNodeKind, CanvasNodeMutation, FilePreviewApi, ResolvedTheme, StoredCommandResult } from '@contracts'
import { ExternalLink, Expand, FileDiff, Flag, Folder, Folders, GitBranch, Group, LayoutGrid, ListTodo, LockKeyhole, Map as MapIcon, Maximize2, MessageSquare, Minus, MoreHorizontal, Pencil, Pin, Plus, RefreshCw, SquareTerminal, Trash2, Users } from 'lucide-react'
import { CanvasIconButton, CanvasViewportPanel } from './CanvasDock'
import { CanvasFilePreview } from './CanvasFilePreview'
import { ResourceReferenceIcon } from './FilePreviewTabIcon'
import { CanvasTerminal } from './CanvasTerminal'
import { CanvasNote } from './CanvasNote'
import type { FilePreviewContextValue } from './file-preview-controller'
import { useCanvasGraph } from './useCanvasGraph'
import { initialCanvasReferenceState, type CanvasReferenceState } from './canvas-reference-controller'
import { canvasReferenceOptions, canvasSavedReference, canvasSummaryMetadata, canvasSummaryProjectPaths, resolveCanvasRegion, type CanvasFolderResolution, type CanvasRegionResolution } from './canvas-reference-model'
import { browserCanvasStorage, loadCanvasViewState, saveCanvasViewState, CANVAS_MIN_ZOOM, CANVAS_MAX_ZOOM, type CanvasViewScope } from './canvas-view-state'
import { basePathName, BOARD_DOT_GAP, CARD_WIDTH, CARD_HEIGHT, REGION_COLLAPSED_HEIGHT,
  REGION_FOOTER_HEIGHT, REGION_HEADER_HEIGHT, REGION_PADDING, computeAlignment, computeDropHint, effectiveColumns, isRegionKind, layoutRegionGrid, noteHoldsProse,
  packLayout, regionHeightForRows, regionWidthForColumns, visibleMemberCap, columnsForRegionWidth, rowsForRegionHeight, canvasMemberKey, canvasReferenceKey, type CanvasDropHint,
  FILE_CARD_MIN_WIDTH, FILE_CARD_MIN_HEIGHT, TERMINAL_CARD_MIN_WIDTH, TERMINAL_CARD_MIN_HEIGHT, type AlignmentGuide } from './canvas-layout'
import { CanvasNodeEditor, canvasKindNames, canvasColorName, type CanvasEditTarget, type CanvasFolderGroupOption, type CanvasReferenceOption } from './CanvasNodeEditor'
import { AppDialogBody, AppDialogContent, AppDialogFooter, AppDialogHeader } from './AppDialog'
import { useThreadClient } from './camp-client'
import { UiText, uiAttribute, useInterfaceLanguage } from './interface-language'
import { readErrorMessage } from './error-message'
import { useCanvasFolders } from './useCanvasFolders'
import { canvasAbsolutePosition, canvasDropMutation, canvasGroupSelection, canvasMemberMutationSupported } from './canvas-member-interaction'
import { CanvasConversationActions, CanvasConversationFrame, type CanvasConversationBridge } from './CanvasConversationFrame'
import { canvasConversationGeometry, canvasConversationMatches, canvasMutationRemovesConversation } from './canvas-conversation'
import { canvasComposerContext } from './canvas-composer-drafts'
import { CanvasObjectDialog } from './CanvasObjectDialog'
import { canvasObjectId, canvasObjectNames, canvasObjectTarget, canvasPlainConversation, type CanvasObjectTarget } from './canvas-object'
import './canvas.css'

export type { CanvasLeaveGuard } from './canvas-leave'
import type { CanvasLeaveGuard } from './canvas-leave'
export interface CanvasSurfaceProps {
  boardId: string
  scope: CanvasViewScope | null
  agents: AgentProfile[]
  groups?: CanvasFolderGroupOption[]
  references?: CanvasReferenceOption[]
  catalog?: CanvasReferenceState
  onRefreshReferences?(): void
  folderResolutions?: ReadonlyMap<string, CanvasFolderResolution>
  resolvedMembers?: ReadonlyMap<string, { references: CanvasReferenceOption[]; complete: boolean; issue?: string }>
  theme: ResolvedTheme
  conversation?: CanvasConversationBridge
  restoreRevision?: number
  onOpenReference(reference: CanvasConversationRef): void
  onOpenObject?(target: CanvasObjectTarget): void
  onOpenMember?(agentId: string): void
  onOpenProject?(path: string): void
  fileApi?: FilePreviewApi
  onOpenFileSource?(threadId: string, ...args: Parameters<FilePreviewContextValue['open']>): ReturnType<FilePreviewContextValue['open']>
  onFileWorkspace?(threadId: string, tabId: string): Promise<void>
  onLeaveGuardChange?(guard: CanvasLeaveGuard | null): void
}
type FlowNode = Node<{ row: CanvasNode; member?: CanvasConversationRef; regionId?: string }, 'canvas-card'>
const EMPTY_ROWS: CanvasNode[] = [], EMPTY_GROUPS: CanvasFolderGroupOption[] = []
const EMPTY_CATALOG = initialCanvasReferenceState()
type Presentation = CanvasSurfaceProps & {
  terminalVersion?: number
  blocked: boolean
  noteRevision: number
  noteDirty(nodeId: string, dirty: boolean): void
  saveNote(row: CanvasNode, text: string, revision: number): Promise<void>
  selectedReferences: ReadonlySet<string>
  dropTargetId: string | null
  expandedRegions: ReadonlySet<string>
  title(reference: CanvasConversationRef): string
  available(reference: CanvasConversationRef): boolean | undefined
  collapse(row: CanvasNode): void
  expand(row: CanvasNode): void
  detach(row: CanvasNode, reference: CanvasConversationRef): void
  openConversation(row: CanvasNode, reference: CanvasConversationRef, member?: boolean): void
  edit(row: CanvasNode): void
  openObject(row: CanvasNode): void
  bindFile(row: CanvasNode): void
  removeNode(row: CanvasNode): void
  beginGesture(owner?: string): number | null
  resize(row: CanvasNode, geometry: { x: number; y: number; width: number; height: number }, revision: number | null): void
}
const EMPTY_CONVERSATIONS: CanvasConversationBridge['instances'] = []
const PresentationContext = createContext<Presentation | null>(null)

// Codeg conversation-card-node: 224×132 summary, four-line title and compact metadata.
function CanvasConversationSummary({ actions, row, reference, selected, derived, title, color }: {
  actions: Presentation; row: CanvasNode; reference: CanvasConversationRef; selected?: boolean; derived?: boolean; title: string; color?: string | null
}): React.JSX.Element {
  const privateChat = Boolean(reference.conversationId)
  const unavailable = actions.available(reference) === false
  const metadata = canvasSummaryMetadata(reference, actions.catalog?.items ?? [], actions.agents, actions.folderResolutions)
  const kind = uiAttribute(privateChat ? '私有对话' : '公开对话')
  const openLabel = uiAttribute(actions.conversation ? '展开对话' : '打开对话')
  return <article className={`${derived ? 'canvas-member-card' : 'canvas-card canvas-card-conversation'} canvas-conversation-summary canvas-card-handle${selected ? ' is-selected' : actions.selectedReferences.has(canvasReferenceKey(reference)) ? ' is-mirrored' : ''}`} data-color={color ?? undefined}>
    <div className="canvas-summary-meta">
      {privateChat ? <LockKeyhole size={14} aria-hidden="true" /> : <MessageSquare size={14} aria-hidden="true" />}
      {actions.catalog?.complete && metadata.active !== undefined && <span className="canvas-summary-status" data-active={metadata.active}
        role="img" aria-label={uiAttribute(metadata.active ? '有进行中的任务' : '当前没有进行中的任务')} title={uiAttribute(metadata.active ? '有进行中的任务' : '当前没有进行中的任务')} />}
      <span className={`canvas-summary-kind${metadata.model ? ' canvas-summary-model' : ''}`} title={metadata.modelTitle ?? kind} aria-label={metadata.modelTitle ? `${kind} · ${metadata.modelTitle}` : kind}>{metadata.model ?? kind}</span>
      <div className="canvas-summary-actions nodrag nowheel">
        <CanvasIconButton disabled={actions.blocked || unavailable} label={openLabel} onClick={() => actions.openConversation(row, reference, derived)}><Maximize2 size={14} /></CanvasIconButton>
        {derived ? <CanvasIconButton disabled={actions.blocked} label={uiAttribute(row.data.kind === 'custom' ? '移出分组' : '固定到画布')} onClick={() => actions.detach(row, reference)}><Pin size={14} /></CanvasIconButton>
          : <CanvasIconButton disabled={actions.blocked} label={uiAttribute('编辑节点')} onClick={() => actions.edit(row)}><Pencil size={14} /></CanvasIconButton>}
      </div>
    </div>
    <p className="canvas-summary-title" title={title}>{title}</p>
    <div className="canvas-summary-footer">
      {unavailable ? <span><UiText zh="对话已结束或不可用" /></span> : <>
        {metadata.project ? <span title={metadata.project}><Folder size={10} aria-hidden="true" /><span>{basePathName(metadata.project)}</span></span> : <span><UiText zh={privateChat ? '独立私聊材料' : '共享会话'} /></span>}
        {metadata.branch && <span className="canvas-summary-branch" title={uiAttribute('Git 分支：{0}', metadata.branch)}><GitBranch size={10} aria-hidden="true" /><span dir="ltr">{metadata.branch}</span></span>}
      </>}
    </div>
  </article>
}

function CanvasCard({ data, selected }: NodeProps<FlowNode>): React.JSX.Element {
  const actions = useContext(PresentationContext)!
  const resizeRevision = useRef<number | null>(null)
  const [fileActionsHost, setFileActionsHost] = useState<HTMLSpanElement | null>(null)
  const inlineConversation = actions.conversation?.instances.find(item => item.target.presentation === 'inline' && canvasConversationMatches(data.row, item.target))
  const expandedConversation = Boolean(inlineConversation)
  const row = data.row, d = row.data, region = isRegionKind(d.kind)
  const member = actions.agents.find(item => item.agentId === d.agentId)
  const group = d.kind === 'group' ? actions.groups?.find(item => item.id === d.folderGroupId) : undefined
  const color = d.color ?? group?.color
  const title = d.title || group?.label || (d.objectReference ? uiAttribute(canvasObjectNames[d.objectReference.kind]) : d.conversation ? actions.title(d.conversation) : member?.displayName)
    || (d.path || d.folderPath ? basePathName(d.path || d.folderPath!) : uiAttribute(canvasKindNames[d.kind]))
  const columns = effectiveColumns(d, d.width), cap = visibleMemberCap(d, columns)
  const resolution = actions.resolvedMembers?.get(row.id)
  const references = resolution?.references.map(item => item.reference) ?? (d.kind === 'custom' ? d.conversations : [])
  const visible = actions.expandedRegions.has(row.id) ? references : references.slice(0, cap)
  if (data.member) return <CanvasConversationSummary actions={actions} row={row} reference={data.member} selected={selected} derived title={actions.title(data.member)} color={color} />
  if (canvasPlainConversation(row) && !expandedConversation) return <CanvasConversationSummary actions={actions} row={row} reference={d.conversation!} selected={selected} title={title} color={color} />
  const resizer = <NodeResizer isVisible={selected && !actions.blocked && !d.collapsed && (d.kind !== 'conversation' || expandedConversation)}
    minWidth={expandedConversation ? 520 : d.kind === 'file' ? FILE_CARD_MIN_WIDTH : d.kind === 'terminal' ? TERMINAL_CARD_MIN_WIDTH : d.kind === 'note' ? 140 : region ? 260 : 48}
    minHeight={expandedConversation ? 560 : d.kind === 'file' ? FILE_CARD_MIN_HEIGHT : d.kind === 'terminal' ? TERMINAL_CARD_MIN_HEIGHT : d.kind === 'note' ? 96 : region ? 160 : 48} maxWidth={20000} maxHeight={20000}
    onResizeStart={() => { resizeRevision.current = actions.beginGesture(row.id) }}
    onResizeEnd={(_event, geometry) => { actions.resize(row, geometry, resizeRevision.current); resizeRevision.current = null }} />
  if (d.kind === 'note') return <CanvasNote row={row} revision={actions.noteRevision} scope={actions.scope} theme={actions.theme} blocked={actions.blocked}
    onDirtyChange={dirty => actions.noteDirty(row.id, dirty)} onSave={(text, revision) => actions.saveNote(row, text, revision)}>{resizer}</CanvasNote>
  const HeaderIcon = d.objectReference ? d.objectReference.kind === 'task' ? ListTodo : d.objectReference.kind === 'mission' ? Flag : FileDiff
    : d.kind === 'folder' ? Folder : d.kind === 'group' ? Folders : d.kind === 'agent' ? Users : d.kind === 'custom' ? Group
      : d.kind === 'terminal' ? SquareTerminal : d.kind === 'conversation' ? MessageSquare : null
  return <article className={`canvas-card canvas-card-${d.kind}${region ? ' canvas-region' : ''}${region && resolution && !resolution.complete ? ' is-unresolved' : ''}${d.collapsed ? ' is-collapsed' : ''}${canvasPlainConversation(row) && !selected && actions.selectedReferences.has(canvasReferenceKey(d.conversation!)) ? ' is-mirrored' : ''}${actions.dropTargetId === row.id ? ' is-drop-target' : ''}`} data-color={color ?? undefined}>
    {resizer}
    <header className="canvas-card-handle">
      {color && <span className="canvas-color-dot" role="img" aria-label={uiAttribute(canvasColorName(color))} />}
      {d.kind === 'file' && <ResourceReferenceIcon kind="file" className="resource-reference-icon" />}
      {HeaderIcon && <HeaderIcon className="canvas-card-kind-icon" size={14} aria-hidden="true" />}
      <strong title={(d.kind === 'file' || d.kind === 'terminal') && d.path ? `${title}\n${d.path}` : title}>{title}</strong>
      {region && <span className="canvas-region-count" title={uiAttribute(resolution?.complete ? '{0} 个关联对话' : '已载入 {0} 个关联对话', references.length)}>{references.length}</span>}
      {inlineConversation && actions.conversation && <CanvasConversationActions bridge={actions.conversation} instance={inlineConversation}
        onOpenWorkspace={() => actions.onOpenReference(inlineConversation.target.reference)} />}
      {d.kind === 'file' && <span ref={setFileActionsHost} className="canvas-file-actions nodrag nowheel" />}
      {d.kind === 'folder' && actions.onOpenProject && <CanvasIconButton className="nodrag" label={uiAttribute('进入工程')} onClick={() => actions.onOpenProject?.(d.folderPath!)}><ExternalLink size={15} /></CanvasIconButton>}
      {d.kind === 'agent' && member && !member.removedAt && actions.onOpenMember && <CanvasIconButton className="nodrag" label={uiAttribute('打开队员')} onClick={() => actions.onOpenMember?.(member.agentId)}><ExternalLink size={15} /></CanvasIconButton>}
      {d.kind === 'file' ? <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild><button className="canvas-icon-button nodrag" type="button" disabled={actions.blocked} aria-label={uiAttribute('文件节点操作')} title={uiAttribute('文件节点操作')}><MoreHorizontal size={16} /></button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content className="canvas-card-menu" align="end" sideOffset={4} collisionPadding={12} loop onCloseAutoFocus={event => event.preventDefault()}>
          <DropdownMenu.Item className="canvas-card-menu-item" disabled={actions.blocked} onSelect={() => actions.edit(row)}><UiText zh="编辑节点" /></DropdownMenu.Item>
          <DropdownMenu.Item className="canvas-card-menu-item is-danger" disabled={actions.blocked} onSelect={() => actions.removeNode(row)}><UiText zh="移除文件节点" /></DropdownMenu.Item>
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root> : <CanvasIconButton className="nodrag" disabled={actions.blocked} onClick={() => actions.edit(row)} label={uiAttribute('编辑节点')}><Pencil size={15} /></CanvasIconButton>}
      {d.kind === 'terminal' && <CanvasIconButton className="nodrag" disabled={actions.blocked} onClick={() => actions.removeNode(row)} label={uiAttribute('删除终端节点')}><Trash2 size={15} /></CanvasIconButton>}
      {(region || d.kind === 'file' || d.kind === 'terminal') && <CanvasIconButton className="nodrag" disabled={actions.blocked} onClick={() => actions.collapse(row)}
        label={uiAttribute(d.kind === 'file' ? d.collapsed ? '展开预览' : '收起预览' : d.kind === 'terminal' ? d.collapsed ? '展开终端' : '收起终端' : d.collapsed ? '展开区域' : '折叠区域')}>{d.collapsed ? <Plus size={15} /> : <Minus size={15} />}</CanvasIconButton>}
    </header>
    {!d.collapsed && <div className="canvas-card-body nodrag nowheel">
      {d.objectReference && <div className="canvas-object-pin"><code title={canvasObjectId(d.objectReference)}>{canvasObjectId(d.objectReference)}</code>
        {d.objectReference.kind === 'mission_diff' && d.objectReference.path != null && <code title={d.objectReference.path}>{d.objectReference.path}</code>}
        <button type="button" disabled={actions.blocked || !canvasObjectTarget(row)} onClick={() => actions.openObject(row)}><UiText zh="读取详情" /></button></div>}
      {canvasPlainConversation(row) && actions.available(d.conversation!) === false && <p className="canvas-empty-copy"><UiText zh="对话已结束或不可用" /></p>}
      {region && <>
        {resolution?.complete && references.length === 0 && <p className="canvas-region-empty canvas-empty-copy"><UiText zh={d.kind === 'custom' ? '拖入对话卡片进行分组' : '还没有关联对话'} /></p>}
        <div aria-hidden="true" className="canvas-member-grid-space" style={{ height: Math.max(0, layoutRegionGrid(visible.length, row.data.width, columns).contentHeight - REGION_HEADER_HEIGHT - REGION_PADDING * 2) }} />
        <div className="canvas-region-footer">
        {references.length > cap && <button type="button" onClick={() => actions.expand(row)}>
          {actions.expandedRegions.has(row.id) ? uiAttribute('收起成员') : uiAttribute('显示全部 {0} 个成员', references.length)}
        </button>}
        {d.kind !== 'custom' && !resolution && <p className="canvas-empty-copy"><UiText zh="关联对话尚未载入" /></p>}
        {resolution && !resolution.complete && <p className="canvas-empty-copy">{resolution.issue || uiAttribute('部分关联对话尚未载入')}</p>}
        {d.kind === 'agent' && d.agentId && (!member || member.removedAt) && <p className="canvas-empty-copy"><UiText zh="队员已移除或不可用" /></p>}
        </div>
      </>}
      {d.kind === 'terminal' && (actions.scope ? <CanvasTerminal row={row} scope={JSON.stringify([actions.scope.host, actions.scope.core])} terminalVersion={actions.terminalVersion} disabled={actions.blocked} />
        : <p className="canvas-empty-copy"><UiText zh="画布输入的所属信息不完整，请重新读取画板。" /></p>)}
      {d.kind === 'file' && <>
        {!d.fileReference ? <><p className="canvas-empty-copy"><UiText zh="文件节点尚未绑定原工程会话，请先选择来源。" /></p>
          <button type="button" disabled={actions.blocked} onClick={() => actions.bindFile(row)}><UiText zh="选择所属对话" /></button></>
          : actions.fileApi ? <CanvasFilePreview row={row} api={actions.fileApi} theme={actions.theme} actionsHost={fileActionsHost} onNavigate={actions.onOpenFileSource} onWorkspace={actions.onFileWorkspace} />
          : <p role="status"><UiText zh="当前连接尚未提供文件预览。" /></p>}
      </>}
    </div>}
  </article>
}
const nodeTypes = { 'canvas-card': CanvasCard }
export function CanvasSurface(props: CanvasSurfaceProps): React.JSX.Element {
  const client = useThreadClient(), owner = useRef({ client, generation: 0 })
  if (owner.current.client !== client) owner.current = { client, generation: owner.current.generation + 1 }
  // A changed owner/board mounts fresh view state; an effect must never save the old viewport under a new key.
  const key = JSON.stringify([owner.current.generation, props.scope?.host, props.scope?.core, props.boardId])
  return <ReactFlowProvider key={key}><CanvasSurfaceContent {...props} /></ReactFlowProvider>
}

function CanvasSurfaceContent(props: CanvasSurfaceProps): React.JSX.Element {
  const graph = useCanvasGraph(props.boardId), flow = useReactFlow<FlowNode>(), viewport = useViewport()
  const stage = useRef<HTMLDivElement | null>(null)
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  const [presenting, setPresenting] = useState(false), presentingRef = useRef(false)
  const bridgeRef = useRef(props.conversation); bridgeRef.current = props.conversation
  useEffect(() => {
    const element = stage.current
    if (!element) return
    const measure = () => setStageSize({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure); observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const language = useInterfaceLanguage(), catalog = props.catalog ?? EMPTY_CATALOG
  const [storage] = useState(browserCanvasStorage)
  const [view, setView] = useState(() => loadCanvasViewState(storage, props.scope, props.boardId))
  const [nodes, setNodes] = useState<FlowNode[]>([]), [selected, setSelected] = useState<string[]>([])
  const [issue, setIssue] = useState<string | null>(null)
  const [restoreRetry, setRestoreRetry] = useState(0), restored = useRef<string | null>(null)
  const surface = useRef<HTMLElement | null>(null)
  const [editor, setEditor] = useState<{ target: CanvasEditTarget; revision: number } | null>(null)
  const [objectTarget, setObjectTarget] = useState<CanvasObjectTarget | null>(null)
  const [deletion, setDeletion] = useState<{ ids: string[]; revision: number; hasProse: boolean; hasTerminal: boolean } | null>(null)
  const [guides, setGuides] = useState<AlignmentGuide[]>([])
  const panel = useRef(false), panelCommand = useRef(false)
  const dirtyNotes = useRef(new Set<string>())
  const dragRevision = useRef<number | null>(null), dragging = useRef(false), currentDerived = useRef<FlowNode[]>([])
  const gestureGeneration = useRef(0)
  const dragOwner = useRef<string | null>(null)
  const [frozenMembers, setFrozenMembers] = useState<ReadonlyMap<string, CanvasRegionResolution> | null>(null)
  const [dropHint, setDropHint] = useState<CanvasDropHint | null>(null)
  const latestGraph = useRef(graph)
  latestGraph.current = graph
  const graphBlocked = graph.loading || Boolean(graph.readError || graph.pending) || !graph.snapshot?.board
  const blocked = graphBlocked || Boolean(editor || deletion || objectTarget || presenting || props.conversation?.opening || props.conversation?.restoring)
  const rows = graph.snapshot?.nodes ?? EMPTY_ROWS
  useEffect(() => {
    const stamp = JSON.stringify([props.restoreRevision ?? 0, restoreRetry])
    if (restored.current === stamp || !props.scope || graph.loading || graph.readError || graph.pending || !graph.snapshot?.board || !props.conversation || props.conversation.opening || props.conversation.restoring) return
    restored.current = stamp
    void props.conversation.restore(props.scope, props.boardId, rows).catch(error => setIssue(readErrorMessage(error)))
  }, [props.scope, props.boardId, props.restoreRevision, props.conversation, graph.loading, graph.readError, graph.pending, graph.snapshot, rows, restoreRetry])
  const folderPaths = useMemo(() => [...canvasSummaryProjectPaths(rows, catalog.items), ...rows.flatMap(row => row.data.kind === 'folder' && row.data.folderPath ? [row.data.folderPath]
    : row.data.kind === 'group' ? props.groups?.find(group => group.id === row.data.folderGroupId)?.projectPaths ?? [] : [])], [rows, props.groups, catalog.items])
  const folders = useCanvasFolders(folderPaths)
  const folderResolutions = props.folderResolutions ?? folders.resolutions
  const referenceOptions = useMemo(() => props.references ?? canvasReferenceOptions(catalog.items), [props.references, catalog.items, language])
  const liveRegions = useMemo(() => props.resolvedMembers ?? new Map(rows.filter(row => isRegionKind(row.data.kind)).map(row => [row.id,
    resolveCanvasRegion(row, catalog, props.groups ?? EMPTY_GROUPS, folderResolutions)])),
  [props.resolvedMembers, rows, catalog.items, catalog.complete, catalog.error, props.groups, folderResolutions, language])
  const regions = useMemo(() => frozenMembers ? new Map([...liveRegions, ...frozenMembers]) : liveRegions, [liveRegions, frozenMembers])
  const expanded = useMemo(() => new Set(view.expandedRegions), [view.expandedRegions])
  const conversationInstances = props.conversation?.instances ?? EMPTY_CONVERSATIONS
  // Content elements/visibility reports change without changing any node geometry.
  const conversationLayoutKey = JSON.stringify(conversationInstances.map(item => [item.key, item.target.presentation]))
  const orphanedConversations = conversationInstances.filter(item => item.target.boardId === props.boardId && !rows.some(row => canvasConversationMatches(row, item.target)))
  const derived = useMemo<FlowNode[]>(() => rows.flatMap(row => {
    const d = row.data, region = isRegionKind(d.kind)
    const inlineIndex = conversationInstances.findIndex(item => item.target.presentation === 'inline' && canvasConversationMatches(row, item.target))
    const inline = inlineIndex >= 0
    const width = inline ? Math.max(520, d.width) : region && d.gridColumns > 0 ? regionWidthForColumns(d.gridColumns) : d.kind === 'conversation' ? CARD_WIDTH : d.width
    let height = d.height
    if (region) {
      if (d.collapsed) height = REGION_COLLAPSED_HEIGHT
      else {
        const memberCount = regions.get(row.id)?.references.length ?? (d.kind === 'custom' ? d.conversations.length : 0)
        const columns = effectiveColumns(d, width), cap = visibleMemberCap(d, columns)
        const count = expanded.has(row.id) ? memberCount : Math.min(cap, memberCount)
        height = Math.max(d.gridRows > 0 ? regionHeightForRows(d.gridRows) : height,
          layoutRegionGrid(count, width, columns).contentHeight + REGION_FOOTER_HEIGHT * 2)
      }
    } else if (d.kind === 'conversation') height = inline ? Math.max(560, d.height) : CARD_HEIGHT
    else if ((d.kind === 'file' || d.kind === 'terminal') && d.collapsed) height = REGION_COLLAPSED_HEIGHT
    const root: FlowNode = { id: row.id, type: 'canvas-card', data: { row }, position: { x: d.x, y: d.y },
      width, height, style: { width, height }, selected: selected.includes(row.id), dragHandle: '.canvas-card-handle',
      zIndex: (selected.includes(row.id) ? 1000 : 0) + (inline ? 10 + inlineIndex : region ? 0 : 1), connectable: false, deletable: false }
    if (!region || d.collapsed) return [root]
    const allMembers = regions.get(row.id)?.references.map(item => item.reference) ?? d.conversations
    const members = expanded.has(row.id) ? allMembers : allMembers.slice(0, visibleMemberCap(d, effectiveColumns(d, width)))
    const grid = layoutRegionGrid(members.length, width, effectiveColumns(d, width))
    return [root, ...members.map((member, index): FlowNode => {
      const id = canvasMemberKey(row.id, member)
      return { id, type: 'canvas-card', parentId: row.id, data: { row, member, regionId: row.id }, position: grid.positions[index],
        width: CARD_WIDTH, height: CARD_HEIGHT, style: { width: CARD_WIDTH, height: CARD_HEIGHT }, selected: selected.includes(id),
        ariaLabel: uiAttribute('区域对话：{0}。可拖动，或按 Tab 使用卡片操作。', regions.get(row.id)?.references[index]?.label ?? uiAttribute('对话')),
        dragHandle: '.canvas-card-handle', connectable: false, deletable: false, zIndex: 2 }
    })]
  }), [rows, selected, expanded, regions, conversationLayoutKey])
  currentDerived.current = derived
  useEffect(() => {
    if (!dragging.current) setNodes(derived)
    // Core删除或移出成员后，旧选中ID不应继续占用工具条的单选状态。
    const ids = new Set(derived.map(node => node.id))
    setSelected(current => {
      const next = current.filter(id => ids.has(id))
      return next.length === current.length ? current : next
    })
  }, [derived])
  useEffect(() => { saveCanvasViewState(storage, props.scope, props.boardId, view) }, [storage, view, props.scope, props.boardId])
  useEffect(() => {
    const isBlocked = () => dirtyNotes.current.size > 0 || panel.current || dragging.current || presentingRef.current || Boolean(bridgeRef.current?.opening || bridgeRef.current?.restoring || latestGraph.current.hasUnsettled())
    props.onLeaveGuardChange?.({ isBlocked, canLeave: async () => !isBlocked() })
    return () => props.onLeaveGuardChange?.(null)
  }, [props.onLeaveGuardChange])

  const settlePanel = (receipt: StoredCommandResult) => {
    if (receipt.status === 'rejected') {
      const message = receipt.code === 'canvas.nodes.conflict' ? uiAttribute('画布已有新修改，此次操作未保存。请核对最新布局后重试。')
        : receipt.code === 'canvas.nodes.too_many_members' ? uiAttribute('所选对话或成员引用超过200个，请减少选择。')
          : uiAttribute('此次画布操作未完成，请核对输入后重试。')
      setIssue(message); panelCommand.current = false
      throw new Error(message)
    }
    if (panelCommand.current) { panelCommand.current = false; panel.current = false; setEditor(null); setDeletion(null) }
  }
  const submit = async (mutation: CanvasNodeMutation, revision?: number, fromPanel = false) => {
    const gesture = gestureGeneration.current
    setIssue(null)
    panelCommand.current = fromPanel
    try {
      if (!canvasMemberMutationSupported(mutation, graph.snapshot?.memberTransferVersion)) throw new Error(uiAttribute('当前 Core 不支持原子成员转移，请升级服务后重试。'))
      const bridge = bridgeRef.current
      const affected = bridge?.instances.filter(item => item.target.boardId === props.boardId && canvasMutationRemovesConversation(mutation, item.target)).map(item => item.key) ?? []
      const prepared = affected.length ? await bridge!.prepare(affected) : null
      try {
        const receipt = await graph.apply(mutation, revision)
        settlePanel(receipt)
        return receipt
      } finally { prepared?.complete(false) }
    } catch (error) {
      if (!graph.hasUnsettled()) panelCommand.current = false
      setIssue(readErrorMessage(error)); throw error
    } finally {
      if (gesture === gestureGeneration.current) { dragOwner.current = null; dragging.current = false; setFrozenMembers(null); setDropHint(null); setGuides([]); setNodes(currentDerived.current) }
    }
  }
  const mutate = (mutation: CanvasNodeMutation, revision?: number) => { void submit(mutation, revision).catch(() => undefined) }
  const closePanel = () => { if (!graph.hasUnsettled()) { panel.current = false; setEditor(null); setDeletion(null) } }
  const beginGesture = (owner?: string) => {
    if (dragging.current || panel.current || presentingRef.current || bridgeRef.current?.opening || latestGraph.current.loading || latestGraph.current.readError || latestGraph.current.hasUnsettled() || !latestGraph.current.snapshot?.board) return null
    gestureGeneration.current += 1; dragOwner.current = owner ?? null; dragging.current = true; return graph.snapshot?.board?.revision ?? null
  }
  const cancelGesture = () => {
    gestureGeneration.current += 1; dragRevision.current = null; dragOwner.current = null; dragging.current = false
    setFrozenMembers(null); setDropHint(null); setGuides([]); setNodes(currentDerived.current)
  }
  useEffect(() => {
    const cancel = () => { if (dragging.current && !latestGraph.current.hasUnsettled()) cancelGesture() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel() }
    window.addEventListener('blur', cancel); window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('blur', cancel); window.removeEventListener('keydown', escape) }
  }, [])
  const recover = async (retry: boolean) => {
    try { const receipt = await (retry ? graph.retry() : graph.reconcile()); if (receipt) { setIssue(null); settlePanel(receipt) } }
    catch (error) { setIssue(readErrorMessage(error)) }
  }
  const title = (reference: CanvasConversationRef) => {
    return referenceOptions.find(item => item.reference.threadId === reference.threadId && item.reference.conversationId === reference.conversationId)?.label
      ?? canvasSavedReference(reference, catalog).label
  }
  const openConversation = async (row: CanvasNode, reference: CanvasConversationRef, member = false) => {
    if (row.data.objectReference) return
    if (!props.conversation) { props.onOpenReference(reference); return }
    if (blocked || presentingRef.current) return
    if (!props.scope) { setIssue(uiAttribute('展开输入前需要核对服务信息，请重试画板连接。')); return }
    presentingRef.current = true; setPresenting(true)
    try {
      let nodeId = row.id
      if (member) {
        const receipt = await submit({ type: 'detach', regionId: row.id, conversation: reference,
          x: row.data.x + (flow.getNode(row.id)?.width ?? row.data.width) + 24, y: row.data.y }, graph.snapshot!.board!.revision)
        const ids = receipt.payload.nodeIds
        const created = Array.isArray(ids) ? ids.find(id => typeof id === 'string' && id !== row.id) : undefined
        if (typeof created !== 'string') throw new Error(uiAttribute('对话卡片已保存，请刷新后展开。'))
        nodeId = created
      }
      await props.conversation.open({ boardId: props.boardId, nodeId, reference, presentation: 'inline',
        draftContext: canvasComposerContext(props.scope, props.boardId, nodeId, reference) })
    } catch (error) { setIssue(readErrorMessage(error)) }
    finally { presentingRef.current = false; setPresenting(false) }
  }
  const actions: Presentation = { ...props, folderResolutions, terminalVersion: graph.snapshot?.terminalVersion, openConversation: (row, reference, member) => { void openConversation(row, reference, member) }, resolvedMembers: regions, blocked, expandedRegions: expanded, title,
    noteRevision: graph.snapshot?.board?.revision ?? 0,
    noteDirty: (nodeId, dirty) => { if (dirty) dirtyNotes.current.add(nodeId); else dirtyNotes.current.delete(nodeId) },
    saveNote: async (row, content, revision) => { await submit({ type: 'update', nodeId: row.id, patch: { content } }, revision) },
    selectedReferences: new Set(nodes.filter(node => selected.includes(node.id)).flatMap(node => node.data.member ? [canvasReferenceKey(node.data.member)]
      : canvasPlainConversation(node.data.row) ? [canvasReferenceKey(node.data.row.data.conversation!)] : [])),
    dropTargetId: dropHint?.type === 'region' ? dropHint.regionId : dropHint?.type === 'merge' ? dropHint.targetNodeId : null,
    available: reference => canvasSavedReference(reference, catalog).available,
    collapse: row => { mutate({ type: 'update', nodeId: row.id, patch: { collapsed: !row.data.collapsed } }) },
    expand: row => setView(current => ({ ...current, expandedRegions: expanded.has(row.id)
      ? current.expandedRegions.filter(id => id !== row.id) : [...current.expandedRegions, row.id] })),
    detach: (row, reference) => { mutate({ type: 'detach', regionId: row.id, conversation: reference,
      x: row.data.x + (flow.getNode(row.id)?.width ?? row.data.width) + 24, y: row.data.y }) },
    edit: row => { if (dirtyNotes.current.size) { setIssue(uiAttribute('请先保存便笺草稿，再编辑节点。')); return } panel.current = true; setEditor({ target: { type: 'update', row }, revision: graph.snapshot!.board!.revision }) },
    openObject: row => { if (!blocked) setObjectTarget(canvasObjectTarget(row)) },
    bindFile: row => {
      if (graph.snapshot?.fileReferenceVersion !== 1) { setIssue(uiAttribute('当前连接暂不支持文件节点来源绑定，请升级服务后重试。')); return }
      panel.current = true; setEditor({ target: { type: 'bind_file', row }, revision: graph.snapshot!.board!.revision })
    },
    removeNode: row => deleteSelected([row.id]),
    beginGesture,
    resize: (row, geometry, revision) => {
      if (revision === null || dragOwner.current !== row.id) return
      const region = isRegionKind(row.data.kind)
      const columns = Math.min(12, columnsForRegionWidth(geometry.width)), rows = Math.min(12, rowsForRegionHeight(geometry.height))
      mutate({ type: 'update', nodeId: row.id, patch: { ...geometry,
        ...(region ? { width: regionWidthForColumns(columns), height: regionHeightForRows(rows),
          ...(row.data.gridColumns ? { gridColumns: columns } : {}), ...(row.data.gridRows ? { gridRows: rows } : {}) } : {}) } }, revision ?? undefined)
    }
  }
  const deleteSelected = (ids = flow.getNodes().filter(node => node.selected).map(node => node.id)) => {
    if (dirtyNotes.current.size) { setIssue(uiAttribute('请先保存便笺草稿，再删除节点。')); return }
    ids = ids.filter(id => rows.some(row => row.id === id))
    if (!ids.length) { setIssue(uiAttribute('区域成员可通过卡片操作移出或固定到画布。')); return }
    panel.current = true
    setDeletion({ ids: [...ids], revision: graph.snapshot!.board!.revision,
      hasProse: rows.some(row => ids.includes(row.id) && noteHoldsProse(row)), hasTerminal: rows.some(row => ids.includes(row.id) && row.data.kind === 'terminal') })
  }
  const groupSelected = () => {
    const items = flow.getNodes().filter(node => node.selected && (node.data.member || canvasPlainConversation(node.data.row))).map(node => ({
      conversation: (node.data.member ?? canvasPlainConversation(node.data.row))!, ...canvasAbsolutePosition(node, nodes),
      ...(node.data.member ? { regionId: node.data.regionId! } : { nodeId: node.id }) }))
    const mutation = canvasGroupSelection(items)
    if (mutation) mutate(mutation)
    else if (items.length) setIssue(uiAttribute('所选对话或成员引用超过200个，请减少选择。'))
  }
  const error = issue || props.conversation?.issue || (graph.readError ? readErrorMessage(graph.readError) : null)
  const recovery = graph.pending && <div className="canvas-notice" role="status"><UiText zh={graph.pending.state === 'unknown' ? '原操作结果待核对，请先核对或重试原操作。' : '正在保存画布…'} />
    {graph.pending.state === 'unknown' && <><button type="button" onClick={() => { void recover(false) }}><UiText zh="核对结果" /></button>
      <button type="button" onClick={() => { void recover(true) }}><UiText zh="重试原操作" /></button></>}
  </div>
  const align = (moved: FlowNode, movedNodes: FlowNode[]) => {
    if (moved.data.member) return { dx: 0, dy: 0, guides: [] }
    const moving = (movedNodes.length ? movedNodes : [moved]).filter(item => !item.data.member), ids = new Set(moving.map(item => item.id))
    const left = Math.min(...moving.map(item => item.position.x)), top = Math.min(...moving.map(item => item.position.y))
    const right = Math.max(...moving.map(item => item.position.x + (item.width ?? item.data.row.data.width)))
    const bottom = Math.max(...moving.map(item => item.position.y + (item.height ?? item.data.row.data.height)))
    const others = nodes.filter(item => !item.data.member && !ids.has(item.id)).map(item => ({ ...item.position, width: item.width ?? 0, height: item.height ?? 0 }))
    return computeAlignment({ x: left, y: top, width: right - left, height: bottom - top }, others, 8 / flow.getZoom(), BOARD_DOT_GAP)
  }
  const drop = (moved: FlowNode, position: { x: number; y: number }) => {
    const reference = moved.data.member ?? canvasPlainConversation(moved.data.row)
    if (!reference) return null
    const painted = nodes.filter(item => !item.data.member).toSorted((left, right) =>
      (flow.getInternalNode(left.id)?.internals.z ?? left.zIndex ?? 0) - (flow.getInternalNode(right.id)?.internals.z ?? right.zIndex ?? 0))
    const regions = painted.filter(item => isRegionKind(item.data.row.data.kind)).map(item => ({ nodeId: item.id,
      kind: item.data.row.data.kind, ...item.position, width: item.width ?? 0, height: item.height ?? 0 }))
    const pins = painted.filter(item => canvasPlainConversation(item.data.row)).map(item => ({ nodeId: item.id,
      conversation: item.data.row.data.conversation!, ...item.position, width: CARD_WIDTH, height: CARD_HEIGHT }))
    const source = moved.data.member ? { kind: 'member' as const, regionId: moved.data.regionId!, conversation: reference }
      : { kind: 'pin' as const, nodeId: moved.id, conversation: reference }
    return { source, hint: computeDropHint(source, position, regions, pins) }
  }
  const addNode = (kind?: CanvasNodeKind) => {
      if (blocked) return
      const bounds = flow.getViewport(), element = surface.current?.getBoundingClientRect()
      const point = element ? flow.screenToFlowPosition({ x: element.left + element.width / 2, y: element.top + element.height / 2 }) : { x: -bounds.x / bounds.zoom, y: -bounds.y / bounds.zoom }
      panel.current = true; setEditor({ target: { type: 'create', position: point, kind }, revision: graph.snapshot!.board!.revision })
  }
  const arrange = () => {
    const sizes = new Map(nodes.map(node => [node.id, { width: node.width ?? node.data.row.data.width, height: node.height ?? node.data.row.data.height }]))
    const moves = packLayout(rows.map(row => ({ id: row.id, ...row.data })), sizes)
    if (moves.length) mutate({ type: 'move', moves })
  }
  // Codeg's board actions stay in a bottom-centred dock; viewport controls own their corner.
  const toolbar = <div className="canvas-toolbar" role="toolbar" aria-label={uiAttribute('画布工具')}>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild><button type="button" className="canvas-icon-button" disabled={blocked} aria-label={uiAttribute('添加节点')} title={uiAttribute('添加节点')}><Plus size={18} /></button></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="canvas-card-menu" side="top" align="start" sideOffset={10} collisionPadding={12} loop onCloseAutoFocus={event => event.preventDefault()}>
        {(Object.keys(canvasKindNames) as CanvasNodeKind[]).map(kind => <DropdownMenu.Item key={kind} className="canvas-card-menu-item" disabled={blocked} onSelect={() => addNode(kind)}>{uiAttribute(canvasKindNames[kind])}</DropdownMenu.Item>)}
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    <CanvasIconButton label={uiAttribute('查看全部')} onClick={() => { void flow.fitView({ padding: 0.15 }) }}><Expand size={17} /></CanvasIconButton>
    <CanvasIconButton label={uiAttribute('自动排列')} disabled={blocked || !rows.length} onClick={arrange}><LayoutGrid size={17} /></CanvasIconButton>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild><button className="canvas-icon-button" type="button" aria-label={uiAttribute('画布操作')} title={uiAttribute('画布操作')}><MoreHorizontal size={18} /></button></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="canvas-card-menu" side="top" align="end" sideOffset={10} collisionPadding={12} loop onCloseAutoFocus={event => event.preventDefault()}>
        <DropdownMenu.Item className="canvas-card-menu-item" onSelect={() => { props.onRefreshReferences?.(); void folders.refresh() }}><RefreshCw size={15} /><UiText zh="刷新关联" /></DropdownMenu.Item>
        <DropdownMenu.Item className="canvas-card-menu-item" disabled={blocked || !nodes.some(node => selected.includes(node.id) && (node.data.member || canvasPlainConversation(node.data.row)))} onSelect={groupSelected}><UiText zh="选中对话分组" /></DropdownMenu.Item>
        <DropdownMenu.Item className="canvas-card-menu-item is-danger" disabled={blocked || !rows.some(row => selected.includes(row.id))} onSelect={() => deleteSelected()}><UiText zh="删除所选" /></DropdownMenu.Item>
        <DropdownMenu.Item className="canvas-card-menu-item" disabled={blocked || !rows.length} onSelect={arrange}><UiText zh="自动排列" /></DropdownMenu.Item>
        <DropdownMenu.CheckboxItem className="canvas-card-menu-item" checked={view.minimap} onCheckedChange={checked => setView(current => ({ ...current, minimap: checked === true }))}>
          <DropdownMenu.ItemIndicator><MapIcon size={15} /></DropdownMenu.ItemIndicator><UiText zh="小地图" />
        </DropdownMenu.CheckboxItem>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    {selected.length > 0 && <><span className="canvas-dock-divider" aria-hidden="true" />
      {selected.length === 1 && rows.find(row => row.id === selected[0])?.data.kind === 'note' && <CanvasIconButton label={uiAttribute('编辑节点')} disabled={blocked} onClick={() => actions.edit(rows.find(row => row.id === selected[0])!)}><Pencil size={17} /></CanvasIconButton>}
      <CanvasIconButton label={uiAttribute('选中对话分组')} disabled={blocked || !nodes.some(node => selected.includes(node.id) && (node.data.member || canvasPlainConversation(node.data.row)))} onClick={groupSelected}><Group size={17} /></CanvasIconButton>
      <CanvasIconButton label={uiAttribute('删除所选')} disabled={blocked || !rows.some(row => selected.includes(row.id))} onClick={() => deleteSelected()}><Trash2 size={17} /></CanvasIconButton></>}
  </div>
  return <section ref={surface} className="canvas-surface" aria-label={uiAttribute('无限画布')} onKeyDownCapture={event => {
    const target = event.target
    if (!(target instanceof HTMLElement) || !target.matches('.react-flow__node, .react-flow__nodesselection-rect') || event.metaKey || event.ctrlKey || event.altKey) return
    const direction = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[event.key]
    if (!direction && event.key !== 'Delete' && event.key !== 'Backspace') return
    // ReactFlow's keyboard movement is local only. Route it through the same Core command as pointer gestures.
    event.preventDefault(); event.stopPropagation()
    if (blocked || panel.current || dragging.current || latestGraph.current.hasUnsettled()) return
    const focused = target.dataset.id, ids = focused && !selected.includes(focused) ? [focused] : selected
    if (!ids.length) return
    if (focused && !selected.includes(focused)) setSelected([focused])
    if (!direction) { deleteSelected(ids); return }
    if (!rows.some(row => ids.includes(row.id))) { setIssue(uiAttribute('区域成员可通过卡片操作移出或固定到画布。')); return }
    const distance = event.shiftKey ? 20 : 5
    const moves = rows.filter(row => ids.includes(row.id)).map(row => ({ nodeId: row.id, x: row.data.x + direction[0] * distance, y: row.data.y + direction[1] * distance }))
    if (moves.length) mutate({ type: 'move', moves }, graph.snapshot!.board!.revision)
  }}>
    {error && <div className="canvas-notice" role="alert">{error}<button type="button" onClick={() => { void graph.refresh().catch(() => undefined) }}><UiText zh="重新读取" /></button>
      {props.conversation?.issue && !props.conversation.restoring && <button type="button" disabled={blocked || !props.scope}
        onClick={() => { setIssue(null); setRestoreRetry(value => value + 1) }}><UiText zh="重试恢复展开" /></button>}
    </div>}
    {!editor && !deletion && recovery}
    {(presenting || props.conversation?.opening) && <p className="canvas-notice" role="status"><UiText zh="正在处理画布对话…" /></p>}
    {props.conversation?.restoring && <p className="canvas-notice" role="status">{uiAttribute('正在恢复已展开的卡片：{0}/{1}', props.conversation.restoring.completed, props.conversation.restoring.total)}
      <button type="button" onClick={() => props.conversation?.cancelRestore()}><UiText zh="停止恢复" /></button></p>}
    {orphanedConversations.length > 1 && <div className="canvas-notice" role="status"><UiText zh="这些卡片已变更，输入仍保留。选择需要查看的对话。" />
      {orphanedConversations.map(item => <button type="button" key={item.key} disabled={props.conversation?.opening}
        onClick={() => { void props.conversation?.open({ ...item.target, presentation: 'drawer' }) }}>{title(item.target.reference)}</button>)}
    </div>}
    {graph.loading && !graph.snapshot && <p className="canvas-notice" role="status"><UiText zh="正在读取画布…" /></p>}
    {!graph.loading && graph.snapshot && !graph.snapshot.board && <p className="canvas-notice"><UiText zh="此画板已被删除，请选择其他画板。" /></p>}
    <div className="canvas-flow-stage" ref={stage}>
    {!graph.loading && graph.snapshot?.board && !rows.length && <div className="canvas-empty-hint"><MapIcon size={40} strokeWidth={1.5} aria-hidden="true" />
      <h3><UiText zh="画布还是空的" /></h3><p><UiText zh="用空间方式梳理工作区：区域对应工程和队员，卡片对应会话，便签记录其它。" /></p>
      <button type="button" className="canvas-primary-button" disabled={blocked} onClick={() => addNode()}><Plus size={16} /><UiText zh="添加节点" /></button></div>}
    <PresentationContext.Provider value={actions}>
      <ReactFlow<FlowNode> nodes={nodes} nodeTypes={nodeTypes} onNodesChange={changes => {
        setNodes(current => applyNodeChanges(changes, current))
        const selections = changes.filter(change => change.type === 'select')
        // Consume selection in the same batch as the controlled nodes, rather than echoing stale store snapshots.
        if (selections.length) setSelected(current => {
          const next = new Set(current)
          for (const change of selections) { if (change.selected) next.add(change.id); else next.delete(change.id) }
          return next.size === current.length && current.every(id => next.has(id)) ? current : [...next]
        })
      }}
        colorMode={props.theme === 'night' ? 'dark' : 'light'} ariaLabelConfig={{ 'controls.zoomIn.ariaLabel': uiAttribute('放大画布'), 'controls.zoomOut.ariaLabel': uiAttribute('缩小画布'), 'controls.fitView.ariaLabel': uiAttribute('查看全部'),
          'controls.ariaLabel': uiAttribute('画布缩放控件'), 'minimap.ariaLabel': uiAttribute('小地图'),
          'node.a11yDescription.default': uiAttribute('按回车或空格选择节点，方向键移动，Shift 加速，Delete 删除。'),
          'node.a11yDescription.keyboardDisabled': uiAttribute('选择节点后可使用工具栏。') }}
        nodesDraggable={!blocked} elementsSelectable={!blocked} selectionMode={SelectionMode.Partial} selectionOnDrag panOnDrag={[1, 2]} panOnScroll
        nodesConnectable={false} elevateNodesOnSelect={false} deleteKeyCode={null} minZoom={CANVAS_MIN_ZOOM} maxZoom={CANVAS_MAX_ZOOM}
        defaultViewport={view.viewport ?? { x: 0, y: 0, zoom: 1 }}
        onMoveEnd={(_event, viewport) => setView(current => ({ ...current, viewport }))}
        onNodeDragStart={(_event, moved) => {
          const revision = beginGesture(moved.id)
          if (revision === null) return
          dragRevision.current = revision
          if (moved.data.member && moved.data.regionId) {
            const resolution = regions.get(moved.data.regionId)
            if (resolution) setFrozenMembers(new Map([[moved.data.regionId, resolution]]))
          }
        }}
        onNodeDrag={(_event, moved, movedNodes) => {
          if (dragOwner.current !== moved.id) return
          const alignment = align(moved, movedNodes); setGuides(alignment.guides)
          const position = canvasAbsolutePosition(moved, nodes)
          setDropHint(drop(moved, { x: position.x + alignment.dx, y: position.y + alignment.dy })?.hint ?? null)
        }}
        onSelectionDragStart={() => { const revision = beginGesture('@selection'); if (revision !== null) dragRevision.current = revision }}
        onSelectionDragStop={(_event, selection) => {
          if (dragOwner.current !== '@selection') return
          const revision = dragRevision.current; dragRevision.current = null
          const real = selection.filter(node => !node.data.member)
          if (revision === null || !real.length) { cancelGesture(); return }
          const alignment = align(real[0], real)
          mutate({ type: 'move', moves: real.map(node => ({ nodeId: node.id, x: node.position.x + alignment.dx, y: node.position.y + alignment.dy })) }, revision)
        }}
        onNodeDragStop={(_event, moved, movedNodes) => {
          if (dragOwner.current !== moved.id) return
          const revision = dragRevision.current
          dragRevision.current = null
          if (revision === null) { cancelGesture(); return }
          const row = moved.data.row, selectedRows = (movedNodes.length ? movedNodes : [moved]).filter(node => !node.data.member)
          const alignment = align(moved, movedNodes)
          const absolute = canvasAbsolutePosition(moved, nodes)
          const position = { x: absolute.x + alignment.dx, y: absolute.y + alignment.dy }
          const reference = moved.data.member ?? canvasPlainConversation(row)
          if (reference && (moved.data.member ? selectedRows.length === 0 : selectedRows.length === 1)) {
            const plan = drop(moved, position)!
            const mutation = canvasDropMutation(plan.source, plan.hint)
            if (mutation) mutate(mutation, revision)
            else cancelGesture()
            return
          }
          mutate({ type: 'move', moves: selectedRows.map(node => ({ nodeId: node.id, x: node.position.x + alignment.dx, y: node.position.y + alignment.dy })) }, revision)
        }}>
        <Background variant={BackgroundVariant.Dots} gap={BOARD_DOT_GAP} size={1} />
        <Panel position="bottom-center" className="canvas-dock-panel">{toolbar}</Panel>
        <CanvasViewportPanel minimap={view.minimap} onMinimapChange={minimap => setView(current => ({ ...current, minimap }))} />
        <ViewportPortal><svg className="canvas-alignment-guides" width={1} height={1} aria-hidden="true">
          {guides.map((guide, i) => <line key={i} x1={guide.axis === 'x' ? guide.at : guide.from} x2={guide.axis === 'x' ? guide.at : guide.to}
            y1={guide.axis === 'y' ? guide.at : guide.from} y2={guide.axis === 'y' ? guide.at : guide.to} vectorEffect="non-scaling-stroke" />)}
        </svg>
          {conversationInstances.filter(instance => instance.target.boardId === props.boardId).map((instance, index) => {
            const row = rows.find(row => canvasConversationMatches(row, instance.target))
            const flowNode = row && nodes.find(node => node.id === row.id)
            const geometry = canvasConversationGeometry(row && instance.target.presentation === 'inline' ? {
              x: flowNode?.position.x ?? row.data.x, y: flowNode?.position.y ?? row.data.y,
              width: flowNode?.width ?? row.data.width, height: flowNode?.height ?? row.data.height
            } : null, viewport, stageSize)
            return <div key={instance.key} className="canvas-conversation-overlay" style={{ ...geometry,
              zIndex: row && instance.target.presentation === 'inline' ? flowNode?.zIndex ?? 10 + index : 2010 + index }}>
              <CanvasConversationFrame bridge={props.conversation!} instance={instance} title={title(instance.target.reference)} orphaned={!row}
                onOpenWorkspace={() => props.onOpenReference(instance.target.reference)} />
            </div>
          })}
        </ViewportPortal>
      </ReactFlow>
    </PresentationContext.Provider>
    </div>
    {editor && <CanvasNodeEditor target={editor.target} revision={editor.revision} latestRevision={graph.snapshot?.board?.revision ?? null}
      agents={props.agents} groups={props.groups ?? EMPTY_GROUPS}
      objectReferencesSupported={graph.snapshot?.objectReferenceVersion === 1} objectThreads={catalog.items}
      fileReferencesSupported={graph.snapshot?.fileReferenceVersion === 1}
      references={referenceOptions} referencesComplete={catalog.complete} onRefreshReferences={() => { props.onRefreshReferences?.(); void folders.refresh() }}
      blocked={graphBlocked} pending={Boolean(graph.pending)} recovery={recovery} onClose={closePanel}
      commandError={issue}
      onSave={async (mutation, revision) => { await submit(mutation, revision, true) }} />}
    {objectTarget && <CanvasObjectDialog target={objectTarget} onClose={() => setObjectTarget(null)}
      onOpenWorkspace={props.onOpenObject ? target => { setObjectTarget(null); props.onOpenObject!(target) } : undefined} />}
    {deletion && <Dialog.Root open onOpenChange={open => { if (!open) closePanel() }}><Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay app-dialog-overlay" />
      <AppDialogContent tone="danger" onEscapeKeyDown={event => { if (graph.hasUnsettled()) event.preventDefault() }} onPointerDownOutside={event => event.preventDefault()}>
        <AppDialogHeader title={uiAttribute('删除所选节点')} description={uiAttribute('只删除画布节点，保留工程、对话、文件及历史。')} closeDisabled={Boolean(graph.pending)} />
        <AppDialogBody><p>{uiAttribute('将删除 {0} 个节点。', deletion.ids.length)}</p>
          <ul>{deletion.ids.map(id => { const row = rows.find(row => row.id === id); return <li key={id}>{row?.data.title || row?.data.path || row?.data.folderPath || id}</li> })}</ul>
          {deletion.hasProse && <p><UiText zh="所选便签的文字将一并删除。" /></p>}
          {deletion.hasTerminal && <p><UiText zh="删除终端节点会请求停止该终端，运行中的命令可能中断。" /></p>}
          {deletion.revision !== graph.snapshot?.board?.revision && <p><UiText zh="画布已更新，请取消并重新核对所选节点。" /></p>}
          {error && <p role="alert">{error}</p>}{recovery}
        </AppDialogBody>
        <AppDialogFooter><button type="button" className="quiet-button" disabled={Boolean(graph.pending)} onClick={closePanel}><UiText zh="取消" /></button>
          <button type="button" className="danger-button" disabled={graphBlocked || deletion.revision !== graph.snapshot?.board?.revision}
            onClick={() => { void submit({ type: 'delete', nodeIds: deletion.ids }, deletion.revision, true).catch(() => undefined) }}><UiText zh="删除节点" /></button>
        </AppDialogFooter>
      </AppDialogContent>
    </Dialog.Portal></Dialog.Root>}
  </section>
}
