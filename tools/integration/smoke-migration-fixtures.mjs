import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { launchHost, within } from '../../scripts/lib/host-test-client.mjs';
import { coreDataDirectoryArguments } from '../../scripts/lib/runtime-camp-files-root.mjs';

// I01验收夹具：真实Core对象和回执；不是生产旧库/消息/Session导入器。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const binary = process.env.ROVAI_HOST_BIN;
const ui = process.env.ROVAI_WEB_UI;
assert(binary && path.isAbsolute(binary) && ui && path.isAbsolute(ui));
const evidenceRoot = path.resolve(process.env.FOUNDATION_EVIDENCE_ROOT ?? path.join(root, 'integration/local/migration'));
await mkdir(evidenceRoot, { recursive: true });
const fixture = await realpath(await mkdtemp(path.join(evidenceRoot, 'migration-')));
const project = path.join(fixture, 'project');
await mkdir(project);
await writeFile(path.join(project, 'README.md'), '# Migration fixture\n');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceLock = JSON.parse(await readFile(path.join(root, 'integration/sources.lock.json'), 'utf8'));
const sourceCommit = sourceLock.sources.find(source => source.id === 'codeg').commit;
const sourceFile = path.join(fixture, 'source-fixture.json');
const source = { kind: 'normalized_codeg_test_record', sourceCommit, sourceHost: 'fixture-host-A', record: {
  folderId: 1, conversationId: 7, agentType: 'codex', title: 'Imported fixture', projectPath: project,
  nativeSessionRef: 'fixture-native-session-not-resumed'
} };
await writeFile(sourceFile, JSON.stringify(source, null, 2));
const sourceHash = hash(await readFile(sourceFile));

function privateRoot(name) {
  const formal = path.join(fixture, name);
  if (process.platform === 'win32') {
    return JSON.parse(execFileSync(binary, ['--prepare-windows-data-root', formal], {
      encoding: 'utf8', windowsHide: true
    })).core;
  }
  return formal;
}
const dataDir = privateRoot('formal');
const backupRoot = privateRoot('before-import');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await mkdir(backupRoot, { recursive: true, mode: 0o700 });
const backupData = path.join(backupRoot, 'data');
const backupProject = path.join(backupRoot, 'project');
const skillRoot = path.join(dataDir, 'skills');
const mcpConfig = path.join(dataDir, 'mcp.json');
const databasePath = path.join(dataDir, 'rovai.sqlite');
let host;
let origin;
let session;
let stage = 'initial_start';
const results = [];
const passed = (id, detail = {}) => results.push({ id, status: 'passed', ...detail });

async function start() {
  host = launchHost(binary, [...coreDataDirectoryArguments(dataDir), '--skill-library-root', skillRoot,
    '--mcp-config-path', mcpConfig], { cwd: root, windowsHide: true });
  await within(host.ready);
  const web = await host.request('host.web.start', { listen: '127.0.0.1:0', uiDirectory: ui });
  origin = web.origin;
  const response = await fetch(`${origin}/api/v1/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 4, administratorToken: web.administratorToken }),
    signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  session = (await response.json()).token;
  assert(session);
}
async function stop() {
  if (host) { await host.close(); host = null; }
  session = null;
}
async function send(operation, params = {}) {
  return fetch(`${origin}/api/v1/request`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
    body: JSON.stringify({ operation, params }), signal: AbortSignal.timeout(15000) });
}
async function call(operation, params = {}) {
  const response = await send(operation, params);
  assert.equal(response.status, 200, operation);
  const body = await response.json();
  assert.equal(body.error, null, operation);
  return body.result;
}
function databaseState() {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const marker = db.prepare('SELECT contract_version,projection_schema_version FROM rovai_data_contract WHERE singleton=1').get();
    const threads = db.prepare('SELECT id FROM camp ORDER BY id').all().map(row => row.id);
    const runs = db.prepare('SELECT count(*) AS n FROM agent_run').get().n;
    const integrity = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
    return { marker, threads, runs, integrity };
  } finally { db.close(); }
}
async function plan(input, team) {
  assert.equal(input.sourceCommit, sourceCommit, 'unknown_source_version');
  assert.equal(input.kind, 'normalized_codeg_test_record');
  assert.equal(typeof input.sourceHost, 'string');
  assert(input.sourceHost.length > 0);
  const record = input.record;
  assert(Number.isSafeInteger(record.conversationId) && record.conversationId > 0);
  assert.equal(typeof record.agentType, 'string');
  const projectPath = await realpath(record.projectPath);
  assert.equal(projectPath, await realpath(project), 'path_outside_fixture');
  const selected = await call('workspaces.validate', { path: projectPath });
  assert.equal(await realpath(selected.projectPath), await realpath(project));
  const sourceRef = [input.sourceHost, record.agentType, record.conversationId];
  return { sourceRef, nativeSessionNotRestored: true, params: {
    commandId: `fixture-import-${hash(JSON.stringify(sourceRef))}`,
    name: record.title, workspace: { projectPath: selected.projectPath }, memberAgentIds: team.memberAgentIds,
    defaultLeadAgentId: team.defaultLeadAgentId, collaborationMode: 'peer'
  } };
}
async function replaceFixtureContents(sourceDirectory, targetDirectory) {
  // 仅恢复本次新建目录，保留Windows原生准备的私有根DACL。
  const target = await realpath(targetDirectory);
  assert(target.startsWith(fixture + path.sep));
  const children = await readdir(target, { withFileTypes: true });
  for (const child of children) {
    assert(!child.isSymbolicLink());
    assert((await realpath(path.join(target, child.name))).startsWith(fixture + path.sep));
  }
  for (const child of children) await rm(path.join(target, child.name), { recursive: true });
  await copyPrivateFixture(sourceDirectory, target);
}
async function copyPrivateFixture(sourceDirectory, targetDirectory) {
  assert(path.resolve(sourceDirectory).startsWith(fixture + path.sep));
  assert(path.resolve(targetDirectory).startsWith(fixture + path.sep));
  await cp(sourceDirectory, targetDirectory, { recursive: true, force: false, errorOnExist: true });
  if (process.platform === 'win32') {
    execFileSync('pwsh', ['-NoProfile', '-File', path.join(root, 'tools/integration/preserve-fixture-acl.ps1'),
      '-FixtureRoot', fixture, '-Source', sourceDirectory, '-Destination', targetDirectory], {
      encoding: 'utf8', windowsHide: true
    });
  }
}

try {
  await start();
  const preflight = await call('threads.creationPreflight');
  assert(preflight.admissible && preflight.initialLeadAgentId);
  assert(preflight.presentMembers.every(member => !member.runtimeConfigured));
  const team = { memberAgentIds: preflight.presentMembers.map(member => member.agentId),
    defaultLeadAgentId: preflight.initialLeadAgentId };
  await stop();
  const before = databaseState();
  assert.equal(before.threads.length, 0);
  await copyPrivateFixture(dataDir, backupData);
  await copyPrivateFixture(project, backupProject);
  const backupHash = hash(await readFile(path.join(backupData, 'rovai.sqlite')));
  stage = 'start_before_import';
  await start();

  const firstPlan = await plan(JSON.parse(await readFile(sourceFile, 'utf8')), team);
  const first = await call('threads.create', firstPlan.params);
  assert.equal(first.status, 'applied');
  assert.match(first.payload.threadId, /^rvcamp_/);
  passed('first_import', { scope: 'thread_shell_only', threadId: first.payload.threadId });
  const replay = await call('threads.create', firstPlan.params);
  assert.deepEqual(replay, first);
  assert.equal(databaseState().threads.length, 1);
  passed('same_record_reimport', { sameThread: true, totalThreads: 1 });

  const otherPlan = await plan({ ...source, sourceHost: 'fixture-host-B' }, team);
  const other = await call('threads.create', otherPlan.params);
  assert.equal(other.status, 'applied');
  assert.notEqual(other.payload.threadId, first.payload.threadId);
  assert.equal(databaseState().threads.length, 2);
  passed('same_integer_id_another_host', { distinctThreads: true });
  await assert.rejects(plan({ ...source, sourceCommit: '0'.repeat(40) }, team), /unknown_source_version/);
  passed('unknown_source_version', { rejectedBeforeCoreWrite: true });
  await assert.rejects(plan({ ...source, record: { ...source.record, projectPath: fixture } }, team), /path_outside_fixture/);
  assert.equal(databaseState().threads.length, 2);
  passed('path_outside_fixture', { rejectedBeforeCoreWrite: true });

  const pendingPlan = await plan({ ...source, record: { ...source.record, conversationId: 8 } }, team);
  const lostBody = await send('threads.create', pendingPlan.params);
  assert.equal(lostBody.status, 200);
  await lostBody.body.cancel(); // 故意不消费结果正文，也不写客户端映射检查点。
  await stop();
  assert.equal(databaseState().threads.length, 3);
  stage = 'restart_after_lost_body';
  await start();
  // 源Core的回执查询内层operation仍使用camps.create，不改旧回执身份。
  const receipt = await call('commands.reconcile', { operation: 'camps.create', params: pendingPlan.params });
  assert.equal(receipt.state, 'recorded');
  assert.equal(receipt.result.status, 'applied');
  const recovered = await call('threads.create', pendingPlan.params);
  assert.deepEqual(recovered, receipt.result);
  assert.equal(databaseState().threads.length, 3);
  passed('interrupted_commit', { scope: 'discarded_http_body_then_host_restart', recoveredFromCoreReceipt: true, totalThreads: 3 });
  await stop();

  await replaceFixtureContents(backupData, dataDir);
  await replaceFixtureContents(backupProject, project);
  assert.equal(hash(await readFile(databasePath)), backupHash);
  stage = 'reopen_restored_snapshot';
  await start();
  const afterRollback = databaseState();
  assert.deepEqual(afterRollback, before);
  const rolledBackReceipt = await call('commands.reconcile', { operation: 'camps.create', params: firstPlan.params });
  assert.equal(rolledBackReceipt.state, 'unknown');
  passed('restore_rollback', { databaseBytesRestoredBeforeReopen: true, totalThreads: 0, receiptState: 'unknown' });
  assert.equal(hash(await readFile(sourceFile)), sourceHash);
  passed('source_fixture_unchanged', { sourceHash });
  assert.equal(afterRollback.runs, 0);
  passed('no_runtime_started', { agentRuns: 0, nativeSessionRestored: false });
  await stop();
  await writeFile(path.join(evidenceRoot, 'migration-result.json'), JSON.stringify({
    status: 'passed', channel: 'automatic_acceptance', host: 'real_native_binary',
    fixtureScope: 'normalized_source_record_thread_shell_and_core_recovery',
    sourceCommit, coreContract: 'v1.72', coreSchema: 146, runtime: 'not_started',
    productionLegacyDatabaseImport: 'not_implemented', historicalMessagesImport: 'not_run',
    cases: results, fixture, dataDir, skillRoot, mcpConfig
  }, null, 2));
  console.log(JSON.stringify({ status: 'passed', cases: results.length, host: 'real_native_binary',
    productionLegacyDatabaseImport: 'not_implemented', historicalMessagesImport: 'not_run' }));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', stage, code: error.code ?? error.message }));
  throw error;
} finally { await stop(); }
