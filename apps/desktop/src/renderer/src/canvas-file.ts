import type { CanvasNode, RestoreFilePreviewRequest } from '@contracts'
import { parseFileReference } from '../../file-preview-reference'
import { uiAttribute } from './interface-language'

/** Encode a literal saved path, never a line target, URL query, fragment, or directory grant. */
export function canvasFileRequest(node: CanvasNode): RestoreFilePreviewRequest {
  const path = node.data.path, owner = node.data.fileReference
  if (node.data.kind !== 'file' || !owner || !owner.threadId || owner.threadId.trim() !== owner.threadId || owner.threadId.length > 128 || owner.threadId.includes('\0') || !path || path.includes('\0')) {
    throw new Error(uiAttribute('文件节点尚未绑定原工程会话，请先选择来源。'))
  }
  const windows = /^[a-z]:[\\/]/i.test(path), unc = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(path)
  const normalized = windows || unc ? path.replace(/\\/g, '/') : path
  if (!windows && !unc && !normalized.startsWith('/')) throw new Error(uiAttribute('请提供文件的绝对路径。'))
  const encoded = normalized.split('/').map(encodeURIComponent).join('/').replace(/^([a-z])%3A\//i, '$1:/')
  const rawReference = unc ? encoded : `file://${windows ? '/' : ''}${encoded}`
  const parsed = parseFileReference(rawReference)
  if (rawReference.length > 4096 || !parsed || parsed.pathPart !== normalized || parsed.target || parsed.query || parsed.fragment) {
    throw new Error(uiAttribute('无法保留该文件的精确路径，请检查路径格式或长度。'))
  }
  return { kind: 'camp_workspace', threadId: owner.threadId, rawReference }
}
