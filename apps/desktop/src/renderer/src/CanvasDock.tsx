// Adapted from Codeg canvas-dock.tsx at aff1e6c; Apache-2.0: integration/licenses/codeg/LICENSE.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { MiniMap, Panel, useReactFlow, useViewport } from '@xyflow/react'
import { CircleMinus, CirclePlus, Map as MapIcon } from 'lucide-react'
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM } from './canvas-view-state'
import { uiAttribute } from './interface-language'

export function CanvasIconButton({ label, children, pressed, ...props }: {
  label: string; children: ReactNode; pressed?: boolean
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'>): React.JSX.Element {
  return <button {...props} type="button" className={`canvas-icon-button${props.className ? ` ${props.className}` : ''}`}
    aria-label={label} title={label} aria-pressed={pressed}>{children}</button>
}

/** Keep the map and live zoom together, independent of the selection dock. */
export function CanvasViewportPanel({ minimap, onMinimapChange }: {
  minimap: boolean; onMinimapChange(visible: boolean): void
}): React.JSX.Element {
  const flow = useReactFlow(), { zoom } = useViewport()
  const pill = useRef<HTMLDivElement | null>(null), [width, setWidth] = useState(200)
  useLayoutEffect(() => {
    const element = pill.current
    if (!element) return
    const measure = () => setWidth(element.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure); observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const mapWidth = width || 200
  const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 150
  return <Panel position="bottom-right" className="canvas-viewport-panel">
    {minimap && <MiniMap pannable zoomable className="canvas-minimap" style={{ position: 'static', margin: 0, width: mapWidth, height: Math.round(mapWidth * .75) }} />}
    <div ref={pill} className="canvas-zoom-pill" role="toolbar" aria-label={uiAttribute('画布缩放控件')}>
      <CanvasIconButton label={uiAttribute('小地图')} pressed={minimap} onClick={() => onMinimapChange(!minimap)}><MapIcon size={16} /></CanvasIconButton>
      <span className="canvas-dock-divider" aria-hidden="true" />
      <CanvasIconButton label={uiAttribute('缩小画布')} disabled={zoom <= CANVAS_MIN_ZOOM + .001} onClick={() => { void flow.zoomOut({ duration }) }}><CircleMinus size={16} /></CanvasIconButton>
      <button type="button" className="canvas-zoom-readout" aria-label={uiAttribute('恢复到 100%')} title={uiAttribute('恢复到 100%')}
        onClick={() => { void flow.zoomTo(1, { duration }) }}>{Math.round(zoom * 100)}%</button>
      <CanvasIconButton label={uiAttribute('放大画布')} disabled={zoom >= CANVAS_MAX_ZOOM - .001} onClick={() => { void flow.zoomIn({ duration }) }}><CirclePlus size={16} /></CanvasIconButton>
    </div>
  </Panel>
}
