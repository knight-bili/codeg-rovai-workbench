import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, readFile, writeFile, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { launchHost } from '../../scripts/lib/host-test-client.mjs'
import { coreDataDirectoryArguments } from '../../scripts/lib/runtime-camp-files-root.mjs'
import { configureProductRuntime } from '../../scripts/configure-product-runtime.mjs'
import { createConfiguredCampAndSend } from '../../scripts/lib/create-configured-camp.mjs'

// Owns the real Core process/controlled ACP seam. The Context owner owns the
// input matrix. No external Runtime identity, provider, or model is used here.
const root = path.resolve(import.meta.dirname, '../..')
const workItemMarker = 'ROVAI_SKILL_RECOVERY_HELD_INPUT'
const [binary, launcher, evidenceRoot] = process.argv.slice(2)
assert([binary, launcher, evidenceRoot].every(value => value && path.isAbsolute(value)),
  'Provide absolute Host binary, compiled fixture launcher and evidence root paths')
await mkdir(evidenceRoot, { recursive: true })
const fixture = await realpath(await mkdtemp(path.join(evidenceRoot, 'skill-recovery-')))
const home = path.join(fixture, 'home'), temp = path.join(fixture, 'tmp')
for (const directory of [home, temp]) await mkdir(directory)
const script = path.join(fixture, 'controlled-acp.mjs')
await copyFile(path.join(root, 'scripts/fixtures/streaming-acp-runtime.mjs'), script)
const capture = path.join(fixture, 'runtime-input.jsonl')
const environment = {}
for (const [key, value] of Object.entries(process.env)) {
  if (['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'].includes(key.toUpperCase())) environment[key] = value
}
Object.assign(environment, {
  PATH: [path.dirname(process.execPath), ...(process.platform === 'win32' ? [path.join(process.env.SystemRoot, 'System32')] : ['/usr/bin', '/bin'])].join(path.delimiter),
  HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData/Local'), TEMP: temp, TMP: temp,
  ROVAI_BUNDLED_SKILLS_ROOT: path.join(root, 'skills'), ROVAI_QWEN_BIN: launcher,
  ROVAI_ACCEPTANCE_NODE: process.execPath, ROVAI_ACCEPTANCE_SCRIPT: script,
  ROVAI_SKILL_RECOVERY_CAPTURE: capture
})
await mkdir(environment.APPDATA, { recursive: true })
await mkdir(environment.LOCALAPPDATA, { recursive: true })
const formal = path.join(fixture, 'formal')
const dataDir = process.platform === 'win32'
  ? JSON.parse(execFileSync(binary, ['--prepare-windows-data-root', formal], {
    env: environment, encoding: 'utf8', windowsHide: true
  })).core : formal
const skillRoot = path.join(dataDir, 'managed-skill-library'), mcpPath = path.join(dataDir, 'mcp.json')
const project = path.join(fixture, 'project')
await mkdir(project)
await writeFile(path.join(project, 'README.md'), '# Isolated recovery fixture\n')
const hashes = {}
for (const [name, file] of Object.entries({ host: binary, launcher, script })) {
  hashes[name] = createHash('sha256').update(await readFile(file)).digest('hex')
}
const checks = [], hosts = []
let host, stage = 'startup', finalResult
const record = (id, detail = {}) => {
  checks.push({ id, status: 'passed', ...detail })
  console.log(JSON.stringify({ stage: id, passed: checks.length }))
}
async function waitFor(read, label, milliseconds = 60_000) {
  const end = Date.now() + milliseconds
  do {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < end)
  throw Error(`Timed out: ${label}`)
}
async function start() {
  host = launchHost(binary, [...coreDataDirectoryArguments(dataDir, { homeDirectory: home }),
    '--skill-library-root', skillRoot, '--mcp-config-path', mcpPath], {
    cwd: root, env: environment, windowsHide: true
  })
  hosts.push(host)
  await waitFor(() => Promise.race([host.ready.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))]), 'Core ready')
  return host
}
const applied = result => assert.equal(result.status, 'applied', JSON.stringify(result))
async function captures() {
  const text = await readFile(capture, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}
async function frozen(runId) {
  const db = new DatabaseSync(path.join(dataDir, 'rovai.sqlite'), { readOnly: true })
  let row
  try {
    row = db.prepare(`SELECT c.id,c.rendered_payload_blob_id,c.rendered_payload_digest,
      c.current_input_skill_resolution_json,c.context_manifest_version,b.sha256,b.byte_size
      FROM context_manifest c JOIN managed_blob b ON b.id=c.rendered_payload_blob_id
      WHERE c.agent_run_id=?`).get(runId)
  } finally { db.close() }
  assert(row)
  assert.match(row.sha256, /^[a-f0-9]{64}$/)
  const bytes = await readFile(path.join(dataDir, 'managed-blobs/sha256', row.sha256.slice(0, 2), row.sha256))
  assert.equal(bytes.length, row.byte_size)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256)
  return { row: { ...row }, bytes }
}
try {
  await start()
  record('isolated_real_core_started', { pid: host.child.pid, dataDir, skillRoot, mcpPath })
  const call = (method, params = {}) => host.request(method, params)
  stage = 'runtime_configuration'
  await configureProductRuntime(call, 'qwen-code', ['agent_1'])
  record('product_runtime_configured_with_owned_native_protocol_fixture')
  const catalog = await call('skillPacks.list')
  applied(await call('skillPacks.install', { commandId: randomUUID(), command: {
    skillId: 'brainstorming', sourceRevision: catalog.commit, expectedVersion: 'absent'
  } }))
  const choice = (await call('skillPacks.members.list')).find(row => row.skillId === 'brainstorming')
  applied(await call('skillPacks.members.set', { commandId: randomUUID(), command: {
    skillId: 'brainstorming', memberIds: ['agent_1'], expectedVersion: choice.version
  } }))
  const workspace = await call('workspaces.inspect', { path: project })
  stage = 'input_delivery'
  const sent = await createConfiguredCampAndSend(call, {
    commandId: randomUUID(), workspace, memberAgentIds: ['agent_1'], defaultLeadAgentId: 'agent_1',
    name: '受控技能恢复验收', body: `${workItemMarker}：保持输入，等待受控的进程恢复检查。`, purpose: 'Process boundary only; no model.'
  })
  assert.equal(sent.status, 'accepted', JSON.stringify(sent))
  const threadId = sent.payload.threadId
  const before = await waitFor(async () => {
    const snapshot = await call('camps.snapshot', { threadId })
    const run = snapshot.agentRuns.find(value => value.status === 'running')
    const manifest = snapshot.contextManifests.find(value => value.agentRunId === run?.id)
    if (snapshot.agentRuns.some(value => ['failed', 'cancelled'].includes(value.status))) throw Error(JSON.stringify(snapshot.agentRuns))
    const input = (await captures()).find(value => JSON.stringify(value.params).includes(workItemMarker))
    return run && manifest?.delivery?.status === 'prepared' && input ? { run, manifest, input } : null
  }, 'dispatched input awaiting native confirmation')
  const original = await frozen(before.run.id)
  assert.equal(original.row.context_manifest_version, 34)
  const dynamic = original.bytes.toString('utf8')
  assert(dynamic.includes('[ROVAI_SKILL_PACKS]') && dynamic.includes('brainstorming'))
  const prompt = before.input.params.prompt.filter(value => value.type === 'text').map(value => value.text).join('\n')
  assert(prompt.includes(dynamic), 'Controlled ACP must actually receive the persisted dynamic payload')
  const deliveryDb = new DatabaseSync(path.join(dataDir, 'rovai.sqlite'), { readOnly: true })
  let delivery
  try {
    delivery = deliveryDb.prepare('SELECT status,dispatch_started_at,accepted_at FROM runtime_input_delivery WHERE agent_run_id=?').get(before.run.id)
  } finally { deliveryDb.close() }
  assert.equal(delivery.status, 'prepared')
  assert(delivery.dispatch_started_at)
  assert.equal(delivery.accepted_at, null)
  await writeFile(path.join(fixture, 'frozen-before.txt'), original.bytes)
  record('real_core_frozen_blob_reached_controlled_acp', { runId: before.run.id, epoch: before.run.executionEpoch,
    manifestId: original.row.id, digest: original.row.sha256, runtimePid: before.input.pid,
    disposition: 'dispatched_native_confirmation_unknown' })
  stage = 'configuration_change'
  const installation = (await call('skillPacks.installations.list')).find(row => row.skillId === 'brainstorming')
  applied(await call('skillPacks.uninstall', { commandId: randomUUID(), command: {
    skillId: 'brainstorming', expectedVersion: installation.version
  } }))
  assert.deepEqual((await call('skillPacks.members.list')).find(row => row.skillId === 'brainstorming').memberIds, [])
  record('uninstall_changed_live_choices_without_rewriting_frozen_input')
  stage = 'hard_restart'
  const firstPid = host.child.pid
  assert.equal(host.child.kill('SIGKILL'), true)
  await host.closed
  await start()
  const recovered = await waitFor(async () => {
    const snapshot = await call('camps.snapshot', { threadId })
    const run = snapshot.agentRuns.find(value => value.id === before.run.id)
    return run?.status === 'failed' ? { snapshot, run } : null
  }, 'honest terminal settlement of unknown dispatched input')
  const recoveryDb = new DatabaseSync(path.join(dataDir, 'rovai.sqlite'), { readOnly: true })
  let terminal
  try {
    terminal = recoveryDb.prepare(`SELECT r.last_error_code,d.status AS delivery_status,d.accepted_at
      FROM agent_run r JOIN runtime_input_delivery d ON d.agent_run_id=r.id WHERE r.id=?`).get(before.run.id)
  } finally { recoveryDb.close() }
  assert.equal(terminal.last_error_code, 'accepted_input_outcome_unknown')
  assert.equal(terminal.delivery_status, 'delivery_unknown')
  assert.equal(terminal.accepted_at, null)
  const after = await frozen(before.run.id)
  assert.deepEqual(after.row, original.row)
  assert.deepEqual(after.bytes, original.bytes)
  assert.equal(recovered.run.executionEpoch, before.run.executionEpoch)
  assert.equal(recovered.snapshot.agentRuns.length, 1)
  assert.equal(recovered.snapshot.contextManifests.length, 1)
  const afterInputs = (await captures()).filter(value => JSON.stringify(value.params).includes(workItemMarker))
  assert.equal(afterInputs.length, 1, 'A dispatched input with unknown outcome must not be blindly sent again after restart')
  await writeFile(path.join(fixture, 'frozen-after.txt'), after.bytes)
  record('restarted_core_preserved_exact_blob_and_blocked_unknown_outcome_redispatch', {
    oldCorePid: firstPid, newCorePid: host.child.pid, epoch: recovered.run.executionEpoch,
    status: recovered.run.status, waitReason: recovered.run.waitReason, ...terminal
  })
  finalResult = { status: 'passed', checks, fixture, hashes, modelCalls: 0,
    limitation: 'Controlled ACP transport receipt with native confirmation unknown. No confirmed-active-input recovery, real model/read, unaccepted epoch redispatch or all-platform qualification.' }
} catch (error) {
  finalResult = { status: 'failed', stage, checks, fixture, hashes, modelCalls: 0, error: error.stack }
  process.exitCode = 1
} finally {
  for (const item of hosts.reverse()) {
    await item.close()
    await writeFile(path.join(fixture, `core-${item.child.pid}.log`), item.stderr())
  }
  await writeFile(path.join(fixture, 'result.json'), JSON.stringify(finalResult, null, 2) + '\n')
  console.log(JSON.stringify({ status: finalResult.status, stage, checks: checks.length, result: path.join(fixture, 'result.json') }))
}
