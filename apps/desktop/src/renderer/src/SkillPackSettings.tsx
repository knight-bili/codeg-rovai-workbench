import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AgentProfile, SkillContentView, SkillPackCatalogView, SkillPackEntry, SkillPackFamily, SkillPackInstallationView, StoredCommandResult } from '@contracts'
import { useThreadClient } from './camp-client'
import { newCommandId } from '../../shared/command-id'
import { useCapabilitySplitter } from './useCapabilitySplitter'
import { SkillIdentityMark } from './SkillIdentityMark'
import { SafeMarkdown } from './SafeMarkdown'
import { skillReadingContent } from './SkillContentPreview'
import { SkillFileNavigation } from './SkillFileNavigation'
import { CapabilityDeleteDialog } from './CapabilityDeleteDialog'
import { SkillPackMembersEditor } from './SkillPackMembersEditor'
import { readErrorMessage } from './error-message'
import { UiText, uiAttribute, useInterfaceLanguage } from './interface-language'

const families: Array<[SkillPackFamily, string]> = [['experts', '专家'], ['science', '科研'], ['office', 'Office'], ['ui', '交互界面'], ['custom', '自定义']]
type PendingMutation = { method: 'skillPacks.install' | 'skillPacks.uninstall'; commandId: string; command: { skillId: string; expectedVersion: string; sourceRevision?: string } }

export function SkillPackSettings({ agents = [] }: { agents?: AgentProfile[] } = {}): React.JSX.Element {
  const client = useThreadClient()
  const language = useInterfaceLanguage()
  const id = useId()
  const { root, compact, separator } = useCapabilitySplitter('rovai.skill-pack-list-width.v1', `${id}-list ${id}-detail`)
  const [catalog, setCatalog] = useState<SkillPackCatalogView | null>(null)
  const [installations, setInstallations] = useState<SkillPackInstallationView[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [family, setFamily] = useState<SkillPackFamily | 'all'>('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [detailVisible, setDetailVisible] = useState(false)
  const [file, setFile] = useState({ skillId: '', path: 'SKILL.md' })
  const [preview, setPreview] = useState<{ skillId: string; path: string; value: SkillContentView } | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewRevision, setPreviewRevision] = useState(0)
  const [raw, setRaw] = useState(false)
  const generation = useRef(0)
  const locked = useRef(false)
  const pending = useRef<PendingMutation | null>(null)
  const title = useCallback((entry: SkillPackEntry) => entry.displayName[language] ?? entry.displayName.en ?? entry.id, [language])
  const description = useCallback((entry: SkillPackEntry) => entry.description[language] ?? entry.description.en ?? '', [language])
  const load = useCallback(async (): Promise<void> => {
    const request = ++generation.current
    setLoading(true)
    try {
      const [nextCatalog, nextInstallations] = await Promise.all([client.request<SkillPackCatalogView>('skillPacks.list'), client.request<SkillPackInstallationView[]>('skillPacks.installations.list')])
      if (request !== generation.current) return
      setCatalog(nextCatalog)
      setInstallations(nextInstallations)
    } catch (reason) {
      if (request === generation.current) setError(readErrorMessage(reason))
      throw reason
    } finally { if (request === generation.current) setLoading(false) }
  }, [client])
  useEffect(() => { void load().catch(() => {}); return () => { generation.current += 1 } }, [load])
  const visible = useMemo(() => (catalog?.entries ?? []).filter(entry => (family === 'all' || entry.family === family) && `${title(entry)} ${description(entry)} ${entry.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [catalog, family, query, title, description])
  const selected = visible.find(entry => entry.id === selectedId) ?? visible[0] ?? null
  const installed = installations.find(entry => entry.skillId === selected?.id)
  const path = file.skillId === selected?.id ? file.path : 'SKILL.md'
  const content = preview && preview.skillId === selected?.id && preview.path === path ? preview.value : null
  useEffect(() => {
    let cancelled = false
    setPreviewError(null)
    if (!selected || selected.contentSource !== 'embedded') { setPreview(null); return }
    void client.request<SkillContentView>('skillPacks.read', { skillId: selected.id, path })
      .then(value => { if (!cancelled) setPreview({ skillId: selected.id, path, value }) })
      .catch(reason => { if (!cancelled) setPreviewError(readErrorMessage(reason)) })
    return () => { cancelled = true }
  }, [client, selected?.id, selected?.contentSource, path, previewRevision])
  const mutate = async (method: PendingMutation['method'], skillId: string): Promise<void> => {
    if (locked.current || !catalog) return
    locked.current = true
    setBusy(skillId)
    setError(null)
    const current = installations.find(entry => entry.skillId === skillId)
    const request = pending.current?.method === method && pending.current.command.skillId === skillId ? pending.current : {
      method, commandId: newCommandId(), command: { skillId, expectedVersion: current?.version ?? 'absent', ...(method === 'skillPacks.install' ? { sourceRevision: catalog.commit } : {}) }
    }
    pending.current = request
    try {
      const result = await client.request<StoredCommandResult>(request.method, { commandId: request.commandId, command: request.command })
      pending.current = null
      await load()
      if (result.status === 'rejected') {
        setError(result.code === 'skill_pack.version_conflict' ? uiAttribute('安装状态已变化，请查看最新状态后重试。') : result.code === 'skill_pack.source_changed' ? uiAttribute('技能包来源已更新，请刷新后重试。') : result.code === 'skill_pack.source_not_bundled' ? uiAttribute('此技能包需要外部内容，暂不能安装。') : result.code)
      } else { setRemoveId(null) }
    } catch (reason) { setError(readErrorMessage(reason)) }
    finally { locked.current = false; setBusy(null) }
  }
  const status = (entry?: SkillPackInstallationView): string => !entry || entry.status === 'removed' ? '未安装' : entry.availability === 'modified' ? '有本地改动' : entry.availability === 'unavailable' ? '内容暂不可用' : '已安装'
  const removeEntry = catalog?.entries.find(entry => entry.id === removeId)
  return <div className="rebuilt-skills-page">
    <div className="rebuilt-runtime-bar"><label htmlFor={`${id}-family`}><UiText zh="技能包类型" /></label><select id={`${id}-family`} value={family} disabled={!!busy} onChange={event => { setFamily(event.target.value as typeof family); setDetailVisible(false) }}><option value="all">{uiAttribute('全部')}</option>{families.map(([key, label]) => <option key={key} value={key}>{uiAttribute(label)}</option>)}</select><button type="button" className="rebuilt-skill-action" disabled={loading || !!busy} onClick={() => { setError(null); void load().catch(() => {}) }}><UiText zh="刷新" /></button></div>
    <p className="skill-pack-stage-note"><UiText zh="可保存队员选择；实际投递尚未接入。" /></p>
    {error && !removeId && <div className="rebuilt-skills-error" role="alert">{error}<button type="button" disabled={loading || !!busy} onClick={() => { setError(null); void load().catch(() => {}) }}><UiText zh="重试" /></button></div>}
    <div ref={root} className="rebuilt-skills-columns" data-compact={compact}>
      <aside id={`${id}-list`} className={`rebuilt-skills-list ${detailVisible ? 'is-detail-visible' : ''}`}>
        <div className="rebuilt-skills-toolbar"><strong><UiText zh="技能包" /></strong><span>{visible.length}<UiText zh=" 项" /></span></div>
        <label className="rebuilt-skills-search"><span className="sr-only"><UiText zh="搜索技能包" /></span><input type="search" placeholder={uiAttribute('搜索技能包')} value={query} disabled={!!busy} onChange={event => setQuery(event.target.value)} /></label>
        {loading && !catalog ? <p className="rebuilt-skills-empty"><UiText zh="正在读取技能包…" /></p> : catalog && !visible.length ? <p className="rebuilt-skills-empty">{family === 'custom' ? uiAttribute('自定义技能的创作与导入尚未接入。') : uiAttribute('没有匹配的技能包。')}</p> : null}
        <div className="rebuilt-skills-list-scroll">{visible.map(entry => <button key={entry.id} type="button" className={`rebuilt-skill-row ${selected?.id === entry.id ? 'is-selected' : ''}`} disabled={!!busy} onClick={() => { setSelectedId(entry.id); setDetailVisible(true); setRaw(false) }}><SkillIdentityMark skillId={`codeg:${entry.id}`} name={entry.id} /><span><strong>{title(entry)}</strong><small>{description(entry)}</small></span><em>{uiAttribute(status(installations.find(item => item.skillId === entry.id)))}</em></button>)}</div>
      </aside>
      {separator}
      <section id={`${id}-detail`} className={`rebuilt-skills-detail ${detailVisible ? 'is-detail-visible' : ''}`} aria-label={uiAttribute('技能包预览')}>
        <button type="button" className="rebuilt-skills-back" onClick={() => setDetailVisible(false)}><UiText zh="返回列表" /></button>
        {selected ? <><header><h2>{title(selected)}</h2><p>{description(selected)}</p><div className="skill-pack-controls"><span>{uiAttribute(status(installed))}</span><button type="button" className="quiet-button" disabled={!!busy || selected.contentSource !== 'embedded' || loading} onClick={() => void mutate('skillPacks.install', selected.id)}>{busy === selected.id ? uiAttribute('正在处理…') : !installed || installed.status === 'removed' ? uiAttribute('安装') : installed.availability !== 'available' ? uiAttribute('保留旧版并重新安装') : installed.sourceRevision !== catalog?.commit ? uiAttribute('更新') : uiAttribute('刷新安装')}</button>{installed?.status === 'installed' && <button type="button" className="danger-button" disabled={!!busy || loading} onClick={() => { setError(null); setRemoveId(selected.id) }}><UiText zh="卸载" /></button>}</div>
          {selected.contentSource === 'embedded' && <p><UiText zh="预览展示随应用提供的来源正文。" /></p>}{selected.needsKey && <p><UiText zh="需要外部服务凭据。" /></p>}{selected.needsEnv && <p><UiText zh="可能需要额外运行环境；安装不会自动安装依赖。" /></p>}{selected.contentSource === 'officecli' && <p><UiText zh="此内容由 OfficeCLI 提供，当前尚未接入。" /></p>}{selected.requiredCapability === 'generative_ui_renderer' && <p><UiText zh="这里只提供指南，交互式渲染器尚未接入。" /></p>}
          <details className="skill-pack-provenance"><summary><UiText zh="来源与许可" /></summary><p>Codeg · {catalog?.commit.slice(0, 7)} · {selected.id}</p>{catalog?.notices.map(notice => <details key={notice.name}><summary>{notice.name}</summary><pre className="capability-source-code">{notice.content}</pre></details>)}</details>
          {installed?.status === 'installed' && <SkillPackMembersEditor key={selected.id} skillId={selected.id} agents={agents} disabled={!!busy} onBusy={value => setBusy(value ? selected.id : null)} />}
        </header><div className="rebuilt-skills-content">{selected.contentSource === 'embedded' && <><SkillFileNavigation files={content?.files ?? []} path={path} onSelect={next => { setFile({ skillId: selected.id, path: next }); setRaw(false) }}>{/\.(?:md|markdown)$/iu.test(path) && <div className="capability-view-modes" role="group" aria-label={uiAttribute('Skill 预览方式')}><button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}><UiText zh="阅读" /></button><button type="button" aria-pressed={raw} onClick={() => setRaw(true)}><UiText zh="源码" /></button></div>}</SkillFileNavigation>{previewError ? <div className="rebuilt-skills-error" role="alert">{previewError}<button type="button" onClick={() => setPreviewRevision(value => value + 1)}><UiText zh="重试" /></button></div> : !content ? <p className="rebuilt-skills-empty"><UiText zh="正在读取正文…" /></p> : content.status === 'too_large' ? <p className="rebuilt-skills-empty"><UiText zh="该文件较大，暂不支持正文预览。" /></p> : content.status === 'binary' ? <p className="rebuilt-skills-empty"><UiText zh="该文件不是文本文件。" /></p> : raw || !/\.(?:md|markdown)$/iu.test(path) ? <pre className="capability-source-code">{content.content}</pre> : <SafeMarkdown className="capability-reading" mode="document">{skillReadingContent(content.content ?? '')}</SafeMarkdown>}</>}</div></> : <p className="rebuilt-skills-empty"><UiText zh="选择一项技能包查看正文。" /></p>}
      </section>
    </div>
    <CapabilityDeleteDialog open={!!removeEntry} title={uiAttribute('卸载技能包')} description={removeEntry ? `${title(removeEntry)} · ${uiAttribute('保留文件和历史版本，稍后可重新安装。')}` : ''} busy={!!busy} error={removeId ? error : null} actionLabels={{ confirm: '确认卸载', busy: '正在卸载…' }} onCancel={() => { if (!busy) { setRemoveId(null); setError(null) } }} onConfirm={() => { if (removeId) void mutate('skillPacks.uninstall', removeId) }} />
  </div>
}
