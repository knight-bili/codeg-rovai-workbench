import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

const [packageRoot, evidenceRoot] = process.argv.slice(2)
assert(packageRoot && evidenceRoot && [packageRoot, evidenceRoot].every(path.isAbsolute), 'Explicit isolated package/evidence roots required')
const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
assert.equal(manifest.name, '@google/gemini-cli')
assert.equal(manifest.version, '0.60.0')
const executable = path.join(packageRoot, manifest.bin.gemini)
const executableHash = createHash('sha256').update(await readFile(executable)).digest('hex')
await mkdir(evidenceRoot, { recursive: true })
const fixture = await mkdtemp(path.join(evidenceRoot, 'gemini-acp-'))
const home = path.join(fixture, 'home')
const workspace = path.join(fixture, 'workspace')
await mkdir(path.join(home, '.gemini'), { recursive: true })
await mkdir(workspace)
const settings = { telemetry: { enabled: false }, general: { enableAutoUpdate: false }, security: { auth: { selectedType: 'gemini-api-key' } } }
await writeFile(path.join(home, '.gemini', 'settings.json'), JSON.stringify(settings))
const systemSettings = path.join(fixture, 'system-settings.json')
await writeFile(systemSettings, '{}')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|pathext|systemroot|windir|comspec|temp|tmp|lang|lc_all)$/i.test(key)))
Object.assign(env, { GEMINI_CLI_HOME: home, GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettings, GEMINI_FORCE_FILE_STORAGE: 'true', NO_COLOR: '1' })
const version = spawnSync(process.execPath, [executable, '--version'], { env, cwd: workspace, encoding: 'utf8', timeout: 20_000, windowsHide: true })
assert.equal(version.status, 0, 'Pinned Gemini version command failed')
assert.equal(version.stdout.trim(), '0.60.0')
const child = spawn(process.execPath, [executable, '--acp', '--skip-trust'], { env, cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
let nextId = 1, stderr = '', parseFailure = null
const pending = new Map()
const notifications = []
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12_000) })
child.stdin.on('error', () => {})
const closed = new Promise(resolve => { child.once('error', error => resolve({ error: error.message })); child.once('close', code => { for (const request of pending.values()) request.reject(Error(`Gemini exited: ${code}`)); resolve({ code }) }) })
const lines = createInterface({ input: child.stdout })
lines.on('line', line => {
  let packet
  try { packet = JSON.parse(line) } catch { parseFailure = 'Non-JSON stdout in ACP mode'; return }
  if (packet.id !== undefined && pending.has(packet.id)) { const request = pending.get(packet.id); pending.delete(packet.id); request.resolve(packet) }
  else notifications.push({ method: packet.method ?? null })
})
const request = async (method, params) => {
  const id = nextId++
  let timer
  try { return await new Promise((resolve, reject) => { timer = setTimeout(() => reject(Error(`ACP response timed out: ${method}`)), 25_000); pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') }) }
  finally { clearTimeout(timer); pending.delete(id) }
}
let result
try {
  const initialized = await request('initialize', { protocolVersion: 1, clientInfo: { name: 'integration-acceptance', version: '1' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
  assert.equal(initialized.error, undefined)
  assert.equal(initialized.result.protocolVersion, 1)
  assert.equal(initialized.result.agentInfo.name, 'gemini-cli')
  assert.equal(initialized.result.agentInfo.version, '0.60.0')
  assert.equal(initialized.result.agentCapabilities.loadSession, true)
  assert(initialized.result.authMethods.some(method => method.id === 'gemini-api-key'))
  const unauthenticated = await request('session/new', { cwd: workspace, mcpServers: [] })
  assert.equal(unauthenticated.result, undefined, 'Unauthenticated session must not be admitted')
  assert.equal(unauthenticated.error.code, -32000)
  assert.match(unauthenticated.error.message, /API key.*missing|not configured|authentication/i)
  assert.equal(parseFailure, null)
  result = { status: 'passed', scope: 'real_pinned_Gemini_native_ACP_initialize_and_unauthenticated_rejection', source: { package: manifest.name, version: manifest.version, executableSha256: executableHash }, isolation: { fixture, home, workspace, credentialEnvironment: 'not_inherited', credentialStorage: 'provider_forced_file_store_in_fixture', globalConfiguration: 'not_modified', core: 'not_started' }, checks: ['pinned_version', 'real_initialize_protocol_and_product_identity', 'loadSession_advertised_not_execution_verified', 'API_key_auth_method_advertised', 'unauthenticated_session_rejected_without_success_result', 'stdout_machine_JSON_only'], observations: { initialized: initialized.result, rejection: { code: unauthenticated.error.code, message: unauthenticated.error.message }, notifications }, limits: { CoreExecution: 'not_run_by_this_native_probe', modelInference: 'not_run', authenticatedModelCatalog: 'not_run', streaming: 'not_run', cancellation: 'not_run', resume: 'not_run', skillMcp: 'not_run', fusionAcceptance: 'not_run' } }
} catch (error) {
  result = { status: 'failed', error: String(error), fixture, scope: 'native_ACP_probe_only_no_Core_or_model' }
  process.exitCode = 1
} finally {
  child.stdin.end()
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
  try { result.processClose = await closed } finally { clearTimeout(timer); lines.close() }
  await writeFile(path.join(fixture, 'stderr.log'), stderr)
  await writeFile(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ status: result.status, checks: result.checks?.length ?? 0, error: result.error ?? null, evidence: path.join(fixture, 'result.json') }))
}
