import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,mkdtemp,realpath,readFile,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';import {fileURLToPath} from 'node:url';
import react from '@vitejs/plugin-react';import {build} from 'vite';
import {launchHost} from '../../scripts/lib/host-test-client.mjs';
import {coreDataDirectoryArguments} from '../../scripts/lib/runtime-camp-files-root.mjs';
import {launchAcceptanceBrowser} from '../../scripts/lib/host-web-browser.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [oldBinary,binary,browserBinary,evidenceRoot]=process.argv.slice(2);
assert([oldBinary,binary,browserBinary,evidenceRoot].every(value=>value && path.isAbsolute(value)),'Provide four absolute artifact/browser/evidence paths');
await mkdir(evidenceRoot,{recursive:true});const fixture=await realpath(await mkdtemp(path.join(evidenceRoot,'members-')));
const home=path.join(fixture,'fake-home'),temp=path.join(fixture,'tmp'),src=path.join(fixture,'ui-source'),ui=path.join(fixture,'ui-build');
for(const directory of [home,temp,src])await mkdir(directory);
const env={};for(const [key,value] of Object.entries(process.env))if(['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT'].includes(key.toUpperCase()))env[key]=value;
Object.assign(env,{HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local'),TEMP:temp,TMP:temp,ROVAI_BUNDLED_SKILLS_ROOT:path.join(root,'skills')});
await mkdir(env.APPDATA,{recursive:true});await mkdir(env.LOCALAPPDATA,{recursive:true});
const source=file=>JSON.stringify(path.join(root,'apps/desktop/src/renderer/src',file).replaceAll('\\','/'));
await writeFile(path.join(src,'index.html'),'<!doctype html><html lang="zh-CN" data-theme="day"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="./fixture.jsx"></script></body></html>');
await writeFile(path.join(src,'fixture.jsx'),`
import React from 'react';import {createRoot} from 'react-dom/client';import ${source('styles.css')};import ${source('member-editor.css')};
import {NativeSkillsSettings} from ${source('RebuiltSkillsSettings.tsx')};import {ThreadClientProvider} from ${source('camp-client.tsx')};
import {changeInterfaceLanguage} from ${source('interface-language.ts')};
const calls=[];let loseNext=false;
window.fixture={calls,loseNext:()=>loseNext=true,language:language=>changeInterfaceLanguage({setInterfaceLanguage:async value=>({interfaceLanguage:value})},language),theme:value=>document.documentElement.dataset.theme=value};
const client={platform:'win32',onEvent:()=>()=>{},request:async(method,params={})=>{
 if(method==='nativeSkills.list')return {skills:[],errors:[]};calls.push({method,params});
 const response=await fetch('/api/v1/request',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+window.uiAcceptanceToken},body:JSON.stringify({operation:method,params})});
 if(!response.ok)throw Error('HTTP '+response.status);const reply=await response.json();if(reply.error)throw Error(reply.error.message ?? 'Core request failed');
 if(method==='skillPacks.members.set' && loseNext){loseNext=false;throw Error('Injected member response loss after Core committed');}return reply.result;
}};
async function boot(){const agents=await client.request('members.list');window.fixture.agents=agents;createRoot(document.getElementById('root')).render(<ThreadClientProvider client={client}><main className="settings-content" style={{height:'100vh',padding:0}}><section className="settings-panel settings-panel-skills" style={{height:'100%',margin:0}}><NativeSkillsSettings agents={agents}/></section></main></ThreadClientProvider>);}
void boot();
`);
const formal=path.join(fixture,'formal');const dataDir=process.platform==='win32'?JSON.parse(execFileSync(oldBinary,['--prepare-windows-data-root',formal],{env,encoding:'utf8',windowsHide:true})).core:formal;
let host,browser,call,web,token,stage='build';const checks=[];
const record=(id,kind='HTTP',detail={})=>{checks.push({id,kind,status:'passed',...detail});console.log(JSON.stringify({stage:id,checks:checks.length}));};
const start=async executable=>{
 host=launchHost(executable,[...coreDataDirectoryArguments(dataDir,{homeDirectory:home}),'--skill-library-root',path.join(dataDir,'skills'),'--mcp-config-path',path.join(dataDir,'mcp.json')],{cwd:root,env,windowsHide:true});
 let timer;try{await Promise.race([host.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Isolated startup exceeded 60 seconds')),60000);})]);}finally{clearTimeout(timer);}
 web=await host.request('host.web.start',{listen:'127.0.0.1:0',uiDirectory:ui});assert(web.origin.startsWith('http://127.0.0.1:'));
 const response=await fetch(web.origin+'/api/v1/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:4,administratorToken:web.administratorToken})});assert.equal(response.status,200);token=(await response.json()).token;assert(token);
 call=async(operation,params={})=>{const response=await fetch(web.origin+'/api/v1/request',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({operation,params}),signal:AbortSignal.timeout(15000)});assert.equal(response.status,200,operation);const reply=await response.json();assert.equal(reply.error,null,JSON.stringify({operation,error:reply.error}));return reply.result;};
};
const close=async()=>{await host.close();host=undefined;};
const selected=async()=>{const rows=await call('skillPacks.members.list');return rows.find(row=>row.skillId==='brainstorming');};
const setMembers=(memberIds,expectedVersion,commandId=randomUUID())=>call('skillPacks.members.set',{commandId,command:{skillId:'brainstorming',memberIds,expectedVersion}});
const applied=result=>assert.equal(result.status,'applied',result.code);
const memberInputs='document.querySelectorAll(".skill-pack-member-list input")';
let rosterCount;
const readyChoices=()=>`!!document.querySelector('.skill-pack-member-settings') && ${memberInputs}.length===${rosterCount} && !document.querySelector('.skill-pack-member-list input')?.disabled`;
try {
 await build({root:src,configFile:false,base:'./',logLevel:'error',plugins:[react()],resolve:{alias:{'@contracts':path.join(root,'packages/contracts/src/index.ts'),'react':path.join(root,'node_modules/react'),'react-dom':path.join(root,'node_modules/react-dom')}},build:{outDir:ui,emptyOutDir:false}});
 stage='old150';await start(oldBinary);
 const originalAgents=await call('members.list');
 for(const [displayName,teamRole] of [['测试开发者','开发'],['测试设计师','设计']])applied(await call('members.create',{commandId:randomUUID(),command:{displayName,teamRole,professionalResponsibilities:'仅用于隔离验收的测试队员',personalityTraits:['谨慎'],workingPrinciples:'按客户要求执行并核查结果',growthTopic:'验证协作流程'}}));
 const agents=await call('members.list');assert.equal(agents.length,originalAgents.length+2);rosterCount=agents.length;const [firstId,secondId]=['测试开发者','测试设计师'].map(name=>agents.find(agent=>agent.displayName===name)?.agentId);assert(firstId && secondId);record('old150_preserves_default_roster_and_creates_two_real_members_without_inference','HTTP',{original:originalAgents.length,current:rosterCount});
 const catalog=await call('skillPacks.list');const installCommand={commandId:randomUUID(),command:{skillId:'brainstorming',sourceRevision:catalog.commit,expectedVersion:'absent'}};
 const installationReceipt=await call('skillPacks.install',installCommand);applied(installationReceipt);const initial=(await call('skillPacks.installations.list'))[0];const sourceBytes=await readFile(path.join(initial.contentPath,'SKILL.md'));await close();
 stage='upgrade151';await start(binary);assert.deepEqual(await call('skillPacks.install',installCommand),installationReceipt);assert.equal((await call('skillPacks.installations.list'))[0].version,initial.version);assert.deepEqual(await readFile(path.join(initial.contentPath,'SKILL.md')),sourceBytes);record('real_150_to_151_preserves_installation_files_and_first_result');
 let choice=await selected();assert(choice.installed);assert.deepEqual(choice.memberIds,[]);assert.equal(choice.memberDeliveryEnabled,false);record('upgrade_does_not_select_members_or_enable_delivery');
 const invalid=await setMembers(['missing-member'],choice.version);assert.equal(invalid.code,'skill_pack.members.member_unavailable');assert.deepEqual((await selected()).memberIds,[]);record('unknown_member_does_not_partially_write_choices');
 const firstCommandId=randomUUID();const firstReceipt=await setMembers([firstId,firstId],choice.version,firstCommandId);applied(firstReceipt);assert.deepEqual((await selected()).memberIds,[firstId]);record('explicit_member_selection_is_sorted_and_deduplicated');
 assert.equal((await setMembers([secondId],choice.version)).code,'skill_pack.members.conflict');assert.deepEqual(await setMembers([],choice.version,firstCommandId),firstReceipt);assert.deepEqual((await selected()).memberIds,[firstId]);record('stale_write_is_fenced_and_first_result_replays');
 await close();await start(binary);assert.deepEqual((await selected()).memberIds,[firstId]);assert.deepEqual(await setMembers([],choice.version,firstCommandId),firstReceipt);record('member_configuration_and_command_result_survive_Core_restart');
 choice=await selected();applied(await setMembers([],choice.version));
 stage='production_UI';const profile=path.join(dataDir,'acceptance-browser');await mkdir(profile);
 browser=await launchAcceptanceBrowser({executable:browserBinary,args:['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],env});
 await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`window.uiAcceptanceToken=${JSON.stringify(token)}`});await browser.send('Page.navigate',{url:web.origin});
 await browser.wait(`!!document.querySelector('[role="tab"]')`);await browser.click(`Array.from(document.querySelectorAll('[role="tab"]')).find(button=>button.textContent==='技能包')`);await browser.wait(readyChoices());
 await browser.click(`document.querySelector('.skill-pack-member-settings summary')`);assert.equal(await browser.evaluate(`Array.from(${memberInputs}).filter(input=>input.checked).length`),0);record('production_UI_reads_real_member_roster_and_empty_configuration','UI');
 await browser.evaluate('window.fixture.loseNext()');await browser.click(`document.querySelector('.skill-pack-member-list input[data-member-id="${firstId}"]')`);await browser.wait(`document.body.innerText.includes('Injected member response loss')`);assert.deepEqual((await selected()).memberIds,[firstId]);record('Core_commit_with_lost_UI_response_is_preserved','UI');
 await browser.click(`Array.from(document.querySelectorAll('[role="tab"]')).find(button=>button.textContent==='原生 Skills')`);await browser.click(`Array.from(document.querySelectorAll('[role="tab"]')).find(button=>button.textContent==='技能包')`);await browser.wait(`document.body.innerText.includes('Injected member response loss')`);
 await browser.click(`Array.from(document.querySelectorAll('.skill-pack-member-settings button')).find(button=>button.textContent==='重试保存')`);await browser.wait(`${readyChoices()} && document.querySelector('.skill-pack-member-list input[data-member-id="${firstId}"]').checked`);
 const commandIds=await browser.evaluate(`window.fixture.calls.filter(call=>call.method==='skillPacks.members.set').map(call=>call.params.commandId)`);assert.equal(commandIds.length,2);assert.equal(commandIds[0],commandIds[1]);record('tab_roundtrip_and_retry_keep_the_same_member_command_identity','UI');
 const search=`document.querySelector('.skill-pack-member-tools input')`;
 await browser.evaluate(`(()=>{const input=${search};const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'测试设计师');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await browser.wait(`${memberInputs}.length===1`);
 await browser.click(`Array.from(document.querySelectorAll('.skill-pack-member-tools button')).find(button=>button.textContent==='全选')`);await browser.wait(`${readyChoices().replace('==='+rosterCount,'===1')} && document.querySelector('.skill-pack-member-list input')?.checked`);assert.equal((await selected()).memberIds.length,2);
 await browser.click(`Array.from(document.querySelectorAll('.skill-pack-member-tools button')).find(button=>button.textContent==='取消全选')`);await browser.wait(`${readyChoices().replace('==='+rosterCount,'===1')} && !document.querySelector('.skill-pack-member-list input')?.checked`);assert.deepEqual((await selected()).memberIds,[firstId]);record('filtered_bulk_actions_preserve_choices_outside_the_filter','UI');
 await browser.evaluate(`(()=>{const input=${search};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await browser.wait(readyChoices());
 choice=await selected();applied(await setMembers([],choice.version));await browser.click(`document.querySelector('.skill-pack-member-list input[data-member-id="${secondId}"]')`);await browser.wait(`document.body.innerText.includes('配置或安装版本已变化') && Array.from(${memberInputs}).every(input=>!input.checked) && !document.querySelector('.skill-pack-member-list input')?.disabled`);record('stale_UI_save_refreshes_truth_without_overwriting_other_client','UI');
 await browser.click(`document.querySelector('.skill-pack-member-list input[data-member-id="${secondId}"]')`);await browser.wait(`${readyChoices()} && document.querySelector('.skill-pack-member-list input[data-member-id="${secondId}"]').checked`);assert.deepEqual((await selected()).memberIds,[secondId]);assert.equal((await selected()).memberDeliveryEnabled,false);assert(await browser.evaluate(`document.body.innerText.includes('实际投递尚未接入')`));record('saved_choices_are_not_presented_as_model_delivery','UI');
 await browser.capture(path.join(fixture,'skill-pack-members-day.png'));await browser.evaluate(`window.fixture.theme('night')`);await browser.wait(`(()=>{const probe=document.createElement('span');probe.style.backgroundColor='var(--surface)';document.body.append(probe);const expected=getComputedStyle(probe).backgroundColor;probe.remove();return getComputedStyle(document.querySelector('.skill-pack-controls .quiet-button')).backgroundColor===expected;})()`);await browser.capture(path.join(fixture,'skill-pack-members-night.png'));record('expanded_configuration_day_and_night_captured','UI');
 await browser.evaluate(`window.fixture.language('en')`);await browser.wait(`document.body.innerText.includes('Teammate selection') && document.body.innerText.includes('Runtime delivery is not connected yet')`);record('member_controls_follow_interface_language','UI');
 await browser.evaluate(`window.fixture.language('zh-CN');window.fixture.theme('day')`);await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await browser.wait(`document.querySelector('[role="tabpanel"]:not([hidden]) .rebuilt-skills-columns')?.getAttribute('data-compact')==='true'`);await browser.click(`document.querySelector('[role="tabpanel"]:not([hidden]) .rebuilt-skill-row')`);await browser.wait(`document.querySelector('[role="tabpanel"]:not([hidden]) .rebuilt-skills-detail')?.classList.contains('is-detail-visible')`);assert.equal(await browser.evaluate('document.documentElement.scrollWidth<=window.innerWidth'),true);await browser.capture(path.join(fixture,'skill-pack-members-narrow.png'));record('expanded_member_configuration_fits_narrow_detail','UI');
 await browser.send('Emulation.clearDeviceMetricsOverride',{});
 await browser.click(`Array.from(document.querySelectorAll('.skill-pack-controls button')).find(button=>button.textContent==='卸载')`);await browser.wait(`!!document.querySelector('.capability-delete-dialog')`);await browser.click(`Array.from(document.querySelectorAll('.capability-delete-dialog button')).find(button=>button.textContent==='确认卸载')`);await browser.wait(`!document.querySelector('.skill-pack-member-settings')`);assert.deepEqual((await selected()).memberIds,[]);record('UI_uninstall_atomically_clears_member_choices','UI');
 await browser.click(`Array.from(document.querySelectorAll('.skill-pack-controls button')).find(button=>button.textContent==='安装')`);await browser.wait(readyChoices());assert.deepEqual((await selected()).memberIds,[]);assert.deepEqual(await setMembers([],choice.version,firstCommandId),firstReceipt);assert.deepEqual((await selected()).memberIds,[]);record('reinstall_and_historical_member_replay_do_not_reenable_choices','HTTP');
 assert.deepEqual(browser.errors,[]);await browser.close();browser=undefined;await close();
 const db=new DatabaseSync(path.join(dataDir,'rovai.sqlite'),{readOnly:true});try{
  assert.equal(db.prepare('SELECT projection_schema_version AS n FROM rovai_data_contract').get().n,151);assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migration WHERE version=201').get().n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM agent_run').get().n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM context_manifest').get().n,0);assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0],'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}record('schema151_integrity_and_zero_Run_or_ContextManifest');
 const protectedFiles=['crates/rovai-core/src/context.rs','crates/rovai-core/src/current_input_skill.rs','crates/rovai-core/src/context_contract.rs','crates/rovai-core/src/managed_skills.rs'];const unchangedModelSources=[];
 for(const file of protectedFiles){const previous=execFileSync('git',['show','01f242ca3980ac12059102d6bc5dbb0d1cbd20d2:'+file],{cwd:root,windowsHide:true,maxBuffer:16*1024*1024});const current=await readFile(path.join(root,file));assert.deepEqual(current,previous,file);unchangedModelSources.push({file,sha256:createHash('sha256').update(current).digest('hex')});}
 const result={status:'passed',checks,fixture,dataDir,sourceCommit:catalog.commit,oldBinarySha256:createHash('sha256').update(await readFile(oldBinary)).digest('hex'),currentBinarySha256:createHash('sha256').update(await readFile(binary)).digest('hex'),scope:'real_150_to_151_HTTP_member_configuration_and_production_Skills_components',realMemberRoster:true,nativeDiscoveryFixture:true,wholeWorkbench:false,memberDelivery:false,modelInference:false,sourceDeclaredModelContextVersions:{nonBatch:28,publicBatch:33},unchangedModelSources,UIImages:['skill-pack-members-day.png','skill-pack-members-night.png','skill-pack-members-narrow.png']};await writeFile(path.join(fixture,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:'passed',checks:checks.length,evidence:path.join(fixture,'result.json')}));
}catch(error){await writeFile(path.join(fixture,'failure.json'),JSON.stringify({status:'failed',stage,checks,error:String(error),fixture},null,2)+'\n');throw error;}
finally{if(browser)await browser.close();if(host)await close();}
