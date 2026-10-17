import { describe, expect, it, vi } from 'vitest'
import type { CanvasTerminalInputReceipt, CanvasTerminalSnapshot } from '@contracts'
import { CanvasTerminalController } from './canvas-terminal-controller'
import { CanvasTerminalReader } from './canvas-terminal-reader'
import { canvasTerminalSession } from './canvas-terminal-sessions'
import { terminalKey, terminalModifiedInput } from './canvas-terminal-input'

const core = '11111111-1111-4111-8111-111111111111'
const generation = '22222222-2222-4222-8222-222222222222'
const next = '33333333-3333-4333-8333-333333333333'
function snapshot(patch: Partial<CanvasTerminalSnapshot> = {}): CanvasTerminalSnapshot {
  return { coreGeneration: core, target: { boardId: 'board', nodeId: 'node' }, exists: true, generation, launchRequestId: next,
    phase: 'running', cols: 80, rows: 24, exitCode: null, throughSeq: 0, firstAvailableSeq: 1, gap: false, chunks: [],
    inputSequence: 0, inputs: [], issue: null, cleanupComplete: false, ...patch }
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture() {
  let current = snapshot(), sequence = 0
  const api = {
    snapshot: vi.fn(async (expected?: string | null, after = 0): Promise<CanvasTerminalSnapshot> => {
      if (expected && expected !== current.generation) throw new Error('canvas_terminal.stale_generation')
      return structuredClone({ ...current, gap: after + 1 < current.firstAvailableSeq, chunks: current.chunks.filter(chunk => chunk.seq > after) })
    }),
    start: vi.fn(async (request: Parameters<import('./canvas-terminal-client').CanvasTerminalClient['start']>[0]) => {
      current = snapshot({ coreGeneration: request.coreGeneration, launchRequestId: request.requestId, cols: request.cols, rows: request.rows }); return structuredClone(current)
    }),
    write: vi.fn(async (request: Parameters<import('./canvas-terminal-client').CanvasTerminalClient['write']>[0], _bytes: Uint8Array): Promise<CanvasTerminalInputReceipt> => {
      const receipt = { inputId: request.inputId, sequence: request.expectedInputSequence + 1, status: 'written' as const }
      current = { ...current, inputSequence: receipt.sequence, inputs: [...current.inputs, receipt] }; return receipt
    }),
    resize: vi.fn(async (_size: Parameters<import('./canvas-terminal-client').CanvasTerminalClient['resize']>[0]) => undefined),
    stop: vi.fn(async (_generation: string) => { current = { ...current, phase: 'stopping' } })
  }
  const controller = new CanvasTerminalController(api, () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++sequence).padStart(12, '0')}`)
  const writes: Uint8Array[] = []
  const terminal = { reset: vi.fn(), write: vi.fn((bytes: Uint8Array, done: () => void) => { writes.push(new Uint8Array(bytes)); done() }) }
  const reader = new CanvasTerminalReader(terminal)
  const detach = controller.attach(reader.apply)
  return { api, controller, reader, terminal, writes, detach, set(value: CanvasTerminalSnapshot) { current = value }, get: () => current }
}

describe('临时终端控制器与字节读者', () => {
  it('读取不启动；未知启动只在显式重试时用原编号/尺寸，Core重启不会重开', async () => {
    const f = fixture()
    const missing = snapshot({ exists: false, generation: null, launchRequestId: null, phase: 'missing', cols: null, rows: null, cleanupComplete: true })
    f.set(missing); await f.controller.refresh(); expect(f.api.start).not.toHaveBeenCalled()
    f.api.start.mockRejectedValueOnce(new TypeError('lost start'))
    await f.controller.start({ cols: 80, rows: 24 })
    const original = structuredClone(f.api.start.mock.calls[0][0])
    await f.controller.refresh(); expect(f.controller.getSnapshot().startUnknown).toBe(true)
    expect(f.api.start).toHaveBeenCalledOnce()
    await f.controller.retryStart()
    expect(f.api.start.mock.calls[1][0]).toEqual(original)
    expect(f.controller.getSnapshot()).toMatchObject({ action: null, startUnknown: false, actionError: null, snapshot: { launchRequestId: original.requestId } })
    f.set({ ...missing, coreGeneration: next }); await f.controller.refresh()
    expect(f.api.start).toHaveBeenCalledTimes(2)
    expect(f.controller.getSnapshot().snapshot?.phase).toBe('missing')
  })

  it('原始输出跨UTF8和控制字符边界连续写入，绘制回执前不推进读取游标', async () => {
    const f = fixture(), done: Array<() => void> = []
    f.terminal.write.mockImplementation((bytes, callback) => { f.writes.push(new Uint8Array(bytes)); done.push(callback) })
    f.set(snapshot({ throughSeq: 2, chunks: [{ seq: 1, bytesBase64: '5Lit5g==' }, { seq: 2, bytesBase64: 'lofkuI0bWzBt' }] }))
    const reading = f.controller.refresh()
    await vi.waitFor(() => expect(done).toHaveLength(1))
    const again = f.controller.refresh()
    expect(f.api.snapshot).toHaveBeenCalledOnce()
    done.shift()!(); await vi.waitFor(() => expect(done).toHaveLength(1)); done.shift()!()
    await Promise.all([reading, again])
    expect(f.api.snapshot.mock.calls[1]).toEqual([generation, 2])
    expect(f.writes).toHaveLength(2)
    expect(new TextDecoder().decode(Uint8Array.from(f.writes.flatMap(bytes => [...bytes])))).toBe('中文不\x1b[0m')
    f.set(snapshot({ throughSeq: 5, firstAvailableSeq: 5, chunks: [{ seq: 5, bytesBase64: 'YQ==' }] }))
    const gap = f.controller.refresh(); await vi.waitFor(() => expect(done).toHaveLength(1)); done.shift()!(); await gap
    expect(f.terminal.reset).toHaveBeenCalledTimes(2)
    expect(f.controller.getSnapshot().outputTruncated).toBe(true)
  })

  it('快速输入单份在途并按16KiB拆分，队列超限整次拒绝，调用后修改不能污染字节', async () => {
    const f = fixture(), first = deferred<CanvasTerminalInputReceipt>()
    await f.controller.refresh()
    f.api.write.mockImplementationOnce(() => first.promise)
    const bytes = new Uint8Array(20000).fill(65)
    expect(f.controller.enqueue(bytes)).toBe(true); bytes.fill(66)
    expect(f.controller.enqueue(Uint8Array.of(13))).toBe(true)
    expect(f.controller.enqueue(new Uint8Array(65536))).toBe(false)
    expect(f.api.write).toHaveBeenCalledOnce()
    const original = f.api.write.mock.calls[0][0]
    first.resolve({ sequence: 1, inputId: original.inputId, status: 'written' })
    await vi.waitFor(() => expect(f.api.write).toHaveBeenCalledTimes(2))
    expect(f.api.write.mock.calls[0][1]).toEqual(new Uint8Array(16384).fill(65))
    expect(f.api.write.mock.calls[1][1]).toEqual(Uint8Array.from([...new Uint8Array(3616).fill(65), 13]))
    expect(f.api.write.mock.calls[1][0].expectedInputSequence).toBe(1)
    expect(f.controller.getSnapshot()).toMatchObject({ inputStatus: 'idle', queuedBytes: 0 })
  })

  it('输入丢回执清空未发队列，重新读取只核对原编号，确认写入才开放新输入', async () => {
    const f = fixture(), lost = deferred<CanvasTerminalInputReceipt>()
    await f.controller.refresh(); f.api.write.mockImplementationOnce(() => lost.promise)
    f.controller.enqueue(Uint8Array.of(65)); f.controller.enqueue(Uint8Array.of(66))
    const original = f.api.write.mock.calls[0][0]
    lost.reject(new TypeError('lost reply'))
    await vi.waitFor(() => expect(f.controller.getSnapshot().inputStatus).toBe('unknown'))
    expect(f.controller.getSnapshot().queuedBytes).toBe(0)
    expect(f.controller.enqueue(Uint8Array.of(67))).toBe(false)
    await f.controller.refresh(); f.controller.acknowledgeInput()
    expect(f.controller.inputReady()).toBe(false)
    expect(f.controller.canAcknowledgeInput()).toBe(false)
    f.set(snapshot({ inputSequence: 1, inputs: [{ sequence: 1, inputId: original.inputId, status: 'written' }] }))
    await f.controller.refresh()
    expect(f.controller.getSnapshot().actionError).toBeNull()
    expect(f.controller.inputReady()).toBe(true); expect(f.api.write).toHaveBeenCalledOnce()
    f.controller.enqueue(Uint8Array.of(68)); await vi.waitFor(() => expect(f.api.write).toHaveBeenCalledTimes(2))
    expect(f.api.write.mock.calls[1][1]).toEqual(Uint8Array.of(68))
  })

  it('收起不停止shell，待定输入身份在原控制器重挂后仍核对，不重发未发送字节', async () => {
    const f = fixture(), first = deferred<CanvasTerminalInputReceipt>()
    await f.controller.refresh(); f.api.write.mockImplementationOnce(() => first.promise)
    f.controller.enqueue(Uint8Array.of(65)); f.controller.enqueue(Uint8Array.of(66))
    const input = f.api.write.mock.calls[0][0]
    f.detach(); f.reader.dispose()
    expect(f.api.stop).not.toHaveBeenCalled(); expect(f.controller.canEvict()).toBe(false)
    first.resolve({ sequence: 1, inputId: input.inputId, status: 'pending' })
    await vi.waitFor(() => expect(f.controller.getSnapshot().inputStatus).toBe('waiting'))
    const reader = new CanvasTerminalReader(f.terminal), release = f.controller.attach(reader.apply)
    f.set(snapshot({ inputSequence: 1, inputs: [{ sequence: 1, inputId: input.inputId, status: 'written' }] }))
    await f.controller.refresh()
    expect(f.api.write).toHaveBeenCalledOnce(); expect(f.controller.getSnapshot().queuedBytes).toBe(0)
    release(); reader.dispose(); expect(f.controller.canEvict()).toBe(true)
  })

  it('替换Core围住旧在途写入，迟到回执不覆盖新会话或卡住新启动', async () => {
    const f = fixture(), write = deferred<CanvasTerminalInputReceipt>(), start = deferred<CanvasTerminalSnapshot>()
    await f.controller.refresh(); f.api.write.mockImplementationOnce(() => write.promise)
    f.controller.enqueue(Uint8Array.of(65)); const input = f.api.write.mock.calls[0][0]
    f.set(snapshot({ coreGeneration: next, exists: false, generation: null, launchRequestId: null, phase: 'missing', cols: null, rows: null, cleanupComplete: true }))
    await f.controller.refresh(); f.api.start.mockImplementationOnce(() => start.promise)
    const starting = f.controller.start({ cols: 80, rows: 24 })
    write.resolve({ sequence: 1, inputId: input.inputId, status: 'written' }); await Promise.resolve()
    const request = f.api.start.mock.calls[0][0]
    start.resolve(snapshot({ coreGeneration: next, generation: next, launchRequestId: request.requestId }))
    await starting
    expect(f.controller.getSnapshot()).toMatchObject({ action: null, inputStatus: 'idle', snapshot: { coreGeneration: next, generation: next, inputSequence: 0 } })
    expect(f.api.write).toHaveBeenCalledOnce()
  })

  it('未知或过期输入需明确确认且不重发，停止响应不冒充已回收', async () => {
    const f = fixture()
    f.set(snapshot({ inputSequence: 3, inputs: [{ sequence: 3, inputId: next, status: 'unknown' }] }))
    await f.controller.refresh(); expect(f.controller.inputReady()).toBe(false)
    expect(f.controller.canAcknowledgeInput()).toBe(true)
    f.controller.acknowledgeInput(); expect(f.controller.inputReady()).toBe(true)
    await f.controller.refresh(); expect(f.controller.inputReady()).toBe(true)
    await f.controller.stop()
    expect(f.api.stop).toHaveBeenCalledWith(generation)
    expect(f.controller.getSnapshot().snapshot).toMatchObject({ phase: 'stopping', cleanupComplete: false })
    await f.controller.start({ cols: 80, rows: 24 }); expect(f.api.start).not.toHaveBeenCalled()
    expect(f.api.write).not.toHaveBeenCalled()
  })

  it('读者释放解决等待中的绘制，损坏写入后可重新读取，整块重叠不会重复写', async () => {
    const terminal = { reset: vi.fn(), write: vi.fn((_bytes: Uint8Array, _done: () => void) => {}) }
    const reader = new CanvasTerminalReader(terminal), value = snapshot({ throughSeq: 1, chunks: [{ seq: 1, bytesBase64: 'YQ==' }] })
    const first = reader.apply(value); await vi.waitFor(() => expect(terminal.write).toHaveBeenCalledOnce())
    reader.dispose(); await first; await reader.apply(value); expect(terminal.write).toHaveBeenCalledOnce()
    const live = new CanvasTerminalReader(terminal)
    terminal.write.mockImplementationOnce(() => { throw new Error('reader failure') })
    await expect(live.apply(value)).rejects.toThrow('reader failure')
    terminal.write.mockImplementation((_bytes, done) => done())
    await live.apply(value); await live.apply(value)
    expect(terminal.write).toHaveBeenCalledTimes(3)
  })

  it('未准入的未知输入在旧会话确认回收后解除围栏，允许显式新启动', async () => {
    const f = fixture(); await f.controller.refresh()
    f.api.write.mockRejectedValueOnce(new TypeError('unadmitted or lost'))
    f.controller.enqueue(Uint8Array.of(65))
    await vi.waitFor(() => expect(f.controller.getSnapshot().inputStatus).toBe('unknown'))
    await f.controller.stop(); expect(f.controller.getSnapshot().snapshot?.phase).toBe('stopping')
    f.set(snapshot({ phase: 'exited', cleanupComplete: true, exitCode: 0 })); await f.controller.refresh()
    await f.controller.start({ cols: 80, rows: 24 })
    expect(f.api.start).toHaveBeenCalledOnce(); expect(f.api.write).toHaveBeenCalledOnce()
  })

  it('缩放在一份在途期间只保留最新尺寸，失败后先读原状态再重试尺寸', async () => {
    const f = fixture(), first = deferred<undefined>(); await f.controller.refresh()
    f.api.resize.mockImplementationOnce(() => first.promise)
    f.controller.resize({ cols: 100, rows: 30 }); f.controller.resize({ cols: 110, rows: 35 }); f.controller.resize({ cols: 120, rows: 40 })
    expect(f.api.resize).toHaveBeenCalledOnce(); first.resolve(undefined)
    await vi.waitFor(() => expect(f.api.resize).toHaveBeenCalledTimes(2))
    expect(f.api.resize.mock.calls.map(([value]) => value.cols)).toEqual([100, 120])
    f.api.resize.mockRejectedValueOnce(new Error('resize uncertain'))
    f.controller.resize({ cols: 130, rows: 45 })
    await vi.waitFor(() => expect(f.controller.getSnapshot().actionError).toBe('resize uncertain'))
    expect(f.api.resize).toHaveBeenCalledTimes(3)
    await f.controller.refresh(); await vi.waitFor(() => expect(f.api.resize).toHaveBeenCalledTimes(4))
    expect(f.api.resize.mock.calls[3][0]).toMatchObject({ cols: 130, rows: 45 })
  })

  it('会话缓存隔离客户端、Core目录、画板和节点；只淘汰无展示且无未决操作的条目', () => {
    const request = { request<T>(): Promise<T> { return Promise.reject(new Error('must not dispatch')) } }
    const target = { boardId: 'board', nodeId: 'A' }, first = canvasTerminalSession(request, 'scope', target, 1)
    expect(canvasTerminalSession(request, 'scope', target, 1)).toBe(first)
    expect(canvasTerminalSession(request, 'other', target, 1)).not.toBe(first)
    expect(canvasTerminalSession(request, 'scope', { ...target, nodeId: 'B' }, 1)).not.toBe(first)
    const guarded = { request: request.request }, releases: Array<() => void> = []
    for (let i = 0; i < 64; i++) releases.push(canvasTerminalSession(guarded, 'scope', { ...target, nodeId: String(i) }, 1).attach(async () => undefined))
    expect(() => canvasTerminalSession(guarded, 'scope', target, 1)).toThrow('已达上限')
    releases[0](); expect(() => canvasTerminalSession(guarded, 'scope', target, 1)).not.toThrow()
    releases.slice(1).forEach(release => release())
  })

  it('快捷键保留应用光标模式、组合修饰、首字符控制码和中文输入', () => {
    expect(terminalKey('up', { ctrl: false, alt: false }, true)).toBe('\x1bOA')
    expect(terminalKey('up', { ctrl: true, alt: true }, true)).toBe('\x1b[1;7A')
    expect(terminalKey('pgdn', { ctrl: true, alt: false })).toBe('\x1b[6;5~')
    expect(terminalKey('slash', { ctrl: false, alt: true })).toBe('\x1b/')
    expect(terminalModifiedInput('abc', { ctrl: true, alt: false })).toEqual({ out: '\x01bc', consumed: true })
    expect(terminalModifiedInput('中文', { ctrl: true, alt: false })).toEqual({ out: '中文', consumed: true })
    expect(terminalModifiedInput('C', { ctrl: true, alt: true })).toEqual({ out: '\x1b\x03', consumed: true })
  })
})
