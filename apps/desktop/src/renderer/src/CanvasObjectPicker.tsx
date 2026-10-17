import { useEffect, useRef, useState } from 'react'
import type { CanvasObjectReference, CanvasThreadReference, MissionChangedFile, MissionRecord, TaskListItem } from '@contracts'
import { useThreadClient } from './camp-client'
import { readCanvasDiffFiles, readCanvasObject, readCanvasTaskPage, type CanvasObjectTarget } from './canvas-object'
import { UiText, uiAttribute } from './interface-language'
import { readErrorMessage } from './error-message'

export function CanvasObjectPicker({ kind, threads, complete, onChange }: {
  kind: CanvasObjectReference['kind']; threads: readonly CanvasThreadReference[]; complete: boolean
  onChange(value: CanvasObjectTarget | null): void
}): React.JSX.Element {
  const client = useThreadClient(), [threadId, setThreadId] = useState(''), [retry, setRetry] = useState(0)
  const [mission, setMission] = useState<MissionRecord | null>(null), [tasks, setTasks] = useState<TaskListItem[]>([])
  const [taskId, setTaskId] = useState(''), [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null)
  const [diffFiles, setDiffFiles] = useState<MissionChangedFile[] | null>(null), [diffPath, setDiffPath] = useState('')
  const [diffLoading, setDiffLoading] = useState(false), [diffError, setDiffError] = useState<string | null>(null)
  const generation = useRef(0), morePending = useRef(false)
  const diffPending = useRef(false)
  const selectedThread = threads.find(thread => thread.threadId === threadId)
  const missionId = selectedThread?.missionId ?? null
  // The editor keys this picker by kind. Owner/Thread changes cancel every outstanding read and selection.
  useEffect(() => {
    const stamp = ++generation.current
    setMission(null); setTasks([]); setTaskId(''); setCursor(null); setError(null); morePending.current = false
    setDiffFiles(null); setDiffPath(''); setDiffLoading(false); setDiffError(null); diffPending.current = false
    if (!threadId || !selectedThread || kind !== 'task' && !missionId) { setLoading(false); return }
    setLoading(true)
    const load = kind === 'task'
      ? readCanvasTaskPage(client, threadId, null).then(page => { if (generation.current === stamp) { setTasks(page.tasks); setCursor(page.nextCursor) } })
      : readCanvasObject(client, { threadId, object: { kind: 'mission', missionId: missionId! } }, () => generation.current === stamp)
        .then(value => { if (value && value.kind !== 'task') setMission(value.mission) })
    void load.catch(failure => { if (generation.current === stamp) setError(readErrorMessage(failure)) })
      .finally(() => { if (generation.current === stamp) setLoading(false) })
    return () => { ++generation.current }
  }, [client, threadId, Boolean(selectedThread), missionId, kind, retry])
  useEffect(() => {
    const object: CanvasObjectReference | null = kind === 'task'
      ? tasks.some(task => task.taskId === taskId) ? { kind, taskId } : null
      : mission && mission.missionId === missionId && mission.threadId === threadId
        ? { kind, missionId: mission.missionId, ...(kind === 'mission_diff' && diffPath ? { path: diffPath } : {}) } : null
    const pathAvailable = !diffPath || diffFiles?.some(file => file.path === diffPath)
    onChange(!loading && !diffLoading && !error && pathAvailable && selectedThread && object ? { threadId, object } : null)
  }, [kind, tasks, taskId, mission, missionId, threadId, loading, diffLoading, diffPath, diffFiles, error, selectedThread, onChange])
  const loadDiff = async () => {
    if (!mission || diffPending.current) return
    const stamp = generation.current
    diffPending.current = true; setDiffLoading(true); setDiffError(null)
    try {
      const files = await readCanvasDiffFiles(client, mission.missionId)
      if (generation.current === stamp) setDiffFiles(files)
    } catch (failure) { if (generation.current === stamp) setDiffError(readErrorMessage(failure)) }
    finally { if (generation.current === stamp) { diffPending.current = false; setDiffLoading(false) } }
  }
  const more = async () => {
    if (!cursor || loading || morePending.current) return
    const stamp = generation.current, after = cursor
    morePending.current = true; setLoading(true); setError(null)
    try {
      const page = await readCanvasTaskPage(client, threadId, after)
      if (generation.current !== stamp) return
      if (page.tasks.some(task => tasks.some(previous => previous.taskId === task.taskId))) throw new Error(uiAttribute('任务分页未前进，请重新读取。'))
      setTasks(previous => [...previous, ...page.tasks]); setCursor(page.nextCursor)
    } catch (failure) { if (generation.current === stamp) setError(readErrorMessage(failure)) }
    finally { if (generation.current === stamp) { morePending.current = false; setLoading(false) } }
  }
  return <div className="canvas-object-picker">
    <label className="field-label"><UiText zh="所属对话" /><select value={threadId} onChange={event => {
      ++generation.current; onChange(null); setTaskId(''); setTasks([]); setMission(null); setDiffPath(''); setThreadId(event.target.value)
    }}>
      <option value="">{uiAttribute('请选择')}</option>{threads.map(thread => <option key={thread.threadId} value={thread.threadId} disabled={kind !== 'task' && !thread.missionId}>{thread.title}</option>)}
    </select></label>
    {kind === 'task' && threadId && <label className="field-label"><UiText zh="任务" /><select value={taskId} disabled={loading} onChange={event => setTaskId(event.target.value)}>
      <option value="">{uiAttribute('请选择')}</option>{tasks.map(task => <option key={task.taskId} value={task.taskId}>{task.title} · {task.taskId}</option>)}
    </select></label>}
    {mission && <p className="canvas-binding-summary">{mission.title} · {mission.missionId}</p>}
    {kind === 'mission_diff' && mission && <>
      <button type="button" disabled={diffLoading} onClick={() => { void loadDiff() }}><UiText zh="读取可固定的变更文件" /></button>
      {diffFiles && <label className="field-label"><UiText zh="定位文件（可选）" /><select value={diffPath} disabled={diffLoading} onChange={event => setDiffPath(event.target.value)}>
        <option value="">{uiAttribute('整个使命的累计变更')}</option>{diffFiles.map(file => <option key={file.id} value={file.path}>{file.path}</option>)}
        {diffPath && !diffFiles.some(file => file.path === diffPath) && <option value={diffPath} disabled>{diffPath}</option>}
      </select></label>}
      {diffPath && diffFiles && !diffFiles.some(file => file.path === diffPath) && <p role="alert"><UiText zh="原文件已不在当前变更清单中，保留卡片中的原路径。" /></p>}
      {diffError && <p role="alert">{diffError}</p>}
    </>}
    {loading && <p role="status"><UiText zh="正在读取原对象…" /></p>}
    {error && <p role="alert">{error}<button type="button" disabled={loading} onClick={() => { onChange(null); setRetry(value => value + 1) }}><UiText zh="重新读取" /></button></p>}
    {cursor && <button type="button" disabled={loading} onClick={() => { void more() }}><UiText zh="载入更多任务" /></button>}
    {!complete && <p className="canvas-notice"><UiText zh="对话清单尚未完整载入，当前结果仍在核对。" /></p>}
    <p className="canvas-empty-copy"><UiText zh="只保存原对象的引用；打开卡片不会启动队员。" /></p>
  </div>
}
