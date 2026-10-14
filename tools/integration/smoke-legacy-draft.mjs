import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { launchHost, within } from '../../scripts/lib/host-test-client.mjs'
import { launchAcceptanceBrowser } from '../../scripts/lib/host-web-browser.mjs'
import { coreDataDirectoryArguments } from '../../scripts/lib/runtime-camp-files-root.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const { ROVAI_HOST_BIN: binary, ROVAI_WEB_UI: ui, WORKBENCH_BROWSER_BIN: chrome, WORKBENCH_EVIDENCE_ROOT: evidenceRoot, WORKBENCH_LEGACY_FIXTURE: source } = process.env
assert([binary, ui, chrome, evidenceRoot, source].every(value => value && path.isAbsolute(value)))
const allowed = await realpath(evidenceRoot), fixture = await realpath(source)
assert.equal(path.dirname(fixture), allowed)
assert(/^live-[A-Za-z0-9]+$/.test(path.basename(fixture)))
const previous = JSON.parse(await readFile(path.join(fixture, 'evidence/failure.json'), 'utf8'))
assert.equal(previous.stage, 'same_browser_tab_drafts')
assert(previous.error.includes('I02_TAB_A_UNSENT'))
const data = await realpath(path.join(fixture, 'formal/Core'))
const profile = path.join(data, 'acceptance-browser')
const history = new DatabaseSync(path.join(profile, 'Default/History'), { readOnly: true })
let origin
try {
  const origins = [...new Set(history.prepare("select url from urls where url like 'http://127.0.0.1:%'").all().map(row => new URL(row.url).origin))]
  assert.equal(origins.length, 1)
  origin = origins[0]
} finally { history.close() }
const checks = [], output = await mkdtemp(path.join(allowed, 'legacy-'))
const record = id => { checks.push({ id, status: 'passed' }); console.log(JSON.stringify({ stage: id, passed: checks.length })) }
const digest = value => createHash('sha256').update(value).digest('hex')
let host, browser, result, stage = 'start_owned_fixture'
try {
  host = launchHost(binary, [...coreDataDirectoryArguments(data), '--skill-library-root', path.join(data, 'skills'), '--mcp-config-path', path.join(data, 'mcp.json')], { cwd: root, windowsHide: true })
  await within(host.ready)
  const started = await host.request('host.web.start', { listen: `127.0.0.1:${new URL(origin).port}`, uiDirectory: ui })
  assert.equal(started.origin, origin)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  browser = await launchAcceptanceBrowser({ executable: chrome, env, args: ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'] })
  await browser.send('Page.navigate', { url: origin })
  await browser.wait(`document.querySelector('.unified-sidebar') !== null || document.querySelector('#administrator-token') !== null`)
  if (await browser.evaluate(`document.querySelector('#administrator-token') !== null`)) {
    await browser.click(`document.querySelector('#administrator-token')`)
    await browser.send('Input.insertText', { text: started.administratorToken })
    await browser.click(`document.querySelector('.web-login button[type=submit]')`)
  }
  await browser.wait(`document.querySelector('.quick-chat-continue-row') !== null || document.querySelector('.conversation-controls [contenteditable=true]') !== null`)
  if (await browser.evaluate(`document.querySelector('.quick-chat-continue-row') !== null`)) await browser.click(`document.querySelector('.quick-chat-continue-row')`)
  const editor = `document.querySelector('.conversation-controls [contenteditable=true]')`
  await browser.wait(`Boolean(${editor}) && document.querySelector('.legacy-draft-recovery button') !== null`)
  assert.equal(await browser.evaluate('typeof window.rovai'), 'undefined')
  const legacyKeys = await browser.evaluate(`Object.keys(localStorage).filter(key=>key.startsWith('rovai.camp-composer-draft.v1:'))`)
  assert.equal(legacyKeys.length, 1)
  const key = legacyKeys[0]
  const original = await browser.evaluate(`localStorage.getItem(${JSON.stringify(key)})`)
  assert(original.includes('I02_TAB_A_UNSENT'))
  await writeFile(path.join(output, 'legacy-before.json'), original)
  assert.equal(await browser.evaluate(`${editor}.textContent`), '')
  record('actual_pre_fix_profile_offers_explicit_recovery_without_auto_copy')
  await browser.capture(path.join(output, 'legacy-offer.png'))

  stage = 'retain_new_input'
  await browser.click(editor)
  await browser.send('Input.insertText', { text: 'CURRENT_TAB_NEW_INPUT' })
  await browser.wait(`${editor}.textContent === 'CURRENT_TAB_NEW_INPUT' && document.querySelector('.legacy-draft-recovery') === null`)
  assert.equal(await browser.evaluate(`localStorage.getItem(${JSON.stringify(key)})`), original)
  record('new_input_prevents_legacy_replacement_and_keeps_original')
  await browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await browser.wait(`${editor}.textContent === '' && document.querySelector('.legacy-draft-recovery button:not(:disabled)') !== null`)
  stage = 'explicit_restore'
  await browser.click(`document.querySelector('.legacy-draft-recovery button')`)
  await browser.wait(`${editor}.textContent === 'I02_TAB_A_UNSENT'`)
  assert.equal(await browser.evaluate(`localStorage.getItem(${JSON.stringify(key)})`), original)
  const scoped = await browser.evaluate(`Object.keys(localStorage).filter(key=>key.startsWith('rovai.web.thread-drafts.v1:')).map(key=>JSON.parse(localStorage.getItem(key)).entries[${JSON.stringify(key)}]?.value).find(value=>value?.includes('I02_TAB_A_UNSENT'))`)
  assert.equal(JSON.parse(scoped).body, 'I02_TAB_A_UNSENT')
  record('explicit_restore_copies_to_verified_editor_and_preserves_original_bytes')
  await browser.reload()
  await browser.wait(`${editor}?.textContent === 'I02_TAB_A_UNSENT' && document.querySelector('.web-login-overlay') === null`)
  assert.equal(await browser.evaluate(`localStorage.getItem(${JSON.stringify(key)})`), original)
  assert.equal(browser.errors.length, 0)
  record('restored_editor_survives_reload')
  await browser.capture(path.join(output, 'legacy-restored.png'))
  result = { date: '2026-10-14', status: 'passed', scope: 'production_web_explicit_legacy_recovery_actual_pre_fix_fixture', checks,
    originalSha256: digest(original), originalPreserved: true, realAgent: 'not_run', sourceFixture: path.basename(fixture), sourcePreFixFailure: previous.stage,
    screenshots: ['legacy-offer.png', 'legacy-restored.png'], closedBrowserDraftRecovery: 'not_run', customerAcceptance: 'not_run' }
} catch (error) {
  if (browser) await browser.capture(path.join(output, 'failure.png')).catch(() => {})
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ stage, error: String(error), checks }, null, 2))
  console.log(JSON.stringify({ status: 'failed', stage, error: String(error).slice(0, 1500), output }))
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  if (host) await host.close()
  const db = new DatabaseSync(path.join(data, 'rovai.sqlite'), { readOnly: true })
  try { assert.equal(db.prepare('select count(*) n from agent_run').get().n, 0); assert.equal(Object.values(db.prepare('pragma integrity_check').get())[0], 'ok') }
  finally { db.close() }
  if (result) {
    record('owned_database_integrity_and_zero_agent_runs')
    await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ status: 'passed', checks: checks.length, output }))
  }
}
