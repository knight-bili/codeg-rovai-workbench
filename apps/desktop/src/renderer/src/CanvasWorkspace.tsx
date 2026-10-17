import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronDown, ChevronRight, Map as MapIcon, MoreHorizontal, Pencil, Plus, SquareArrowOutUpRight, Trash2 } from 'lucide-react'
import type { CanvasBoard, CanvasBoardSummary, StoredCommandResult, NavigationPreferencesSnapshot, NavigationProjectLayoutMutation } from '@contracts'
import { CanvasSurface, type CanvasLeaveGuard, type CanvasSurfaceProps } from './CanvasSurface'
import { CanvasBoardDialog } from './CanvasBoardDialog'
import { CanvasBoardPreview, canvasPreviewTint } from './CanvasBoardPreview'
import { CanvasBoardsController, initialCanvasBoardsState, type CanvasBoardIntent } from './canvas-boards-controller'
import { browserCanvasStorage, readCanvasViewScope, loadCanvasBoardSelection, saveCanvasBoardSelection, type CanvasViewScope } from './canvas-view-state'
import { useThreadClient } from './camp-client'
import { useCanvasReferences } from './useCanvasReferences'
import { UiText, uiAttribute, useInterfaceLanguage } from './interface-language'
import { readErrorMessage } from './error-message'
import { ProjectGroupsDialog } from './ProjectGroupsDialog'
import { runCanvasLeaveTransition, type CanvasLeavePreparation } from './canvas-leave'

export type CanvasWorkspaceProps = Omit<CanvasSurfaceProps, 'boardId' | 'scope' | 'catalog' | 'onRefreshReferences' | 'groups'> & {
  navigationPreferences?: NavigationPreferencesSnapshot | null
  onProjectLayout?(revision: number, mutation: NavigationProjectLayoutMutation): Promise<void>
  onRefreshProjectGroups?(): Promise<void>
}
const NO_BOARDS: CanvasBoard[] = []

// Codeg canvas-board-list.tsx BoardCard: silhouette, compact copy, count, edit time and a separate menu.
function BoardCard({ board, summary, name, now, blocked, onOpen, onEdit, onDelete }: {
  board: CanvasBoard; summary?: CanvasBoardSummary; name: string; now: number; blocked: boolean
  onOpen(): void; onEdit(): void; onDelete(): void
}) {
  const language = useInterfaceLanguage(), tint = canvasPreviewTint(board.color), at = Date.parse(board.updatedAt)
  const [menu, setMenu] = useState<'dropdown' | { x: number; y: number } | null>(null)
  const openButton = useRef<HTMLButtonElement | null>(null), returnFocus = useRef(false)
  const context = menu && typeof menu === 'object' ? menu : null
  const openContext = (x: number, y: number) => { if (!blocked) { returnFocus.current = false; setMenu({ x, y }) } }
  const items = <>
    <DropdownMenu.Item className="canvas-card-menu-item" disabled={blocked} onSelect={onOpen}><SquareArrowOutUpRight size={15} /><UiText zh="打开画板" /></DropdownMenu.Item>
    <DropdownMenu.Item className="canvas-card-menu-item" disabled={blocked} onSelect={onEdit}><Pencil size={15} /><UiText zh="编辑画板" /></DropdownMenu.Item>
    <DropdownMenu.Separator className="canvas-menu-separator" />
    <DropdownMenu.Item className="canvas-card-menu-item is-danger" disabled={blocked} onSelect={onDelete}><Trash2 size={15} /><UiText zh="删除画板" /></DropdownMenu.Item>
  </>
  let edited: string | null = null
  if (now && Number.isFinite(at)) {
    const seconds = Math.floor(Math.max(0, now - at) / 1000)
    const [unit, divisor] = seconds >= 86400 ? ['day', 86400] as const : seconds >= 3600 ? ['hour', 3600] as const
      : seconds >= 60 ? ['minute', 60] as const : ['second', 1] as const
    edited = new Intl.RelativeTimeFormat(language === 'en' ? 'en' : 'zh-CN', { numeric: 'auto' }).format(-Math.floor(seconds / divisor), unit)
  }
  return <article className="canvas-board-item" title={Number.isFinite(at) ? new Date(at).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN') : undefined}
    onContextMenu={event => { if ((event.target as HTMLElement).closest('[role="menu"]')) return; event.preventDefault(); openContext(event.clientX, event.clientY) }}>
    <button ref={openButton} className="canvas-board-tile" data-board-id={board.id} type="button" disabled={blocked} aria-label={name} onClick={onOpen}
      onKeyDown={event => { if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) { event.preventDefault(); event.stopPropagation(); const bounds = event.currentTarget.getBoundingClientRect(); openContext(bounds.left, bounds.bottom) } }} />
    <CanvasBoardPreview rects={summary?.preview ?? []} />
    {tint && <span className="canvas-board-color" style={{ background: tint }} aria-hidden="true" />}
    <div className="canvas-board-copy"><strong>{name}</strong>{board.description && <p>{board.description}</p>}
      <span className="canvas-board-meta">{summary ? uiAttribute('{0} 个节点', summary.nodeCount) : uiAttribute('统计暂不可用')}
        {edited && <> · <time dateTime={board.updatedAt}>{edited}</time></>}</span></div>
    <DropdownMenu.Root open={menu === 'dropdown'} onOpenChange={open => setMenu(current => open ? 'dropdown' : current === 'dropdown' ? null : current)}><DropdownMenu.Trigger asChild><button type="button" className="canvas-icon-button canvas-board-menu-trigger" disabled={blocked}
      aria-label={uiAttribute('画板操作：{0}', name)} title={uiAttribute('画板操作')}><MoreHorizontal size={16} /></button></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="canvas-card-menu" align="end" sideOffset={4} collisionPadding={12} loop>
        {items}
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    {/* Reuse Rovai ImageContextMenu's viewport anchor and Escape focus return. */}
    <DropdownMenu.Root open={Boolean(context)} onOpenChange={open => { if (!open) setMenu(current => typeof current === 'object' ? null : current) }}>
      {context && createPortal(<DropdownMenu.Trigger asChild><span className="attachment-context-anchor" style={{ left: context.x, top: context.y }} /></DropdownMenu.Trigger>, document.body)}
      <DropdownMenu.Portal><DropdownMenu.Content className="canvas-card-menu canvas-board-context-menu" aria-label={uiAttribute('画板操作：{0}', name)}
        align="start" side="right" sideOffset={4} collisionPadding={12} loop onKeyDown={event => event.stopPropagation()}
        onEscapeKeyDown={() => { returnFocus.current = true }} onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current) openButton.current?.focus({ preventScroll: true }); returnFocus.current = false }}>
        {items}
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
  </article>
}

function useCanvasBoards() {
  const client = useThreadClient(), controller = useRef<CanvasBoardsController | null>(null)
  const [owned, setOwned] = useState(() => ({ client, state: initialCanvasBoardsState() }))
  useEffect(() => {
    const current = new CanvasBoardsController(client)
    controller.current = current
    const unsubscribe = current.subscribe(() => setOwned({ client, state: current.getSnapshot() }))
    setOwned({ client, state: current.getSnapshot() }); current.start()
    const foreground = () => current.setVisible(document.visibilityState === 'visible')
    const poll = setInterval(() => { if (document.visibilityState === 'visible') void current.refresh().catch(() => undefined) }, 20_000)
    window.addEventListener('focus', foreground); document.addEventListener('visibilitychange', foreground)
    return () => {
      unsubscribe(); current.dispose(); if (controller.current === current) controller.current = null
      clearInterval(poll); window.removeEventListener('focus', foreground); document.removeEventListener('visibilitychange', foreground)
    }
  }, [client])
  return { controller, state: owned.client === client ? owned.state : initialCanvasBoardsState() }
}

export function CanvasWorkspace(props: CanvasWorkspaceProps): React.JSX.Element {
  const client = useThreadClient(), owner = useRef({ client, generation: 0 })
  if (owner.current.client !== client) owner.current = { client, generation: owner.current.generation + 1 }
  const [identity, setIdentity] = useState<{ client: typeof client; scope: CanvasViewScope | null; issue: string | null } | null>(null)
  const [identityAttempt, setIdentityAttempt] = useState(0)
  useEffect(() => {
    let disposed = false
    void readCanvasViewScope(client).then(scope => {
      if (!disposed) setIdentity({ client, scope, issue: scope ? null : uiAttribute('画布输入的所属信息不完整，请重新读取画板。') })
    }, error => { if (!disposed) setIdentity({ client, scope: null, issue: readErrorMessage(error) }) })
    return () => { disposed = true }
  }, [client, identityAttempt])
  if (identity?.client !== client) return <section className="canvas-workspace"><p role="status"><UiText zh="正在读取画板…" /></p></section>
  return <CanvasWorkspaceContent key={owner.current.generation} {...props} scope={identity.scope} identityIssue={identity.issue}
    onRetryIdentity={() => { setIdentity(null); setIdentityAttempt(current => current + 1) }} />
}

function CanvasWorkspaceContent({ scope, identityIssue, onRetryIdentity, onLeaveGuardChange, navigationPreferences, onProjectLayout, onRefreshProjectGroups, ...props }: CanvasWorkspaceProps & {
  scope: CanvasViewScope | null; identityIssue: string | null; onRetryIdentity(): void
}): React.JSX.Element {
  const [showBoards, setShowBoards] = useState(false), [query, setQuery] = useState('')
  const { controller, state } = useCanvasBoards(), [storage] = useState(browserCanvasStorage)
  const catalog = useCanvasReferences()
  const [selectedId, setSelectedId] = useState(() => loadCanvasBoardSelection(storage, scope))
  const [restoreRevision, setRestoreRevision] = useState(0)
  const [dialog, setDialog] = useState<{ board: CanvasBoard | null; remove: boolean } | null>(null)
  const [groupManager, setGroupManager] = useState(false)
  const [issue, setIssue] = useState<string | null>(null), panel = useRef(false), graphGuard = useRef<CanvasLeaveGuard | null>(null)
  const conversationRef = useRef(props.conversation); conversationRef.current = props.conversation
  const boards = state.snapshot?.boards ?? NO_BOARDS
  const summaries = useMemo(() => new Map(state.snapshot?.summaries?.map(summary => [summary.boardId, summary])), [state.snapshot])
  const [now, setNow] = useState(0), listVisible = !boards.length || showBoards
  useEffect(() => {
    if (!listVisible) return
    const tick = () => setNow(Date.now()); tick()
    const clock = setInterval(tick, 30_000); return () => clearInterval(clock)
  }, [listVisible])
  const selected = boards.find(board => board.id === selectedId) ?? null
  const registerGraphGuard = useCallback((guard: CanvasLeaveGuard | null) => { graphGuard.current = guard }, [])
  const isBlocked = useCallback(() => panel.current || Boolean(conversationRef.current?.opening || conversationRef.current?.restoring || controller.current?.getSnapshot().pending || graphGuard.current?.isBlocked()), [controller])
  const canLeave = useCallback(async () => {
    if (isBlocked()) { setIssue(uiAttribute('请先保存或取消编辑，并核对未完成的画布操作。')); return false }
    try { return await conversationRef.current?.suspend() ?? true }
    catch (error) { setIssue(readErrorMessage(error)); return false }
  }, [isBlocked])
  const prepareLeave = useCallback(async (): Promise<CanvasLeavePreparation> => {
    const bridge = conversationRef.current
    if (panel.current || controller.current?.getSnapshot().pending || bridge?.restoring
      || bridge?.opening && !bridge.leaving || !bridge?.leaving && graphGuard.current?.isBlocked()) {
      throw new Error(uiAttribute('请先保存或取消编辑，并核对未完成的画布操作。'))
    }
    return bridge?.prepareLeave() ?? { complete: async () => undefined }
  }, [controller])
  const transition = useCallback(async (action: () => void | boolean | Promise<void | boolean>, leaves = true): Promise<boolean> => {
    try { return await runCanvasLeaveTransition('canvas', { canLeave, isBlocked, prepareLeave }, action, () => leaves) }
    catch (error) { setIssue(readErrorMessage(error)); return false }
  }, [canLeave, isBlocked, prepareLeave])
  useEffect(() => {
    const guard = { canLeave, isBlocked, prepareLeave, resume: () => setRestoreRevision(value => value + 1) }
    onLeaveGuardChange?.(guard)
    const beforeUnload = (event: BeforeUnloadEvent) => { if (guard.isBlocked()) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', beforeUnload)
    return () => { onLeaveGuardChange?.(null); window.removeEventListener('beforeunload', beforeUnload) }
  }, [canLeave, isBlocked, prepareLeave, onLeaveGuardChange])
  useEffect(() => {
    if (state.loading || state.readError || !state.snapshot || selected || isBlocked() || props.conversation?.instances.length) return
    // No editor is leaving here. Starting a leave transaction would invalidate this effect itself.
    setSelectedId(current => current === selectedId ? boards[0]?.id ?? null : current)
  }, [state.loading, state.readError, state.snapshot, selected, selectedId, boards, isBlocked, props.conversation?.instances])
  useEffect(() => { if (selected) saveCanvasBoardSelection(storage, scope, selected.id) }, [selected, storage, scope])
  const openDialog = async (board: CanvasBoard | null, remove = false) => {
    await transition(() => { setIssue(null); panel.current = true; setDialog({ board: board ? structuredClone(board) : null, remove }) }, false)
  }
  const closeDialog = () => { if (!controller.current?.getSnapshot().pending) { panel.current = false; setDialog(null); setRestoreRevision(value => value + 1) } }
  const acceptReceipt = (result: StoredCommandResult) => {
    if (result.status === 'rejected') {
      const message = result.code === 'canvas.board.conflict' ? uiAttribute('画板已有新修改，此次操作未保存。请重新核对。') : uiAttribute('画板操作未完成，请核对输入后重试。')
      setIssue(message); throw new Error(message)
    }
    const board = result.payload.board as Partial<CanvasBoard> | undefined
    if (result.commandType === 'canvas.board.create' && typeof board?.id === 'string') { setSelectedId(board.id); setShowBoards(false) }
    if (result.commandType === 'canvas.board.delete' && result.payload.boardId === selectedId) setSelectedId(null)
    panel.current = false; setDialog(null); setIssue(null); setRestoreRevision(value => value + 1)
  }
  const save = async (intent: CanvasBoardIntent) => {
    if (!controller.current) throw new Error(uiAttribute('画板页面尚未准备好。'))
    let prepared: CanvasLeavePreparation | undefined
    try {
      prepared = await prepareBoardChange(intent)
      acceptReceipt(await controller.current.apply(intent))
      await prepared?.complete(true)
    } catch (error) { await prepared?.complete(false).catch(() => undefined); setIssue(readErrorMessage(error)); throw error }
  }
  const prepareBoardChange = (intent: CanvasBoardIntent) => {
    const bridge = conversationRef.current
    if (!bridge || intent.operation === 'canvas.boards.update') return undefined
    return bridge.prepareLeave(intent.operation === 'canvas.boards.delete'
      ? bridge.instances.filter(item => item.target.boardId === intent.command.boardId).map(item => item.key) : undefined)
  }
  const recover = async (retry: boolean) => {
    let prepared: CanvasLeavePreparation | undefined
    try {
      const current = controller.current
      if (!current) return
      const pending = current.getSnapshot().pending
      if (!pending) return
      prepared = await prepareBoardChange(pending)
      const receipt = await (retry ? current.retry() : current.reconcile())
      if (receipt) acceptReceipt(receipt)
      await prepared?.complete(Boolean(receipt))
    } catch (error) { await prepared?.complete(false).catch(() => undefined); setIssue(readErrorMessage(error)) }
  }
  const recovery = state.pending && <div className="canvas-notice" role="status"><UiText zh={state.pending.state === 'unknown' ? '原画板操作结果待核对。' : '正在保存画板…'} />
    {state.pending.state === 'unknown' && <><button type="button" onClick={() => { void recover(false) }}><UiText zh="核对结果" /></button>
      <button type="button" onClick={() => { void recover(true) }}><UiText zh="重试原操作" /></button></>}
  </div>
  const blocked = state.loading || Boolean(state.readError || state.pending || dialog || groupManager || props.conversation?.opening || props.conversation?.restoring)
  const groups = useMemo(() => navigationPreferences && !navigationPreferences.readError ? navigationPreferences.projectGroups.map(group => ({ id: group.id, label: group.name, color: group.color,
    projectPaths: group.projectPaths.filter(path => navigationPreferences.registeredProjects.includes(path) && !navigationPreferences.removedProjects.some(item => item.targetKey === `directory:${path}`)) })) : [], [navigationPreferences])
  const selectBoard = (id: string) => { void transition(() => { setSelectedId(id); setShowBoards(false); setIssue(null) }, id !== selectedId || showBoards) }
  const boardName = (board: CanvasBoard) => board.name || uiAttribute('未命名画布')
  const visibleBoards = boards.filter(board => `${boardName(board)}\n${board.description ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  // Codeg canvas-page / canvas-board-list, adapted to the existing Core controller and leave transaction.
  return <section className="canvas-workspace" aria-label={uiAttribute('画板工作区')}>
    <header className="canvas-boards-toolbar">
      <button className="canvas-breadcrumb-root" type="button" disabled={blocked} onClick={() => { void transition(() => setShowBoards(true)) }}><MapIcon size={16} /><UiText zh="无限画布" /></button>
      {selected && !showBoards && <><ChevronRight className="canvas-breadcrumb-separator" size={14} aria-hidden="true" /><DropdownMenu.Root>
        <DropdownMenu.Trigger asChild><button className="canvas-board-title" type="button" data-board-id={selected.id} disabled={blocked} aria-label={uiAttribute('画板操作')}>
          <span>{boardName(selected)}</span><ChevronDown size={14} aria-hidden="true" /></button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content className="canvas-card-menu" align="start" sideOffset={4} collisionPadding={12} loop onCloseAutoFocus={event => event.preventDefault()}>
          <DropdownMenu.Item className="canvas-card-menu-item" disabled={blocked} onSelect={() => { void openDialog(selected) }}><Pencil size={15} /><UiText zh="编辑画板" /></DropdownMenu.Item>
          <DropdownMenu.Item className="canvas-card-menu-item" disabled={blocked} onSelect={() => { void openDialog(null) }}><Plus size={15} /><UiText zh="新建画布" /></DropdownMenu.Item>
          {navigationPreferences && onProjectLayout && onRefreshProjectGroups && <DropdownMenu.Item className="canvas-card-menu-item" disabled={blocked} onSelect={() => { void transition(() => { panel.current = true; setGroupManager(true) }, false) }}><UiText zh="管理项目分组" /></DropdownMenu.Item>}
          <DropdownMenu.Separator className="canvas-menu-separator" />
          {boards.map(board => <DropdownMenu.Item key={board.id} className="canvas-card-menu-item" data-board-id={board.id} disabled={blocked} onSelect={() => selectBoard(board.id)}>{boardName(board)}</DropdownMenu.Item>)}
          <DropdownMenu.Separator className="canvas-menu-separator" />
          <DropdownMenu.Item className="canvas-card-menu-item is-danger" disabled={blocked} onSelect={() => { void openDialog(selected, true) }}><Trash2 size={15} /><UiText zh="删除画板" /></DropdownMenu.Item>
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root></>}
    </header>
    {identityIssue && <div className="canvas-notice" role="alert"><UiText zh="服务信息未核对，暂时不能展开对话输入。" /> {identityIssue}
      <button type="button" disabled={blocked} onClick={() => { void transition(onRetryIdentity) }}><UiText zh="重新核对服务" /></button></div>}
    {(issue || Boolean(state.readError)) && <div className="canvas-notice" role="alert">{issue || readErrorMessage(state.readError)}
      <button type="button" onClick={() => { void controller.current?.refresh().catch(() => undefined) }}><UiText zh="重新读取" /></button></div>}
    {!dialog && recovery}
    {!catalog.complete && <div className="canvas-notice" role={catalog.error ? 'alert' : 'status'}><UiText zh={catalog.error ? '对话清单读取未完成，已保留画布。' : '正在核对完整对话清单…'} />
      {Boolean(catalog.error) && <button type="button" onClick={() => { void catalog.refresh().catch(() => undefined) }}><UiText zh="重新载入对话" /></button>}
    </div>}
    {!state.snapshot && state.loading && <p role="status"><UiText zh="正在读取画板…" /></p>}
    {state.snapshot && (!boards.length || showBoards) && !state.loading && <div className="canvas-boards-home">
      <div className="canvas-home-heading"><div><h2><UiText zh="画布" />{Boolean(boards.length) && <span className="canvas-board-total">{boards.length}</span>}</h2><p><UiText zh="每个画布都是一块独立的无限画板，可以摆放区域、会话卡片、便签、文件和终端。" /></p></div>
        {Boolean(boards.length) && <div className="canvas-home-actions"><input type="search" value={query} onChange={event => setQuery(event.target.value)} aria-label={uiAttribute('搜索画板')} placeholder={uiAttribute('搜索画板')} />
          <button className="canvas-primary-button" type="button" disabled={blocked} onClick={() => { void openDialog(null) }}><Plus size={16} /><UiText zh="新建画布" /></button></div>}</div>
      {!boards.length ? <div className="canvas-workspace-empty"><MapIcon size={40} strokeWidth={1.5} aria-hidden="true" /><h3><UiText zh="还没有画布" /></h3>
        <p><UiText zh="新建一个画布，用空间方式梳理工作。每个画布都有自己的区域、卡片和便签。" /></p>
        <button className="canvas-primary-button" type="button" disabled={blocked} onClick={() => { void openDialog(null) }}><Plus size={16} /><UiText zh="新建画布" /></button></div>
        : <div className="canvas-board-scroll"><div className="canvas-board-grid">{visibleBoards.map(board => <BoardCard key={board.id} board={board} summary={summaries.get(board.id)} name={boardName(board)} now={now} blocked={blocked}
          onOpen={() => selectBoard(board.id)} onEdit={() => { void openDialog(board) }} onDelete={() => { void openDialog(board, true) }} />)}
          {!query.trim() && <button type="button" className="canvas-board-tile canvas-board-create" disabled={blocked} onClick={() => { void openDialog(null) }}><Plus size={24} /><UiText zh="新建画布" /></button>}
          {query.trim() && !visibleBoards.length && <p className="canvas-empty-copy"><UiText zh="没有匹配的画板" /></p>}</div></div>}
    </div>}
    {selectedId && !showBoards && <CanvasSurface {...props} boardId={selectedId} scope={scope} catalog={catalog} groups={groups} restoreRevision={restoreRevision}
      onRefreshReferences={() => { void catalog.refresh().catch(() => undefined) }} onLeaveGuardChange={registerGraphGuard} />}
    {dialog && <CanvasBoardDialog board={dialog.board} remove={dialog.remove}
      summary={dialog.board ? summaries.get(dialog.board.id) : undefined}
      latest={dialog.board ? boards.find(board => board.id === dialog.board!.id) ?? null : null}
      blocked={state.loading || Boolean(state.readError)} pending={Boolean(state.pending)} recovery={recovery}
      commandError={issue}
      onClose={closeDialog} onSave={save} />}
    {groupManager && navigationPreferences && onProjectLayout && onRefreshProjectGroups && <ProjectGroupsDialog snapshot={navigationPreferences}
      onSave={onProjectLayout} onRefresh={onRefreshProjectGroups} onClose={() => { panel.current = false; setGroupManager(false); setRestoreRevision(value => value + 1) }} />}
  </section>
}
