import { uiAttribute } from './interface-language'
import { memo, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { FilePreviewApi, ResolvedTheme, RestoreFilePreviewRequest } from '@contracts'
import { desktopFilePreviewApi } from './desktop-file-preview-api'
import { FilePreviewLayoutProvider, useOptionalFilePreviewLayout } from './FilePreviewLayout'
import { FileFindProvider } from './FilePreviewFind'
import { FilePreviewResources, windowFilePreviewResources } from './file-preview-resources'
import { FilePreviewPaneContent, FilePreviewSingleContent } from './FilePreviewPane'
import type { FilePreviewContextValue, FilePreviewSession, FilePreviewTabModel } from './file-preview-controller'
import { UiText } from './interface-language'
import { filePreviewSourceKey } from './file-preview-session'
export * from './file-preview-controller'

const FilePreviewApiContext = createContext<FilePreviewApi | null>(null)
const FilePreviewContext = createContext<FilePreviewContextValue | null>(null)
const HtmlPresentationContext = createContext<FilePreviewResources | null>(null)
const noSubscription = (): (() => void) => () => undefined
const emptyRevision = (): number => 0
const PreviewHostContext = createContext<((element: HTMLDivElement | null) => void) | null>(null)
const ExecutionPreviewHostContext = createContext<ReadonlyMap<string, HTMLDivElement>>(new Map())

function sessionValue(session: FilePreviewSession, resolvedTheme: ResolvedTheme): FilePreviewContextValue {
  const state = session.getSnapshot()
  return { ...state, ...session.actions, resolvedTheme, activeTab: state.tabs.find(tab => tab.id === state.activeTabId) ?? null }
}

const RetainedPane = memo(FilePreviewPaneContent)
function RetainedPreview({ session, resolvedTheme, current, bounds, resizing, missionActivity, registerExecutionHost, domScope, isFocusedSurface }: {
  session: FilePreviewSession; resolvedTheme: ResolvedTheme; current: boolean; bounds: CSSProperties | null; resizing: boolean; missionActivity?: ReactNode
  registerExecutionHost(threadId: string, element: HTMLDivElement | null): void
  domScope?: string; isFocusedSurface: boolean
}): React.JSX.Element {
  const state = session.getSnapshot()
  const value = useMemo(() => ({ ...sessionValue(session, resolvedTheme), isCurrentThread: current, domScope, isFocusedSurface }), [session, state, resolvedTheme, current, domScope, isFocusedSurface])
  const visible = current && value.paneVisible && !!bounds
  const executionHostRef = useCallback(
    (element: HTMLDivElement | null) => registerExecutionHost(session.threadId, element),
    [registerExecutionHost, session.threadId]
  )
  return <FilePreviewContext.Provider value={value}>
    <div className={`file-preview-retained-host${resizing ? ' is-resizing' : ''}`} hidden={!visible} inert={!visible}
      style={bounds ?? undefined} data-preview-camp={session.threadId}>
      <RetainedPane
        visible={visible}
        missionActivity={missionActivity}
        executionHostRef={executionHostRef}
      />
    </div>
  </FilePreviewContext.Provider>
}

function PreviewDeck({ resources, anchor, resolvedTheme, missionActivity, registerExecutionHost, contained, host, threadId, domScope, isFocusedSurface }: {
  resources: FilePreviewResources; anchor: HTMLDivElement | null; resolvedTheme: ResolvedTheme; missionActivity?: ReactNode
  registerExecutionHost(threadId: string, element: HTMLDivElement | null): void
  contained?: boolean; host: HTMLElement; threadId: string | null
  domScope?: string; isFocusedSurface: boolean
}): React.JSX.Element {
  const layout = useOptionalFilePreviewLayout()
  const [bounds, setBounds] = useState<CSSProperties | null>(null)
  useLayoutEffect(() => {
    if (!anchor) return
    const measure = (): void => {
      const bounds = anchor.getBoundingClientRect()
      if (!bounds.width || !bounds.height || !anchor.clientWidth) return
      const hostBounds = host.getBoundingClientRect()
      const scale = contained ? hostBounds.width / host.clientWidth : bounds.width / anchor.clientWidth
      if (!Number.isFinite(scale) || scale <= 0) return
      const rect = { left: (bounds.left - (contained ? hostBounds.left : 0)) / scale,
        top: (bounds.top - (contained ? hostBounds.top : 0)) / scale, width: bounds.width / scale, height: bounds.height / scale }
      setBounds(previous => previous?.left === rect.left && previous.top === rect.top
        && previous.width === rect.width && previous.height === rect.height ? previous
        : { left: rect.left, top: rect.top, width: rect.width, height: rect.height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(anchor)
    if (contained) observer.observe(host)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  }, [anchor, layout?.width, layout?.availableWidth, layout?.compact, contained, host])
  // The split context updates before a ResizeObserver delivery on a window resize.
  const width = layout?.workspace ? (layout.compact ? layout.availableWidth : Math.round(layout.width)) : undefined
  const positioned = bounds && {
    ...bounds, ...(contained ? { position: 'absolute' as const } : {}), width: width ?? bounds.width,
    left: typeof bounds.left === 'number' && typeof bounds.width === 'number' && width !== undefined
      ? bounds.left + bounds.width - width : bounds.left
  }
  return <>{[...resources.sessions.values()].filter(session => !contained || session.threadId === threadId).map(session => <RetainedPreview key={session.id} session={session}
    resolvedTheme={resolvedTheme} current={session.threadId === threadId} bounds={positioned} resizing={!!layout?.resizing}
    missionActivity={session.threadId === threadId ? missionActivity : null}
    registerExecutionHost={registerExecutionHost} domScope={domScope} isFocusedSurface={isFocusedSurface && session.threadId === threadId} />)}</>

}

export function FilePreviewProvider({ threadId, resolvedTheme, api: providedApi, children, missionActivity, contained = false }: {
  threadId: string | null; resolvedTheme: ResolvedTheme; api?: FilePreviewApi; children: ReactNode; missionActivity?: ReactNode; contained?: boolean
}): React.JSX.Element {
  const api = providedApi ?? (typeof window === 'undefined' || window.rovai ? desktopFilePreviewApi : null)
  if (!api) throw new Error(uiAttribute('共享文件页面缺少显式资源适配。'))
  const resources = useMemo(() => windowFilePreviewResources(api), [api])
  const owner = useRef({}).current
  const surfaceId = useId(), domScope = contained ? `canvas-${surfaceId}` : undefined
  const isFocusedSurface = resources.isFocused(owner)
  useSyncExternalStore(resources.subscribe, resources.getSnapshot, resources.getSnapshot)
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)
  const [deckHost, setDeckHost] = useState<HTMLElement>(document.body)
  const [executionHosts, setExecutionHosts] = useState<ReadonlyMap<string, HTMLDivElement>>(new Map())
  const registerAnchor = useCallback((element: HTMLDivElement | null): void => {
    setAnchor(element)
    if (element) setDeckHost(element.closest<HTMLElement>(contained ? '.file-preview-contained' : '.app-shell') ?? document.body)
  }, [contained])
  const registerExecutionHost = useCallback((targetThreadId: string, element: HTMLDivElement | null): void => {
    setExecutionHosts((current) => {
      if (current.get(targetThreadId) === element || (!element && !current.has(targetThreadId))) return current
      const next = new Map(current)
      if (element) next.set(targetThreadId, element)
      else next.delete(targetThreadId)
      return next
    })
  }, [])
  const session = resources.session(threadId ?? '')
  const state = session.getSnapshot()
  const value = useMemo(() => ({ ...sessionValue(session, resolvedTheme), domScope, isFocusedSurface }), [session, state, resolvedTheme, domScope, isFocusedSurface])
  useLayoutEffect(() => { resources.activate(threadId, owner); return () => resources.deactivate(owner) }, [resources, threadId, owner])
  useEffect(() => {
    const release = resources.retainOwner()
    const dispose = (): void => resources.dispose()
    window.addEventListener('beforeunload', dispose)
    return () => { window.removeEventListener('beforeunload', dispose); release() }
  }, [resources])
  const deck = createPortal(<PreviewDeck resources={resources} anchor={anchor} resolvedTheme={resolvedTheme} missionActivity={missionActivity}
    registerExecutionHost={registerExecutionHost} contained={contained} host={deckHost} threadId={threadId} domScope={domScope} isFocusedSurface={isFocusedSurface} />, deckHost)
  return <HtmlPresentationContext.Provider value={resources}><FilePreviewApiContext.Provider value={api}><FilePreviewContext.Provider value={value}>
    <FilePreviewLayoutProvider threadId={threadId} visible={!!threadId && value.paneVisible} activityMode={value.activeTab?.kind === 'mission_activity'}>
      <FileFindProvider activeTabId={value.activeTabId} visible={!!threadId && value.paneVisible && isFocusedSurface}>
        <ExecutionPreviewHostContext.Provider value={executionHosts}>
          <PreviewHostContext.Provider value={registerAnchor}>{contained ? <div className="file-preview-contained"
            onPointerDownCapture={() => resources.focus(threadId, owner)} onFocusCapture={() => resources.focus(threadId, owner)}>{children}{deck}</div> : <>{children}{deck}</>}</PreviewHostContext.Provider>
        </ExecutionPreviewHostContext.Provider>
      </FileFindProvider>
    </FilePreviewLayoutProvider>
  </FilePreviewContext.Provider></FilePreviewApiContext.Provider></HtmlPresentationContext.Provider>
}

/** A hidden deck must not create a second author document for a pinned file. */
export function useHtmlPreviewPresentation(host: { current: HTMLElement | null }): { presented: boolean; limited: boolean } {
  const resources = useContext(HtmlPresentationContext), owner = useRef({}).current
  useSyncExternalStore(resources?.subscribe ?? noSubscription, resources?.getSnapshot ?? emptyRevision, emptyRevision)
  useLayoutEffect(() => {
    if (!resources || !host.current) return
    const release = resources.retainHtmlPresentation(owner)
    const target = host.current.closest('.file-preview-html-version')?.parentElement ?? host.current
    const observer = new IntersectionObserver(entries => resources.presentHtml(owner,
      entries.some(entry => entry.isIntersecting) && target.getClientRects().length > 0 && getComputedStyle(target).visibility !== 'hidden'))
    observer.observe(target)
    return () => { observer.disconnect(); release() }
  }, [resources, owner, host])
  return { presented: !resources || resources.canPresentHtml(owner), limited: resources?.htmlPresentationLimited(owner) ?? false }
}

export function useFilePreview(): FilePreviewContextValue {
  const value = useContext(FilePreviewContext)
  if (!value) throw new Error('FilePreviewProvider is unavailable')
  return value
}
export function useOptionalFilePreview(): FilePreviewContextValue | null { return useContext(FilePreviewContext) }
export function useFilePreviewApi(): FilePreviewApi {
  const api = useContext(FilePreviewApiContext)
  if (!api) throw new Error('FilePreviewApi is unavailable')
  return api
}
export function usePreviewHost(): (element: HTMLDivElement | null) => void {
  const value = useContext(PreviewHostContext)
  if (!value) throw new Error('FilePreviewProvider is unavailable')
  return value
}
export function useExecutionPreviewHost(threadId: string): HTMLDivElement | null {
  return useContext(ExecutionPreviewHostContext).get(threadId) ?? null
}

/** A fixed file presentation shares the original Thread session and window resource pool. */
export function PinnedFilePreview({ api, source, resolvedTheme, actionsHost, onNavigate, onWorkspace }: {
  api: FilePreviewApi; source: RestoreFilePreviewRequest; resolvedTheme: ResolvedTheme
  actionsHost: HTMLElement | null
  onNavigate?: FilePreviewContextValue['open']
  onWorkspace?(tabId: string): Promise<void>
}): React.JSX.Element {
  const resources = useMemo(() => windowFilePreviewResources(api), [api])
  const owner = useRef({}).current, host = useRef<HTMLDivElement>(null), domScope = `file-card-${useId()}`
  useSyncExternalStore(resources.subscribe, resources.getSnapshot, resources.getSnapshot)
  const session = resources.session(source.threadId), state = session.getSnapshot()
  const [tabId, setTabId] = useState<string | null>(null), [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0), [visible, setVisible] = useState(false), [sourceMode, setSourceMode] = useState(false)
  const [armed, setArmed] = useState(false)
  const pending = useRef(false)
  const tab = state.tabs.find(item => item.id === tabId && item.kind === 'file') as FilePreviewTabModel | undefined
  const focus = () => { resources.focus(source.threadId, owner); if (tabId) resources.touch(session, tabId) }
  useLayoutEffect(() => {
    const release = resources.retainOwner()
    resources.presentFile(owner, source.threadId, null, false)
    resources.activate(source.threadId, owner)
    return () => { resources.deactivate(owner); release() }
  }, [resources, owner, source.threadId])
  useEffect(() => {
    if (!host.current) return
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)))
    observer.observe(host.current)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => { resources.presentFile(owner, source.threadId, tab?.id ?? null, visible, error ? undefined : filePreviewSourceKey(source)) }, [resources, owner, source, tab?.id, visible, error])
  useEffect(() => { if (visible) setArmed(true) }, [visible])
  useEffect(() => {
    if (!armed) return
    let current = true
    pending.current = true; setError(null); setTabId(null)
    void session.actions.open(source, undefined, undefined, { commitOnSuccess: true, previewOnly: true, revalidateSource: true, background: true }).then(outcome => {
      if (!current) return
      if (outcome.kind === 'preview') setTabId(outcome.tabId)
      else setError(outcome.kind === 'error' ? outcome.error.message : uiAttribute('无法在这里预览这个文件'))
    }).catch(() => { if (current) setError(uiAttribute('暂时无法读取文件')) })
      .finally(() => { if (current) pending.current = false })
    return () => { current = false }
  }, [session, source, retry, armed])
  useEffect(() => {
    if (tabId && !tab && !pending.current) { setTabId(null); setRetry(value => value + 1) }
  }, [tabId, tab])
  useEffect(() => { if (visible && tab?.loadState === 'cold') void session.actions.reopen(tab.id, true) }, [visible, tab?.id, tab?.loadState, session])
  const value: FilePreviewContextValue = { ...sessionValue(session, resolvedTheme), domScope,
    activeTab: tab ?? null, activeTabId: tab?.id ?? null, tabs: tab ? [tab] : [], paneVisible: true,
    isCurrentThread: true, isFocusedSurface: resources.isFocused(owner),
    open: (...args) => onNavigate ? onNavigate(...args) : Promise.resolve({ kind: 'error', error: { code: 'source_not_authorized', message: uiAttribute('当前页面无法打开关联文件。'), retryable: false } }) }
  const presented = useMemo(() => tab && sourceMode && tab.content?.kind === 'markdown'
    ? { ...tab, content: { kind: 'code' as const, text: tab.content.text } } : tab, [tab, sourceMode])
  return <HtmlPresentationContext.Provider value={resources}><FilePreviewApiContext.Provider value={api}><FilePreviewContext.Provider value={value}>
    <FileFindProvider activeTabId={tab?.id ?? null} visible={visible && resources.isFocused(owner)}>
      <div ref={host} className="canvas-file-preview" onPointerDownCapture={focus} onFocusCapture={focus}>
        {actionsHost && createPortal(<>
          {tab && <button type="button" title={uiAttribute('重新读取')} aria-label={uiAttribute('重新读取')} disabled={tab.isRefreshing} onClick={() => { void session.actions.reload(tab.id) }}><UiText zh="重读" /></button>}
          {tab?.content?.kind === 'markdown' && <button type="button" aria-label={uiAttribute(sourceMode ? '显示预览' : '显示源码')} aria-pressed={sourceMode} onClick={() => setSourceMode(value => !value)}><UiText zh={sourceMode ? '预览' : '源码'} /></button>}
          {tab?.file?.kind === 'html' && <button type="button" aria-label={uiAttribute(tab.htmlSourceMode ? '显示预览' : '显示源码')} aria-pressed={Boolean(tab.htmlSourceMode)} onClick={() => session.actions.toggleHtmlSource(tab.id)}><UiText zh={tab.htmlSourceMode ? '预览' : '源码'} /></button>}
          {tab && onWorkspace && <button type="button" title={uiAttribute('在工作区中操作')} aria-label={uiAttribute('在工作区中操作')} onClick={() => { void onWorkspace(tab.id).catch(() => setError(uiAttribute('暂时无法打开原文件工作区。'))) }}><UiText zh="工作区" /></button>}
          {tab?.file?.capabilities.includes('download') && <button type="button" aria-label={uiAttribute('下载文件')} onClick={() => { void session.actions.download(tab.id).then(result => { if (!result.ok) setError(result.error.message) }) }}><UiText zh="下载" /></button>}
        </>, actionsHost)}
        {error && <p className="canvas-notice" role="alert">{error}<button type="button" onClick={() => setRetry(value => value + 1)}><UiText zh="重试" /></button>
          {onNavigate && <button type="button" onClick={() => { void onNavigate(source).then(outcome => { if (outcome.kind === 'error') setError(outcome.error.message) }).catch(() => setError(uiAttribute('暂时无法打开原文件工作区。'))) }}><UiText zh="打开原文件" /></button>}</p>}
        {!presented && !error && <p role="status"><UiText zh="正在读取原文件…" /></p>}
        {presented && (resources.canPresentFile(owner, source.threadId, tab?.id) ? <FilePreviewSingleContent tab={presented} />
          : <p className="canvas-notice" role="status"><UiText zh="页面预览已达窗口上限，请先收起其他页面预览。" /></p>)}
      </div>
    </FileFindProvider>
  </FilePreviewContext.Provider></FilePreviewApiContext.Provider></HtmlPresentationContext.Provider>
}
