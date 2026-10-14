import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, realpath, writeFile, readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {launchHost,within} from '../../scripts/lib/host-test-client.mjs';
import {coreDataDirectoryArguments} from '../../scripts/lib/runtime-camp-files-root.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [binary,ui,evidenceRoot]=process.argv.slice(2);
assert([binary,ui,evidenceRoot].every(value=>value && path.isAbsolute(value)),'Provide absolute Host, Web UI and dedicated evidence paths');
await mkdir(evidenceRoot,{recursive:true});
const fixture=await realpath(await mkdtemp(path.join(evidenceRoot,'catalog-')));
const home=path.join(fixture,'fake-home'),temp=path.join(fixture,'tmp');
await mkdir(home);await mkdir(temp);
const env={};for(const [key,value] of Object.entries(process.env))if(['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT'].includes(key.toUpperCase()))env[key]=value;
Object.assign(env,{HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local'),XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share'),XDG_STATE_HOME:path.join(home,'.local/state'),TEMP:temp,TMP:temp,ROVAI_BUNDLED_SKILLS_ROOT:path.join(root,'skills')});
const formal=path.join(fixture,'formal');
const dataDir=process.platform==='win32'?JSON.parse(execFileSync(binary,['--prepare-windows-data-root',formal],{encoding:'utf8',env,windowsHide:true})).core:formal;
const skillRoot=path.join(dataDir,'skills'),mcp=path.join(dataDir,'mcp.json');
const checks=[];let host;let stage='start';
const record=(id,detail={})=>{checks.push({id,status:'passed',...detail});console.log(JSON.stringify({stage:id,passed:checks.length}));};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const start=()=>launchHost(binary,[...coreDataDirectoryArguments(dataDir,{homeDirectory:home}),'--skill-library-root',skillRoot,'--mcp-config-path',mcp],{cwd:root,env,windowsHide:true});
try {
  host=start();await within(host.ready);
  const direct=await host.request('skillPacks.list',{});
  assert.equal(direct.entries.length,37);assert.equal(direct.families.length,5);
  assert.equal(direct.commit,'aff1e6c278453ed8d0b96a5f664edcdca621aa3f');
  record('real_Core_catalog_and_fixed_commit',{entries:37,families:5});
  const started=await host.request('host.web.start',{listen:'127.0.0.1:0',uiDirectory:ui});
  assert(started.origin.startsWith('http://127.0.0.1:'));
  const login=await fetch(`${started.origin}/api/v1/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:4,administratorToken:started.administratorToken}),signal:AbortSignal.timeout(15000)});
  assert.equal(login.status,200);const token=(await login.json()).token;assert(token);
  const request=async(operation,params={},authenticated=true)=>{
    const response=await fetch(`${started.origin}/api/v1/request`,{method:'POST',headers:{'Content-Type':'application/json',...(authenticated?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({operation,params}),signal:AbortSignal.timeout(15000)});
    return {http:response.status,body:await response.json()};
  };
  stage='HTTP_catalog';
  const anonymous=await request('skillPacks.list',{},false);assert.equal(anonymous.http,401);record('HTTP_anonymous_catalog_rejected');
  const catalog=await request('skillPacks.list');assert.equal(catalog.http,200);assert.equal(catalog.body.error,null);assert.deepEqual(catalog.body.result,direct);record('HTTP_and_Core_share_one_catalog');
  const preview=await request('skillPacks.read',{skillId:'brainstorming'});assert.equal(preview.http,200);assert.equal(preview.body.error,null);assert.equal(preview.body.result.status,'text');assert(preview.body.result.content.startsWith('---'));
  const expected=await readFile(path.join(root,'crates/rovai-core/resources/codeg-skill-packs/experts/skills/brainstorming/SKILL.md'),'utf8');
  assert.equal(preview.body.result.content,expected);record('HTTP_preview_exact_fixed_source',{sha256:sha(expected)});
  const office=await request('skillPacks.read',{skillId:'officecli-pptx'});assert.equal(office.http,200);assert(office.body.error);record('HTTP_Office_dependency_is_explicit');
  const traversal=await request('skillPacks.read',{skillId:'brainstorming',path:'../SKILL.md'});assert.equal(traversal.http,200);assert(traversal.body.error);record('HTTP_cross_package_read_rejected');
  stage='restart';await host.close();host=undefined;
  host=start();await within(host.ready);const reopened=await host.request('skillPacks.list',{});assert.deepEqual(reopened,direct);record('Core_restart_keeps_catalog_bytes');
  await host.close();host=undefined;
  const db=new DatabaseSync(path.join(dataDir,'rovai.sqlite'),{readOnly:true});
  try {const marker=db.prepare('SELECT contract_version,projection_schema_version FROM rovai_data_contract WHERE singleton=1').get();assert.equal(marker.projection_schema_version,149);assert.equal(db.prepare('SELECT count(*) AS n FROM agent_run').get().n,0);assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0],'ok');record('fresh_schema149_integrity_and_no_AgentRun',{schema:149});}finally{db.close();}
  assert.deepEqual(await readdir(home),[]);record('fake_Home_has_no_installed_packages');
  const result={status:'passed',task:'I02-T03',scope:'real_Core_and_HTTP_fixed_catalog_and_preview',checks,fixture,dataDir,fakeHome:home,CoreBinarySha256:sha(await readFile(binary)),schema:149,sourceCommit:direct.commit,modelInference:false,runtimeExecutionRequested:false,installation:false,memberDelivery:false,OfficeCLI:false,generativeUiRenderer:false};
  await writeFile(path.join(fixture,'result.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({status:'passed',checks:checks.length,evidence:path.join(fixture,'result.json')}));
} catch(error) {
  await writeFile(path.join(fixture,'failure.json'),JSON.stringify({status:'failed',stage,checks,error:String(error),fixture},null,2)+'\n');throw error;
} finally {if(host)await host.close();}
