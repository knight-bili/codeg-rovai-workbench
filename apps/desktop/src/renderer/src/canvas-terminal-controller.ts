import type { CanvasTerminalInputReceipt, CanvasTerminalSize, CanvasTerminalSnapshot, CanvasTerminalStart } from '@contracts'
import { newCommandId } from '../../shared/command-id'
import type { CanvasTerminalClient } from './canvas-terminal-client'
import { uiAttribute } from './interface-language'
import { readErrorMessage } from './error-message'

type Api = Pick<CanvasTerminalClient, 'snapshot' | 'start' | 'write' | 'resize' | 'stop'>
type PendingStart = Omit<CanvasTerminalStart, 'target'>
type PendingInput = { coreGeneration: string; generation: string; inputId: string; expectedInputSequence: number }
export interface CanvasTerminalState {
  snapshot: CanvasTerminalSnapshot | null
  reading: boolean
  action: 'start' | 'stop' | null
  startUnknown: boolean
  inputStatus: 'idle' | 'sending' | 'waiting' | 'unknown' | 'not_written' | 'expired'
  queuedBytes: number
  readError: string | null
  actionError: string | null
  outputTruncated: boolean
}

/** Temporary input ordering survives a card unmount; process ownership stays in Core. */
export class CanvasTerminalController {
  private state: CanvasTerminalState = { snapshot: null, reading: false, action: null, startUnknown: false,
    inputStatus: 'idle', queuedBytes: 0, readError: null, actionError: null, outputTruncated: false }
  private listeners = new Set<() => void>()
  private pendingStart: PendingStart | null = null
  private pendingInput: PendingInput | null = null
  private acknowledgedInputId: string | null = null
  private queue = new Uint8Array()
  private desiredSize: CanvasTerminalSize | null = null
  private pumping = false
  private resizeNeedsRead = false
  private revision = 0
  private cursor = 0
  private reading: Promise<void> | null = null
  private readAgain = false
  private presentation = 0
  private reader: ((snapshot: CanvasTerminalSnapshot) => Promise<void>) | null = null
  private readyPresentation = false

  constructor(private readonly api: Api, private readonly uuid = newCommandId) {}
  getSnapshot = (): CanvasTerminalState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  canEvict(): boolean { return !this.reader && !this.reading && !this.pumping && !this.pendingStart && !this.pendingInput && !this.state.action }
  private publish(patch: Partial<CanvasTerminalState>): void { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() }

  attach(reader: (snapshot: CanvasTerminalSnapshot) => Promise<void>): () => void {
    const presentation = ++this.presentation
    this.reader = reader; this.cursor = 0; this.readyPresentation = false
    return () => {
      if (presentation !== this.presentation) return
      ++this.presentation; this.reader = null; this.cursor = 0; this.readyPresentation = false; this.queue = new Uint8Array(); this.desiredSize = null
      this.publish({ queuedBytes: 0 })
    }
  }

  refresh(): Promise<void> {
    this.readAgain = true
    if (this.reading) return this.reading
    this.reading = this.readLoop().finally(() => { this.reading = null })
    return this.reading
  }

  private async readLoop(): Promise<void> {
    this.publish({ reading: true })
    try {
      do {
        this.readAgain = false
        const revision = this.revision, presentation = this.presentation, current = this.state.snapshot
        let snapshot: CanvasTerminalSnapshot
        try {
          try { snapshot = await this.api.snapshot(current?.generation ?? null, this.cursor) }
          catch (error) {
            // Only reads may fall back to a full discovery after a replaced Core/session.
            if (!current?.generation) throw error
            snapshot = await this.api.snapshot()
          }
          if (revision !== this.revision || presentation !== this.presentation) { this.readAgain = Boolean(this.reader); continue }
          await this.accept(snapshot, revision, presentation)
          this.resizeNeedsRead = false
          void this.pump()
        } catch (error) {
          if (revision === this.revision && presentation === this.presentation) this.publish({ readError: readErrorMessage(error) })
        }
      } while (this.readAgain)
    } finally { this.publish({ reading: false }) }
  }

  private async accept(snapshot: CanvasTerminalSnapshot, revision = this.revision, presentation = this.presentation): Promise<void> {
    const previous = this.state.snapshot
    const replaced = Boolean(previous && (previous.coreGeneration !== snapshot.coreGeneration || previous.generation !== snapshot.generation))
    if (replaced) { this.queue = new Uint8Array(); this.pendingInput = null; this.acknowledgedInputId = null; this.desiredSize = null }
    let actionError = replaced ? null : this.state.actionError
    if (this.pendingStart) {
      if (snapshot.coreGeneration !== this.pendingStart.coreGeneration) {
        this.pendingStart = null; actionError = uiAttribute('服务已重启，原终端不会自动启动。')
      } else if (snapshot.launchRequestId === this.pendingStart.requestId) { this.pendingStart = null; actionError = null }
      else if (snapshot.generation !== this.pendingStart.expectedGeneration) {
        this.pendingStart = null; actionError = uiAttribute('终端会话已变化，已读取当前会话。')
      }
    }
    let inputStatus = replaced ? 'idle' as const : this.state.inputStatus
    const lastInput = snapshot.inputs.at(-1)
    if (!this.pendingInput && lastInput && lastInput.inputId !== this.acknowledgedInputId && ['unknown', 'not_written'].includes(lastInput.status)) {
      this.pendingInput = { coreGeneration: snapshot.coreGeneration, generation: snapshot.generation!, inputId: lastInput.inputId, expectedInputSequence: lastInput.sequence - 1 }
    }
    if (this.pendingInput && snapshot.cleanupComplete && ['exited', 'failed'].includes(snapshot.phase)) {
      this.pendingInput = null; this.queue = new Uint8Array(); inputStatus = 'idle'
    }
    const pending = this.pendingInput
    if (pending) {
      const receipt = snapshot.inputs.find(item => item.inputId === pending.inputId && item.sequence === pending.expectedInputSequence + 1)
      if (receipt?.status === 'written') { this.pendingInput = null; inputStatus = 'idle'; actionError = null }
      else if (receipt) inputStatus = receipt.status === 'queued' || receipt.status === 'pending' ? 'waiting' : receipt.status
      else if (snapshot.inputSequence > pending.expectedInputSequence) inputStatus = 'expired'
    } else if (snapshot.inputs.some(item => item.status === 'queued' || item.status === 'pending')) inputStatus = 'waiting'
    else if (inputStatus === 'waiting') inputStatus = 'idle'
    if (inputStatus === 'unknown' || inputStatus === 'not_written' || inputStatus === 'expired') this.queue = new Uint8Array()
    const reader = this.reader
    if (reader) await reader(snapshot)
    if (revision !== this.revision || presentation !== this.presentation) { this.readAgain = Boolean(this.reader); return }
    this.cursor = reader ? snapshot.throughSeq : 0
    this.readyPresentation = Boolean(reader)
    this.publish({ snapshot, readError: null, actionError, startUnknown: Boolean(this.pendingStart), inputStatus,
      queuedBytes: this.queue.length, outputTruncated: replaced ? snapshot.gap : this.state.outputTruncated || snapshot.gap })
  }

  async start(size: CanvasTerminalSize): Promise<void> {
    const snapshot = this.state.snapshot
    if (!this.readyPresentation || !snapshot || this.state.action || this.pendingStart || this.pendingInput || this.state.readError
      || snapshot.exists && (!snapshot.cleanupComplete || !['exited', 'failed'].includes(snapshot.phase))) return
    this.pendingStart = { coreGeneration: snapshot.coreGeneration, requestId: this.uuid(), expectedGeneration: snapshot.generation,
      cols: size.cols, rows: size.rows }
    await this.dispatchStart()
  }

  async retryStart(): Promise<void> {
    if (!this.readyPresentation || this.state.action || !this.pendingStart || this.state.snapshot?.coreGeneration !== this.pendingStart.coreGeneration) return
    await this.dispatchStart()
  }

  private async dispatchStart(): Promise<void> {
    const request = this.pendingStart!
    ++this.revision
    this.publish({ action: 'start', actionError: null, startUnknown: false })
    try {
      const snapshot = await this.api.start({ ...request })
      if (this.state.snapshot?.coreGeneration !== request.coreGeneration) return
      this.pendingStart = null; this.cursor = 0
      await this.accept(snapshot, ++this.revision)
    } catch (error) {
      if (this.pendingStart === request) this.publish({ startUnknown: true, actionError: readErrorMessage(error) })
    } finally {
      ++this.revision; this.publish({ action: null })
    }
  }

  async stop(): Promise<void> {
    const snapshot = this.state.snapshot
    if (!snapshot?.generation || this.state.action) return
    this.queue = new Uint8Array(); this.desiredSize = null
    ++this.revision; this.publish({ action: 'stop', queuedBytes: 0, actionError: null })
    try { await this.api.stop(snapshot.generation) }
    catch (error) { this.publish({ actionError: readErrorMessage(error) }) }
    finally { ++this.revision; await this.refresh(); this.publish({ action: null }) }
  }

  inputReady(): boolean {
    return Boolean(this.readyPresentation && this.reader && this.state.snapshot?.phase === 'running' && !this.state.action && !this.pendingStart && !this.state.readError
      && !['unknown', 'not_written', 'expired'].includes(this.state.inputStatus))
  }

  enqueue(bytes: Uint8Array): boolean {
    if (!this.inputReady() || !bytes.length) return false
    if (this.queue.length + bytes.length > 64 * 1024) {
      this.publish({ actionError: uiAttribute('终端输入队列已满，此次输入未发送。请等候后重试。') }); return false
    }
    const queue = new Uint8Array(this.queue.length + bytes.length)
    queue.set(this.queue); queue.set(bytes, this.queue.length); this.queue = queue
    this.publish({ queuedBytes: queue.length }); void this.pump(); return true
  }

  resize(size: CanvasTerminalSize): void {
    if (!Number.isInteger(size.cols) || size.cols < 1 || size.cols > 1000 || !Number.isInteger(size.rows) || size.rows < 1 || size.rows > 1000) return
    this.desiredSize = { ...size }; void this.pump()
  }

  acknowledgeInput(): void {
    // A missing unadmitted receipt may still arrive. Only an advanced sequence fences that old input.
    if (!this.canAcknowledgeInput()) return
    const pending = this.pendingInput!
    this.acknowledgedInputId = pending.inputId; this.pendingInput = null; this.queue = new Uint8Array()
    this.publish({ inputStatus: 'idle', queuedBytes: 0, actionError: null })
  }

  canAcknowledgeInput(): boolean {
    return Boolean(this.pendingInput && this.state.snapshot && this.state.snapshot.inputSequence > this.pendingInput.expectedInputSequence
      && ['unknown', 'not_written', 'expired'].includes(this.state.inputStatus))
  }

  private sameSession(pending: Pick<PendingInput, 'coreGeneration' | 'generation'>): boolean {
    return this.state.snapshot?.coreGeneration === pending.coreGeneration && this.state.snapshot.generation === pending.generation
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.resizeNeedsRead || !this.reader || !this.inputReady() || this.pendingInput || this.state.inputStatus === 'waiting') return
    const snapshot = this.state.snapshot!
    const identity = { coreGeneration: snapshot.coreGeneration, generation: snapshot.generation! }
    this.pumping = true
    let resizing: CanvasTerminalSize | null = null
    try {
      const size = this.desiredSize
      if (size && !this.resizeNeedsRead) {
        this.desiredSize = null
        if (snapshot.cols !== size.cols || snapshot.rows !== size.rows) {
          resizing = size
          await this.api.resize({ generation: identity.generation, ...size })
          if (!this.sameSession(identity)) return
          this.publish({ snapshot: { ...this.state.snapshot!, ...size }, actionError: null })
        }
      }
      if (!this.queue.length || !this.inputReady() || !this.sameSession(identity)) return
      const bytes = this.queue.slice(0, 16 * 1024); this.queue = this.queue.slice(bytes.length)
      const pending: PendingInput = { ...identity, inputId: this.uuid(), expectedInputSequence: this.state.snapshot!.inputSequence }
      this.pendingInput = pending
      ++this.revision; this.publish({ queuedBytes: this.queue.length, inputStatus: 'sending', actionError: null })
      try {
        const receipt = await this.api.write({ generation: pending.generation, inputId: pending.inputId, expectedInputSequence: pending.expectedInputSequence }, bytes)
        if (!this.sameSession(pending) || this.pendingInput !== pending) return
        this.acceptInput(receipt)
      } catch (error) {
        if (this.sameSession(pending) && this.pendingInput === pending) {
          this.queue = new Uint8Array(); this.publish({ inputStatus: 'unknown', queuedBytes: 0, actionError: readErrorMessage(error) })
        }
      } finally { ++this.revision }
    } catch (error) {
      this.desiredSize ??= resizing
      this.resizeNeedsRead = true
      this.publish({ actionError: readErrorMessage(error) })
    } finally {
      this.pumping = false
      if (this.queue.length || this.desiredSize && !this.resizeNeedsRead) void this.pump()
    }
  }

  private acceptInput(receipt: CanvasTerminalInputReceipt): void {
    if (receipt.status === 'written') this.pendingInput = null
    const uncertain = receipt.status === 'unknown' || receipt.status === 'not_written'
    if (uncertain) this.queue = new Uint8Array()
    this.publish({ snapshot: { ...this.state.snapshot!, inputSequence: Math.max(this.state.snapshot!.inputSequence, receipt.sequence) },
      inputStatus: receipt.status === 'written' ? 'idle' : uncertain ? receipt.status as 'unknown' | 'not_written' : 'waiting', queuedBytes: this.queue.length })
  }
}
