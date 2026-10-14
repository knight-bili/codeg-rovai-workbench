import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentProfile, SetSkillPackMembersCommand, SkillPackMembersView, StoredCommandResult } from '@contracts'
import { useThreadClient } from './camp-client'
import { MemberAvatar } from './MemberAvatar'
import { newCommandId } from '../../shared/command-id'
import { readErrorMessage } from './error-message'
import { UiText, uiAttribute } from './interface-language'

type PendingChoice = { commandId: string; command: SetSkillPackMembersCommand }

export function SkillPackMembersEditor({ skillId, agents, disabled, onBusy }: {
  skillId: string
  agents: AgentProfile[]
  disabled: boolean
  onBusy(value: boolean): void
}): React.JSX.Element {
  const client = useThreadClient()
  const [view, setView] = useState<SkillPackMembersView | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const generation = useRef(0)
  const locked = useRef(false)
  const pending = useRef<PendingChoice | null>(null)
  const load = useCallback(async (): Promise<void> => {
    const request = ++generation.current
    setLoading(true)
    try {
      const rows = await client.request<SkillPackMembersView[]>('skillPacks.members.list')
      if (request !== generation.current) return
      setView(rows.find(row => row.skillId === skillId) ?? null)
      setLoadError(null)
    } catch (reason) { if (request === generation.current) setLoadError(readErrorMessage(reason)) }
    finally { if (request === generation.current) setLoading(false) }
  }, [client, skillId])
  useEffect(() => { void load(); return () => { generation.current += 1 } }, [load])
  const available = agents.filter(agent => agent.presence !== 'removed')
  const visible = available.filter(agent => `${agent.displayName} ${agent.teamRole}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const selected = new Set(view?.memberIds ?? [])
  const save = async (memberIds: string[], retry?: PendingChoice): Promise<void> => {
    if (locked.current || !view || !view.installed || (pending.current && !retry)) return
    const before = view
    const request = retry ?? { commandId: newCommandId(), command: { skillId, memberIds, expectedVersion: view.version } }
    locked.current = true
    pending.current = request
    setSaving(true)
    onBusy(true)
    setError(null)
    setView({ ...view, memberIds: request.command.memberIds })
    try {
      const result = await client.request<StoredCommandResult>('skillPacks.members.set', request)
      pending.current = null
      if (result.status === 'applied' && typeof result.payload.version === 'string') {
        setView({ ...before, memberIds: result.payload.memberIds as string[], version: result.payload.version })
      } else {
        setView(before)
        setError(result.code === 'skill_pack.members.conflict'
          ? uiAttribute('配置或安装版本已变化，请按最新状态重试。')
          : result.code === 'skill_pack.members.not_installed'
            ? uiAttribute('技能包已卸载，请刷新安装状态。')
            : uiAttribute('队员配置已变化，请重新选择。'))
        await load()
      }
    } catch (reason) { setView(before); setError(readErrorMessage(reason)) }
    finally { locked.current = false; setSaving(false); onBusy(false) }
  }
  const unavailable = disabled || saving || loading || !view?.installed || !!pending.current
  return <details className="skill-pack-member-settings">
    <summary><UiText zh="队员选择" /> · {view ? uiAttribute('已选 {0} 人', String(view.memberIds.length)) : '—'}</summary>
    <p><UiText zh="选择会保存，实际投递尚未接入。" /></p>
    {loadError && <div className="rebuilt-skills-error" role="alert">{loadError}<button type="button" disabled={saving || loading} onClick={() => void load()}><UiText zh="重试" /></button></div>}
    {error && <div className="rebuilt-skills-error" role="alert">{error}{pending.current && <button type="button" disabled={saving} onClick={() => { if (pending.current) void save(pending.current.command.memberIds, pending.current) }}><UiText zh="重试保存" /></button>}</div>}
    <div className="skill-pack-member-tools">
      <input type="search" aria-label={uiAttribute('搜索队员')} placeholder={uiAttribute('搜索队员')} value={query} disabled={saving} onChange={event => setQuery(event.target.value)} />
      <button type="button" className="rebuilt-skill-action" disabled={unavailable || !visible.length} onClick={() => void save([...new Set([...selected, ...visible.map(agent => agent.agentId)])])}><UiText zh="全选" /></button>
      <button type="button" className="rebuilt-skill-action" disabled={unavailable || !visible.length} onClick={() => { const visibleIds = new Set(visible.map(agent => agent.agentId)); void save([...selected].filter(id => !visibleIds.has(id))) }}><UiText zh="取消全选" /></button>
    </div>
    {loading && !view ? <p><UiText zh="正在读取队员选择…" /></p> : !visible.length ? <p><UiText zh="没有匹配的队员。" /></p> : null}
    <div className="skill-pack-member-list">{visible.map(agent => <label key={agent.agentId}>
      <input type="checkbox" data-member-id={agent.agentId} aria-label={uiAttribute('选择队员 {0}', agent.displayName)} checked={selected.has(agent.agentId)} disabled={unavailable} onChange={event => { const next = new Set(selected); if (event.target.checked) next.add(agent.agentId); else next.delete(agent.agentId); void save([...next]) }} />
      <MemberAvatar agentId={agent.agentId} avatarRef={agent.avatarRef} displayName={agent.displayName} size="mention" decorative /><span><strong>{agent.displayName}</strong><small>{agent.teamRole}</small></span>
    </label>)}</div>
    {saving && <p role="status"><UiText zh="正在保存…" /></p>}
  </details>
}
