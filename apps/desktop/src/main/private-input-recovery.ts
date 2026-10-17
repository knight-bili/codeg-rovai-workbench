import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Desktop-owned editor state only. Command receipts and material authority remain in Core. */
export class NativePrivateInputRecovery {
  constructor(private readonly root: string) {}
  private path(identity: unknown): string {
    if (typeof identity !== 'string' || identity.length > 8192 || identity.includes('\0')
      || !['single-chat:', 'single-chat-input-intent:v1:', 'single-chat-input-body-index:v1'].some(prefix => identity.startsWith(prefix))) {
      throw new Error('私聊输入记录归属无效。')
    }
    return join(this.root, createHash('sha256').update(identity).digest('hex')+'.json')
  }
  get(identity: string): {found:false} | {found:true; value:unknown} {
    const path = this.path(identity)
    let bytes: Buffer
    try {
      const entry = lstatSync(path)
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 32*1024*1024) throw new Error('私聊输入记录无效。')
      bytes = readFileSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {found:false}
      throw error
    }
    const saved: unknown = JSON.parse(bytes.toString('utf8'))
    if (!saved || typeof saved !== 'object' || Array.isArray(saved) || !('version' in saved) || saved.version !== 1
      || !('identity' in saved) || saved.identity !== identity || !('value' in saved)) throw new Error('私聊输入记录无效。')
    return {found:true, value:saved.value}
  }
  set(identity: string, value: unknown): void {
    const path = this.path(identity)
    // A damaged saved record requires recovery; never silently replace it with an empty draft.
    this.get(identity)
    if (value === undefined) throw new Error('私聊输入记录无效。')
    const bytes = Buffer.from(JSON.stringify({version:1, identity, value}))
    if (bytes.length > 32*1024*1024) throw new Error('私聊输入记录过大，请保留原文后重试。')
    mkdirSync(this.root, {recursive:true, mode:0o700})
    if (!lstatSync(this.root).isDirectory() || lstatSync(this.root).isSymbolicLink()) throw new Error('私聊输入目录无效。')
    const temporary = join(this.root, randomUUID()+'.tmp')
    try {
      writeFileSync(temporary, bytes, {flag:'wx', mode:0o600, flush:true})
      renameSync(temporary, path)
    } finally {
      try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
}
