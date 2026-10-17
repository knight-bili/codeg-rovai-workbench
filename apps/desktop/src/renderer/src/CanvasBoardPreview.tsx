// Adapted from Codeg aff1e6c canvas-board-preview.tsx; Apache-2.0: integration/licenses/codeg/LICENSE.
import { memo } from 'react'
import { Map as MapIcon } from 'lucide-react'
import type { CanvasBoardPreviewRect } from '@contracts'
import { canvasColors } from './CanvasNodeEditor'
import { isRegionKind } from './canvas-layout'

export const canvasPreviewTint = (color: string | null) => color && canvasColors.includes(color as typeof canvasColors[number])
  ? `var(--canvas-color-${color})` : undefined

export function previewFrame(rects: readonly CanvasBoardPreviewRect[]) {
  if (!rects.length) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const rect of rects) {
    minX = Math.min(minX, rect.x); minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.width); maxY = Math.max(maxY, rect.y + rect.height)
  }
  const width = Math.max(maxX - minX, 1200), height = Math.max(maxY - minY, 720)
  return { x: (minX + maxX) / 2 - width * .58, y: (minY + maxY) / 2 - height * .58, width: width * 1.16, height: height * 1.16 }
}

export const CanvasBoardPreview = memo(function CanvasBoardPreview({ rects }: { rects: readonly CanvasBoardPreviewRect[] }) {
  const frame = previewFrame(rects)
  return <div className="canvas-board-preview" aria-hidden="true">
    {frame ? <svg viewBox={`${frame.x} ${frame.y} ${frame.width} ${frame.height}`} preserveAspectRatio="xMidYMid meet">
      {rects.map((rect, index) => {
        const region = isRegionKind(rect.kind), terminal = rect.kind === 'terminal', tint = canvasPreviewTint(rect.color)
        return <rect key={index} x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx={region ? 22 : 12}
          fill={terminal ? 'var(--muted)' : tint ?? (region ? 'var(--muted)' : 'var(--surface)')}
          fillOpacity={terminal ? .55 : region ? tint ? .14 : .06 : tint ? .35 : 1}
          stroke={region && tint ? tint : 'var(--ink)'} strokeOpacity={.22} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      })}
    </svg> : <MapIcon size={28} strokeWidth={1.5} />}
  </div>
})
