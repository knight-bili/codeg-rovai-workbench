import { useContext, useEffect, useRef } from 'react'
import type { CanvasFolderResolution } from './canvas-reference-model'
import { CanvasFolderContext } from './CanvasFolderProvider'

const EMPTY: ReadonlyMap<string, CanvasFolderResolution> = new Map()
const NO_REFRESH = () => Promise.resolve()
export function useCanvasFolders(paths: readonly string[]) {
  const context = useContext(CanvasFolderContext), token = useRef(Symbol('folder-consumer'))
  const register = context?.register, key = JSON.stringify([...new Set(paths)].sort())
  useEffect(() => register?.(token.current, JSON.parse(key)), [register, key])
  return { resolutions: context?.resolutions ?? EMPTY, refresh: context?.refresh ?? NO_REFRESH }
}
