import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchHost, within } from '../lib/host-test-client.mjs'
import { coreDataDirectoryArguments } from '../lib/runtime-camp-files-root.mjs'
import { launchAcceptanceBrowser, pause } from '../lib/host-web-browser.mjs'

// Existing Web entry, actual Core authorities and browser navigation. Only the
// old upload response is paused; no authentication or business reply is forged.
export async function qualifyCrossCoreUpload({ binary, uiDirectory, chrome, output }) {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'rovai-cross-core-upload-')))
  const profile = join(fixture, 'browser-profile'), home = join(fixture, 'home'), hosts = []
  await mkdir(output, { recursive: true }); await mkdir(home)
  const env = {}
  for (const key of ['SystemRoot','WINDIR','COMSPEC','PATHEXT']) if (process.env[key]) env[key] = process.env[key]
  Object.assign(env, { PATH: join(process.env.SystemRoot, 'System32'), HOME: home, USERPROFILE: home,
    APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'), TEMP: fixture, TMP: fixture })
  await Promise.all([mkdir(env.APPDATA, { recursive: true }), mkdir(env.LOCALAPPDATA, { recursive: true })])
  const report = { status: 'running', channel: 'automatic_acceptance', fixture, profile, hosts: [], checks: [],
    external_model_calls: 0, started_at: new Date().toISOString() }
  console.log(JSON.stringify({ channel: report.channel, fixture, profile, model: false }))
  let browser, pausedUpload, stopEvents
  const record = name => { report.checks.push({ name, passed: true }); console.log(JSON.stringify({ check: name, passed: true })) }
  const request = async (host, token, operation, params) => {
    const response = await fetch(`${host.origin}/api/v1/request`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation, params }), signal: AbortSignal.timeout(15_000), redirect: 'error' })
    assert.equal(response.status, 200, operation)
    const reply = await response.json(); assert.equal(reply.error, null, `${operation}: ${reply.error?.code}`)
    return reply.result
  }
  try {
    for (const label of ['A', 'B']) {
      const formal = join(fixture, 'core-' + label)
      const prepared = JSON.parse(execFileSync(binary, ['--prepare-windows-data-root', formal], { encoding: 'utf8', windowsHide: true }))
      const dataDir = prepared.core, skillLibraryRoot = join(dataDir, 'managed-skill-library'), mcpConfigPath = join(dataDir, 'mcp.json')
      await writeFile(mcpConfigPath, '{"mcpServers":{}}\n', { flag: 'wx' })
      const process = launchHost(binary, [...coreDataDirectoryArguments(dataDir), '--skill-library-root', skillLibraryRoot,
        '--mcp-config-path', mcpConfigPath], { env, cwd: fixture, windowsHide: true })
      const host = { process, dataDir, skillLibraryRoot, mcpConfigPath }; hosts.push(host)
      await within(process.ready)
      const started = await process.request('host.web.start', { listen: '127.0.0.1:0', uiDirectory })
      host.origin = started.origin; host.administratorToken = started.administratorToken
      const member = await process.request('members.create', { commandId: randomUUID(), command: {
        displayName: `PC10 ${label} Core队员`, teamRole: '隔离上传验证', professionalResponsibilities: '不配置Runtime，不发送模型消息。',
        personalityTraits: [], workingPrinciples: '只验证实际材料与连接归属。', growthTopic: '' } })
      assert.equal(member.status, 'applied')
      const agentId = member.resultEntity.entityId
      const created = await process.request('threads.create', { commandId: randomUUID(), name: `PC10 ${label} Core工程`, workspace: null,
        memberAgentIds: [agentId], defaultLeadAgentId: agentId, collaborationMode: 'peer' })
      assert.equal(created.status, 'applied'); host.threadId = created.payload.threadId
      const opened = await process.request('singleChat.open', { commandId: randomUUID(), command: { threadId: host.threadId, agentId } })
      assert.equal(opened.status, 'applied'); host.conversationId = opened.payload.conversationId
      const board = await process.request('canvas.boards.create', { commandId: randomUUID(), command: { name: `PC10 ${label} Core画板` } })
      assert.equal(board.status, 'applied'); host.boardId = board.payload.board.id
      const pin = await process.request('canvas.nodes.apply', { commandId: randomUUID(), command: { boardId: host.boardId,
        expectedRevision: board.payload.board.revision, mutation: { type: 'create', node: { kind: 'conversation', title: `PC10 ${label} Core私聊`,
          conversation: { threadId: host.threadId, conversationId: host.conversationId }, x: 0, y: 0, width: 600, height: 650 } } } })
      assert.equal(pin.status, 'applied'); host.scope = { kind: 'canvas', boardId: host.boardId, nodeId: pin.payload.nodeIds[0] }
      report.hosts.push({ label, pid: process.child.pid, origin: host.origin, dataDir, skillLibraryRoot, mcpConfigPath,
        threadId: host.threadId, conversationId: host.conversationId, scope: host.scope })
    }
    const [first, second] = hosts
    assert.notEqual(first.dataDir, second.dataDir); assert.notEqual(first.origin, second.origin)
    record('two_independent_protected_core_authorities_and_real_http_entries_without_runtime_or_seeded_rows')
    browser = await launchAcceptanceBrowser({ executable: chrome, env, args: ['--headless=new', '--no-first-run', '--disable-sync',
      '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-extensions',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'] })
    let resolvePaused
    const paused = new Promise(resolve => { resolvePaused = resolve })
    const networkEvents = [], dialogEvents = [], contexts = new Map()
    report.network_events = networkEvents; report.dialog_events = dialogEvents
    stopEvents = browser.onProtocolEvent(message => {
      if (message.method === 'Runtime.executionContextCreated') contexts.set(message.params.context.id, message.params.context)
      if (message.method === 'Runtime.executionContextDestroyed') contexts.delete(message.params.executionContextId)
      if (message.method === 'Runtime.executionContextsCleared') contexts.clear()
      if (message.method === 'Fetch.requestPaused' && message.params.request.url === `${first.origin}/api/v1/uploads`) {
        assert.equal(pausedUpload, undefined)
        pausedUpload = message.params; resolvePaused()
      }
      if (message.method === 'Network.loadingFailed' && message.params.requestId === pausedUpload?.networkId)
        networkEvents.push({ method: message.method, cancelled: message.params.canceled, errorText: message.params.errorText })
      if (message.method === 'Network.loadingFinished' && message.params.requestId === pausedUpload?.networkId)
        networkEvents.push({ method: message.method })
      if (message.method === 'Page.javascriptDialogOpening') {
        dialogEvents.push({ type: message.params.type })
        void browser.send('Page.handleJavaScriptDialog', { accept: true }).catch(error => { dialogEvents.push({ failure: String(error) }) })
      }
    })
    const navigate = async origin => {
      const before = await browser.send('Page.getFrameTree')
      let resolveCommit
      const committed = new Promise(resolve => { resolveCommit = resolve })
      const stop = browser.onProtocolEvent(message => {
        if (message.method === 'Page.frameNavigated' && message.params.frame.id === before.frameTree.frame.id
          && message.params.frame.loaderId !== before.frameTree.frame.loaderId && message.params.frame.url.startsWith(origin)) resolveCommit()
      })
      try { await browser.send('Page.navigate', { url: origin }); await within(committed) } finally { stop() }
      await pause(100); await browser.wait('document.readyState === "complete"', 30_000)
      const after = await browser.send('Page.getFrameTree')
      assert.equal(after.frameTree.frame.id, before.frameTree.frame.id, 'switch the same browser page, not a second page')
    }
    const open = async host => {
      await navigate(host.origin)
      await browser.wait('Boolean(document.querySelector("#administrator-token"))', 30_000)
      await browser.click('document.querySelector("#administrator-token")')
      await browser.send('Input.insertText', { text: host.administratorToken })
      await browser.click('document.querySelector(".web-login button[type=submit]")')
      await browser.wait('!document.querySelector(".web-login-overlay")&&Boolean(document.querySelector("button[aria-label=无限画布]"))', 30_000)
      await browser.click('document.querySelector("button[aria-label=无限画布]")')
      await browser.wait(`Boolean(document.querySelector('.canvas-board-title[data-board-id="${host.boardId}"]'))||Boolean(document.querySelector('.canvas-board-tile[data-board-id="${host.boardId}"]:not(:disabled)'))`, 30_000)
      if (!await browser.evaluate(`Boolean(document.querySelector('.canvas-board-title[data-board-id="${host.boardId}"]'))`)) {
        await browser.click(`document.querySelector('.canvas-board-tile[data-board-id="${host.boardId}"]')`)
      }
      await browser.wait(`Boolean(document.querySelector('[data-id="${host.scope.nodeId}"] button[aria-label="展开对话"]:not(:disabled)'))`)
      await browser.click(`document.querySelector('[data-id="${host.scope.nodeId}"] button[aria-label="展开对话"]')`)
      await browser.wait('Boolean(document.querySelector(".single-chat-composer textarea:not(:disabled)"))')
      host.token = await browser.evaluate('JSON.parse(sessionStorage.getItem("rovai.web.auth.v1")).token')
      assert.ok(host.token)
    }
    await open(first)
    const oldContext = [...contexts.values()].find(context => context.origin === first.origin && context.auxData?.isDefault)
    assert.ok(oldContext, 'observe the actual old page default execution context before navigation')
    const frame = host => `.canvas-conversation-frame[data-canvas-conversation-key*="${host.scope.nodeId}"]`
    const input = host => `document.querySelector('${frame(host)} .single-chat-composer textarea')`
    const firstBody = '旧Core保留的未发送正文', nextBody = '新Core自己的未发送正文', fileName = 'PC10 仅属于原Core.txt'
    await browser.click(input(first)); await browser.send('Input.insertText', { text: firstBody })
    await browser.wait(`Boolean(document.querySelector('${frame(first)} button[aria-label="添加文件"]:not(:disabled)'))`)
    const file = join(fixture, fileName); await writeFile(file, 'PC10 只允许绑定旧Core的合成材料。', { flag: 'wx' })
    await browser.send('Fetch.enable', { patterns: [{ urlPattern: `${first.origin}/api/v1/uploads`, requestStage: 'Response' }] })
    await browser.setFiles(`${frame(first)} input.composer-file-input`, [file]); await within(paused)
    assert.equal(pausedUpload.responseStatusCode, 200)
    const get = host => request(host, host.token, 'singleChat.get', { conversationId: host.conversationId, composerScope: host.scope })
    const committed = await get(first)
    assert.deepEqual(committed.draft.attachments.map(item => item.displayName), [fileName])
    assert.equal(await browser.evaluate(`${input(first)}.value`), firstBody)
    report.upload_pause = { url: pausedUpload.request.url, status: pausedUpload.responseStatusCode,
      requestId: pausedUpload.requestId, networkId: pausedUpload.networkId, attachmentIds: committed.draft.attachments.map(item => item.id) }
    record('real_old_core_committed_the_browser_file_before_its_actual_http_upload_reply_is_released')
    await browser.capture(join(output, '01-old-core-upload-response-paused.png'))
    await open(second)
    assert.equal(await browser.evaluate(`${input(second)}.value`), '')
    await browser.click(input(second)); await browser.send('Input.insertText', { text: nextBody })
    const clean = await get(second)
    assert.deepEqual(clean.draft.attachments, []); assert.deepEqual(clean.draft.quotes, [])
    assert.deepEqual(clean.messages, []); assert.deepEqual(clean.agentRuns, [])
    let destroyedContext
    try { await browser.send('Runtime.evaluate', { expression: 'location.origin', contextId: oldContext.id, returnByValue: true }) }
    catch (error) {
      assert.equal(error.code, -32000)
      assert.match(error.message, /Cannot find context with specified id/)
      destroyedContext = { id: oldContext.id, code: error.code, message: error.message }
    }
    assert.ok(destroyedContext, 'the new Core must own a new page, with the old execution context actually gone')
    report.destroyed_old_context = destroyedContext
    let release
    try { await browser.send('Fetch.continueResponse', { requestId: pausedUpload.requestId }); release = 'continued_after_new_core_opened' }
    catch (error) {
      report.release_error = { code: error.code, message: error.message }
      assert.equal(error.code, -32602)
      assert.equal(error.message, 'Invalid InterceptionId.')
      assert.ok(destroyedContext, 'accept an invalid interception only after proving the original page context was destroyed')
      release = { cancelled_with_old_document: true, protocolCode: error.code, message: error.message }
    }
    await browser.send('Fetch.disable'); await pause(400)
    const after = await get(second), original = await get(first)
    assert.deepEqual(after.draft, clean.draft); assert.deepEqual(after.messages, []); assert.deepEqual(after.agentRuns, [])
    assert.equal(await browser.evaluate('location.origin'), second.origin)
    assert.equal(await browser.evaluate(`${input(second)}.value`), nextBody)
    assert.ok(!(await browser.evaluate('document.body.innerText')).includes(fileName))
    assert.deepEqual(original.draft, committed.draft); assert.deepEqual(original.agentRuns, [])
    assert.deepEqual(browser.errors, [])
    report.release = release; report.network_events = networkEvents; report.dialog_events = dialogEvents
    record('same_browser_page_switches_to_another_real_core_and_old_upload_cannot_modify_its_editor_materials_messages_or_runs')
    record('original_core_retains_only_its_own_material_with_no_resend_or_agent_execution')
    await browser.capture(join(output, '02-new-core-input-stays-independent.png'))
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'; report.error = String(error.stack ?? error)
    if (browser) { report.browser_errors = browser.errors; report.dom = await browser.evaluate('document.body.innerText.slice(-2500)').catch(() => null)
      await browser.capture(join(output, 'failure.png')).catch(() => {}) }
  } finally {
    if (browser) { await browser.send('Fetch.disable').catch(() => {}); await browser.close(); stopEvents?.() }
    for (const host of hosts.reverse()) {
      await host.process.request('host.web.stop').catch(() => {})
      await host.process.close({ timeoutMs: 15_000 })
      const exit = await host.process.closed
      const item = report.hosts.find(item => item.dataDir === host.dataDir)
      if (item) item.exit = { ...exit, signal: host.process.child.signalCode }
      if (exit.code !== 0 || host.process.child.signalCode !== null) report.status = 'failed'
    }
    report.finished_at = new Date().toISOString()
    await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  }
  assert.equal(report.status, 'passed', report.error)
  return report
}
