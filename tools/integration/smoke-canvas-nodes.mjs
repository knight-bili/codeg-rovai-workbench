import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, realpath, readFile, writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchHost} from '../../scripts/lib/host-test-client.mjs';
import {coreDataDirectoryArguments} from '../../scripts/lib/runtime-camp-files-root.mjs';

// Real Host/HTTP acceptance in a new private root. No runtime, model or PTY is launched.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [oldBinary, binary, evidenceRoot] = process.argv.slice(2);
assert([oldBinary, binary, evidenceRoot].every(value => value && path.isAbsolute(value)),
  'Provide immutable schema153/schema154 Host and evidence absolute paths');
await mkdir(evidenceRoot, {recursive: true});
const fixture = await realpath(await mkdtemp(path.join(evidenceRoot, 'nodes-')));
const home = path.join(fixture, 'fake-home'), temp = path.join(fixture, 'tmp'), ui = path.join(fixture, 'ui');
for (const directory of [home, temp, ui]) await mkdir(directory);
await writeFile(path.join(ui, 'index.html'), '<!doctype html><meta charset="UTF-8"><p>Isolated canvas API acceptance</p>');
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'].includes(key.toUpperCase())) env[key] = value;
}
const git = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'],
  {encoding: 'utf8', windowsHide: true}).trim().split(/\r?\n/)[0];
env.PATH = [path.dirname(binary), path.dirname(oldBinary), path.dirname(git),
  ...(process.platform === 'win32' ? [path.join(env.SystemRoot ?? env.SYSTEMROOT, 'System32')] : ['/usr/bin', '/bin'])].join(path.delimiter);
Object.assign(env, {HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData/Local'), TEMP: temp, TMP: temp,
  ROVAI_BUNDLED_SKILLS_ROOT: path.join(root, 'skills')});
await mkdir(env.APPDATA, {recursive: true}); await mkdir(env.LOCALAPPDATA, {recursive: true});
const formal = path.join(fixture, 'formal');
const dataDir = process.platform === 'win32'
  ? JSON.parse(execFileSync(oldBinary, ['--prepare-windows-data-root', formal],
    {env, encoding: 'utf8', windowsHide: true})).core : formal;
console.log(JSON.stringify({channel: 'automatic_acceptance', fixture, dataDir,
  skillLibraryRoot: path.join(dataDir, 'skills'), mcpConfig: path.join(dataDir, 'mcp.json'), home}));
let host, web, call, raw, stage = 'schema153';
const checks = [];
const record = id => {checks.push({id, status: 'passed'}); console.log(JSON.stringify({stage: id, checks: checks.length}));};
const applied = result => assert.equal(result.status, 'applied', result.code);
async function start(executable) {
  host = launchHost(executable, [...coreDataDirectoryArguments(dataDir, {homeDirectory: home}),
    '--skill-library-root', path.join(dataDir, 'skills'), '--mcp-config-path', path.join(dataDir, 'mcp.json')],
  {cwd: root, env, windowsHide: true});
  let timer;
  try {await Promise.race([host.ready, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('Isolated startup exceeded 60 seconds')), 60000);
  })]);} finally {clearTimeout(timer);}
  web = await host.request('host.web.start', {listen: '127.0.0.1:0', uiDirectory: ui});
  assert(web.origin.startsWith('http://127.0.0.1:'));
  const login = await fetch(web.origin + '/api/v1/login', {method: 'POST',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify({protocolVersion: 4,
      administratorToken: web.administratorToken}), signal: AbortSignal.timeout(15000)});
  assert.equal(login.status, 200);
  const token = (await login.json()).token; assert(token);
  raw = (operation, params = {}, authenticated = true) => fetch(web.origin + '/api/v1/request', {
    method: 'POST', headers: {'Content-Type': 'application/json', ...(authenticated ? {Authorization: 'Bearer ' + token} : {})},
    body: JSON.stringify({operation, params}), signal: AbortSignal.timeout(15000)});
  call = async (operation, params = {}) => {
    const response = await raw(operation, params); assert.equal(response.status, 200, operation);
    const reply = await response.json(); assert.equal(reply.error, null, JSON.stringify({operation, error: reply.error}));
    return reply.result;
  };
}
async function close() {await host.close(); host = undefined;}
const command = (operation, value, commandId = randomUUID()) => call(operation, {commandId, command: value});
const withDB = action => {const db = new DatabaseSync(path.join(dataDir, 'rovai.sqlite'), {readOnly: true});
  try {return action(db);} finally {db.close();}};
const sourcePaths = ['crates/rovai-core/src/canvas_node.rs', 'crates/rovai-core/src/canvas_board.rs',
  'crates/rovai-core/src/db.rs', 'crates/rovai-core/src/db_skill_pack_context.rs',
  'crates/rovai-core/src/application.rs', 'crates/rovai-web/src/operations.rs',
  'crates/rovai-core/src/read_model.rs', 'crates/rovai-core/src/read_model/canvas_references.rs', 'crates/rovai-core/src/read_model/navigation.rs',
  'crates/rovai-core/src/git.rs', 'crates/rovai-core/src/git/worktrees.rs'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  await start(oldBinary);
  const roster = await call('members.list'); assert(roster.length);
  const preflight = await call('threads.creationPreflight'); assert(preflight.admissible);
  assert(preflight.presentMembers.every(member => !member.runtimeConfigured));
  const memberId = preflight.initialLeadAgentId;
  const catalog = await call('skillPacks.list');
  const install = {commandId: randomUUID(), command: {skillId: 'brainstorming', sourceRevision: catalog.commit, expectedVersion: 'absent'}};
  const installReceipt = await call('skillPacks.install', install); applied(installReceipt);
  const installation = (await call('skillPacks.installations.list')).find(item => item.skillId === 'brainstorming');
  const content = await readFile(path.join(installation.contentPath, 'SKILL.md'));
  const selection = (await call('skillPacks.members.list')).find(item => item.skillId === 'brainstorming');
  const choice = {commandId: randomUUID(), command: {skillId: 'brainstorming', memberIds: [memberId], expectedVersion: selection.version}};
  const choiceReceipt = await call('skillPacks.members.set', choice); applied(choiceReceipt);
  const createBoardId = randomUUID();
  const boardReceipt = await command('canvas.boards.create', {name: '升级前总体画板', color: 'blue'}, createBoardId);
  applied(boardReceipt); const boardId = boardReceipt.payload.board.id;
  const thread = await call('threads.create', {commandId: randomUUID(), name: '画布引用的真实会话', workspace: null,
    memberAgentIds: [memberId], defaultLeadAgentId: memberId, collaborationMode: 'peer', activationState: 'active'});
  applied(thread); const threadId = thread.payload.threadId; assert(threadId);
  const single = await command('singleChat.open', {threadId, agentId: memberId}); applied(single);
  const conversationId = single.payload.conversationId; assert(conversationId);
  await close();
  const oldFacts = withDB(db => {
    assert.equal(db.prepare('SELECT projection_schema_version AS v FROM rovai_data_contract').get().v, 153);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='canvas_node'").get().n, 0);
    return {board: db.prepare('SELECT * FROM canvas_board WHERE id=?').get(boardId),
      thread: db.prepare('SELECT * FROM camp WHERE id=?').get(threadId)};
  });
  record('real153_board_thread_single_chat_skill_installation_selection_and_receipts');
  stage = 'upgrade154'; await start(binary);
  assert.deepEqual(await call('skillPacks.install', install), installReceipt);
  assert.deepEqual(await call('skillPacks.members.set', choice), choiceReceipt);
  assert.deepEqual(await command('canvas.boards.create', {name: '不能重复创建'}, createBoardId), boardReceipt);
  const reconciledBoard = await call('commands.reconcile', {operation: 'canvas.boards.create',
    params: {commandId: createBoardId, command: {name: '回查不得改写'}}});
  assert.deepEqual(reconciledBoard, {state: 'recorded', result: boardReceipt});
  assert.deepEqual(await readFile(path.join(installation.contentPath, 'SKILL.md')), content);
  assert.equal((await call('skillPacks.installations.list')).find(item => item.skillId === 'brainstorming').version, installation.version);
  assert.deepEqual((await call('skillPacks.members.list')).find(item => item.skillId === 'brainstorming').memberIds, [memberId]);
  assert.deepEqual(await call('members.list'), roster);
  let graph = await call('canvas.nodes.snapshot', {boardId}); assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.board, boardReceipt.payload.board);
  record('153_to154_migration_preserves_real_objects_skill_bytes_and_original_command_results');
  const directoryThread = await call('threads.create', {commandId: randomUUID(), name: '目录分页的第二个会话', workspace: null,
    memberAgentIds: [memberId], defaultLeadAgentId: memberId, collaborationMode: 'peer', activationState: 'active'});
  applied(directoryThread);
  assert.equal((await raw('canvas.references.page', {}, false)).status, 401);
  for (const params of [{sql: true}, {afterThreadId: 'not-a-thread'}]) {
    assert((await (await raw('canvas.references.page', params)).json()).error);
  }
  const sequenceBeforeDirectory = (await call('canvas.nodes.snapshot', {boardId})).throughGlobalSequence;
  const directory = []; let afterThreadId = null, upperThreadId = null;
  do {
    const page = await call('canvas.references.page', {afterThreadId, upperThreadId, limit: 1});
    assert.equal(page.schemaVersion, 1); assert(page.items.length <= 1);
    if (upperThreadId !== null) assert.equal(page.upperThreadId, upperThreadId);
    upperThreadId = page.upperThreadId;
    if (page.nextAfterThreadId !== null) {
      assert.equal(page.nextAfterThreadId, page.items.at(-1).threadId);
      assert(afterThreadId === null || page.nextAfterThreadId > afterThreadId);
    }
    directory.push(...page.items); afterThreadId = page.nextAfterThreadId;
  } while (afterThreadId !== null);
  assert.equal(new Set(directory.map(item => item.threadId)).size, directory.length);
  assert(directory.some(item => item.threadId === directoryThread.payload.threadId));
  const directoryItem = directory.find(item => item.threadId === threadId); assert(directoryItem);
  assert(directoryItem.members.some(item => item.agentId === memberId));
  assert(directoryItem.privateConversations.some(item => item.conversationId === conversationId && item.agentId === memberId));
  assert.equal((await call('canvas.nodes.snapshot', {boardId})).throughGlobalSequence, sequenceBeforeDirectory);
  record('authenticated_keyset_directory_preserves_exact_member_private_identity_and_performs_no_business_writes');
  assert.equal((await raw('workspaces.worktrees', {path: fixture}, false)).status, 401);
  for (const params of [{path: fixture, sql: true}, {path: dataDir}, {path: 'relative'}]) {
    assert((await (await raw('workspaces.worktrees', params)).json()).error);
  }
  const plainTopology = await call('workspaces.worktrees', {path: fixture});
  assert.equal(plainTopology.schemaVersion, 1); assert.equal(plainTopology.requestedPath, fixture);
  assert.equal(plainTopology.repositoryRoot, null); assert.deepEqual(plainTopology.worktrees, []);
  assert.equal((await call('canvas.nodes.snapshot', {boardId})).throughGlobalSequence, sequenceBeforeDirectory);
  record('authenticated_worktree_read_rejects_managed_paths_and_unknown_params_without_business_writes');
  assert.equal((await raw('navigation.activity', {groupKeys: ['quick-chat']}, false)).status, 401);
  for (const params of [{groupKeys: []}, {groupKeys: ['foreign']}, {groupKeys: ['quick-chat'], sql: true}, {groupKeys: ['quick-chat'], threadIds: []}]) {
    assert((await (await raw('navigation.activity', params)).json()).error);
  }
  const activity = await call('navigation.activity', {groupKeys: ['quick-chat', `directory:${fixture}`]});
  assert.equal(activity.schemaVersion, 1); assert.equal(activity.groups.length, 2);
  assert(activity.groups.every(group => group.activeThreadCount === 0));
  const unchangedActivity = await call('navigation.activity', {groupKeys: ['quick-chat', `directory:${fixture}`], threadIds: ['physically-absent-thread']});
  assert.deepEqual(unchangedActivity.groups, activity.groups);
  assert.equal((await call('canvas.nodes.snapshot', {boardId})).throughGlobalSequence, sequenceBeforeDirectory);
  record('authenticated_navigation_activity_is_bounded_complete_metadata_and_missing_thread_reconciliation_without_business_writes');
  assert.equal((await raw('canvas.nodes.snapshot', {boardId}, false)).status, 401);
  const malformed = await raw('canvas.nodes.snapshot', {boardId, path: 'C:/fake'}); assert((await malformed.json()).error);
  const other = await command('canvas.boards.create', {name: '另一块画板'}); applied(other);
  const otherId = other.payload.board.id;
  const ref = {threadId, conversationId: null}, exact = {threadId, conversationId};
  const node = (kind, extra = {}) => ({kind, x: 5, y: -7, width: 320, height: 240,
    ...(kind === 'folder' ? {folderPath: path.join(fixture, 'missing-folder')} : {}),
    ...(kind === 'group' ? {folderGroupId: 'unavailable-local-group'} : {}),
    ...(kind === 'agent' ? {agentId: memberId, runtimeKind: 'codex-cli'} : {}),
    ...(kind === 'conversation' ? {conversation: ref} : {}),
    ...(kind === 'custom' ? {conversations: [ref, ref, exact]} : {}),
    ...(kind === 'note' ? {content: '\n中文 **便签**\n'} : {}),
    ...(['file', 'terminal'].includes(kind) ? {path: path.join(fixture, 'unavailable-path')} : {}), ...extra});
  const snapshot = id => call('canvas.nodes.snapshot', {boardId: id ?? boardId});
  const mutate = async (mutation, id = boardId, commandId) => {
    const before = await snapshot(id);
    const result = await command('canvas.nodes.apply', {boardId: id, expectedRevision: before.board.revision, mutation}, commandId);
    applied(result); return result;
  };
  const kinds = ['folder', 'group', 'agent', 'conversation', 'custom', 'note', 'file', 'terminal'];
  const ids = {};
  for (const kind of kinds) ids[kind] = (await mutate({type: 'create', node: node(kind)})).payload.nodeIds[0];
  graph = await snapshot(); assert.equal(graph.nodes.length, 8);
  assert.deepEqual(graph.nodes.find(item => item.id === ids.custom).data.conversations, [ref, exact]);
  assert.equal(graph.nodes.find(item => item.id === ids.note).data.content, '\n中文 **便签**\n');
  record('authenticated_HTTP_creates_all_eight_kinds_with_distinct_thread_and_private_conversation_refs');
  assert.equal(graph.memberTransferVersion, 1);
  const foreign = await mutate({type: 'create', node: node('note', {content: '其他画板'})}, otherId);
  const foreignId = foreign.payload.nodeIds[0], foreignGraph = await snapshot(otherId);
  const moveId = randomUUID();
  const moveCommand = {boardId, expectedRevision: graph.board.revision, mutation: {type: 'move', moves: []}};
  const beforeLookup = await snapshot();
  assert.deepEqual(await call('commands.reconcile', {operation: 'canvas.nodes.apply',
    params: {commandId: moveId, command: moveCommand}}), {state: 'unknown'});
  assert.deepEqual(await snapshot(), beforeLookup);
  const moved = await mutate({type: 'move', moves: [{nodeId: ids.note, x: 99, y: 100},
    {nodeId: foreignId, x: 50, y: 60}, {nodeId: ids.note, x: 2000000, y: -2000000}]}, boardId, moveId);
  graph = await snapshot(); const note = graph.nodes.find(item => item.id === ids.note);
  assert.equal(note.data.x, 1000000); assert.equal(note.data.y, -1000000); assert.equal(note.data.content, '\n中文 **便签**\n');
  assert.deepEqual((await snapshot(otherId)).nodes, foreignGraph.nodes);
  assert.deepEqual(await command('canvas.nodes.apply', {boardId, expectedRevision: -1, mutation: {type: 'delete', nodeIds: [ids.note]}}, moveId), moved);
  assert.deepEqual(await call('commands.reconcile', {operation: 'canvas.nodes.apply',
    params: {commandId: moveId, command: moveCommand}}), {state: 'recorded', result: moved});
  const stale = await command('canvas.nodes.apply', {boardId, expectedRevision: graph.board.revision - 1,
    mutation: {type: 'delete', nodeIds: [ids.note]}}); assert.equal(stale.code, 'canvas.nodes.conflict');
  assert.equal((await snapshot()).board.revision, graph.board.revision);
  record('scoped_batch_move_clamps_last_duplicate_preserves_note_and_replays_without_reapplying');
  const invalid = await command('canvas.nodes.apply', {boardId, expectedRevision: graph.board.revision,
    mutation: {type: 'group', targetNodeId: ids.custom, newRegion: null, conversations: [], consumeNodeIds: [foreignId, ids.note]}});
  // Notes and foreign-board IDs cannot be consumed by grouping.
  applied(invalid); assert.equal((await snapshot()).nodes.length, 8);
  await mutate({type: 'group', targetNodeId: ids.custom, newRegion: null, conversations: [ref], consumeNodeIds: [ids.conversation, ids.note, foreignId]});
  graph = await snapshot(); assert(!graph.nodes.some(item => item.id === ids.conversation));
  assert(graph.nodes.some(item => item.id === ids.note)); assert.deepEqual((await snapshot(otherId)).nodes, foreignGraph.nodes);
  const targetGroup = (await mutate({type: 'create', node: node('custom', {conversations: []})})).payload.nodeIds[0];
  graph = await snapshot();
  const transferId = randomUUID(), transferRequest = {boardId, expectedRevision: graph.board.revision, mutation: {type: 'group', targetNodeId: targetGroup,
    newRegion: null, conversations: [exact], consumeNodeIds: [], sourceMembers: [{regionId: ids.custom, conversation: exact}]}};
  const transferred = await command('canvas.nodes.apply', transferRequest, transferId); applied(transferred);
  graph = await snapshot(); const afterTransfer = graph.board.revision;
  assert.deepEqual(graph.nodes.find(item => item.id === ids.custom).data.conversations, [ref]);
  assert.deepEqual(graph.nodes.find(item => item.id === targetGroup).data.conversations, [exact]);
  assert.deepEqual(await command('canvas.nodes.apply', transferRequest, transferId), transferred);
  assert.equal((await snapshot()).board.revision, afterTransfer);
  await mutate({type: 'group', targetNodeId: ids.custom, newRegion: null, conversations: [exact], consumeNodeIds: [], sourceMembers: [{regionId: targetGroup, conversation: exact}]});
  await mutate({type: 'delete', nodeIds: [targetGroup]});
  record('atomic_member_transfer_preserves_private_identity_source_membership_and_first_receipt_replay');
  const detached = await mutate({type: 'detach', regionId: ids.custom, conversation: exact, x: 12, y: 18});
  graph = await snapshot(); const pin = graph.nodes.find(item => item.id === detached.payload.nodeIds.find(id => id !== ids.custom));
  assert.deepEqual(pin.data.conversation, exact); assert.equal(pin.data.width, 224); assert.equal(pin.data.height, 132);
  assert.deepEqual(graph.nodes.find(item => item.id === ids.custom).data.conversations, [ref]);
  record('group_only_consumes_adopted_pins_and_detach_preserves_exact_reference_and_source_pin_size');
  const unchanged = await mutate({type: 'move', moves: []}); assert.equal(unchanged.code, 'canvas.nodes.unchanged');
  await mutate({type: 'update', nodeId: ids.note, patch: {content: '\n更新正文\n', title: '便签', collapsed: true, width: 400}});
  await mutate({type: 'prune'});
  const beforeRestart = await snapshot(); await close();
  withDB(db => {
    assert.deepEqual(db.prepare('SELECT * FROM camp WHERE id=?').get(threadId), oldFacts.thread);
    const before = {...oldFacts.board}; const after = {...db.prepare('SELECT * FROM canvas_board WHERE id=?').get(boardId)};
    for (const field of ['revision', 'updated_at']) {delete before[field]; delete after[field];}
    assert.deepEqual(after, before);
  });
  stage = 'restart154'; await start(binary);
  graph = await snapshot(); assert.deepEqual(graph.nodes, beforeRestart.nodes); assert.deepEqual(graph.board, beforeRestart.board);
  assert.deepEqual(await command('canvas.nodes.apply', {boardId, expectedRevision: 0, mutation: {type: 'prune'}}, moveId), moved);
  record('real154_Host_restart_preserves_graph_revision_note_bytes_and_historical_result');
  const deleteId = randomUUID();
  const deleteCommand = {boardId, expectedRevision: graph.board.revision};
  const deleted = await command('canvas.boards.delete', deleteCommand, deleteId); applied(deleted);
  assert.deepEqual((await snapshot()).nodes, []); assert.equal((await snapshot()).board, null);
  assert.deepEqual((await snapshot(otherId)).nodes, foreignGraph.nodes);
  assert.deepEqual(await command('canvas.nodes.apply', {boardId, expectedRevision: 0, mutation: {type: 'prune'}}, moveId), moved);
  assert.deepEqual(await call('commands.reconcile', {operation: 'canvas.boards.delete',
    params: {commandId: deleteId, command: deleteCommand}}), {state: 'recorded', result: deleted});
  await close();
  withDB(db => {
    assert.equal(db.prepare('SELECT projection_schema_version AS v FROM rovai_data_contract').get().v, 154);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migration WHERE version=204').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM canvas_node WHERE board_id=?').get(boardId).n, 0);
    assert.deepEqual(db.prepare('SELECT * FROM camp WHERE id=?').get(threadId), oldFacts.thread);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversation WHERE id=?').get(conversationId).n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_run').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM context_manifest').get().n, 0);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    for (const event of db.prepare("SELECT payload_json FROM event_log WHERE event_type='canvas.board.invalidated'").all()) {
      assert.deepEqual(Object.keys(JSON.parse(event.payload_json)).sort(), ['boardId', 'revision']);
    }
  });
  record('board_delete_cleans_own_graph_without_deleting_business_history_or_starting_any_Run');
  const sourceHashes = await Promise.all(sourcePaths.map(async file => ({file, sha256: hash(await readFile(path.join(root, file)))})));
  const result = {status: 'passed', checks, fixture, dataDir, platform: process.platform,
    scope: 'real153_to154_Host_HTTP_node_graph_without_renderer_or_PTY', schema: 154, migration: 204,
    oldBinarySha256: hash(await readFile(oldBinary)), currentBinarySha256: hash(await readFile(binary)), sourceHashes,
    canvasUI: false, liveRegionResolution: false, interactivePTY: false, modelInference: false, zeroAgentRun: true, zeroContextManifest: true};
  await writeFile(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({status: 'passed', checks: checks.length, evidence: path.join(fixture, 'result.json')}));
} catch (error) {
  await writeFile(path.join(fixture, 'failure.json'), JSON.stringify({status: 'failed', stage, checks, error: String(error), fixture}, null, 2) + '\n');
  throw error;
} finally {if (host) await close();}
