// Fixed read-only file-card behavior follows Codeg aff1e6c278453ed8d0b96a5f664edcdca621aa3f
// src/components/canvas/nodes/file-node.tsx; license: integration/licenses/codeg/LICENSE.
import { useMemo } from 'react'
import type { CanvasNode, FilePreviewApi, ResolvedTheme } from '@contracts'
import { PinnedFilePreview } from './FilePreviewContext'
import type { FilePreviewContextValue } from './file-preview-controller'
import { canvasFileRequest } from './canvas-file'
import { readErrorMessage } from './error-message'

export function CanvasFilePreview({ row, api, theme, actionsHost, onNavigate, onWorkspace }: {
  row: CanvasNode; api: FilePreviewApi; theme: ResolvedTheme
  actionsHost: HTMLElement | null
  onNavigate?(threadId: string, ...args: Parameters<FilePreviewContextValue['open']>): ReturnType<FilePreviewContextValue['open']>
  onWorkspace?(threadId: string, tabId: string): Promise<void>
}): React.JSX.Element {
  const frozen = useMemo(() => {
    try { return { source: canvasFileRequest(row), error: null } }
    catch (error) { return { source: null, error: readErrorMessage(error) } }
  }, [row.data.fileReference?.threadId, row.data.path])
  if (!frozen.source) return <p role="alert">{frozen.error}</p>
  const source = frozen.source
  return <PinnedFilePreview key={JSON.stringify(source)} api={api} source={source} resolvedTheme={theme} actionsHost={actionsHost}
    onNavigate={onNavigate ? (...args) => onNavigate(source.threadId, ...args) : undefined}
    onWorkspace={onWorkspace ? tabId => onWorkspace(source.threadId, tabId) : undefined} />
}
