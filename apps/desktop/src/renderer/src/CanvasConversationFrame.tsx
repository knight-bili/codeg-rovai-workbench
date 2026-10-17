import type { ReactNode } from 'react'
import { ExternalLink, MessageSquare, PanelRight, PanelsTopLeft, X } from 'lucide-react'
import { CanvasIconButton } from './CanvasDock'
import type { CanvasConversationTarget } from './canvas-conversation'
import type { CanvasNode } from '@contracts'
import type { CanvasViewScope } from './canvas-view-state'
import type { ThreadLeavePreparation } from './ThreadWorkspace'
import type { CanvasLeavePreparation } from './canvas-leave'
import { UiText, uiAttribute } from './interface-language'

export interface CanvasConversationBridge {
  instances: Array<{ key: string; target: CanvasConversationTarget; content: ReactNode; busy: boolean }>
  opening: boolean
  leaving?: boolean
  restoring?: { boardId: string; completed: number; total: number } | null
  issue: string | null
  open(target: CanvasConversationTarget): Promise<boolean>
  close(keys?: readonly string[]): Promise<boolean>
  suspend(): Promise<boolean>
  prepareLeave(keys?: readonly string[]): Promise<CanvasLeavePreparation>
  restore(scope: CanvasViewScope, boardId: string, nodes: readonly CanvasNode[]): Promise<boolean>
  cancelRestore(): void
  prepare(keys: readonly string[]): Promise<ThreadLeavePreparation>
}

export function CanvasConversationFrame({ bridge, instance, title, orphaned = false, onOpenWorkspace }: {
  bridge: CanvasConversationBridge; instance: CanvasConversationBridge['instances'][number]; title: string; orphaned?: boolean; onOpenWorkspace(): void
}): React.JSX.Element {
  const { target, key, busy } = instance
  const inline = target.presentation === 'inline' && !orphaned
  return <section className={`canvas-conversation-frame nodrag nowheel nopan${inline ? ' is-inline' : ''}`} data-canvas-conversation-key={key} aria-label={uiAttribute('画布对话：{0}', title)}
    onKeyDown={event => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); void bridge.close([key]) }
      // Preserve document-level conversation shortcuts, while isolating canvas movement/deletion.
      if (['Escape', 'Delete', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) event.stopPropagation()
    }} onWheel={event => event.stopPropagation()}
    onPointerDown={event => event.stopPropagation()}>
    {!inline && <header className="canvas-conversation-heading">
      <MessageSquare size={16} aria-hidden="true" />
      <strong title={title}>{title}</strong>
      <CanvasConversationActions bridge={bridge} instance={instance} orphaned={orphaned} onOpenWorkspace={onOpenWorkspace} />
    </header>}
    {orphaned && <p className="canvas-notice" role="status"><UiText zh="原画布卡片已变更，当前对话保留在侧边，请先保存或收起。" /></p>}
    <div className="canvas-conversation-content" inert={busy} aria-busy={busy}>{instance.content}</div>
  </section>
}

export function CanvasConversationActions({ bridge, instance, orphaned = false, onOpenWorkspace }: {
  bridge: CanvasConversationBridge; instance: CanvasConversationBridge['instances'][number]; orphaned?: boolean; onOpenWorkspace(): void
}): React.JSX.Element {
  const { target, key } = instance, disabled = bridge.opening || Boolean(bridge.restoring)
  return <>
    {!orphaned && <CanvasIconButton className="nodrag" disabled={disabled} onClick={() => { void bridge.open({ ...target, presentation: target.presentation === 'inline' ? 'drawer' : 'inline' }) }}
      label={uiAttribute(target.presentation === 'inline' ? '移至侧边' : '放回画布')}>{target.presentation === 'inline' ? <PanelRight size={15} /> : <PanelsTopLeft size={15} />}</CanvasIconButton>}
    <CanvasIconButton className="nodrag" disabled={disabled} onClick={onOpenWorkspace} label={uiAttribute('打开完整工作区')}><ExternalLink size={15} /></CanvasIconButton>
    <CanvasIconButton className="nodrag" disabled={disabled} onClick={() => { void bridge.close([key]) }} label={uiAttribute('收起对话')}><X size={16} /></CanvasIconButton>
  </>
}
