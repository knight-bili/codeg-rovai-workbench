import { describe, expect, it, vi } from 'vitest'
import type { RovaiApi, SingleChatComposerScope } from '@contracts'
import { matchesPrivateComposerScope, readScopedPrivateChat } from './private-composer-scope'

describe('私聊材料能力与归属', () => {
  const scope: SingleChatComposerScope = { kind: 'canvas', boardId: 'board-a', nodeId: 'node-a' }
  const snapshot = () => ({
    conversation: { id: 'private-a', threadId: 'thread-a' },
    draft: { scopeVersion: 1, scopeKey: 'canvas:board-a:node-a', composerScope: { ...scope } }
  })

  it('拒绝旧Core、错误版本和另一张卡片或私聊的回显', () => {
    const ready = snapshot()
    expect(matchesPrivateComposerScope(ready, 'thread-a', 'private-a', scope)).toBe(true)
    for (const value of [
      null, {}, { ...ready, draft: { revision: 0, quotes: [], attachments: [], updatedAt: null } },
      { ...ready, conversation: { ...ready.conversation, id: 'private-b' } },
      { ...ready, conversation: { ...ready.conversation, threadId: 'thread-b' } },
      { ...ready, draft: { ...ready.draft, scopeVersion: 2 } },
      { ...ready, draft: { ...ready.draft, scopeKey: '' } },
      { ...ready, draft: { ...ready.draft, composerScope: { ...scope, nodeId: 'node-b' } } },
      { ...ready, draft: { ...ready.draft, composerScope: { ...scope, boardId: 'board-b' } } }
    ]) expect(matchesPrivateComposerScope(value, 'thread-a', 'private-a', scope)).toBe(false)
    const defaultView = { ...ready, draft: { ...ready.draft, scopeKey: '', composerScope: null } }
    expect(matchesPrivateComposerScope(defaultView, 'thread-a', 'private-a', null)).toBe(true)
    expect(matchesPrivateComposerScope(defaultView, 'thread-a', 'private-a', scope)).toBe(false)
    expect(matchesPrivateComposerScope(ready, 'thread-a', 'private-a', null)).toBe(false)
  })

  it('固定请求归属，不写入、不自动降级；调用方后续修改不改变核对条件', async () => {
    let finish!: (value: unknown) => void
    const request = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const api = { request } as Pick<RovaiApi, 'request'>
    const changing = { ...scope }
    const pending = readScopedPrivateChat(api, 'thread-a', 'private-a', changing)
    changing.nodeId = 'node-b'
    finish(snapshot())
    await expect(pending).resolves.toEqual(snapshot())
    expect(request).toHaveBeenCalledExactlyOnceWith('singleChat.get', { conversationId: 'private-a', composerScope: scope })
    request.mockResolvedValueOnce({ conversation: { id: 'private-a', threadId: 'thread-a' }, draft: {} })
    await expect(readScopedPrivateChat(api, 'thread-a', 'private-a', null)).rejects.toThrow('scope_capability_required')
    request.mockResolvedValueOnce(null)
    await expect(readScopedPrivateChat(api, 'thread-a', 'missing', null)).resolves.toBeNull()
    expect(request.mock.calls).toHaveLength(3)
  })
})
