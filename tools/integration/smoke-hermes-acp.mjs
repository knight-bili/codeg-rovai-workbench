import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const [packageArgument,evidenceArgument]=process.argv.slice(2);
assert(packageArgument&&evidenceArgument,'usage: smoke-hermes-acp.mjs <isolated-package-root> <evidence-root>');
const packageRoot=path.resolve(packageArgument),evidenceRoot=path.resolve(evidenceArgument);
const metadata=JSON.parse(await readFile(path.join(packageRoot,'package.json'),'utf8'));
const marker=JSON.parse(await readFile(path.join(packageRoot,'.hermes-agent-runtime.json'),'utf8'));
const commit='818c13be1dc4fd28987e1e881a9408224afd4535';
assert.equal(metadata.version,'0.21.6');assert.equal(marker.runtimeCommitAtInstall,commit);
const source=path.join(packageRoot,'runtime/hermes-agent');
assert.equal(execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),commit);
const bin=path.join(source,'venv',process.platform==='win32'?'Scripts':'bin');
const executable=path.join(bin,process.platform==='win32'?'hermes.exe':'hermes');
await mkdir(evidenceRoot,{recursive:true});
const fixture=await mkdtemp(path.join(evidenceRoot,'hermes-acp-'));
const home=path.join(fixture,'home'),workspace=path.join(fixture,'project'),nativeHome=path.join(home,'.hermes');
for(const item of [home,workspace,nativeHome,path.join(home,'AppData/Roaming'),path.join(home,'AppData/Local'),path.join(home,'.config')])await mkdir(item,{recursive:true});
await writeFile(path.join(nativeHome,'config.yaml'),'model:\n  provider: openrouter\n');
const env={};
for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','ComSpec','COMSPEC','PATHEXT','TEMP','TMP','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE','PROGRAMFILES','ProgramFiles','ProgramFiles(x86)','ProgramW6432'])if(process.env[key]!==undefined)env[key]=process.env[key];
Object.assign(env,{HOME:home,USERPROFILE:home,HERMES_HOME:nativeHome,XDG_CONFIG_HOME:path.join(home,'.config'),APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local'),VIRTUAL_ENV:path.join(source,'venv'),HERMES_NPM_BRIDGE:'1',HERMES_NPM_PACKAGE_ROOT:packageRoot,HERMES_NPM_PACKAGE_VERSION:metadata.version,HERMES_NPM_RELEASE_TAG:'v0.21.6',PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1'});
const child=spawn(executable,['acp'],{cwd:workspace,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
let stderr='',parseFailure=null,nextId=0;const pending=new Map();
const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
child.once('error',error=>{for(const value of pending.values())value.reject(error)});
child.stderr.on('data',bytes=>{stderr+=bytes.toString()});
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{if(!line.trim())return;try{const message=JSON.parse(line);if(message.id!==undefined&&pending.has(message.id)){const wait=pending.get(message.id);pending.delete(message.id);wait.resolve(message)}}catch(error){parseFailure=String(error)}});
async function rpc(method,params){const id=++nextId;let timer;try{return await Promise.race([new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${method} timed out`)),45000)})])}finally{clearTimeout(timer);pending.delete(id)}}
let result;const observations={};
try {
    const initialized=await rpc('initialize',{protocolVersion:1,clientInfo:{name:'integration-acceptance',version:'1'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});
    observations.initialize=initialized.result;
    assert.equal(initialized.error,undefined);assert.equal(initialized.result.protocolVersion,1);
    assert.equal(initialized.result.agentInfo.name,'hermes-agent');assert.equal(initialized.result.agentInfo.version,'0.21.6');
    assert.equal(initialized.result.agentCapabilities.loadSession,true);
    assert(initialized.result.authMethods.some(method=>method.id==='hermes-setup'));
    const sessionId='missing-fixture-session';
    const missing=await rpc('session/load',{sessionId,cwd:workspace,mcpServers:[]});
    observations.missingLoad=missing;
    assert.equal(missing.error,undefined);assert.deepEqual(missing.result,{},'SDK empty response must contain no restored Session metadata');
    const mode=await rpc('session/set_mode',{sessionId,modeId:'default'});
    observations.missingMode=mode;
    assert.equal(mode.error,undefined);assert.deepEqual(mode.result,{});
    const model=await rpc('session/set_model',{sessionId,modelId:'unconfigured-fixture-model'});
    observations.missingModel=model;
    assert.equal(model.error,undefined);assert.deepEqual(model.result,{});
    assert.equal(parseFailure,null);
    result={status:'passed',scope:'real_pinned_Hermes_native_initialize_and_absent_session_rejection',source:{package:metadata.name,version:metadata.version,commit,executableSha256:createHash('sha256').update(await readFile(executable)).digest('hex')},isolation:{fixture,home,workspace,credentials:'not_inherited',configuredProvider:'openrouter_without_key',core:'not_started'},checks:['fixed_runtime_commit','real_initialize_protocol_and_product','native_load_and_auth_method_declarations_only','missing_load_returns_empty_not_restored_session','native_mode_method_exists_without_creating_session','native_model_method_exists_without_creating_session','stdout_machine_JSON_only'],observations,limits:{modelInference:'not_run',successfulSession:'not_run',authenticatedModels:'not_run',streaming:'not_run',stopResume:'not_run',MCP:'not_run',Skills:'not_run',CoreQualification:'not_granted'}};
} catch(error){result={status:'failed',scope:'native_probe_no_Core_or_model',error:String(error),fixture,observations};process.exitCode=1}
finally {
    child.stdin.end();const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
    try{result.processClose=await closed}finally{clearTimeout(timer);lines.close()}
    if(result.status==='passed') {
        try {
            assert.equal(result.processClose.code,0);assert.equal(result.processClose.signal,null);
            const python=path.join(bin,process.platform==='win32'?'python.exe':'python');
            const db=path.join(nativeHome,'state.db');
            const inspected=JSON.parse(execFileSync(python,['-c',`import json,sqlite3,sys,pathlib
p=pathlib.Path(sys.argv[1]); c=sqlite3.connect(p.resolve().as_uri()+'?mode=ro',uri=True)
print(json.dumps({'sessions':c.execute('SELECT COUNT(*) FROM sessions').fetchone()[0],'integrity':c.execute('PRAGMA integrity_check').fetchone()[0]}))`,db],{env,cwd:workspace,encoding:'utf8',windowsHide:true}));
            assert.equal(inspected.sessions,0);assert.equal(inspected.integrity,'ok');
            result.observations.nativeState=inspected;
            result.checks.push('no_native_session_rows_created','normal_EOF_exit');
        } catch(error){result.status='failed';result.error=String(error);process.exitCode=1}
    }
    await writeFile(path.join(fixture,'stderr.log'),stderr);
    await writeFile(path.join(fixture,'result.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({status:result.status,checks:result.checks?.length??0,error:result.error??null,evidence:path.join(fixture,'result.json')}));
}
