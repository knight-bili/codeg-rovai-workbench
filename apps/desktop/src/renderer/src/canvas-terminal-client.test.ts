import { describe, expect, it, vi } from 'vitest'
import type { CanvasTerminalSnapshot, CoreMethod } from '@contracts'
import { CanvasTerminalClient } from './canvas-terminal-client'

const core = '11111111-1111-4111-8111-111111111111'
const generation = '22222222-2222-4222-8222-222222222222'
const requestId = '33333333-3333-4333-8333-333333333333'
const inputId = '44444444-4444-4444-8444-444444444444'
const target = { boardId: 'board', nodeId: 'A' }
const start = { coreGeneration: core, requestId, expectedGeneration: null, cols: 80, rows: 24 }
function snapshot(patch: Partial<CanvasTerminalSnapshot> = {}): CanvasTerminalSnapshot {
  return { coreGeneration: core, target, exists: true, generation, launchRequestId: requestId, phase: 'running', cols: 80, rows: 24,
    exitCode: null, throughSeq: 0, firstAvailableSeq: 1, gap: false, chunks: [], inputSequence: 0, inputs: [], issue: null, cleanupComplete: false, ...patch }
}
function fixture(handler: (method: CoreMethod, params: unknown) => Promise<unknown> = async () => snapshot(), version: number | null = 1, scope = { ...target }) {
  const transport = vi.fn(handler)
  const client = new CanvasTerminalClient({ request<T>(method: CoreMethod, params?: unknown) { return transport(method, params) as Promise<T> } }, scope, version ?? undefined)
  return { client, transport }
}

describe('画布终端的固定节点客户端', () => {
  it('旧服务在运输前拒绝全部终端动作，目标标识按UTF8字节限制', async () => {
    for (const version of [null, 0, 2]) {
      const { client, transport } = fixture(undefined, version)
      await expect(client.snapshot()).rejects.toThrow('暂不支持')
      await expect(client.start(start)).rejects.toThrow('暂不支持')
      await expect(client.write({ generation, inputId, expectedInputSequence: 0 }, Uint8Array.of(13))).rejects.toThrow('暂不支持')
      await expect(client.resize({ generation, cols: 80, rows: 24 })).rejects.toThrow('暂不支持')
      await expect(client.stop(generation)).rejects.toThrow('暂不支持')
      expect(transport).not.toHaveBeenCalled()
    }
    for (const nodeId of [' A', 'A\0', '中'.repeat(43)]) expect(() => fixture(undefined, 1, { boardId: 'board', nodeId })).toThrow('请求格式')
  })

  it('固定原卡片并投递闭合字段，调用方修改和另一卡片不能污染原请求', async () => {
    const scope = { ...target }, params = { ...start, cwd: '/injected', ownerId: 'injected' }
    const { client, transport } = fixture(async () => snapshot(), 1, scope)
    const pending = client.start(params)
    scope.nodeId = 'B'; params.requestId = inputId; params.cols = 120
    await expect(pending).resolves.toMatchObject({ target, launchRequestId: requestId })
    expect(transport).toHaveBeenCalledWith('canvas.terminals.start', { target, ...start })
    const second = fixture(async () => snapshot({ target: { boardId: 'board', nodeId: 'B' } }), 1, scope)
    await second.client.snapshot()
    expect(second.transport).toHaveBeenCalledWith('canvas.terminals.snapshot', { target: { boardId: 'board', nodeId: 'B' }, generation: null, afterSeq: 0 })
    await client.snapshot()
    expect(transport.mock.calls[1][1]).toEqual({ target, generation: null, afterSeq: 0 })
  })

  it('发送前冻结原始字节及输入身份，运输失败只返回一次，回执必须对应原输入', async () => {
    let reject!: (reason: Error) => void
    const { client, transport } = fixture(() => new Promise((_, no) => { reject = no }))
    const bytes = Uint8Array.of(0, 27, 255, 13), params = { generation, inputId, expectedInputSequence: 5 }
    const pending = client.write(params, bytes)
    bytes.fill(65); params.inputId = requestId; params.expectedInputSequence = 6
    expect(transport).toHaveBeenCalledWith('canvas.terminals.write', { target, generation, inputId, expectedInputSequence: 5, bytesBase64: 'ABv/DQ==' })
    reject(new TypeError('offline'))
    await expect(pending).rejects.toThrow('offline')
    expect(transport).toHaveBeenCalledOnce()
    for (const response of [{ sequence: 5, inputId, status: 'written' }, { sequence: 6, inputId: requestId, status: 'written' }, { sequence: 6, inputId, status: 'sent' }]) {
      await expect(fixture(async () => response).client.write({ generation, inputId, expectedInputSequence: 5 }, Uint8Array.of(13))).rejects.toThrow('原节点')
    }
    await expect(fixture(async () => ({ sequence: 6, inputId, status: 'unknown', digest: 'internal' })).client.write({ generation, inputId, expectedInputSequence: 5 }, Uint8Array.of(13))).resolves.toEqual({ sequence: 6, inputId, status: 'unknown' })
  })

  it('读取完整有界原始块及保留回执，排除内部字段，正文被淘汰后仍保留原游标', async () => {
    const publicState = snapshot({ throughSeq: 3, firstAvailableSeq: 2, gap: true,
      chunks: [{ seq: 2, bytesBase64: '5Lit' }, { seq: 3, bytesBase64: 'ABv/' }],
      inputSequence: 7, inputs: [{ sequence: 7, inputId, status: 'pending' }] })
    const response = { ...publicState, pid: 123, environment: { private: 'hidden' },
      target: { ...target, cwd: '/hidden' }, chunks: publicState.chunks.map(chunk => ({ ...chunk, future: 'hidden' })),
      inputs: publicState.inputs.map(input => ({ ...input, bytesBase64: 'hidden', digest: 'hidden' })) }
    await expect(fixture(async () => response).client.snapshot(generation, 0)).resolves.toEqual(publicState)
    const cold = snapshot({ phase: 'exited', throughSeq: 3, firstAvailableSeq: 4, gap: true, inputSequence: 7, cleanupComplete: true })
    await expect(fixture(async () => cold).client.snapshot(generation, 0)).resolves.toEqual(cold)
    const missing = snapshot({ exists: false, generation: null, launchRequestId: null, phase: 'missing', cols: null, rows: null, cleanupComplete: true })
    await expect(fixture(async () => missing).client.snapshot()).resolves.toEqual(missing)
  })

  it('拒绝串卡、串代次、错误游标、破损或超量输出，不把不完整正文当连续输出', async () => {
    const invalid: unknown[] = [
      snapshot({ target: { ...target, nodeId: 'B' } }), snapshot({ generation: requestId }), snapshot({ cols: 0 }),
      { ...snapshot(), phase: ['running'] },
      snapshot({ throughSeq: 1, firstAvailableSeq: 2, gap: false }), snapshot({ throughSeq: 1 }),
      snapshot({ throughSeq: 1, chunks: [{ seq: 2, bytesBase64: 'YQ==' }] }),
      snapshot({ throughSeq: 1, chunks: [{ seq: 1, bytesBase64: 'YR==' }] }),
      snapshot({ throughSeq: 1, chunks: [{ seq: 1, bytesBase64: '!' }] }),
      snapshot({ throughSeq: 1, chunks: [{ seq: 1, bytesBase64: btoa('a'.repeat(8193)) }] }),
      snapshot({ throughSeq: 17, chunks: Array.from({ length: 17 }, (_, i) => ({ seq: i + 1, bytesBase64: btoa('a'.repeat(8192)) })) }),
      snapshot({ throughSeq: 2049, chunks: Array.from({ length: 2049 }, (_, i) => ({ seq: i + 1, bytesBase64: 'YQ==' })) }),
      snapshot({ inputSequence: 1, inputs: [{ sequence: 2, inputId, status: 'written' }] })
    ]
    for (const response of invalid) await expect(fixture(async () => response).client.snapshot(generation)).rejects.toThrow('原节点')
    await expect(fixture(async () => snapshot({ coreGeneration: requestId })).client.start(start)).rejects.toThrow('原节点')
    await expect(fixture(async () => snapshot({ launchRequestId: inputId })).client.start(start)).rejects.toThrow('原节点')
  })

  it('非法请求不运输，resize只接受确认而stop只表示已请求停止', async () => {
    const { client, transport } = fixture(async method => method === 'canvas.terminals.resize' ? { resized: true } : { stopping: true })
    for (const bytes of [new Uint8Array(), new Uint8Array(16385)]) await expect(client.write({ generation, inputId, expectedInputSequence: 0 }, bytes)).rejects.toThrow('请求格式')
    await expect(client.snapshot(null, 1)).rejects.toThrow('请求格式')
    await expect(client.snapshot(generation, -1)).rejects.toThrow('请求格式')
    await expect(client.start({ ...start, coreGeneration: 'old' })).rejects.toThrow('请求格式')
    await expect(client.resize({ generation, cols: 1001, rows: 24 })).rejects.toThrow('请求格式')
    await expect(client.stop(generation.toUpperCase().replace('2', 'F'))).rejects.toThrow('请求格式')
    expect(transport).not.toHaveBeenCalled()
    await client.resize({ generation, cols: 120, rows: 40 }); await client.stop(generation)
    expect(transport.mock.calls).toEqual([
      ['canvas.terminals.resize', { target, generation, cols: 120, rows: 40 }], ['canvas.terminals.stop', { target, generation }]
    ])
    await expect(fixture(async () => ({ resized: false })).client.resize({ generation, cols: 80, rows: 24 })).rejects.toThrow('原节点')
    await expect(fixture(async () => ({ stopped: true })).client.stop(generation)).rejects.toThrow('原节点')
  })
})
