import { expect, it } from 'vitest'
import type { CanvasNode } from '@contracts'
import { canvasFileRequest } from './canvas-file'
import { parseFileReference } from '../../file-preview-reference'

const file = (path: string, threadId = 'original-thread') => ({ id: 'node', boardId: 'board', data: { kind: 'file', path, fileReference: { threadId } } }) as CanvasNode

it('keeps literal spaces, Unicode, percent, query, fragment and colon filenames distinct from locations', () => {
  for (const path of ['/工程/原文件 #?.txt ', '/workspace/100%.md', '/workspace/file:44', '/workspace/a\\b:12:7', '/workspace/a\nb.txt']) {
    const request = canvasFileRequest(file(path))
    expect(request.kind).toBe('camp_workspace')
    expect(request.threadId).toBe('original-thread')
    const parsed = parseFileReference('rawReference' in request ? request.rawReference : '')
    expect(parsed?.pathPart).toBe(path)
    expect(parsed?.target).toBeUndefined()
    expect(parsed?.query).toBeUndefined()
    expect(parsed?.fragment).toBeUndefined()
  }
})

it('preserves local-drive and UNC identity without guessing from the current browser platform', () => {
  for (const path of ['C:\\工程\\a #?.md', '\\\\server\\share\\原文件.md']) {
    const request = canvasFileRequest(file(path))
    expect(parseFileReference('rawReference' in request ? request.rawReference : '')?.pathPart).toBe(path.replace(/\\/g, '/'))
  }
})

it('refuses unbound, non-file, relative, malformed and oversized references instead of borrowing a Thread or changing paths', () => {
  const unbound = file('/original.txt'); delete unbound.data.fileReference
  expect(() => canvasFileRequest(unbound)).toThrow('绑定')
  expect(() => canvasFileRequest({ ...file('/original.txt'), data: { ...file('/original.txt').data, kind: 'note' } })).toThrow('绑定')
  for (const path of ['relative.txt', '/a\0b', '/'+ '文'.repeat(1000)]) expect(() => canvasFileRequest(file(path))).toThrow()
  for (const thread of ['', ' other', 'other\0']) expect(() => canvasFileRequest(file('/file', thread))).toThrow('绑定')
})
