import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const { values } = parseArgs({ options: Object.fromEntries([
  'host', 'openclaw-bin', 'node-dir', 'cargo-wrapper', 'output-dir',
].map(name => [name, { type: 'string' }])) });
if (process.platform !== 'win32') throw new Error('This native entrypoint smoke currently owns Windows only.');
for (const name of ['host', 'openclaw-bin', 'node-dir', 'cargo-wrapper', 'output-dir']) {
  assert.ok(values[name] && path.isAbsolute(values[name]), `An absolute --${name} is required`);
}
for (const name of ['host', 'openclaw-bin', 'cargo-wrapper']) assert.ok((await stat(values[name])).isFile(), name);
assert.ok((await stat(path.join(values['node-dir'], 'node.exe'))).isFile());
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(values['output-dir'], { recursive: true });
const fixture = await mkdtemp(path.join(values['output-dir'], 'core-gateway-'));
// The native preparer creates the protected DACL. Do not mkdir the formal root.
const layout = JSON.parse(execFileSync(values.host, ['--prepare-windows-data-root', path.join(fixture, 'formal')], { encoding: 'utf8', windowsHide: true }));
const root = layout.core;
const project = path.join(root, 'project');
await mkdir(project);
await writeFile(path.join(root, 'fixture.json'), JSON.stringify({ purpose: 'rovai-openclaw-metadata-only' }));
const requests = [];
const server = createServer((request, response) => {
  requests.push({ method: request.method, url: request.url });
  response.writeHead(503, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: { message: 'Metadata fixture never serves inference' } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await writeFile(path.join(root, 'native.json'), JSON.stringify({
  agents: { list: [{ id: 'Native-Fixture', name: 'Preserved native owner' }], defaults: { workspace: project, heartbeat: { every: '0m' }, model: { primary: 'integration-probe/metadata-only-model' } } },
  models: { providers: { 'integration-probe': { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture-not-a-real-credential', models: [{ id: 'metadata-only-model', name: 'Metadata only fixture', input: ['text'], reasoning: false, contextWindow: 4096, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
  plugins: { enabled: false }, tools: { exec: { notifyOnExit: false } },
}, null, 2));
const authoredConfiguration = await readFile(path.join(root, 'native.json'));
const env = { ...process.env,
  ROVAI_OPENCLAW_SMOKE_ROOT: root, ROVAI_OPENCLAW_SMOKE_BIN: values['openclaw-bin'], ROVAI_OPENCLAW_SMOKE_NODE_DIR: values['node-dir'],
};
const command = `& '${values['cargo-wrapper'].replaceAll("'", "''")}' test -p rovai-core --features extended-tests --lib openclaw_gateway::managed_native_gateway_freezes_routes_and_reaps_its_process_tree -- --exact --ignored --nocapture`;
const child = spawn('pwsh', ['-NoProfile', '-Command', command], { cwd: repository, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', data => { output += data; });
child.stderr.on('data', data => { output += data; });
console.log(JSON.stringify({ stage: 'core_native_gateway_probe_started', fixture, isolatedRoot: root }));
const started = Date.now();
const heartbeat = setInterval(() => console.log(JSON.stringify({ stage: 'running', elapsedSeconds: Math.floor((Date.now() - started) / 1000) })), 30000);
let result;
try {
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  assert.equal(exit, 0, output.slice(-6500));
  const native = JSON.parse(await readFile(path.join(root, 'core-probe-result.json'), 'utf8'));
  assert.equal(native.status, 'passed');
  assert.deepEqual(await readFile(path.join(root, 'native.json')), authoredConfiguration);
  assert.equal(requests.filter(request => request.method === 'POST').length, 0);
  result = { status: 'passed', fixture, isolatedRoot: root, native, requests, nativeConfigurationUnchanged: true, realProviderCredentials: false, CoreAgentRun: false, modelInference: false };
} catch (error) {
  process.exitCode = 1;
  result = { status: 'failed', fixture, isolatedRoot: root, error: String(error.stack ?? error), requests, CoreAgentRun: false, modelInference: false };
} finally {
  clearInterval(heartbeat);
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(fixture, 'cargo.log'), output);
  await writeFile(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ status: result.status, evidence: path.join(fixture, 'result.json'), error: result.error?.slice(-3000) }));
}
