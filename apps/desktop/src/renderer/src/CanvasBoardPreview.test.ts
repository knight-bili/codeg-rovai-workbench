import { expect, it } from 'vitest'
import { previewFrame, canvasPreviewTint } from './CanvasBoardPreview'
import type { CanvasBoardPreviewRect } from '@contracts'

const rect = (x: number, y: number, width = 224, height = 132): CanvasBoardPreviewRect => ({ kind: 'conversation', x, y, width, height, color: null })

it('keeps empty boards empty and a single small footprint centred with the original extent floor', () => {
  expect(previewFrame([])).toBeNull()
  const frame = previewFrame([rect(-200, 60)])!
  expect(frame.width).toBeCloseTo(1392); expect(frame.height).toBeCloseTo(835.2)
  expect(frame.x + frame.width / 2).toBeCloseTo(-88)
  expect(frame.y + frame.height / 2).toBeCloseTo(126)
})

it('contains every footprint across large negative and positive coordinates', () => {
  const rects = [rect(-1_000_000, -50, 20000, 20000), rect(1_000_000, 1_000_000, 400, 300)]
  const frame = previewFrame(rects)!
  for (const item of rects) {
    expect(frame.x).toBeLessThan(item.x); expect(frame.y).toBeLessThan(item.y)
    expect(frame.x + frame.width).toBeGreaterThan(item.x + item.width)
    expect(frame.y + frame.height).toBeGreaterThan(item.y + item.height)
  }
})

it('uses only the original preset colour variables for the silhouette', () => {
  expect(canvasPreviewTint('red')).toBe('var(--canvas-color-red)')
  expect(canvasPreviewTint(null)).toBeUndefined()
  expect(canvasPreviewTint('url(https://invalid.test)')).toBeUndefined()
})
