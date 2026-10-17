import type { CanvasTerminalSnapshot } from '@contracts'
import { uiAttribute } from './interface-language'

type TerminalWriter = { reset(): void; write(bytes: Uint8Array, callback: () => void): void }

/** Raw bytes reach one emulator in sequence; the callback is the redraw backpressure boundary. */
export class CanvasTerminalReader {
  private identity = ''
  private through = 0
  private disposed = false
  private tail = Promise.resolve()
  private completions = new Set<() => void>()

  constructor(private readonly terminal: TerminalWriter) {}
  apply = (snapshot: CanvasTerminalSnapshot): Promise<void> => {
    this.tail = this.tail.catch(() => { this.identity = ''; this.through = 0 }).then(async () => {
      if (this.disposed) return
      const identity = JSON.stringify([snapshot.coreGeneration, snapshot.generation])
      if (identity !== this.identity || snapshot.firstAvailableSeq > this.through + 1) {
        this.terminal.reset(); this.identity = identity; this.through = snapshot.firstAvailableSeq - 1
      }
      for (const chunk of snapshot.chunks) {
        if (this.disposed) return
        if (chunk.seq <= this.through) continue
        if (chunk.seq !== this.through + 1) throw new Error(uiAttribute('终端输出顺序不完整，请重新读取。'))
        const bytes = Uint8Array.from(atob(chunk.bytesBase64), byte => byte.charCodeAt(0))
        await new Promise<void>((resolve, reject) => {
          const complete = () => { this.completions.delete(complete); resolve() }
          this.completions.add(complete)
          try { this.terminal.write(bytes, complete) } catch (error) { this.completions.delete(complete); reject(error) }
        })
        this.through = chunk.seq
      }
    })
    return this.tail
  }
  dispose(): void {
    this.disposed = true
    for (const complete of this.completions) complete()
    this.completions.clear()
  }
}
