import { afterEach, expect, it, vi } from 'vitest'
import type { AgentRunExecutionEvidenceView, CoreMethod } from '@contracts'
import { ExecutionWindow } from '../../desktop/src/renderer/src/execution-window'
import { ConsoleClient } from './client'
import { createThreadAdapter } from './camp-adapter'

// Owns the production Web adapter + execution window seam. A Host-only HTTP
// test bypasses this adapter's allowlist; a populated page hides missing deltas.
afterEach(() => vi.unstubAllGlobals())
it.each([false, true])('恢复与结束准备分别按服务端能力开放（结束能力 %s）', async lifecycle => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  vi.stubGlobal('sessionStorage', storage); vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('navigator', { platform: 'Win32' })
  vi.stubGlobal('window', { sessionStorage: storage, history: { state: null } })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const id = '00000000-0000-4000-8000-000000000001', conversationId = '00000000-0000-4000-8000-000000000002'
  const input = { commandId: id, threadId: 'rvcamp_0000000000e008000000000001', expectedRevision: 0,
    target: { kind: 'single_chat' as const, conversationId } }
  const paths: string[] = []
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    if (String(url).endsWith('/login')) return Response.json({ protocolVersion: 4, token: 'a'.repeat(64), clientId: 'b'.repeat(64), editorProof: 'c'.repeat(64), ownerId: 'owner', privateUploadRecoveryVersion: 1, ...(lifecycle ? { privateUploadLifecycleVersion: 1 } : {}) })
    paths.push(new URL(String(url)).pathname)
    if (String(url).endsWith('/uploads')) {
      expect(JSON.parse(String((options!.body as FormData).get('intent')))).toMatchObject(input)
      return Response.json({ draft: null })
    }
    return Response.json({ state: 'recorded', receipt: { commandId: id, commandType: 'camp.source_attachment.upload.bind', status: 'applied', code: 'attachment.upload_bound',
      payload: { attachmentRefId: id }, resultEntity: null, recordedAt: '2026-10-16T00:00:00Z' } })
  })
  const transport = new ConsoleClient('http://localhost:4317', fetcher)
  await transport.login('d'.repeat(64))
  const { client } = createThreadAdapter(transport, async () => null).environment
  const api = client.singleChatAttachments
  expect(typeof api.finishInput).toBe(lifecycle ? 'function' : 'undefined')
  expect(await api.prepareInput!(input, new File(['input'], 'input.txt'))).toMatchObject({ state: 'recorded' })
  expect(await api.pendingPreparations!({ threadId: input.threadId, conversationId, composerScope: null })).toHaveLength(1)
  expect(await api.reconcileInput!(input)).toMatchObject({ state: 'recorded' })
  expect(await api.retryInput!(input)).toMatchObject({ state: 'recorded' })
  if (lifecycle) expect(await api.finishInput!(input)).toMatchObject({ state: 'recorded' })
  expect(paths).toEqual(['/api/v1/uploads', '/api/v1/uploads/receipt'])
  transport.clear()
})

it('admits the shared canvas operations through the authenticated Web adapter and rejects native-only operations', async () => {
  const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
  vi.stubGlobal('sessionStorage', storage); vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
  vi.stubGlobal('window', { sessionStorage: storage, history: { state: null } })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const requests: unknown[] = []
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    if (String(url).endsWith('/login')) return Response.json({ protocolVersion: 4, token: 'a'.repeat(64), clientId: 'd'.repeat(64), editorProof: 'e'.repeat(64), ownerId: 'local_user' })
    const request = JSON.parse(String(options?.body)); requests.push(request)
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer ' + 'a'.repeat(64))
    return Response.json({ result: request })
  })
  const transport = new ConsoleClient('http://127.0.0.1:8766', fetcher)
  await transport.login('b'.repeat(64))
  const { client } = createThreadAdapter(transport, async () => null).environment
  expect(client.singleChatAttachments.prepareInput).toBeUndefined()
  const operations = ['canvas.boards.list', 'canvas.boards.get', 'canvas.boards.create',
    'canvas.boards.update', 'canvas.boards.delete', 'canvas.nodes.snapshot', 'canvas.nodes.apply', 'canvas.references.page',
    'canvas.terminals.start', 'canvas.terminals.snapshot', 'canvas.terminals.write', 'canvas.terminals.resize', 'canvas.terminals.stop',
    'skillPacks.list', 'skillPacks.read', 'skillPacks.installations.list', 'skillPacks.install', 'skillPacks.uninstall', 'skillPacks.members.list', 'skillPacks.members.set',
    'threads.pendingDraft.setPresence',
    'workspaces.worktrees', 'navigation.activity'] satisfies CoreMethod[]
  try {
    for (const operation of operations) {
      const params = operation === 'navigation.activity' ? { groupKeys: ['directory:/project'], threadIds: ['external-window-thread'] }
        : operation === 'canvas.references.page' ? { afterThreadId: null, upperThreadId: null, limit: 200 }
        : operation === 'workspaces.worktrees' ? { path: '/project' }
        : operation.startsWith('canvas.terminals.') ? { target: { boardId: 'board', nodeId: 'terminal' }, generation: 'original' }
        : operation.startsWith('skillPacks.') ? { skillId: 'example', commandId: 'original', command: { skillId: 'example', expectedVersion: 'absent' } }
        : operation === 'threads.pendingDraft.setPresence' ? { threadId: 'pending', present: true }
        : { commandId: operation, command: { boardId: 'board', expectedRevision: 3 } }
      expect(await client.request(operation, params)).toEqual({ operation, params })
    }
    expect(requests).toHaveLength(operations.length)
    await expect(client.request('preferences.newConversation.initialize')).rejects.toThrow('尚未开放此 Web 操作')
    expect(requests).toHaveLength(operations.length)
  } finally { transport.clear() }
})

it('loads a command after an initially empty Web Run and refreshes its completion', async () => {
  const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
  vi.stubGlobal('sessionStorage', storage)
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
  vi.stubGlobal('window', { sessionStorage: storage, history: { state: null } })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  let evidence: AgentRunExecutionEvidenceView[] = []
  let changeSequence = 0
  const operations: string[] = []
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    if (String(url).endsWith('/login')) return Response.json({ protocolVersion: 4, token: 'a'.repeat(64), clientId: 'd'.repeat(64), editorProof: 'e'.repeat(64), ownerId: 'local_user' })
    const { operation, params } = JSON.parse(String(options?.body))
    operations.push(operation)
    expect(params.projection).toBe('blocks')
    const blocks = evidence.map(item => ({
      key: 'tools:1', kind: 'toolGroup', sequence: 1, lastSequence: 1, changeSequence,
      toolCount: 1, counts: { completed: Number(item.phase === 'completed'), running: Number(item.phase !== 'completed'),
        failed: 0, stopped: 0, waiting: 0, recorded: 0 }, evidence: [item]
    }))
    const common = {
      schemaVersion: 3,
      threadId: 'camp',
      agentRunId: 'run',
      throughSequence: evidence.at(-1)?.sequence ?? 0,
      throughChangeSequence: changeSequence,
      hasMore: false
    }
    if (operation === 'agentRunExecution.page') return Response.json({ result: {
      ...common, requestedBeforeSequence: params.beforeSequence, nextBeforeSequence: null, blocks
    } })
    if (operation === 'agentRunExecution.changes') return Response.json({ result: {
      ...common,
      requestedAfterChangeSequence: params.afterChangeSequence,
      nextAfterChangeSequence: changeSequence,
      blocks: blocks.filter(item => item.changeSequence > params.afterChangeSequence)
    } })
    throw Error(`Unexpected request: ${operation}`)
  })
  const transport = new ConsoleClient('http://127.0.0.1:8766', fetcher)
  await transport.login('b'.repeat(64))
  const adapter = createThreadAdapter(transport, async () => null)
  const client = adapter.environment.client
  const current = new ExecutionWindow('camp', 'run', 12,
    params => client.request('agentRunExecution.page', { ...params, projection: 'blocks' }), () => undefined,
    params => client.request('agentRunExecution.changes', { ...params, projection: 'blocks' }))
  try {
    await current.latest()
    expect(current.loaded).toBe(true)
    expect(current.evidence).toEqual([])
    changeSequence = 1
    evidence = [{ id: 'command', agentRunId: 'run', executionEpoch: 1, sequence: 1,
      operationId: 'command', revision: 1, changeSequence,
      eventType: 'command.started', kind: 'command', phase: 'started',
      payload: { command: 'printf WEB_LIVE_COMMAND_MARKER' }, contentBlobId: null,
      contentByteCount: 0, isTruncated: false, occurredAt: '2026-09-14T00:00:00Z' }]
    await current.refresh()
    expect(current.evidence).toEqual(evidence)
    changeSequence = 2
    evidence = [{ ...evidence[0], revision: 2, changeSequence,
      eventType: 'command.completed', phase: 'completed',
      payload: { command: 'printf WEB_LIVE_COMMAND_MARKER', exitCode: 0 } }]
    await current.refresh()
    expect(current.evidence[0].phase).toBe('completed')
    expect(operations).toEqual(['agentRunExecution.page', 'agentRunExecution.changes', 'agentRunExecution.changes'])
  } finally { current.dispose(); transport.clear() }
})

// Subscription alone must not cause idle HTTP work; only retained handles do.
it('polls changes only while files are open and resumes after reopening', async () => {
  vi.useFakeTimers()
  const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
  vi.stubGlobal('sessionStorage', storage); vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
  vi.stubGlobal('window', { sessionStorage: storage, history: { state: null } })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const actions: string[] = []
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    if (String(url).endsWith('/login')) return Response.json({ protocolVersion: 4, token: 'a'.repeat(64), clientId: 'd'.repeat(64), editorProof: 'e'.repeat(64), ownerId: 'local_user' })
    const { action } = JSON.parse(String(options?.body)); actions.push(action)
    if (action === 'open' || action === 'restore') return Response.json({ ok: true, value: { kind: 'file_preview', file: { handleId: action === 'restore' ? 'candidate' : 'file', displayPath: 'file.txt' } } })
    return Response.json(action === 'release' ? { released: true } : { ok: true, value: [] })
  })
  const transport = new ConsoleClient('http://127.0.0.1:8766', fetcher)
  await transport.login('b'.repeat(64))
  const adapter = createThreadAdapter(transport, async () => null)
  const files = adapter.environment.files
  const unsubscribe = files.onExternalUpdate(() => undefined)
  const open = () => files.open({ kind: 'camp_workspace', threadId: 'camp', rawReference: 'file.txt' })
  try {
    adapter.invalidate()
    await vi.advanceTimersByTimeAsync(6000)
    expect(actions).toEqual([])
    await open(); await vi.advanceTimersByTimeAsync(4000)
    expect(actions).toEqual(['open', 'updates', 'updates'])
    await files.release({ handleId: 'file' }); await vi.advanceTimersByTimeAsync(6000)
    expect(actions).toEqual(['open', 'updates', 'updates', 'release'])
    await open(); await vi.advanceTimersByTimeAsync(2000)
    expect(actions.slice(-2)).toEqual(['open', 'updates'])
    const candidate = await files.reload({ handleId: 'file', reopenToken: 'token', expectedGeneration: 'generation' })
    expect(candidate).toMatchObject({ ok: true, value: { handleId: 'candidate' } })
    expect(actions.at(-1)).toBe('restore')
    expect(actions.filter(action => action === 'release')).toHaveLength(1)
    await files.release({ handleId: 'candidate' })
    await files.release({ handleId: 'file' })
  } finally { unsubscribe(); transport.clear(); vi.useRealTimers() }
})

it('confirms uploaded image bindings before reusing local bytes and falls back for changes or missing files', async () => {
  const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
  vi.stubGlobal('sessionStorage', storage); vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
  vi.stubGlobal('window', { sessionStorage: storage, history: { state: null } })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('atob', () => { throw Error('Binary previews must not use Base64') })
  const file = new File([new Uint8Array(600_000)], 'photo.png', { type: 'image/png' })
  vi.spyOn(file, 'arrayBuffer').mockRejectedValue(Error('No complete upload buffer'))
  let digest = '', changed = false, missing = false
  const actions: string[] = []
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    if (String(url).endsWith('/login')) return Response.json({ protocolVersion: 4, token: 'a'.repeat(64), clientId: 'd'.repeat(64), editorProof: 'e'.repeat(64), ownerId: 'local_user' })
    if (String(url).endsWith('/uploads')) {
      digest = JSON.parse(String((options!.body as FormData).get('intent'))).sha256
      return Response.json({ draft: { attachments: [{ id: 'attachment' }] } })
    }
    const { action } = JSON.parse(String(options?.body)); actions.push(action)
    if (action === 'open') return Response.json(missing ? { ok: false, error: { code: 'file_not_found' } } : {
      ok: true, value: { kind: 'file_preview', file: { handleId: 'file', displayPath: 'photo.png', kind: 'image', size: file.size, contentGeneration: changed ? 'c'.repeat(64) : digest } }
    })
    if (action === 'readBinary') {
      expect(String(url)).toMatch(/\/files\/bytes$/)
      return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png', 'x-rovai-content-generation': 'c'.repeat(64), 'x-rovai-content-version': '{"size":4,"mtimeMs":1}' } })
    }
    return Response.json({ released: true })
  })
  const transport = new ConsoleClient('http://127.0.0.1:8766', fetcher)
  await transport.login('b'.repeat(64))
  const adapter = createThreadAdapter(transport, async () => null)
  const preview = () => adapter.environment.client.composerAttachments.preview({ owner: 'composer', threadId: 'camp', attachmentRefId: 'attachment' })
  try {
    await transport.uploadFile('camp', 1, file)
    expect((await preview()).preview).toEqual({ blob: file })
    expect(actions).toEqual(['open', 'release'])
    changed = true
    const result = await preview()
    expect(result.availability).toBe('available')
    expect('blob' in result.preview! && await result.preview.blob.arrayBuffer()).toEqual(new Uint8Array([137, 80, 78, 71]).buffer)
    expect(actions.slice(-3)).toEqual(['open', 'readBinary', 'release'])
    missing = true
    expect(await preview()).toEqual({ preview: null, availability: 'missing' })
    expect(actions.at(-1)).toBe('open')
    transport.clear()
    expect(transport.confirmedUpload('camp', digest, file.size)).toBeNull()
  } finally { transport.clear() }
})
