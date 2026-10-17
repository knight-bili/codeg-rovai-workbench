// Behavior ported from Codeg aff1e6c terminal-node/terminal-view; Apache-2.0 notice: integration/licenses/codeg/LICENSE.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ClipboardPaste, Copy, Keyboard, Play, RefreshCw, RotateCcw, Square } from 'lucide-react'
import { CanvasIconButton } from './CanvasDock'
import type { Terminal, ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { CanvasNode } from '@contracts'
import { useThreadClient } from './camp-client'
import { canvasTerminalSession } from './canvas-terminal-sessions'
import { CanvasTerminalReader } from './canvas-terminal-reader'
import { UiText, uiAttribute } from './interface-language'
import { copyTerminalSelection, TERMINAL_KEYS, terminalKey, terminalModifiedInput } from './canvas-terminal-input'
import { readErrorMessage } from './error-message'

function terminalTheme(element: HTMLElement): ITheme {
  const style = getComputedStyle(element), token = (name: string) => style.getPropertyValue(name).trim() || style.color
  const colors = { black: token('--surface-sunken'), red: token('--danger'), green: token('--success'), yellow: token('--ember'),
    blue: token('--info'), magenta: token('--violet'), cyan: token('--brand'), white: token('--ink') }
  return { ...colors, background: token('--surface-raised'), foreground: token('--ink'), cursor: token('--ink'),
    cursorAccent: token('--surface-raised'), selectionBackground: token('--neutral-selected'), selectionForeground: token('--ink'),
    brightBlack: token('--muted'), brightRed: colors.red, brightGreen: colors.green, brightYellow: colors.yellow,
    brightBlue: colors.blue, brightMagenta: colors.magenta, brightCyan: colors.cyan, brightWhite: colors.white }
}
const phases = { missing: '尚未启动', starting: '正在启动', running: '运行中', stopping: '正在停止', exited: '已退出', failed: '启动失败' } as const
const emptySubscribe = () => () => undefined

export function CanvasTerminal({ row, scope, terminalVersion, disabled = false }: {
  row: CanvasNode; scope: string; terminalVersion: number | undefined; disabled?: boolean
}): React.JSX.Element {
  const client = useThreadClient(), box = useRef<HTMLDivElement | null>(null), terminal = useRef<Terminal | null>(null)
  const fit = useRef<(() => void) | null>(null), mods = useRef({ ctrl: false, alt: false })
  const [visible, setVisible] = useState(false), [foreground, setForeground] = useState(true)
  const [uiError, setUiError] = useState<string | null>(null), [showKeys, setShowKeys] = useState(false), [modifiers, setModifiers] = useState(mods.current)
  const [sessionAttempt, setSessionAttempt] = useState(0)
  const owned = useMemo(() => {
    if (terminalVersion !== 1) return { controller: null, error: uiAttribute('当前连接暂不支持画布终端，请升级服务后重试。') }
    try { return { controller: canvasTerminalSession(client, scope, { boardId: row.boardId, nodeId: row.id }, terminalVersion), error: null } }
    catch (error) { return { controller: null, error: readErrorMessage(error) } }
  }, [client, scope, row.boardId, row.id, terminalVersion, sessionAttempt])
  const controller = owned.controller
  const state = useSyncExternalStore(controller?.subscribe ?? emptySubscribe, controller?.getSnapshot ?? (() => null))

  useEffect(() => {
    const element = box.current
    if (!element) return
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)))
    observer.observe(element)
    const update = () => setForeground(document.visibilityState === 'visible')
    update(); document.addEventListener('visibilitychange', update)
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update) }
  }, [])

  useEffect(() => {
    if (!controller || !visible || !foreground) return
    let disposed = false, cleanup = () => {}, resizeTimer: ReturnType<typeof setTimeout> | undefined
    void (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-web-links')])
      if (disposed || !box.current) return
      const open = (_event: MouseEvent, uri: string) => {
        try { const url = new URL(uri); if (url.protocol === 'http:' || url.protocol === 'https:') window.open(url.href, '_blank', 'noopener,noreferrer') } catch { /* Invalid output is never a navigation target. */ }
      }
      const term = new Terminal({ cursorBlink: false, screenReaderMode: true, scrollback: 2000, disableStdin: true, allowProposedApi: true,
        theme: terminalTheme(box.current), fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', linkHandler: { activate: open } })
      const sizing = new FitAddon(); term.loadAddon(sizing); term.loadAddon(new WebLinksAddon(open)); term.open(box.current)
      terminal.current = term
      const reader = new CanvasTerminalReader({ reset: () => {
        term.reset()
        // The accessibility live region also belongs to this generation, not the previous shell.
        term.options.screenReaderMode = false; term.options.screenReaderMode = true
      }, write: (bytes, done) => term.write(bytes, done) }), detach = controller.attach(reader.apply)
      const measure = () => {
        const dimensions = sizing.proposeDimensions()
        if (dimensions && box.current && box.current.clientWidth > 0 && box.current.clientHeight > 0) {
          const cols = Math.max(1, Math.min(1000, dimensions.cols)), rows = Math.max(1, Math.min(1000, dimensions.rows))
          if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows)
          controller.resize({ cols, rows })
        }
      }
      fit.current = measure
      const appearance = () => {
        if (!box.current) return
        term.options.theme = terminalTheme(box.current)
        const size = Number.parseFloat(getComputedStyle(box.current).getPropertyValue('--code-preview-font-size'))
        if (Number.isFinite(size)) term.options.fontSize = size
        measure()
      }
      const themeObserver = new MutationObserver(appearance); themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] })
      const resizeObserver = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(measure, 80) }); resizeObserver.observe(box.current)
      const enqueueText = (text: string) => {
        if (text === '\x1b[I' || text === '\x1b[O') return
        const current = mods.current
        const modified = terminalModifiedInput(text, current)
        if (modified.consumed) { mods.current = { ctrl: false, alt: false }; setModifiers(mods.current) }
        controller.enqueue(new TextEncoder().encode(modified.out))
      }
      const data = term.onData(enqueueText), binary = term.onBinary(value => controller.enqueue(Uint8Array.from(value, byte => byte.charCodeAt(0))))
      term.attachCustomKeyEventHandler(event => {
        if (event.type !== 'keydown' || event.isComposing) return true
        const mac = client.platform === 'darwin', { code, altKey, ctrlKey, metaKey, shiftKey } = event
        let sequence: string | null = null
        if ((code === 'KeyC' || event.key.toLowerCase() === 'c') && (mac ? metaKey && !altKey && !ctrlKey : ctrlKey && shiftKey && !altKey && !metaKey)) {
          if (term.hasSelection()) void copyTerminalSelection(term).then(ok => { if (!ok && !disposed) setUiError(uiAttribute('复制失败，请使用系统复制快捷键。')) })
          event.preventDefault(); return false
        }
        if (altKey && !ctrlKey && !metaKey && !shiftKey) sequence = code === 'ArrowLeft' ? '\x1bb' : code === 'ArrowRight' ? '\x1bf' : code === 'Backspace' ? '\x1b\x7f' : null
        if (mac && metaKey && !altKey && !ctrlKey && !shiftKey) sequence = code === 'ArrowLeft' ? '\x01' : code === 'ArrowRight' ? '\x05' : code === 'Backspace' ? '\x15' : null
        if (sequence !== null) { enqueueText(sequence); event.preventDefault(); return false }
        return true
      })
      const refresh = () => { void controller.refresh() }
      let poll: ReturnType<typeof setTimeout> | undefined
      const tick = async () => {
        await controller.refresh()
        if (!disposed) schedule()
      }
      const schedule = () => {
        const state = controller.getSnapshot()
        poll = setTimeout(() => void tick(), state.readError ? 5000 : state.snapshot && ['running', 'starting', 'stopping'].includes(state.snapshot.phase) ? 500 : 3000)
      }
      window.addEventListener('focus', refresh)
      cleanup = () => {
        clearTimeout(poll); clearTimeout(resizeTimer); window.removeEventListener('focus', refresh)
        themeObserver.disconnect(); resizeObserver.disconnect(); data.dispose(); binary.dispose()
        detach(); reader.dispose(); fit.current = null; terminal.current = null; term.dispose()
      }
      appearance(); await controller.refresh(); if (!disposed) { measure(); schedule() }
    })().catch(error => { if (!disposed) setUiError(readErrorMessage(error)) })
    return () => { disposed = true; cleanup() }
  }, [controller, visible, foreground, client.platform])

  useEffect(() => { if (terminal.current) terminal.current.options.disableStdin = disabled || !controller?.inputReady() }, [state, disabled, controller])
  const current = state?.snapshot, busy = Boolean(disabled || state?.action)
  const canStart = Boolean(current && !state?.readError && !state?.startUnknown && (!current.exists || current.cleanupComplete && ['exited', 'failed'].includes(current.phase)))
  const canStop = Boolean(current?.generation && !current.cleanupComplete)
  const refresh = () => { setUiError(null); if (controller) void controller.refresh().then(() => fit.current?.()); else setSessionAttempt(value => value + 1) }
  const size = () => ({ cols: terminal.current?.cols ?? 80, rows: terminal.current?.rows ?? 24 })
  return <section className="canvas-terminal nodrag nowheel nopan" aria-label={uiAttribute('画布终端')} onKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
    <div className="canvas-terminal-toolbar">
      <span role="status" title={row.data.path ?? undefined}>{current ? uiAttribute(phases[current.phase]) : uiAttribute(owned.error ? '终端不可用' : '正在读取终端…')}</span>
      <CanvasIconButton label={uiAttribute(current?.exists ? '重新启动' : '启动终端')} disabled={busy || !canStart || !visible || !foreground} onClick={() => { setUiError(null); void controller?.start(size()) }}>{current?.exists ? <RotateCcw size={14} /> : <Play size={14} />}</CanvasIconButton>
      <CanvasIconButton label={uiAttribute('停止终端')} disabled={busy || !canStop} onClick={() => void controller?.stop()}><Square size={14} /></CanvasIconButton>
      <CanvasIconButton label={uiAttribute('重新读取')} disabled={busy || state?.reading} onClick={refresh}><RefreshCw size={14} /></CanvasIconButton>
      <CanvasIconButton label={uiAttribute('快捷键')} disabled={!controller} onClick={() => setShowKeys(value => !value)} aria-expanded={showKeys}><Keyboard size={14} /></CanvasIconButton>
      <CanvasIconButton label={uiAttribute('复制选区')} disabled={!terminal.current} onClick={() => { if (terminal.current?.hasSelection()) void copyTerminalSelection(terminal.current).then(ok => { if (!ok) setUiError(uiAttribute('复制失败，请使用系统复制快捷键。')) }) }}><Copy size={14} /></CanvasIconButton>
      <CanvasIconButton label={uiAttribute('粘贴')} disabled={busy || !controller?.inputReady()} onClick={() => { void navigator.clipboard.readText().then(value => terminal.current?.paste(value)).catch(() => setUiError(uiAttribute('无法读取剪贴板，请使用系统粘贴快捷键。'))) }}><ClipboardPaste size={14} /></CanvasIconButton>
    </div>
    {(owned.error || uiError || state?.readError || state?.actionError) && <p className="canvas-terminal-issue" role="alert">{owned.error || uiError || state?.readError || state?.actionError}</p>}
    {state?.startUnknown && <p className="canvas-terminal-issue"><UiText zh="启动结果尚未查明，不会另开会话。" /> <button type="button" disabled={busy || !!state.readError} onClick={() => void controller?.retryStart()}><UiText zh="重试原启动" /></button></p>}
    {state && ['unknown', 'not_written', 'expired'].includes(state.inputStatus) && <p className="canvas-terminal-issue"><UiText zh="上次输入尚未确认完整写入，后续未发送输入已丢弃；不会自动重发。" />
      <button type="button" disabled={busy || !controller?.canAcknowledgeInput()} onClick={() => controller?.acknowledgeInput()}><UiText zh="已知悉，继续输入" /></button></p>}
    {state?.inputStatus === 'waiting' && <p className="canvas-terminal-issue" role="status"><UiText zh="正在核对上次输入回执…" /></p>}
    {state?.outputTruncated && <p className="canvas-terminal-issue"><UiText zh="仅保留最近的终端输出，更早内容已丢弃。" /></p>}
    {current?.issue && <p className="canvas-terminal-issue" role="status"><UiText zh="终端运行或回收出现问题，请核对后重新读取。" /></p>}
    {current?.exitCode != null && <p className="canvas-terminal-issue">{uiAttribute('退出码：{0}', String(current.exitCode))}</p>}
    <div ref={box} className="canvas-terminal-emulator" />
    {showKeys && <div className="canvas-terminal-keys" role="toolbar" aria-label={uiAttribute('终端快捷键')}>
      {(['ctrl', 'alt'] as const).map(key => <button key={key} type="button" aria-pressed={modifiers[key]} onPointerDown={event => event.preventDefault()} onClick={() => { mods.current = { ...mods.current, [key]: !mods.current[key] }; setModifiers(mods.current); terminal.current?.focus() }}>{key === 'ctrl' ? 'Ctrl' : 'Alt'}</button>)}
      {TERMINAL_KEYS.map(([key, label]) => <button key={key} type="button" disabled={busy || !controller?.inputReady()} onPointerDown={event => event.preventDefault()} onClick={() => {
        controller?.enqueue(new TextEncoder().encode(terminalKey(key, mods.current, terminal.current?.modes.applicationCursorKeysMode))); mods.current = { ctrl: false, alt: false }; setModifiers(mods.current); terminal.current?.focus()
      }}>{label}</button>)}
    </div>}
  </section>
}
