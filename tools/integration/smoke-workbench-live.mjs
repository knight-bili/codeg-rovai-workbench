import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile, readFile, unlink, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { launchHost, within } from '../../scripts/lib/host-test-client.mjs'
import { launchAcceptanceBrowser } from '../../scripts/lib/host-web-browser.mjs'
import { coreDataDirectoryArguments } from '../../scripts/lib/runtime-camp-files-root.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const binary = process.env.ROVAI_HOST_BIN
const ui = process.env.ROVAI_WEB_UI
const evidenceRoot = process.env.WORKBENCH_EVIDENCE_ROOT
const browserBinary = process.env.WORKBENCH_BROWSER_BIN
assert(binary && ui && evidenceRoot && browserBinary && [binary, ui, evidenceRoot, browserBinary].every(path.isAbsolute))
await mkdir(evidenceRoot, { recursive: true })
const fixture = await realpath(await mkdtemp(path.join(evidenceRoot, 'live-')))
const formal = path.join(fixture, 'formal')
const dataDir = process.platform === 'win32'
  ? JSON.parse(execFileSync(binary, ['--prepare-windows-data-root', formal], { encoding: 'utf8', windowsHide: true })).core
  : formal
const skillRoot = path.join(dataDir, 'skills')
const mcp = path.join(dataDir, 'mcp.json')
const profile = path.join(dataDir, 'acceptance-browser')
await mkdir(profile, { recursive: true })
const output = path.join(fixture, 'evidence')
await mkdir(output)
const projects = {}
for (const name of ['I02-工程-A', 'I02-工程-B']) {
  const project = path.join(fixture, name)
  await mkdir(project)
  await writeFile(path.join(project, 'README.md'), `# ${name}\n`)
  projects[name] = project
}
const checks = []
let host, browser, finalResult, stage = 'start_host'
const record = (id, detail = {}) => { checks.push({ id, status: 'passed', ...detail }); console.log(JSON.stringify({ stage: id, passed: checks.length })) }
try {
  host = launchHost(binary, [...coreDataDirectoryArguments(dataDir), '--skill-library-root', skillRoot, '--mcp-config-path', mcp], { cwd: root, windowsHide: true })
  await within(host.ready)
  const started = await host.request('host.web.start', { listen: '127.0.0.1:0', uiDirectory: ui })
  const origin = started.origin
  assert(origin.startsWith('http://127.0.0.1:'))
  const login = await fetch(`${origin}/api/v1/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 4, administratorToken: started.administratorToken }) })
  assert.equal(login.status, 200)
  const token = (await login.json()).token
  const call = async (operation, params = {}) => {
    const response = await fetch(`${origin}/api/v1/request`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ operation, params }), signal: AbortSignal.timeout(15000) })
    assert.equal(response.status, 200, operation)
    const body = await response.json()
    assert.equal(body.error, null, JSON.stringify({ operation, error: body.error }))
    return body.result
  }
  stage = 'seed_real_threads'
  const preflight = await call('threads.creationPreflight')
  assert(preflight.admissible && preflight.initialLeadAgentId)
  assert(preflight.presentMembers.every(member => !member.runtimeConfigured))
  for (const [name, directory] of Object.entries(projects)) {
    const workspace = await call('workspaces.inspect', { path: directory })
    const created = await call('threads.create', { commandId: crypto.randomUUID(), name: `${name}-对话`, workspace: { projectPath: workspace.projectPath },
      memberAgentIds: preflight.presentMembers.map(member => member.agentId), defaultLeadAgentId: preflight.initialLeadAgentId, collaborationMode: 'peer', activationState: 'active' })
    assert.equal(created.status, 'applied')
    const threadId = created.payload.threadId
    projects[name] = { path: workspace.projectPath, threadId }
  }
  record('real_core_fixture_created', { threads: 2, activation: 'active', messages: 0, runtimeConfigured: false })
  stage = 'seed_current_message_contract'
  const recordedMessages = []
  for (let index = 1; index <= 8; index++) {
    const params = { commandId: crypto.randomUUID(), threadId: projects['I02-工程-B'].threadId,
      content: { version: 2, segments: [{ kind: 'text', text: `Controlled Host record ${index}.\n\n**真实记录**保留结构化文本。` }] },
      sourceAttachments: [], quotes: [], replyToThreadMessageId: null, execution: null }
    const sent = await call('thread.messages.send', params)
    assert.equal(sent.commandResult.status, 'applied')
    assert(sent.commandResult.payload.threadMessageId)
    recordedMessages.push(sent.commandResult.payload.threadMessageId)
    if (index === 1) {
      const replay = await call('thread.messages.send', params)
      assert.equal(replay.replayed, true)
      assert.equal(replay.commandResult.payload.threadMessageId, recordedMessages[0])
    }
  }
  record('current_message_contract_records_eight_messages_and_replays_once', { recordedMessages: 8, execution: null })
  stage = 'production_web_login'
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const launchBrowser = () => launchAcceptanceBrowser({ executable: browserBinary, args: ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], env })
  browser = await launchBrowser()
  await writeFile(path.join(output, 'browser-version.json'), JSON.stringify(await browser.send('Browser.getVersion'), null, 2))
  await browser.send('Page.navigate', { url: origin })
  await browser.wait(`document.querySelector('#administrator-token') !== null`)
  await browser.click(`document.querySelector('#administrator-token')`)
  await browser.send('Input.insertText', { text: started.administratorToken })
  await browser.click(`document.querySelector('.web-login button[type=submit]')`)
  await browser.wait(`document.querySelector('.web-login-overlay') === null && document.querySelector('.unified-sidebar') !== null`)
  assert.equal(await browser.evaluate('typeof window.rovai'), 'undefined')
  record('production_web_authenticated_no_desktop_mock')
  const menuItem = text => `[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.getClientRects().length>0 && e.textContent.trim()===${JSON.stringify(text)})`
  const enter = async name => {
    const row = `[...document.querySelectorAll('.project-heading-row')].find(e=>e.querySelector('.project-select-row')?.title===${JSON.stringify(name)})`
    await browser.wait(`Boolean(${row})`)
    await browser.click(`(${row}).querySelector('.group-menu-trigger')`)
    await browser.wait(`Boolean(${menuItem('进入工程')})`)
    await browser.click(menuItem('进入工程'))
  }
  const home = name => `document.querySelector('.project-home-heading h2')?.textContent===${JSON.stringify(name)}`
  stage = 'enter_project_A'
  await enter('I02-工程-A')
  await browser.wait(home('I02-工程-A'))
  assert.equal(await browser.evaluate(`document.querySelector('.project-home-heading p').textContent`), projects['I02-工程-A'].path)
  assert.equal(await browser.evaluate(`document.querySelectorAll('.quick-chat-continue-row').length`), 1)
  assert(!(await browser.evaluate(`document.querySelector('.quick-chat-workspace').textContent`)).includes('I02-工程-B-对话'))
  record('real_project_A_home_scoped_and_canonical')
  stage = 'enter_project_B'
  await enter('I02-工程-B')
  await browser.wait(home('I02-工程-B'))
  record('real_project_B_home')
  stage = 'back_forward'
  await browser.click(`document.querySelector('[aria-label="后退"]')`)
  await browser.wait(home('I02-工程-A'))
  await browser.click(`document.querySelector('[aria-label="前进"]')`)
  await browser.wait(home('I02-工程-B'))
  record('production_history_back_forward')
  stage = 'reload'
  await browser.reload()
  await browser.wait(`(${home('I02-工程-B')}) && document.querySelector('.web-login-overlay') === null`)
  record('production_reload_restores_project')
  stage = 'late_real_response'
  let held, holdA = true, resolveHeld, resolveACompleted, resolveBCompleted, nextBRequestId
  const holding = new Promise(resolve => { resolveHeld = resolve })
  const aCompleted = new Promise(resolve => { resolveACompleted = resolve })
  const bCompleted = new Promise(resolve => { resolveBCompleted = resolve })
  const eventErrors = []
  const stopEvents = browser.onProtocolEvent(message => {
    if (message.method === 'Network.loadingFinished') {
      if (message.params.requestId === held?.networkId) resolveACompleted()
      if (message.params.requestId === nextBRequestId) resolveBCompleted()
    }
    if (message.method !== 'Fetch.requestPaused') return
    const params = message.params
    let payload
    try { payload = JSON.parse(params.request.postData ?? '{}') } catch { payload = {} }
    if (holdA && payload.operation === 'workspaces.inspect' && payload.params?.path === projects['I02-工程-A'].path) {
      holdA = false; held = params; resolveHeld()
    } else {
      if (held && payload.operation === 'workspaces.inspect' && payload.params?.path === projects['I02-工程-B'].path) nextBRequestId = params.networkId
      void browser.send('Fetch.continueRequest', { requestId: params.requestId }).catch(error => eventErrors.push(String(error)))
    }
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: `${origin}/api/v1/request`, requestStage: 'Response' }] })
  try {
    await enter('I02-工程-A')
    await within(holding)
    assert.equal(held.responseStatusCode, 200)
    const intercepted = await browser.send('Fetch.getResponseBody', { requestId: held.requestId })
    const responseBody = JSON.parse(intercepted.base64Encoded ? Buffer.from(intercepted.body, 'base64').toString('utf8') : intercepted.body)
    assert.equal(responseBody.result.projectPath, projects['I02-工程-A'].path)
    await enter('I02-工程-B')
    await within(bCompleted)
    await browser.send('Fetch.continueRequest', { requestId: held.requestId })
    await within(aCompleted)
    await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
    assert.equal(await browser.evaluate(home('I02-工程-B')), true, '迟到的真实A响应不能覆盖较新的B意图')
    assert.equal(await browser.evaluate('history.state.rovai.target.projectPath'), projects['I02-工程-B'].path)
    assert.equal(eventErrors.length, 0)
    record('late_real_A_response_does_not_replace_B')
  } finally { await browser.send('Fetch.disable'); stopEvents() }
  stage = 'missing_directory'
  const missing = await realpath(projects['I02-工程-A'].path)
  assert.equal(path.dirname(missing), fixture, '只能移除本次测试目录')
  const savedReadme = await readFile(path.join(missing, 'README.md'))
  await writeFile(path.join(output, 'project-A-before-removal.txt'), savedReadme)
  await unlink(path.join(missing, 'README.md'))
  await rmdir(missing)
  const beforeHistory = await browser.evaluate('JSON.stringify(history.state.rovai.target)')
  await enter('I02-工程-A')
  await browser.wait(`document.querySelector('.error-banner[role="alert"]') !== null`)
  assert.equal(await browser.evaluate(home('I02-工程-B')), true)
  assert.equal(await browser.evaluate('JSON.stringify(history.state.rovai.target)'), beforeHistory)
  record('missing_directory_keeps_previous_home_and_history')
  stage = 'directory_retry'
  await mkdir(missing)
  await writeFile(path.join(missing, 'README.md'), savedReadme)
  await enter('I02-工程-A')
  await browser.wait(home('I02-工程-A'))
  assert.equal(await browser.evaluate(`document.querySelector('.error-banner[role="alert"]') === null`), true, '成功重试应清除前一次工程打开错误')
  record('restored_directory_retry_clears_error')
  await enter('I02-工程-B')
  await browser.wait(home('I02-工程-B'))
  assert.equal(browser.errors.length, 0)
  stage = 'browser_restart'
  assert.equal(await browser.evaluate(`JSON.parse(localStorage.getItem('rovai.current-project.v1')).projectPath`), projects['I02-工程-B'].path)
  await browser.close()
  browser = await launchBrowser()
  await browser.send('Page.navigate', { url: origin })
  await browser.wait(`document.querySelector('.unified-sidebar') !== null || document.querySelector('#administrator-token') !== null`)
  const needsLogin = await browser.evaluate(`document.querySelector('#administrator-token') !== null`)
  if (needsLogin) {
    await browser.click(`document.querySelector('#administrator-token')`)
    await browser.send('Input.insertText', { text: started.administratorToken })
    await browser.click(`document.querySelector('.web-login button[type=submit]')`)
  }
  assert.equal(await browser.evaluate(`JSON.parse(localStorage.getItem('rovai.current-project.v1')).projectPath`), projects['I02-工程-B'].path)
  await browser.wait(home('I02-工程-B'))
  await browser.wait(`document.querySelectorAll('.quick-chat-continue-row').length === 1 && document.querySelector('.quick-chat-workspace')?.textContent.includes('I02-工程-B-对话')`)
  assert(!(await browser.evaluate(`document.querySelector('.quick-chat-workspace').textContent`)).includes('I02-工程-A-对话'))
  assert.equal(await browser.evaluate('typeof window.rovai'), 'undefined')
  assert.equal(await browser.evaluate('history.state.rovai.target.projectPath'), projects['I02-工程-B'].path)
  assert.equal(browser.errors.length, 0)
  record('production_browser_restart_restores_current_project', { login: needsLogin ? 'reauthenticated' : 'restored' })
  stage = 'capture'
  await browser.capture(path.join(output, 'project-B-real-host.png'))
  stage = 'production_thread_messages'
  await browser.click(`document.querySelector('.quick-chat-continue-row')`)
  await browser.wait(`document.querySelectorAll('[data-quote-owner="thread:${projects['I02-工程-B'].threadId}"][data-message-quote-body]').length === 8`)
  for (let index = 0; index < recordedMessages.length; index++) {
    const body = await browser.evaluate(`document.querySelector('[data-message-quote-body="${recordedMessages[index]}"]').textContent`)
    assert(body.includes(`Controlled Host record ${index + 1}.`))
    assert(body.includes('真实记录'))
  }
  assert.equal(browser.errors.length, 0)
  record('production_thread_renders_real_recorded_messages')
  await browser.capture(path.join(output, 'thread-real-host.png'))
  stage = 'same_browser_tab_drafts'
  const editor = `document.querySelector('.conversation-controls [contenteditable=true]')`
  await browser.wait(`Boolean(${editor}) && ${editor}.getAttribute('contenteditable') === 'true'`)
  await browser.click(editor)
  await browser.send('Input.insertText', { text: 'I02_TAB_A_UNSENT' })
  const storedDrafts = `Object.keys(localStorage).filter(key=>key.startsWith('rovai.web.thread-drafts.v1:')).map(key=>JSON.parse(localStorage.getItem(key)).entries['rovai.camp-composer-draft.v1:${projects['I02-工程-B'].threadId}']?.value).filter(Boolean)`
  await browser.wait(`(${storedDrafts}).some(value=>value.includes('I02_TAB_A_UNSENT'))`)
  const secondPage = await browser.newPage(origin)
  await browser.wait(home('I02-工程-B'))
  await browser.wait(`document.querySelectorAll('.quick-chat-continue-row').length === 1`)
  await browser.click(`document.querySelector('.quick-chat-continue-row')`)
  await browser.wait(`Boolean(${editor})`)
  assert.equal(await browser.evaluate(`${editor}.textContent`), '', '同一浏览器的另一标签不能读到A的未发送文字')
  await browser.click(editor)
  await browser.send('Input.insertText', { text: 'I02_TAB_B_UNSENT' })
  await browser.wait(`${editor}.textContent === 'I02_TAB_B_UNSENT'`)
  await browser.wait(`(${storedDrafts}).some(value=>value.includes('I02_TAB_B_UNSENT'))`)
  await browser.reload()
  await browser.wait(`${editor}?.textContent === 'I02_TAB_B_UNSENT' && document.querySelector('.web-login-overlay') === null`)
  browser.usePage()
  assert.equal(await browser.evaluate(`${editor}.textContent`), 'I02_TAB_A_UNSENT')
  await browser.reload()
  await browser.wait(`${editor}?.textContent === 'I02_TAB_A_UNSENT' && document.querySelector('.web-login-overlay') === null`)
  browser.usePage(secondPage)
  assert.equal(await browser.evaluate(`${editor}.textContent`), 'I02_TAB_B_UNSENT')
  record('same_browser_tabs_keep_unsent_text_private_and_restore_after_reload')
  stage = 'closed_browser_draft_recovery'
  await browser.close()
  browser = await launchBrowser()
  await browser.send('Page.navigate', { url: origin })
  await browser.wait(`(${home('I02-工程-B')}) && document.querySelector('.quick-chat-continue-row') !== null`)
  await browser.click(`document.querySelector('.quick-chat-continue-row')`)
  await browser.wait(`Boolean(${editor})`)
  assert.equal(await browser.evaluate(`${editor}.textContent`), '', '新的编辑身份不得自动接管已关闭标签的文字')
  await browser.wait(`document.querySelector('.saved-draft-recovery button') !== null`)
  await browser.click(`document.querySelector('.saved-draft-recovery button')`)
  await browser.wait(`document.querySelectorAll('.saved-draft-choice').length === 2`)
  const choices = await browser.evaluate(`[...document.querySelectorAll('.saved-draft-choice')].map(e=>e.textContent)`)
  assert(choices.some(text => text.includes('I02_TAB_A_UNSENT')))
  assert(choices.some(text => text.includes('I02_TAB_B_UNSENT')))
  record('browser_process_restart_keeps_two_separate_body_snapshots')
  await browser.capture(path.join(output, 'saved-draft-picker.png'))
  await browser.click(`[...document.querySelectorAll('.saved-draft-choice')].find(e=>e.textContent.includes('I02_TAB_A_UNSENT'))`)
  await browser.wait(`${editor}.textContent === 'I02_TAB_A_UNSENT' && document.querySelector('.saved-draft-dialog') === null`)
  record('explicit_previous_editor_restore_copies_one_snapshot_without_merging')
  await browser.capture(path.join(output, 'saved-draft-restored.png'))
  stage = 'real_storage_quota'
  const snapshots = `Object.fromEntries(Object.keys(localStorage).filter(key=>key.startsWith('rovai.web.thread-drafts.v1:')).sort().map(key=>[key,localStorage.getItem(key)]))`
  const beforeQuota = await browser.evaluate(`JSON.stringify(${snapshots})`)
  await writeFile(path.join(output, 'archives-before-quota.json'), beforeQuota)
  const quota = await browser.evaluate(`(()=>{let low=0,high=8388608;while(low+1<high){const mid=Math.floor((low+high)/2);try{localStorage.setItem('rovai.acceptance.quota','x'.repeat(mid));low=mid}catch(error){if(error.name!=='QuotaExceededError')throw error;high=mid}}localStorage.setItem('rovai.acceptance.quota','x'.repeat(low));try{localStorage.setItem('rovai.acceptance.quota','x'.repeat(low+1));return 'no quota'}catch(error){return error.name}})()`)
  assert.equal(quota, 'QuotaExceededError')
  await browser.click(editor)
  await browser.send('Input.insertText', { text: '_UNSAVED_AFTER_QUOTA' })
  await browser.wait(`document.querySelector('.conversation-controls')?.textContent.includes('草稿保存失败') === true`)
  assert((await browser.evaluate(`${editor}.textContent`)).includes('_UNSAVED_AFTER_QUOTA'))
  assert.deepEqual(await browser.evaluate(snapshots), JSON.parse(beforeQuota))
  await browser.evaluate(`localStorage.removeItem('rovai.acceptance.quota')`)
  await browser.send('Input.insertText', { text: '!' })
  await browser.wait(`(${storedDrafts}).some(value=>value.includes('_UNSAVED_AFTER_QUOTA'))`)
  const savedInput = await browser.evaluate(`${editor}.textContent`)
  await browser.reload()
  await browser.wait(`${editor}?.textContent === ${JSON.stringify(savedInput)} && document.querySelector('.web-login-overlay') === null`)
  record('actual_browser_quota_preserves_input_and_previous_snapshot_then_retries')
  stage = 'record_only_withdrawal_guard'
  const messageId = recordedMessages.at(-1)
  const readPublication = () => {
    const db = new DatabaseSync(path.join(dataDir, 'rovai.sqlite'), { readOnly: true })
    try { return { message: db.prepare('select id,body,version,recall_state from camp_message where id=?').get(messageId), deliveries: db.prepare('select status from camp_message_delivery where message_id=?').all(messageId) } }
    finally { db.close() }
  }
  const beforePublication = readPublication()
  assert(beforePublication.message.body.includes('Controlled Host record 8.'))
  assert.equal(beforePublication.message.recall_state, 'ineligible')
  assert.equal(beforePublication.deliveries.length, 0)
  await writeFile(path.join(output, 'publication-before-withdrawal.json'), JSON.stringify(beforePublication, null, 2))
  const beforeDrafts = await browser.evaluate(snapshots)
  assert.equal(await browser.evaluate(`document.querySelectorAll('.user-message-withdraw').length`), 0)
  assert.equal(await browser.evaluate(`document.querySelectorAll('.user-message-receipt-row').length`), 0, '未创建投递/Turn/Run的阅读记录不能显示等待投递')
  record('record_only_message_has_no_delivery_or_withdraw_ui')
  const rejected = await call('thread.messages.withdraw', { commandId: crypto.randomUUID(), command: { threadId: projects['I02-工程-B'].threadId, messageId, expectedVersion: beforePublication.message.version } })
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.code, 'message.withdraw_too_late')
  const afterPublication = readPublication()
  assert.deepEqual(afterPublication, beforePublication)
  assert.equal(await browser.evaluate(`${editor}.textContent`), savedInput)
  assert.deepEqual(await browser.evaluate(snapshots), beforeDrafts)
  record('ineligible_withdrawal_rejected_and_keeps_publication_and_client_drafts')
  await writeFile(path.join(output, 'publication-after-withdrawal.json'), JSON.stringify(afterPublication, null, 2))
  await browser.capture(path.join(output, 'record-only-refusal.png'))
  finalResult = { status: 'passed', scope: 'production_web_real_host_navigation_and_recorded_messages_no_runtime', stage, checks, screenshots: ['project-B-real-host.png', 'thread-real-host.png', 'saved-draft-picker.png', 'saved-draft-restored.png', 'record-only-refusal.png'],
    realAgent: 'not_run', customerAcceptance: 'not_run', profile, dataDir, skillRoot, mcpConfigPath: mcp }
} catch (error) {
  const errorText = error instanceof Error ? String(error) : JSON.stringify({ code: error?.code, message: error?.message })
  if (browser) await browser.capture(path.join(output, 'failure.png')).catch(() => {})
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ stage, error: errorText, checks }, null, 2))
  console.log(JSON.stringify({ status: 'failed', stage, evidence: output, error: errorText.slice(0, 1200) }))
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  if (host) await host.close()
  const db = new DatabaseSync(path.join(dataDir, 'rovai.sqlite'), { readOnly: true })
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM agent_run').get().n, 0, '禁止启动真实Runtime'); assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0], 'ok') }
  finally { db.close() }
  if (finalResult) {
    record('isolated_database_integrity_and_zero_agent_runs')
    await writeFile(path.join(output, 'result.json'), JSON.stringify(finalResult, null, 2))
    console.log(JSON.stringify({ status: finalResult.status, cases: checks.length, evidence: output }))
  }
}
