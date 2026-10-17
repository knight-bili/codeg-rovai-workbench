import { useRef, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { NAVIGATION_PROJECT_GROUP_COLORS, type NavigationPreferencesSnapshot, type NavigationProjectGroup, type NavigationProjectLayoutMutation } from '@contracts'
import { AppDialogBody, AppDialogContent, AppDialogFooter, AppDialogHeader } from './AppDialog'
import { canvasColorName } from './CanvasNodeEditor'
import { normalizeProjectDisplayName, projectDisplayNameError } from '../../shared/project-display-name'
import { UiText, uiAttribute } from './interface-language'
import { useCanvasFolders } from './useCanvasFolders'
import { projectGroupMembershipIssue } from './project-group-presentation'
import { ProjectLayoutDialog } from './ProjectLayoutDialog'

export type ProjectGroupInitialAction = { kind: 'edit' | 'delete'; group: NavigationProjectGroup; revision: number }

export function ProjectGroupsDialog({ snapshot, onSave, onRefresh, onClose, initialAction }: {
  snapshot: NavigationPreferencesSnapshot
  onSave(revision: number, mutation: NavigationProjectLayoutMutation): Promise<void>
  onRefresh(): Promise<void>
  onClose(): void
  initialAction?: ProjectGroupInitialAction | null
}): React.JSX.Element {
  const [editor, setEditor] = useState<{ mode: 'create' | 'update'; group: NavigationProjectGroup; revision: number } | null>(() => initialAction?.kind === 'edit'
    ? { mode: 'update', group: structuredClone(initialAction.group), revision: initialAction.revision } : null)
  const [arranging, setArranging] = useState(false)
  const [removal, setRemoval] = useState<{ group: NavigationProjectGroup; revision: number } | null>(() => initialAction?.kind === 'delete'
    ? { group: structuredClone(initialAction.group), revision: initialAction.revision } : null)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), saving = useRef(false)
  const active = snapshot.registeredProjects.filter(path => !snapshot.removedProjects.some(item => item.targetKey === `directory:${path}`))
  const folders = useCanvasFolders(active)
  const paths = [...new Set([...active, ...(editor?.group.projectPaths ?? [])])]
  const stale = !snapshot.readError && (editor?.revision ?? removal?.revision ?? snapshot.projectGroupsRevision) !== snapshot.projectGroupsRevision
  const targetId = editor?.mode === 'update' ? editor.group.id : removal?.group.id
  const missing = Boolean(!snapshot.readError && targetId && !snapshot.projectGroups.some(group => group.id === targetId))
  const previousMembers = snapshot.projectGroups.find(group => group.id === editor?.group.id)?.projectPaths ?? []
  const currentEditorGroup = snapshot.projectGroups.find(group => group.id === editor?.group.id)
  const saved = Boolean(!snapshot.readError && editor && currentEditorGroup && currentEditorGroup.name === normalizeProjectDisplayName(editor.group.name)
    && currentEditorGroup.color === editor.group.color && JSON.stringify(currentEditorGroup.projectPaths) === JSON.stringify(editor.group.projectPaths))
  const membershipIssue = projectGroupMembershipIssue(editor?.group.projectPaths ?? [], previousMembers, folders.resolutions)
  const blocked = busy || Boolean(snapshot.readError || stale || missing || membershipIssue)
  const close = () => { if (!saving.current) onClose() }
  const edit = (group?: NavigationProjectGroup) => {
    setError(null); setRemoval(null)
    setEditor({ mode: group ? 'update' : 'create', group: group ? structuredClone(group) : { id: crypto.randomUUID(), name: '', color: null, projectPaths: [] }, revision: snapshot.projectGroupsRevision })
  }
  const apply = async (revision: number, mutation: NavigationProjectLayoutMutation) => {
    if (saving.current) return
    saving.current = true; setBusy(true); setError(null)
    try { await onSave(revision, mutation); setEditor(null); setRemoval(null) }
    catch { setError(uiAttribute('分组操作未确认，请重新读取后核对。')) }
    finally { saving.current = false; setBusy(false) }
  }
  const refresh = async () => {
    if (saving.current) return
    saving.current = true; setBusy(true)
    try { await onRefresh(); await folders.refresh(); setError(null) } catch { setError(uiAttribute('分组清单读取失败，输入已保留。')) }
    finally { saving.current = false; setBusy(false) }
  }
  const save = (event: FormEvent) => {
    event.preventDefault()
    if (editor && !blocked && !projectDisplayNameError(editor.group.name)) void apply(editor.revision, { type: editor.mode, group: editor.group })
  }
  const change = (patch: Partial<NavigationProjectGroup>) => { if (editor) setEditor({ ...editor, group: { ...editor.group, ...patch } }) }
  if (arranging) return <ProjectLayoutDialog snapshot={snapshot} onSave={onSave} onRefresh={onRefresh} onClose={() => setArranging(false)} />
  return <Dialog.Root open onOpenChange={open => { if (!open) close() }}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay app-dialog-overlay" />
    <AppDialogContent width="wide" onEscapeKeyDown={event => { if (saving.current) event.preventDefault() }}
      onPointerDownOutside={event => { if (saving.current || editor || removal) event.preventDefault() }}>
      <AppDialogHeader title={uiAttribute('管理项目分组')} description={uiAttribute('分组保存在此设备或浏览器，不改动文件和对话。')} closeDisabled={busy} />
      <form className="app-dialog-form" onSubmit={save}>
        <AppDialogBody>
          {(error || snapshot.readError) && <p role="alert" className="rename-project-error">{error || uiAttribute('分组暂时无法保存，原有记录已保留。请重新读取。')}</p>}
          <button type="button" disabled={busy} onClick={() => { void refresh() }}><UiText zh="重新读取分组" /></button>
          {stale && <div className="canvas-notice" role="status"><UiText zh="分组已有新修改，输入已保留。请核对最新清单后继续。" />
            <details><summary><UiText zh="查看最新分组清单" /></summary><ul>{snapshot.projectGroups.map(group => <li key={group.id}>
              <strong>{group.name}</strong><span>{group.color ? uiAttribute(canvasColorName(group.color)) : uiAttribute('跟随主题')}</span>
              <ul>{group.projectPaths.map(path => <li key={path}><code>{path}</code></li>)}</ul>
            </li>)}</ul></details>
            <button type="button" disabled={busy || Boolean(missing || snapshot.readError)} onClick={() => {
              if (editor) setEditor({ ...editor, revision: snapshot.projectGroupsRevision })
              if (removal) {
                const latest = snapshot.projectGroups.find(group => group.id === removal.group.id)
                if (latest) setRemoval({ group: structuredClone(latest), revision: snapshot.projectGroupsRevision })
              }
            }}><UiText zh="已核对最新分组" /></button></div>}
          {missing && <p role="alert"><UiText zh="原分组已移除，不能用旧输入重新创建。" /></p>}
          {saved && <div className="canvas-notice" role="status"><UiText zh="最新分组与输入一致，可使用已保存结果。" />
            <button type="button" disabled={busy} onClick={() => { setEditor(null); setError(null) }}><UiText zh="使用已保存分组" /></button></div>}
          {removal && missing && <button type="button" disabled={busy} onClick={() => { setRemoval(null); setError(null) }}><UiText zh="当前清单已无此分组，返回清单" /></button>}
          {!editor && !removal && <>
            <button type="button" disabled={blocked || active.some(path => !folders.resolutions.get(path)?.complete)} onClick={() => setArranging(true)}><UiText zh="排列项目与分组" /></button>
            {active.some(path => !folders.resolutions.get(path)?.complete) && <p role="status"><UiText zh="工程关系尚未核对，排列入口将在核对完成后可用。" /></p>}
            <button type="button" disabled={blocked} onClick={() => edit()}><UiText zh="新建项目分组" /></button>
            {!snapshot.projectGroups.length && <p><UiText zh="还没有项目分组。" /></p>}
            <ul className="project-groups-list">{snapshot.projectGroups.map(group => <li key={group.id}>
              <span><strong>{group.name}</strong><small>{uiAttribute('{0} 个工程', group.projectPaths.length)}</small></span>
              <button type="button" disabled={blocked} onClick={() => edit(group)}><UiText zh="编辑" /></button>
              <button type="button" disabled={blocked} onClick={() => { setError(null); setRemoval({ group: structuredClone(group), revision: snapshot.projectGroupsRevision }) }}><UiText zh="删除" /></button>
            </li>)}</ul>
          </>}
          {removal && <div className="canvas-notice" role="alert"><p>{uiAttribute('删除分组“{0}”？工程将回到顶层，文件、使命和对话都会保留。', removal.group.name)}</p>
            <button type="button" disabled={blocked} onClick={() => { void apply(removal.revision, { type: 'delete', groupId: removal.group.id }) }}><UiText zh="确认删除分组" /></button>
            <button type="button" disabled={busy} onClick={() => setRemoval(null)}><UiText zh="取消" /></button>
          </div>}
          {editor && <>
            <label className="field-label"><UiText zh="分组名称" /><input data-dialog-autofocus value={editor.group.name} disabled={busy}
              onChange={event => change({ name: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }} /></label>
            {editor.group.name && projectDisplayNameError(editor.group.name) && <p role="alert"><UiText zh="分组名称需为1到80个字符。" /></p>}
            <label className="field-label"><UiText zh="分组颜色" /><select value={editor.group.color ?? ''} disabled={busy}
              onChange={event => change({ color: (event.target.value || null) as NavigationProjectGroup['color'] })}>
              <option value="">{uiAttribute('跟随主题')}</option>{NAVIGATION_PROJECT_GROUP_COLORS.map(color => <option key={color} value={color}>{uiAttribute(canvasColorName(color))}</option>)}
            </select></label>
            <fieldset className="project-groups-members"><legend><UiText zh="选择工程" /></legend>
              {membershipIssue && <p role="status"><UiText zh={membershipIssue === 'unverified' ? '所选工程的工作树关系尚未核对，暂不能新增关联。' : '此工作树跟随主工程，请先登记主工程再归组。'} /></p>}
              {!paths.length && <p><UiText zh="请先通过侧栏选择工作目录。" /></p>}
              {paths.map(path => {
                const selected = editor.group.projectPaths.includes(path), available = active.includes(path)
                const parent = folders.resolutions.get(path)?.parentPath
                const followsParent = Boolean(parent)
                const owner = snapshot.projectGroups.find(group => group.id !== editor.group.id && group.projectPaths.includes(path))
                return <label key={path}><input type="checkbox" checked={selected} disabled={busy || (!available || followsParent) && !selected}
                  onChange={event => change({ projectPaths: event.target.checked ? [...editor.group.projectPaths, path] : editor.group.projectPaths.filter(item => item !== path) })} />
                  <span>{snapshot.projectNames[`directory:${path}`] || path}{owner && !followsParent && <small>{uiAttribute('当前属于“{0}”，保存后移入本组。', owner.name)}</small>}
                    {!available && <small><UiText zh="工程已移除，原关联保留；取消勾选会明确移出。" /></small>}
                    {followsParent && <small><UiText zh="此工作树跟随主工程归组。" /></small>}</span></label>
              })}
            </fieldset>
          </>}
        </AppDialogBody>
        <AppDialogFooter>
          {editor && <><button type="button" disabled={busy} onClick={() => { setEditor(null); setError(null) }}><UiText zh="返回清单" /></button>
            <button type="submit" disabled={blocked || Boolean(projectDisplayNameError(editor.group.name))}><UiText zh="保存分组" /></button></>}
          {!editor && <button type="button" disabled={busy} onClick={close}><UiText zh="完成" /></button>}
        </AppDialogFooter>
      </form>
    </AppDialogContent>
  </Dialog.Portal></Dialog.Root>
}
