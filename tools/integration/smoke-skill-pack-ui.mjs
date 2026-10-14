import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,realpath,readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import react from '@vitejs/plugin-react';
import {build} from 'vite';
import {launchHost} from '../../scripts/lib/host-test-client.mjs';
import {coreDataDirectoryArguments} from '../../scripts/lib/runtime-camp-files-root.mjs';
import {launchAcceptanceBrowser} from '../../scripts/lib/host-web-browser.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [binary,browserBinary,evidenceRoot]=process.argv.slice(2);
assert([binary,browserBinary,evidenceRoot].every(value=>value && path.isAbsolute(value)),'Provide absolute current Host, isolated browser and evidence paths');
await mkdir(evidenceRoot,{recursive:true});const fixture=await realpath(await mkdtemp(path.join(evidenceRoot,'ui-')));
const home=path.join(fixture,'fake-home'),temp=path.join(fixture,'tmp'),src=path.join(fixture,'ui-source'),ui=path.join(fixture,'ui-build');
await mkdir(home);await mkdir(temp);await mkdir(src);
const env={};for(const [key,value] of Object.entries(process.env))if(['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT'].includes(key.toUpperCase()))env[key]=value;
Object.assign(env,{HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local'),TEMP:temp,TMP:temp,ROVAI_BUNDLED_SKILLS_ROOT:path.join(root,'skills')});
await mkdir(env.APPDATA,{recursive:true});await mkdir(env.LOCALAPPDATA,{recursive:true});
const source=file=>JSON.stringify(path.join(root,'apps/desktop/src/renderer/src',file).replaceAll('\\','/'));
await writeFile(path.join(src,'index.html'),'<!doctype html><html lang="zh-CN" data-theme="day"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="./fixture.jsx"></script></body></html>');
await writeFile(path.join(src,'fixture.jsx'),`
import React from 'react';import {createRoot} from 'react-dom/client';
import ${source('styles.css')};
import {NativeSkillsSettings} from ${source('RebuiltSkillsSettings.tsx')};
import {ThreadClientProvider} from ${source('camp-client.tsx')};
import {changeInterfaceLanguage} from ${source('interface-language.ts')};
const calls=[];let loseNextResult=false;
window.fixture={calls,loseNext:()=>loseNextResult=true,language:language=>changeInterfaceLanguage({setInterfaceLanguage:async value=>({interfaceLanguage:value})},language),theme:value=>document.documentElement.dataset.theme=value};
const client={platform:'win32',onEvent:()=>()=>{},request:async(method,params={})=>{
  if(method==='nativeSkills.list')return {skills:[],errors:[]};
  calls.push({method,params});
  const response=await fetch('/api/v1/request',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+window.uiAcceptanceToken},body:JSON.stringify({operation:method,params})});
  if(!response.ok)throw Error('HTTP '+response.status);const reply=await response.json();if(reply.error)throw Error(reply.error.message ?? 'Core request failed');
  if(method==='skillPacks.install' && loseNextResult){loseNextResult=false;throw Error('Injected transport loss after Core committed');}
  return reply.result;
}};
createRoot(document.getElementById('root')).render(<ThreadClientProvider client={client}><main className="settings-content" style={{height:'100vh',padding:0}}><section className="settings-panel settings-panel-skills" style={{height:'100%',margin:0}}><NativeSkillsSettings/></section></main></ThreadClientProvider>);
`);
const formal=path.join(fixture,'formal');const dataDir=process.platform==='win32'?JSON.parse(execFileSync(binary,['--prepare-windows-data-root',formal],{env,encoding:'utf8',windowsHide:true})).core:formal;
let host,browser;const checks=[];let stage='start';
const record=(id,detail={})=>{checks.push({id,status:'passed',...detail});console.log(JSON.stringify({stage:id,passed:checks.length}));};
try {
  stage='fixture_build';await build({root:src,configFile:false,base:'./',logLevel:'error',plugins:[react()],resolve:{alias:{'@contracts':path.join(root,'packages/contracts/src/index.ts'),'react':path.join(root,'node_modules/react'),'react-dom':path.join(root,'node_modules/react-dom')}},build:{outDir:ui,emptyOutDir:false}});
  stage='real_Core_and_UI';
  host=launchHost(binary,[...coreDataDirectoryArguments(dataDir,{homeDirectory:home}),'--skill-library-root',path.join(dataDir,'skills'),'--mcp-config-path',path.join(dataDir,'mcp.json')],{cwd:root,env,windowsHide:true});let readyTimer;try{await Promise.race([host.ready,new Promise((_,reject)=>{readyTimer=setTimeout(()=>reject(Error('Isolated Core startup exceeded 60 seconds')),60000);})]);}finally{clearTimeout(readyTimer);}
  const web=await host.request('host.web.start',{listen:'127.0.0.1:0',uiDirectory:ui});assert(web.origin.startsWith('http://127.0.0.1:'));
  const login=await fetch(`${web.origin}/api/v1/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:4,administratorToken:web.administratorToken})});assert.equal(login.status,200);const token=(await login.json()).token;assert(token);
  const profile=path.join(dataDir,'acceptance-browser');await mkdir(profile);
  browser=await launchAcceptanceBrowser({executable:browserBinary,args:['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],env});
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`window.uiAcceptanceToken=${JSON.stringify(token)}`});await browser.send('Page.navigate',{url:web.origin});
  await browser.wait(`!!document.querySelector('[role="tab"]')`);record('production_Skills_component_has_source_tabs');
  assert.equal(await browser.evaluate('document.compatMode'),'CSS1Compat');assert((await browser.evaluate('getComputedStyle(document.body).fontFamily')).includes('Segoe UI'));record('fixture_uses_production_standards_mode_and_theme_typography');
  await browser.click(`Array.from(document.querySelectorAll('[role="tab"]')).find(button=>button.textContent==='技能包')`);
  await browser.wait(`!!document.querySelector('.skill-pack-controls button:not([disabled])')`);record('catalog_and_preview_load_from_real_Core');
  const installButton=`Array.from(document.querySelectorAll('.skill-pack-controls button')).find(button=>button.textContent==='安装')`;
  await browser.evaluate('window.fixture.loseNext()');await browser.click(installButton);await browser.wait(`document.body.innerText.includes('Injected transport loss')`);
  const versions=path.join(dataDir,'skill-packs/versions');assert.equal((await readdir(versions)).length,1);
  await browser.click(`Array.from(document.querySelectorAll('[role="tab"]')).find(button=>button.textContent==='原生 Skills')`);
  await browser.click(`Array.from(document.querySelectorAll('[role="tab"]')).find(button=>button.textContent==='技能包')`);
  await browser.wait(`document.body.innerText.includes('Injected transport loss')`);record('tab_roundtrip_preserves_unknown_mutation_identity');
  await browser.click(installButton);await browser.wait(`document.querySelector('.skill-pack-controls')?.textContent.includes('已安装')`);
  assert.equal((await readdir(versions)).length,1);const ids=await browser.evaluate(`window.fixture.calls.filter(call=>call.method==='skillPacks.install').map(call=>call.params.commandId)`);assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);record('unknown_transport_outcome_reuses_same_commandId');
  const removeButton=`Array.from(document.querySelectorAll('.skill-pack-controls button')).find(button=>button.textContent==='卸载')`;
  await browser.click(removeButton);await browser.wait(`!!document.querySelector('.capability-delete-dialog')`);assert.equal(await browser.evaluate('document.activeElement.textContent.trim()'),'取消');record('uninstall_confirmation_initially_focuses_Cancel');
  await browser.click(`Array.from(document.querySelectorAll('.capability-delete-dialog button')).find(button=>button.textContent==='取消')`);await browser.wait(`!document.querySelector('.capability-delete-dialog')`);assert.equal((await host.request('skillPacks.installations.list',{}))[0].status,'installed');record('cancel_uninstall_keeps_installation');
  await browser.click(removeButton);await browser.wait(`!!document.querySelector('.capability-delete-dialog')`);await browser.click(`Array.from(document.querySelectorAll('.capability-delete-dialog button')).find(button=>button.textContent==='确认卸载')`);await browser.wait(`!document.querySelector('.capability-delete-dialog') && document.querySelector('.skill-pack-controls')?.textContent.includes('未安装')`);record('confirmed_uninstall_updates_real_Core_and_UI');
  await browser.click(installButton);await browser.wait(`document.querySelector('.skill-pack-controls')?.textContent.includes('已安装')`);record('UI_can_reinstall_retained_pack');
  await browser.capture(path.join(fixture,'skill-packs-day.png'));record('day_preview_captured');
  await browser.evaluate(`window.fixture.theme('night')`);await browser.wait(`(()=>{const probe=document.createElement('span');probe.style.backgroundColor='var(--surface)';document.body.append(probe);const expected=getComputedStyle(probe).backgroundColor;probe.remove();return getComputedStyle(document.querySelector('.skill-pack-controls .quiet-button')).backgroundColor===expected;})()`);record('night_controls_finish_the_production_theme_transition');await browser.capture(path.join(fixture,'skill-packs-night.png'));record('night_preview_captured');
  await browser.evaluate(`(()=>{const select=document.querySelector('.rebuilt-runtime-bar select');select.value='office';select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);await browser.wait(`document.body.innerText.includes('此内容由 OfficeCLI 提供')`);assert.equal(await browser.evaluate(`document.querySelector('.skill-pack-controls button').disabled`),true);record('Office_external_dependency_does_not_offer_fake_install');
  await browser.evaluate(`window.fixture.language('en')`);await browser.wait(`Array.from(document.querySelectorAll('[role="tab"]')).some(button=>button.textContent==='Skill packs') && document.body.innerText.includes('OfficeCLI provides this content')`);record('English_updates_source_tabs_and_pack_copy');
  await browser.evaluate(`window.fixture.language('zh-CN')`);await browser.evaluate(`window.fixture.theme('day')`);await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  await browser.wait(`document.querySelector('[role="tabpanel"]:not([hidden]) .rebuilt-skills-columns')?.getAttribute('data-compact')==='true'`);
  await browser.click(`document.querySelector('[role="tabpanel"]:not([hidden]) .rebuilt-skill-row')`);await browser.wait(`document.querySelector('[role="tabpanel"]:not([hidden]) .rebuilt-skills-detail')?.classList.contains('is-detail-visible')`);assert.equal(await browser.evaluate('document.documentElement.scrollWidth<=window.innerWidth'),true);await browser.capture(path.join(fixture,'skill-packs-narrow.png'));record('narrow_view_opens_detail_without_horizontal_overflow');
  await browser.click(`document.querySelector('[role="tabpanel"]:not([hidden]) .rebuilt-skills-back')`);await browser.wait(`!document.querySelector('[role="tabpanel"]:not([hidden]) .rebuilt-skills-detail')?.classList.contains('is-detail-visible')`);record('narrow_view_returns_to_list');
  assert.deepEqual(browser.errors,[]);const result={status:'passed',checks,fixture,scope:'production_Skills_components_with_real_Core_package_HTTP_and_fixture_empty_native_discovery',nativeDiscoveryFixture:true,realPackageCore:true,wholeWorkbench:false,memberDelivery:false,modelInference:false,UIImages:['skill-packs-day.png','skill-packs-night.png','skill-packs-narrow.png']};
  await writeFile(path.join(fixture,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:'passed',checks:checks.length,evidence:path.join(fixture,'result.json')}));
} catch(error){await writeFile(path.join(fixture,'failure.json'),JSON.stringify({status:'failed',stage,checks,error:String(error)},null,2)+'\n');throw error;}
finally {if(browser)await browser.close();if(host)await host.close();}
