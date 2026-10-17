import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { setTimeout as pause } from 'node:timers/promises'
import { Script } from 'node:vm'

// Extends the existing actual Host/HTTP lifecycle owner. No second Core/DB fixture or model.
export async function canvasTerminalProcessFixture(fixture, scratch, dataDir) {
  const directory = join(fixture, 'terminal-process'), home = join(directory, 'home'), cwd = join(directory, '终端 cwd')
  await Promise.all([mkdir(home, { recursive: true }), mkdir(cwd, { recursive: true })])
  const environment = {}
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'ComSpec', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  const system = process.env.SystemRoot ?? process.env.SYSTEMROOT
  environment.PATH = [dirname(process.execPath), ...(process.platform === 'win32' ? [join(system, 'System32'), join(system, 'System32/WindowsPowerShell/v1.0')] : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(delimiter)
  Object.assign(environment, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home,
    TMPDIR: scratch, TMP: scratch, TEMP: scratch, SHELL: process.execPath, NODE_REPL_HISTORY: '', NO_COLOR: '1' })
  const worker = join(directory, 'owned-worker.cjs')
  await writeFile(worker, `const fs=require('node:fs'),http=require('node:http');
const [path,nonce]=process.argv.slice(2); const server=http.createServer((request,response)=>{
 if(request.headers['x-fixture-nonce']!==nonce){response.writeHead(403);response.end();return}
 response.setHeader('Content-Type','application/json');response.end(JSON.stringify({pid:process.pid,nonce}),()=>{if(request.method==='POST'&&request.url==='/'+nonce+'/stop')process.exit(0)})
});server.listen(0,'127.0.0.1',()=>fs.writeFileSync(path,JSON.stringify({pid:process.pid,nonce,port:server.address().port}),{mode:0o600}));
`)
  const owned = [], shells = [], targets = []
  let control, controlClosed, kept, crash
  const manifest = label => ({ path: join(directory, label + '-' + randomUUID() + '.json'), nonce: randomUUID() })
  const load = async spec => until(async () => {
    try { const value = JSON.parse(await readFile(spec.path, 'utf8')); return value.nonce === spec.nonce && await probe(value) ? value : null }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }, 'fixture process readiness')
  const spawnControl = async () => {
    const spec = manifest('independent-control')
    control = spawn(process.execPath, [worker, spec.path, spec.nonce], { cwd, env: environment, windowsHide: true, stdio: 'ignore' })
    controlClosed = new Promise(resolve => { control.once('close', resolve); control.once('error', resolve) })
    const info = await load(spec); owned.push(info); return info
  }
  const controlAlive = async () => { assert.equal(control.exitCode, null); assert.ok(await probe(owned[0]), 'unrelated control must survive') }
  const createTarget = async request => {
    const created = await request('canvas.boards.create', { commandId: randomUUID(), command: { name: 'Isolated terminal process' } })
    assert.equal(created.status, 'applied', JSON.stringify(created))
    const board = created.payload.board
    const result = await request('canvas.nodes.apply', { commandId: randomUUID(), command: { boardId: board.id, expectedRevision: board.revision,
      mutation: { type: 'create', node: { kind: 'terminal', path: cwd, x: 0, y: 0, width: 480, height: 300 } } } })
    assert.equal(result.status, 'applied', JSON.stringify(result))
    const target = { boardId: board.id, nodeId: result.payload.nodeIds[0] }
    const graph = await request('canvas.nodes.snapshot', { boardId: board.id })
    assert.equal(graph.terminalVersion, 1, 'candidate must contain the current terminal capability')
    targets.push(target); return target
  }
  const start = async (request, target, expectedGeneration = null) => {
    const before = await request('canvas.terminals.snapshot', { target })
    if (expectedGeneration === null) assert.equal(before.exists, false)
    else { assert.equal(before.generation, expectedGeneration); assert.equal(before.cleanupComplete, true) }
    const original = { target, coreGeneration: before.coreGeneration, requestId: randomUUID(), expectedGeneration, cols: 80, rows: 24 }
    const [first, replay] = await Promise.all([request('canvas.terminals.start', original), request('canvas.terminals.start', structuredClone(original))])
    assert.equal(first.launchRequestId, original.requestId)
    assert.equal(first.coreGeneration, original.coreGeneration)
    assert.equal(replay.generation, first.generation, 'concurrent original start creates only one session')
    const snapshot = await until(async () => {
      const value = await request('canvas.terminals.snapshot', { target, generation: first.generation, afterSeq: 0 })
      assert.notEqual(value.phase, 'failed', value.issue)
      const output = stripVTControlCharacters(Buffer.concat(value.chunks.map(chunk => Buffer.from(chunk.bytesBase64, 'base64'))).toString('utf8'))
      return value.phase === 'running' && />\s*$/.test(output) ? value : null
    }, 'actual PTY readiness')
    const session = { request, target, snapshot, generation: snapshot.generation, sequence: snapshot.inputSequence, original }
    const infoSpec = manifest('shell')
    const infoCode = `var __terminalServer=require('node:http').createServer((q,r)=>{if(q.headers['x-fixture-nonce']!==${JSON.stringify(infoSpec.nonce)}){r.writeHead(403);r.end();return}r.end(JSON.stringify({pid:process.pid,nonce:${JSON.stringify(infoSpec.nonce)}}),()=>{if(q.method==='POST'&&q.url===${JSON.stringify('/' + infoSpec.nonce + '/stop')})process.exit(0)})});__terminalServer.listen(0,'127.0.0.1',()=>require('node:fs').writeFileSync(${JSON.stringify(infoSpec.path)},JSON.stringify({pid:process.pid,ppid:process.ppid,nonce:${JSON.stringify(infoSpec.nonce)},port:__terminalServer.address().port,cwd:process.cwd(),tty:process.stdin.isTTY}),{mode:0o600}));`
    await send(session, infoCode)
    const shell = await load(infoSpec)
    assert.equal(shell.tty, true, 'a pipe or mocked console is not an interactive PTY')
    assert.equal(await realpath(shell.cwd), await realpath(cwd))
    shells.push(shell); owned.push(shell)
    const childSpec = manifest('detached-child')
    await send(session, `require('node:child_process').spawn(process.execPath,[${JSON.stringify(worker)},${JSON.stringify(childSpec.path)},${JSON.stringify(childSpec.nonce)}],{detached:true,stdio:'ignore',windowsHide:true}).unref();`)
    const child = await load(childSpec); owned.push(child)
    if (process.platform === 'darwin') {
      // 先见到本夹具的实际落盘归属，再强退；固定等待时长不能证明已捕获。
      const ledgerDirectory = join(dataDir, 'runtime/canvas-terminals', session.generation)
      await until(async () => {
        for (const name of await readdir(ledgerDirectory)) {
          if (!name.endsWith('.json')) continue
          const ledger = JSON.parse(await readFile(join(ledgerDirectory, name), 'utf8'))
          const identities = Object.values(ledger.processes)
          if (ledger.schema === 1 && [shell.pid, shell.ppid, child.pid].every(pid => identities.some(row => row.pid === pid))) return true
        }
        return false
      }, 'macOS persisted owned descendant identities')
    }
    session.shell = shell; session.child = child
    await controlAlive()
    return session
  }
  async function send(session, code, id = randomUUID()) {
    new Script(code) // 在写入实际PTY前报告夹具代码生成错误，避免把语法错误判成运输超时。
    const params = { target: session.target, generation: session.generation, inputId: id, expectedInputSequence: session.sequence,
      bytesBase64: Buffer.from(code + '\r', 'utf8').toString('base64') }
    let receipt = await session.request('canvas.terminals.write', params)
    while (receipt.status === 'queued' || receipt.status === 'pending') {
      receipt = await until(async () => {
        const state = await session.request('canvas.terminals.snapshot', { target: session.target, generation: session.generation })
        return state.inputs.find(item => item.inputId === id && !['queued', 'pending'].includes(item.status))
      }, 'actual input write receipt')
    }
    assert.equal(receipt.status, 'written', JSON.stringify(receipt))
    assert.equal(receipt.sequence, ++session.sequence); assert.equal(receipt.inputId, id)
    return params
  }
  async function marker(session, code, tag = 'TERMINAL_' + randomUUID().replaceAll('-', '')) {
    await send(session, code.replaceAll('$TAG', JSON.stringify(tag)))
    return until(async () => {
      const state = await session.request('canvas.terminals.snapshot', { target: session.target, generation: session.generation, afterSeq: 0 })
      const bytes = Buffer.concat(state.chunks.map(chunk => Buffer.from(chunk.bytesBase64, 'base64')))
      const text = stripVTControlCharacters(bytes.toString('utf8'))
      for (const line of text.split(/[\r\n]+/)) {
        const index = line.indexOf(tag + '{')
        if (index < 0) continue
        try { return { value: JSON.parse(line.slice(index + tag.length)), state, bytes } } catch { /* An echoed JS source line is not runtime evidence. */ }
      }
      return null
    }, 'runtime output marker')
  }
  const assertReaped = async session => {
    await until(async () => !(await alive(session.shell.pid)) && !(await alive(session.shell.ppid)) && !(await alive(session.child.pid)), 'terminal root/helper/detached tree exit')
    await controlAlive()
  }
  return {
    environment,
    async exercise(host, origin, session) {
      await spawnControl()
      const native = host.request.bind(host)
      const web = async (operation, params = {}) => {
        const response = await fetch(origin + '/api/v1/request', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ operation, params }) })
        assert.equal(response.status, 200)
        const reply = await response.json()
        if (reply.error) throw Object.assign(new Error(reply.error.message), reply.error)
        return reply.result
      }
      const first = await start(web, await createTarget(native))
      assert.equal((await native('canvas.terminals.snapshot', { target: first.target })).generation, first.generation)
      const counter = join(directory, 'once.json')
      const increment = `require('node:fs').writeFileSync(${JSON.stringify(counter)},String(Number(require('node:fs').existsSync(${JSON.stringify(counter)})?require('node:fs').readFileSync(${JSON.stringify(counter)},'utf8'):0)+1));`
      const original = await send(first, increment)
      assert.equal((await native('canvas.terminals.write', structuredClone(original))).inputId, original.inputId)
      await marker(first, `console.log($TAG+JSON.stringify({barrier:true}));`)
      assert.equal(await readFile(counter, 'utf8'), '1', 'original input retry must not redeliver bytes')
      await assert.rejects(native('canvas.terminals.write', { ...original, inputId: randomUUID() }))
      await assert.rejects(web('canvas.terminals.start', { ...first.original, cwd: fixture }))
      await assert.rejects(web('canvas.terminals.start', { ...first.original, cols: 81 }))
      await assert.rejects(native('canvas.terminals.snapshot', { target: { ...first.target, nodeId: randomUUID() } }))
      await assert.rejects(web('canvas.terminals.snapshot', { target: { ...first.target, boardId: randomUUID() } }))
      const unauthorized = await fetch(origin + '/api/v1/request', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2000), headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'canvas.terminals.stop', params: { target: first.target, generation: first.generation } }) })
      assert.equal(unauthorized.status, 401); assert.ok(await probe(first.shell))
      await web('canvas.terminals.resize', { target: first.target, generation: first.generation, cols: 111, rows: 33 })
      const size = await marker(first, `(function dimensions(){if(process.stdout.columns===111&&process.stdout.rows===33)console.log($TAG+JSON.stringify({cols:process.stdout.columns,rows:process.stdout.rows}));else setTimeout(dimensions,25)})()`)
      assert.deepEqual(size.value, { cols: 111, rows: 33 })
      const pattern = Buffer.from('中文\x1b[31mRED\x1b[0m', 'utf8')
      const flood = await marker(first, `process.stdout.write(Buffer.alloc(256*1024,120),()=>{process.stdout.write(Buffer.from(${JSON.stringify(pattern.toString('base64'))},'base64'));console.log('\\n'+$TAG+JSON.stringify({flood:true}))});`)
      // ConPTY可规范化颜色/换行控制序列；比较实际PTY后的同序号原字节，不要求它回显原ANSI编码。
      assert.ok(stripVTControlCharacters(flood.bytes.toString('utf8')).replace(/[\r\n]/g, '').includes('中文RED'))
      const pipeOutput = await native('canvas.terminals.snapshot', { target: first.target, generation: first.generation, afterSeq: 0 })
      const httpChunks = new Map(flood.state.chunks.map(chunk => [chunk.seq, chunk.bytesBase64]))
      const sharedChunks = pipeOutput.chunks.filter(chunk => httpChunks.has(chunk.seq))
      assert.ok(sharedChunks.length, 'actual HTTP and pipe snapshots share retained output')
      for (const chunk of sharedChunks) assert.equal(chunk.bytesBase64, httpChunks.get(chunk.seq), 'same-sequence UTF8/control bytes must match across transports')
      assert.ok(flood.bytes.length <= 128 * 1024); assert.ok(flood.state.chunks.length <= 2048); assert.equal(flood.state.gap, true)
      assert.ok(flood.state.chunks.every(chunk => Buffer.from(chunk.bytesBase64, 'base64').length <= 8192))
      const healthAt = Date.now(); await native('app.info'); assert.ok(Date.now() - healthAt < 5000, 'output must not monopolize the interactive queue')
      const graph = await native('canvas.nodes.snapshot', { boardId: first.target.boardId })
      assert.equal((await native('canvas.nodes.apply', { commandId: randomUUID(), command: { boardId: first.target.boardId, expectedRevision: graph.board.revision, mutation: { type: 'delete', nodeIds: [first.target.nodeId] } } })).status, 'applied')
      await assertReaped(first)
      await assert.rejects(web('canvas.terminals.write', { ...original, expectedInputSequence: first.sequence, inputId: randomUUID() }))

      const boardDeleted = await start(native, await createTarget(web))
      const board = await native('canvas.boards.get', { boardId: boardDeleted.target.boardId })
      assert.equal((await web('canvas.boards.delete', { commandId: randomUUID(), command: { boardId: boardDeleted.target.boardId, expectedRevision: board.board.revision } })).status, 'applied')
      await assertReaped(boardDeleted)
      const exited = await start(native, await createTarget(web))
      await native('canvas.terminals.write', { target: exited.target, generation: exited.generation, inputId: randomUUID(), expectedInputSequence: exited.sequence, bytesBase64: Buffer.from('process.exit(7)\r').toString('base64') })
      const exitState = await until(async () => { const value = await native('canvas.terminals.snapshot', { target: exited.target, generation: exited.generation }); return value.cleanupComplete ? value : null }, 'natural shell exit and detached cleanup')
      assert.equal(exitState.phase, 'exited'); assert.equal(exitState.exitCode, 7); await assertReaped(exited)
      kept = await start(native, await createTarget(web))
      assert.deepEqual(await native('canvas.terminals.stop', { target: kept.target, generation: kept.generation }), { stopping: true })
      await until(async () => { const state = await native('canvas.terminals.snapshot', { target: kept.target, generation: kept.generation }); return state.cleanupComplete ? state : null }, 'explicit stop cleanup')
      await assertReaped(kept)
      const previous = kept
      kept = await start(native, previous.target, previous.generation)
      assert.notEqual(kept.generation, previous.generation)
      await assert.rejects(native('canvas.terminals.write', { ...original, target: previous.target, generation: previous.generation }))
      // Leave this real session alive for the existing planned Core shutdown below.
    },
    async assertPlannedReaped() { assert.ok(kept); await assertReaped(kept) },
    async assertRestarted(host) {
      await controlAlive()
      for (const target of targets) {
        const graph = await host.request('canvas.nodes.snapshot', { boardId: target.boardId })
        if (!graph.board || !graph.nodes.some(node => node.id === target.nodeId)) continue
        const state = await host.request('canvas.terminals.snapshot', { target })
        assert.equal(state.exists, false, 'Core restart must not automatically reopen a PTY')
        assert.notEqual(state.coreGeneration, kept.original.coreGeneration)
        if (crash) assert.notEqual(state.coreGeneration, crash.original.coreGeneration)
      }
      if (crash) await assertReaped(crash)
    },
    async armCrash(host) { crash = await start(host.request.bind(host), await createTarget(host.request.bind(host))) },
    async cleanup() {
      for (const info of [...owned].reverse()) await probe(info, true)
      if (control) { const timer = setTimeout(() => control.kill('SIGKILL'), 2000); try { await controlClosed } finally { clearTimeout(timer) } }
      for (const info of owned) await until(async () => !(await alive(info.pid)), 'fixture process cleanup')
      for (const info of shells) await until(async () => !(await alive(info.ppid)), 'fixture helper cleanup')
    }
  }
}

async function probe(info, stop = false) {
  try {
    if (stop && !await probe(info)) return false
    const response = await fetch(`http://127.0.0.1:${info.port}/${info.nonce}/${stop ? 'stop' : 'status'}`, { method: stop ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(500), headers: { 'x-fixture-nonce': info.nonce } })
    const identity = await response.json(); return response.status === 200 && identity.pid === info.pid && identity.nonce === info.nonce
  } catch { return false }
}
async function alive(pid) {
  if (process.platform === 'linux') {
    try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/); return fields[0] !== 'Z' && fields[0] !== 'X' }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error }
  }
  try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
async function until(read, label, ms = 15_000) {
  const deadline = Date.now() + ms
  do { const value = await read(); if (value) return value; await pause(25) } while (Date.now() < deadline)
  throw new Error(`Canvas terminal process verification timed out: ${label}`)
}
