import type { CanvasTerminalInputReceipt, CanvasTerminalResize, CanvasTerminalSnapshot, CanvasTerminalStart, CanvasTerminalTarget, CanvasTerminalWrite } from '@contracts'
import type { ThreadClient } from './camp-client'
import { uiAttribute } from './interface-language'

type RecordValue = Record<string, unknown>
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const validSize = (value: { cols: unknown; rows: unknown }) => integer(value.cols, 1, 1000) && integer(value.rows, 1, 1000)
const inputStatuses = new Set(['queued', 'pending', 'written', 'unknown', 'not_written'])
const phases = new Set(['starting', 'running', 'stopping', 'exited', 'failed'])
const invalidRequest = () => new Error(uiAttribute('终端请求格式不正确。'))
const invalidReply = () => new Error(uiAttribute('终端返回的信息与原节点不一致，请重新读取。'))

function receipt(value: unknown): CanvasTerminalInputReceipt {
  const item = record(value)
  if (!integer(item.sequence, 1) || !uuid(item.inputId) || typeof item.status !== 'string' || !inputStatuses.has(item.status)) throw invalidReply()
  return { sequence: item.sequence, inputId: item.inputId, status: item.status as CanvasTerminalInputReceipt['status'] }
}

/** One card target, no durable command recovery, automatic retry, or process ownership. */
export class CanvasTerminalClient {
  private readonly target: Readonly<CanvasTerminalTarget>

  constructor(private readonly client: Pick<ThreadClient, 'request'>, target: CanvasTerminalTarget, private readonly terminalVersion: number | undefined) {
    for (const id of [target.boardId, target.nodeId]) {
      if (typeof id !== 'string' || !id || id.trim() !== id || id.includes('\0') || new TextEncoder().encode(id).length > 128) throw invalidRequest()
    }
    this.target = Object.freeze({ boardId: target.boardId, nodeId: target.nodeId })
  }

  private requireSupport(): void {
    if (this.terminalVersion !== 1) throw new Error(uiAttribute('当前连接暂不支持画布终端，请升级服务后重试。'))
  }

  async snapshot(generation: string | null = null, afterSeq = 0): Promise<CanvasTerminalSnapshot> {
    this.requireSupport()
    if ((generation !== null && !uuid(generation)) || !integer(afterSeq) || (generation === null && afterSeq !== 0)) throw invalidRequest()
    const result = await this.client.request<unknown>('canvas.terminals.snapshot', { target: this.target, generation, afterSeq })
    return this.projectSnapshot(result, generation, afterSeq)
  }

  async start(params: Omit<CanvasTerminalStart, 'target'>): Promise<CanvasTerminalSnapshot> {
    this.requireSupport()
    const { coreGeneration, requestId, expectedGeneration, cols, rows } = params
    if (!uuid(coreGeneration) || !uuid(requestId) || (expectedGeneration !== null && !uuid(expectedGeneration)) || !validSize({ cols, rows })) throw invalidRequest()
    const result = this.projectSnapshot(await this.client.request<unknown>('canvas.terminals.start', {
      target: this.target, coreGeneration, requestId, expectedGeneration, cols, rows
    }), null, 0)
    if (!result.exists || result.coreGeneration !== coreGeneration || result.launchRequestId !== requestId) throw invalidReply()
    return result
  }

  async write(params: Omit<CanvasTerminalWrite, 'target' | 'bytesBase64'>, bytes: Uint8Array): Promise<CanvasTerminalInputReceipt> {
    this.requireSupport()
    const { generation, inputId, expectedInputSequence } = params
    if (!uuid(generation) || !uuid(inputId) || !integer(expectedInputSequence, 0, Number.MAX_SAFE_INTEGER - 1) || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 16 * 1024) throw invalidRequest()
    // Encode before awaiting transport; later caller edits cannot alter the admitted input.
    const bytesBase64 = btoa(String.fromCharCode(...new Uint8Array(bytes)))
    const result = receipt(await this.client.request<unknown>('canvas.terminals.write', {
      target: this.target, generation, inputId, expectedInputSequence, bytesBase64
    }))
    if (result.sequence !== expectedInputSequence + 1 || result.inputId !== inputId) throw invalidReply()
    return result
  }

  async resize(params: Omit<CanvasTerminalResize, 'target'>): Promise<void> {
    this.requireSupport()
    const { generation, cols, rows } = params
    if (!uuid(generation) || !validSize({ cols, rows })) throw invalidRequest()
    const result = await this.client.request<unknown>('canvas.terminals.resize', { target: this.target, generation, cols, rows })
    if (record(result).resized !== true) throw invalidReply()
  }

  async stop(generation: string): Promise<void> {
    this.requireSupport()
    if (!uuid(generation)) throw invalidRequest()
    const result = await this.client.request<unknown>('canvas.terminals.stop', { target: this.target, generation })
    if (record(result).stopping !== true) throw invalidReply()
  }

  private projectSnapshot(value: unknown, generation: string | null, afterSeq: number): CanvasTerminalSnapshot {
    const item = record(value), target = record(item.target)
    if (target.boardId !== this.target.boardId || target.nodeId !== this.target.nodeId || !uuid(item.coreGeneration)
      || typeof item.exists !== 'boolean' || typeof item.gap !== 'boolean' || typeof item.cleanupComplete !== 'boolean'
      || !integer(item.throughSeq, afterSeq, Number.MAX_SAFE_INTEGER - 1) || !integer(item.firstAvailableSeq, 1, item.throughSeq + 1)
      || !integer(item.inputSequence) || (item.issue !== null && typeof item.issue !== 'string')
      || (item.exitCode !== null && !integer(item.exitCode, 0, 0xffff_ffff))
      || !Array.isArray(item.chunks) || item.chunks.length > 2048 || !Array.isArray(item.inputs) || item.inputs.length > 64
      || item.gap !== (afterSeq + 1 < item.firstAvailableSeq)) throw invalidReply()
    if (item.exists) {
      if (!uuid(item.generation) || !uuid(item.launchRequestId) || (generation !== null && item.generation !== generation)
        || typeof item.phase !== 'string' || !phases.has(item.phase) || !validSize({ cols: item.cols, rows: item.rows })) throw invalidReply()
    } else if (generation !== null || item.generation !== null || item.launchRequestId !== null || item.phase !== 'missing'
      || item.cols !== null || item.rows !== null || item.exitCode !== null || item.throughSeq !== 0 || item.inputSequence !== 0
      || item.inputs.length !== 0 || item.issue !== null || !item.cleanupComplete) throw invalidReply()

    const throughSeq = item.throughSeq
    let outputBytes = 0, expectedSeq = Math.max(afterSeq + 1, item.firstAvailableSeq)
    const chunks = item.chunks.map(value => {
      const chunk = record(value)
      if (chunk.seq !== expectedSeq++ || !integer(chunk.seq, 1, throughSeq) || typeof chunk.bytesBase64 !== 'string' || chunk.bytesBase64.length > 10924) throw invalidReply()
      let decoded: string
      try { decoded = atob(chunk.bytesBase64) } catch { throw invalidReply() }
      outputBytes += decoded.length
      if (!decoded.length || decoded.length > 8192 || outputBytes > 128 * 1024 || btoa(decoded) !== chunk.bytesBase64) throw invalidReply()
      return { seq: chunk.seq, bytesBase64: chunk.bytesBase64 }
    })
    if (expectedSeq !== item.throughSeq + 1) throw invalidReply()
    const inputs = item.inputs.map(receipt)
    for (let i = 0; i < inputs.length; i++) {
      if (inputs[i].sequence > item.inputSequence || (i > 0 && inputs[i].sequence !== inputs[i - 1].sequence + 1)) throw invalidReply()
    }
    if (new Set(inputs.map(input => input.inputId)).size !== inputs.length || (inputs.length > 0 && inputs.at(-1)!.sequence !== item.inputSequence)) throw invalidReply()
    // Explicit projection also protects Native readers from future internal process fields.
    return {
      coreGeneration: item.coreGeneration, target: { ...this.target }, exists: item.exists,
      generation: item.generation as string | null, launchRequestId: item.launchRequestId as string | null,
      phase: item.phase as CanvasTerminalSnapshot['phase'], cols: item.cols as number | null, rows: item.rows as number | null,
      exitCode: item.exitCode as number | null, throughSeq: item.throughSeq, firstAvailableSeq: item.firstAvailableSeq,
      gap: item.gap, chunks, inputSequence: item.inputSequence, inputs, issue: item.issue as string | null, cleanupComplete: item.cleanupComplete
    }
  }
}
