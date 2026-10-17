import { useEffect, useId, useRef, useState, type PointerEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { NavigationPreferencesSnapshot, NavigationProjectLayoutMutation } from '@contracts'
import { AppDialogBody, AppDialogContent, AppDialogFooter, AppDialogHeader } from './AppDialog'
import { UiText, uiAttribute } from './interface-language'
import { useCanvasFolders } from './useCanvasFolders'
import { createProjectLayout, locateProjectLayoutItem, moveProjectLayoutItem, projectLayoutEntries, projectLayoutPointerSlot,
  projectLayoutRelationIssue, projectLayoutSaved, projectLayoutSlots, projectLayoutSlotTarget,
  type ProjectLayoutItem, type ProjectLayoutTarget } from './navigation-project-layout'

const ROW_HEIGHT = 40

export function ProjectLayoutDialog({ snapshot, onSave, onRefresh, onClose }: {
  snapshot: NavigationPreferencesSnapshot
  onSave(revision: number, mutation: NavigationProjectLayoutMutation): Promise<void>
  onRefresh(): Promise<void>
  onClose(): void
}): React.JSX.Element {
  const paths = snapshot.registeredProjects.filter(path => !snapshot.removedProjects.some(item => item.targetKey === `directory:${path}`))
  const folders = useCanvasFolders(paths)
  const [base, setBase] = useState(() => structuredClone(snapshot))
  const [initial, setInitial] = useState(() => createProjectLayout(snapshot, folders.resolutions))
  const [layout, setLayout] = useState(initial)
  const [moving, setMoving] = useState<ProjectLayoutItem | null>(null), [target, setTarget] = useState<number | null>(null)
  const [busy, setBusy] = useState(false), [unknown, setUnknown] = useState(false), [reread, setReread] = useState(false)
  const [error, setError] = useState<string | null>(null), [discard, setDiscard] = useState(false)
  const writing = useRef(false), surface = useRef<HTMLDivElement>(null)
  const pointer = useRef<{ id: number; x: number; y: number; capture: HTMLDivElement } | null>(null)
  const targetRef = useRef<number | null>(null), focusKey = useRef<string | null>(null), slotId = useId()
  const slots = moving ? projectLayoutSlots(layout, moving) : []
  const dirty = JSON.stringify(layout) !== JSON.stringify(initial)
  const stale = base.projectGroupsRevision !== snapshot.projectGroupsRevision
  const relationIssue = projectLayoutRelationIssue(initial, layout, folders.resolutions)
  const blocked = Boolean(busy || snapshot.readError || stale || relationIssue || unknown)
  const names = new Map(base.projectGroups.map(group => [group.id, group.name]))
  const label = (item: ProjectLayoutItem) => item.kind === 'group' ? names.get(item.groupId) ?? item.groupId
    : base.projectNames[`directory:${item.projectPath}`] || item.projectPath
  const selectTarget = (index: number | null) => { if (targetRef.current !== index) { targetRef.current = index; setTarget(index) } }
  const endPointer = () => {
    const active = pointer.current
    pointer.current = null
    if (active?.capture.hasPointerCapture(active.id)) active.capture.releasePointerCapture(active.id)
  }
  const cancel = () => { endPointer(); setMoving(null); selectTarget(null) }
  const move = (item: ProjectLayoutItem, destination: ProjectLayoutTarget) => {
    const next = moveProjectLayoutItem(layout, item, destination)
    if (!projectLayoutRelationIssue(initial, next, folders.resolutions)) { setLayout(next); setError(null) }
    else setError(uiAttribute('工程关系已有变化或尚未核对，请重新读取后使用最新布局。'))
    cancel()
  }
  const drop = (index: number | null) => { if (moving && index !== null && slots[index]) move(moving, projectLayoutSlotTarget(layout, moving, slots[index])); else cancel() }
  const close = () => { if (writing.current) return; cancel(); if (dirty || unknown) setDiscard(true); else onClose() }
  const start = (item: ProjectLayoutItem) => {
    if (blocked || item.kind === 'project' && (!folders.resolutions.get(item.projectPath)?.complete || folders.resolutions.get(item.projectPath)?.parentPath)) return false
    focusKey.current = JSON.stringify(item); setMoving(item); selectTarget(0); setDiscard(false)
    return true
  }
  const beginPointer = (item: ProjectLayoutItem, event: PointerEvent<HTMLButtonElement>) => {
    const node = surface.current
    if (!node || event.button !== 0 || !event.isPrimary || !start(item)) return
    event.preventDefault()
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, capture: node }
    node.setPointerCapture(event.pointerId)
  }
  const updatePointer = (x: number, y: number) => {
    const node = surface.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    selectTarget(x < rect.left || x > rect.right || y < rect.top || y > rect.bottom ? null : projectLayoutPointerSlot(y, rect.top + node.clientTop, node.scrollTop, ROW_HEIGHT, slots.length))
  }
  useEffect(() => {
    if (!moving || !pointer.current) return
    let frame = 0
    const tick = () => {
      const active = pointer.current, node = surface.current
      if (active && node) {
        const rect = node.getBoundingClientRect()
        if (active.x >= rect.left && active.x <= rect.right && active.y >= rect.top && active.y <= rect.bottom) {
          const direction = active.y < rect.top + 28 ? -1 : active.y > rect.bottom - 28 ? 1 : 0
          if (direction) node.scrollTop += direction * 5
        }
        updatePointer(active.x, active.y)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [moving, slots.length])
  useEffect(() => () => endPointer(), [])
  useEffect(() => {
    if (!moving) return
    window.addEventListener('blur', cancel)
    return () => window.removeEventListener('blur', cancel)
  }, [moving])
  useEffect(() => {
    if (moving) surface.current?.focus()
    else if (focusKey.current) {
      const button = [...(surface.current?.querySelectorAll<HTMLButtonElement>('[data-layout-key]') ?? [])].find(node => node.dataset.layoutKey === focusKey.current)
      button?.focus(); focusKey.current = null
    }
  }, [moving])
  useEffect(() => {
    if (moving && target !== null && !pointer.current) {
      surface.current?.children[target]?.scrollIntoView({ block: 'nearest' })
    }
  }, [moving, target])
  const refresh = async () => {
    if (writing.current) return
    cancel(); writing.current = true; setBusy(true); setReread(false)
    try { await onRefresh(); await folders.refresh(); setReread(true); setError(null) }
    catch { setError(uiAttribute('布局读取失败，排列已保留。')) }
    finally { writing.current = false; setBusy(false) }
  }
  const useLatest = () => {
    if (writing.current || snapshot.readError || paths.some(path => !folders.resolutions.get(path)?.complete)) return
    const next = createProjectLayout(snapshot, folders.resolutions)
    setBase(structuredClone(snapshot)); setInitial(next); setLayout(next); setUnknown(false); setDiscard(false); setReread(false); setError(null)
  }
  const save = async () => {
    if (writing.current || blocked || !dirty || moving) return
    writing.current = true; setBusy(true); setError(null); setReread(false)
    try { await onSave(base.projectGroupsRevision, { type: 'layout', entries: projectLayoutEntries(layout) }); onClose() }
    catch { setUnknown(true); setError(uiAttribute('排列保存结果未确认，请重新读取后核对，暂不重复保存。')) }
    finally { writing.current = false; setBusy(false) }
  }
  const matched = unknown && reread && projectLayoutSaved(base, layout, snapshot)
  const grip = (item: ProjectLayoutItem) => <button type="button" className="project-layout-grip" data-layout-key={JSON.stringify(item)} disabled={blocked || item.kind === 'project' && !folders.resolutions.get(item.projectPath)?.complete}
    aria-label={uiAttribute('排列“{0}”', label(item))} onPointerDown={event => beginPointer(item, event)}
    onClick={event => { if (event.detail === 0) start(item) }}><span aria-hidden="true">⠿</span></button>
  return <Dialog.Root open onOpenChange={open => { if (!open) close() }}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay app-dialog-overlay" />
    <AppDialogContent width="wide" onEscapeKeyDown={event => { event.preventDefault(); if (moving) cancel(); else close() }} onPointerDownOutside={event => event.preventDefault()}>
      <AppDialogHeader title={uiAttribute('排列项目与分组')} description={uiAttribute('拖动手柄或按回车选择位置；方向键切换位置，回车放下，Esc 取消移动。保存后生效。')} closeDisabled={busy} />
      <AppDialogBody>
        {(error || snapshot.readError) && <p role="alert">{error || uiAttribute('布局暂时无法保存，原有记录已保留。')}</p>}
        {(stale || relationIssue) && <p role="status"><UiText zh="最新清单或工程关系已有变化。本次排列保留，请核对后使用最新布局重新排列。" /></p>}
        <div className="project-layout-actions"><button type="button" disabled={busy} onClick={() => { void refresh() }}><UiText zh="重新读取布局" /></button>
          {reread && <button type="button" disabled={busy || Boolean(snapshot.readError) || paths.some(path => !folders.resolutions.get(path)?.complete)} onClick={useLatest}><UiText zh="使用最新布局，放弃本次排列" /></button>}
          {matched && <button type="button" disabled={busy} onClick={onClose}><UiText zh="使用已保存布局" /></button>}</div>
        <p role="status" aria-live="polite">{moving ? uiAttribute('正在排列“{0}”', label(moving)) : uiAttribute('工作树跟随主工程，不单独排列。置顶工程在此排列其原位置。')}</p>
        <div ref={surface} className="project-layout-surface" tabIndex={moving ? 0 : -1} role={moving ? 'listbox' : 'group'} aria-label={uiAttribute('项目排列位置')}
          aria-activedescendant={moving && target !== null ? `${slotId}-${target}` : undefined}
          onPointerMove={event => { if (pointer.current?.id === event.pointerId) { pointer.current.x = event.clientX; pointer.current.y = event.clientY; updatePointer(event.clientX, event.clientY) } }}
          onPointerUp={event => { if (pointer.current?.id === event.pointerId) { updatePointer(event.clientX, event.clientY); drop(targetRef.current) } }}
          onPointerCancel={event => { if (pointer.current?.id === event.pointerId) cancel() }} onLostPointerCapture={event => { if (pointer.current?.id === event.pointerId) cancel() }}
          onKeyDown={event => {
            if (!moving || event.nativeEvent.isComposing) return
            if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(event.key)) event.preventDefault()
            if (event.key === 'Escape') cancel()
            else if (event.key === 'Enter' || event.key === ' ') drop(targetRef.current)
            else if (event.key === 'ArrowDown') selectTarget(Math.min(slots.length - 1, (targetRef.current ?? -1) + 1))
            else if (event.key === 'ArrowUp') selectTarget(Math.max(0, (targetRef.current ?? 1) - 1))
            else if (event.key === 'Home') selectTarget(0)
            else if (event.key === 'End') selectTarget(slots.length - 1)
          }}>
          {moving ? slots.map((slot, index) => <button key={index} id={`${slotId}-${index}`} type="button" tabIndex={-1} role="option" aria-selected={target === index} className={`project-layout-row project-layout-target${target === index ? ' is-target' : ''}`}
            data-depth={slot.target.groupId ? 1 : 0} onClick={() => { if (!pointer.current) drop(index) }}>
            {slot.item ? uiAttribute('放到“{0}”{1}', label(slot.item), moving.kind === 'project' && slot.item.kind === 'group' ? uiAttribute('组内开头') : slot.target.groupId ? uiAttribute('之后') : uiAttribute('之前'))
              : uiAttribute('顶层位置 {0}', slot.target.index + 1)}</button>)
            : layout.top.flatMap(item => item.kind === 'project' ? [<div key={item.projectPath} className="project-layout-row">{grip(item)}<span title={item.projectPath}>{label(item)}</span></div>]
              : [<div key={item.groupId} className="project-layout-row project-layout-group">{grip(item)}<strong>{label(item)}</strong></div>,
                ...layout.members[item.groupId].map(projectPath => <div key={projectPath} className="project-layout-row" data-depth="1">{grip({ kind: 'project', projectPath })}<span title={projectPath}>{label({ kind: 'project', projectPath })}</span></div>)])}
        </div>
        {discard && <div className="canvas-notice" role="alert"><p><UiText zh={unknown ? '保存结果仍需核对，请先重新读取布局。' : '排列尚未保存，确认放弃本次排列？'} /></p>
          {!unknown && <button type="button" onClick={onClose}><UiText zh="确认放弃排列" /></button>}
          <button type="button" onClick={() => setDiscard(false)}><UiText zh="继续排列" /></button></div>}
      </AppDialogBody>
      <AppDialogFooter><button type="button" disabled={busy} onClick={close}><UiText zh="返回分组清单" /></button>
        <button type="button" disabled={blocked || !dirty || Boolean(moving)} onClick={() => { void save() }}><UiText zh="保存排列" /></button></AppDialogFooter>
    </AppDialogContent>
  </Dialog.Portal></Dialog.Root>
}
