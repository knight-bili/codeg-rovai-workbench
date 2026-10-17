// Adapted from Codeg aff1e6c nodes/note-node.tsx; Apache-2.0: integration/licenses/codeg/LICENSE.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { CanvasNode, ResolvedTheme } from '@contracts'
import { browserCanvasStorage, type CanvasViewScope } from './canvas-view-state'
import { loadCanvasNoteDraft, saveCanvasNoteDraft, type CanvasNoteDraft, type CanvasNoteStorage } from './canvas-note-draft'
import { SafeMarkdown } from './SafeMarkdown'
import { UiText, uiAttribute } from './interface-language'
import { readErrorMessage } from './error-message'

export function CanvasNote({ row, revision, scope, theme, blocked, children, onDirtyChange, onSave }: {
  row: CanvasNode; revision: number; scope: CanvasViewScope | null; theme: ResolvedTheme; blocked: boolean; children: ReactNode
  onDirtyChange(dirty: boolean): void
  onSave(text: string, expectedRevision: number): Promise<void>
}): React.JSX.Element {
  const [storage] = useState(() => browserCanvasStorage() as CanvasNoteStorage | undefined)
  const [draft, setDraft] = useState(() => loadCanvasNoteDraft(storage, scope, row.boardId, row.id))
  const [text, setText] = useState(draft?.text ?? row.data.content ?? '')
  const [editing, setEditing] = useState(false), [saving, setSaving] = useState(false), [issue, setIssue] = useState<string | null>(null)
  const current = useRef(draft), editingRef = useRef(false), savingRef = useRef(false)
  const seed = useRef<CanvasNoteDraft | null>(null)
  const remote = row.data.content ?? ''
  const persist = (value: CanvasNoteDraft | null) => {
    // Write before scheduling React state: the last input must survive an immediate unmount.
    const stored = saveCanvasNoteDraft(storage, scope, row.boardId, row.id, value)
    current.current = value; setDraft(value); onDirtyChange(Boolean(value))
    if (value && !stored) setIssue(uiAttribute('本机副本保存失败，请先保存便笺再离开当前画布。'))
  }
  useEffect(() => {
    if (current.current?.text === remote && !savingRef.current) { persist(null); setIssue(null) }
    if (!editingRef.current && !current.current) setText(remote)
  }, [remote])
  useEffect(() => { onDirtyChange(Boolean(current.current)); return () => onDirtyChange(false) }, [onDirtyChange])
  const begin = () => {
    if (blocked || savingRef.current || !scope) return
    seed.current = current.current ?? { text: remote, baseline: remote, revision }
    editingRef.current = true; setEditing(true)
  }
  const commit = async (useLatest = false) => {
    editingRef.current = false; setEditing(false)
    const value = current.current
    if (!value || savingRef.current) { if (!value) setText(remote); return }
    if (blocked) { setIssue(uiAttribute('画布操作仍在处理中，草稿已保留，请稍后保存。')); return }
    if (!useLatest && (value.revision !== revision || value.baseline !== remote)) {
      setIssue(uiAttribute('画布已有修改，请核对已保存的文字后再保存草稿。')); return
    }
    const submitted = useLatest ? { ...value, baseline: remote, revision } : value
    savingRef.current = true; setSaving(true); setIssue(null); persist(submitted)
    try {
      await onSave(submitted.text, submitted.revision)
      if (current.current === submitted) { persist(null); setIssue(null) }
    } catch (error) { setIssue(readErrorMessage(error)) }
    finally { savingRef.current = false; setSaving(false) }
  }
  const stale = draft && (draft.revision !== revision || draft.baseline !== remote)
  return <article className="canvas-card canvas-card-note canvas-note-paper canvas-card-handle" data-color={row.data.color ?? undefined}
    tabIndex={0} aria-label={uiAttribute('便笺：{0}', row.data.title || uiAttribute('双击编辑文字'))}
    onDoubleClick={event => { if (!(event.target as HTMLElement).closest('a,button,input,textarea,summary')) begin() }}
    onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === 'F2')) { event.preventDefault(); event.stopPropagation(); begin() } }}>
    {children}
    {row.data.title && <strong className="canvas-note-title">{row.data.title}</strong>}
    {editing ? <textarea autoFocus className="canvas-note-editor nodrag nowheel nopan" aria-label={uiAttribute('编辑便笺文字')}
      value={text} readOnly={saving} placeholder={uiAttribute('写点什么…')}
      onChange={event => {
        const value = event.target.value; setText(value)
        persist(value === remote ? null : { ...(seed.current ?? { baseline: remote, revision }), text: value })
      }} onBlur={() => { void commit() }}
      onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape' && !event.nativeEvent.isComposing) event.currentTarget.blur() }} />
      : <div className="canvas-note-prose" onPointerDown={event => { if ((event.target as HTMLElement).closest('a,button,input,summary')) event.stopPropagation() }}>
        {text ? <SafeMarkdown theme={theme} mode="document">{text}</SafeMarkdown> : <p className="canvas-note-placeholder"><UiText zh="双击添加便笺" /></p>}
      </div>}
    {(issue || draft || saving) && <div className="canvas-note-status nodrag nowheel nopan" onPointerDown={event => event.stopPropagation()}>
      <p role={issue ? 'alert' : 'status'}>{issue || uiAttribute(saving ? '正在保存…' : '有未保存的草稿')}</p>
      {stale && <details><summary><UiText zh="查看已保存的文字" /></summary><pre>{remote || uiAttribute('（空）')}</pre></details>}
      {draft && !editing && <button type="button" disabled={blocked || saving} onClick={() => { void commit(Boolean(stale)) }}><UiText zh={stale ? '核对后保存草稿' : '保存草稿'} /></button>}
    </div>}
  </article>
}
