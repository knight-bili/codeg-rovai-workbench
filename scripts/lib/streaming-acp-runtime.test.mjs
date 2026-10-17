import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { once } from 'node:events'

// Owns the fixed ACP's promised recovery behavior, not production inference.
test('controlled ACP resumes the requested session and holds only the current input', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'rovai-fixed-acp-recovery-'))
  const capture = join(root, 'captured.jsonl'), env = { ROVAI_SKILL_RECOVERY_CAPTURE: capture }
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key]
  const child = spawn(process.execPath, ['scripts/fixtures/streaming-acp-runtime.mjs'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = once(child, 'exit'), messages = [], waiters = []
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line); messages.push(message)
    for (const notify of waiters.splice(0)) notify()
  })
  const send = (id, method, params = {}) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }) + '\n')
  const wait = async predicate => {
    const deadline = Date.now() + 3000
    while (!messages.some(predicate)) {
      assert.ok(Date.now() < deadline, 'controlled ACP response timeout: ' + stderr)
      await new Promise(resolve => { const timer = setTimeout(resolve, 20); waiters.push(() => { clearTimeout(timer); resolve() }) })
    }
    return messages.find(predicate)
  }
  try {
    send(1, 'initialize'); await wait(message => message.id === 1)
    send(2, 'session/resume', { sessionId: 'fixture-stream-from-a-prior-process' })
    assert.equal((await wait(message => message.id === 2)).result.sessionId, 'fixture-stream-from-a-prior-process')
    send(3, 'session/prompt', { sessionId: 'fixture-stream-from-a-prior-process', prompt: [{ type: 'text',
      text: '[REFERENCE]\nROVAI_SKILL_RECOVERY_HELD_INPUT old history\n[/REFERENCE]\n[CURRENT_INPUT]\n{"message":"ordinary successor"}\n[/CURRENT_INPUT]' }] })
    assert.equal((await wait(message => message.id === 3)).result.stopReason, 'end_turn')
    send(4, 'session/prompt', { sessionId: 'fixture-stream-from-a-prior-process', prompt: [{ type: 'text', text: '[CURRENT_INPUT]\n{"message":"ROVAI_SKILL_RECOVERY_HELD_INPUT current"}\n[/CURRENT_INPUT]' }] })
    await wait(message => message.method === 'session/update' && message.params.update.content?.text.includes('waiting for recovery'))
    assert.ok(!messages.some(message => message.id === 4))
    send(null, 'session/cancel', { sessionId: 'fixture-stream-from-a-prior-process' })
    assert.equal((await wait(message => message.id === 4)).result.stopReason, 'cancelled')
    const silentStart = messages.length
    send(5, 'session/prompt', { sessionId: 'fixture-stream-from-a-prior-process', prompt: [{ type: 'text', text: '[CURRENT_INPUT]\n{"message":"ROVAI_SKILL_RECOVERY_SILENT_HELD_INPUT current"}\n[/CURRENT_INPUT]' }] })
    send(6, 'fixture/check')
    await wait(message => message.id === 6)
    assert.ok(!messages.slice(silentStart).some(message => message.id === 5 || message.method === 'session/update'))
    send(null, 'session/cancel', { sessionId: 'fixture-stream-from-a-prior-process' })
    assert.equal((await wait(message => message.id === 5)).result.stopReason, 'cancelled')
    const captured = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(captured.map(entry => entry.requestId), [3, 4, 5])
    assert.ok(messages.filter(message => message.method === 'session/update').every(message => message.params.sessionId === 'fixture-stream-from-a-prior-process'))
  } finally { child.stdin.end(); assert.deepEqual(await closed, [0, null]) }
})
