import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { launchHost, within } from '../../scripts/lib/host-test-client.mjs';
import { coreDataDirectoryArguments } from '../../scripts/lib/runtime-camp-files-root.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const binary=process.env.ROVAI_HOST_BIN, ui=process.env.ROVAI_WEB_UI;
assert(binary && path.isAbsolute(binary) && ui && path.isAbsolute(ui), '须提供绝对Host和WebUI产物路径');
const evidenceRoot=path.resolve(process.env.FOUNDATION_EVIDENCE_ROOT ?? path.join(root,'integration/local/foundation'));
await mkdir(evidenceRoot,{recursive:true});
const fixture=await realpath(await mkdtemp(path.join(evidenceRoot,'run-')));
const dataDir=process.platform==='win32'
  ? JSON.parse(execFileSync(binary,['--prepare-windows-data-root',path.join(fixture,'formal')],{encoding:'utf8',windowsHide:true})).core
  : path.join(fixture,'data');
const skillRoot=path.join(dataDir,'skills'), mcp=path.join(dataDir,'mcp.json');
const host=launchHost(binary,[...coreDataDirectoryArguments(dataDir),'--skill-library-root',skillRoot,'--mcp-config-path',mcp],{cwd:root,windowsHide:true});
const results=[];let session;let stopped=false;
try {
  await within(host.ready);
  const started=await host.request('host.web.start',{listen:'127.0.0.1:0',uiDirectory:ui});
  const administrator=started.administratorToken, origin=started.origin;
  assert(origin?.startsWith('http://127.0.0.1:') && administrator, '仅测试本次隔离Host');
  const cases=JSON.parse(await readFile(path.join(root,'integration/foundation/protocol-cases.json'),'utf8'));
  for(const c of cases) {
    const headers={...(c.headers??{})};
    if(c.auth==='session')headers.Authorization=`Bearer ${session}`;
    if(c.auth==='administrator')headers.Authorization=`Bearer ${administrator}`;
    if(c.body)headers['Content-Type']='application/json';
    const body=c.body?JSON.stringify(c.body).replace('$administrator',administrator):undefined;
    const response=await fetch(`${origin}/api/v1/${c.path}`,{method:c.method,headers,body,redirect:'error',signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,c.expectedHttp,c.id);
    if(c.saveSession) { const payload=await response.json();session=payload.token;assert(session);assert.equal(response.headers.get('set-cookie'),null); }
    else await response.arrayBuffer();
    results.push({id:c.id,status:'passed',http:response.status});
  }
  const stream=await fetch(`${origin}/api/v1/events`,{headers:{Authorization:`Bearer ${session}`},signal:AbortSignal.timeout(15000)});
  const reader=stream.body.getReader();
  const chunk=await within(reader.read());assert.match(new TextDecoder().decode(chunk.value),/event:\s*resync/);
  await reader.cancel();results.push({id:'first_event_requires_resync',status:'passed'});
  await host.close();stopped=true;
  const dbPath=path.join(dataDir,'rovai.sqlite');
  const db=new DatabaseSync(dbPath,{readOnly:true});
  const marker=db.prepare('SELECT contract_version,projection_schema_version FROM rovai_data_contract WHERE singleton=1').get();
  const integrity=db.prepare('PRAGMA integrity_check').get();
  assert.equal(marker.contract_version,'v1.72');assert.equal(marker.projection_schema_version,146);
  assert.equal(Object.values(integrity)[0],'ok');db.close();
  results.push({id:'fresh_database_current_contract_and_integrity',status:'passed',contract:marker.contract_version,schema:marker.projection_schema_version});
  const result={status:'passed',channel:'automatic_acceptance',host:'real_native_binary',runtime:'not_started',productionMigration:'not_run',cases:results,dataDir,skillRoot,mcpConfigPath:mcp};
  await writeFile(path.join(evidenceRoot,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({status:'passed',cases:results.length,runtime:'not_started',productionMigration:'not_run'}));
} finally { if(!stopped)await host.close(); }
