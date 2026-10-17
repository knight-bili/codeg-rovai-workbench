import assert from 'node:assert/strict'
import {execFileSync,spawn} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import {openSync,writeFileSync,closeSync,unlinkSync} from 'node:fs'
import {mkdir,mkdtemp,readFile,writeFile,copyFile,realpath} from 'node:fs/promises'
import {join,resolve,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {setTimeout as pause} from 'node:timers/promises'
import {DatabaseSync} from 'node:sqlite'
import {launchHost,within} from '../lib/host-test-client.mjs'
import {coreDataDirectoryArguments} from '../lib/runtime-camp-files-root.mjs'

const root=resolve(import.meta.dirname,'../..'),here=resolve(process.argv[2]),candidate=resolve(process.argv[3]),revision=process.argv[4]
assert.match(revision,/^r[1-9][0-9]*$/)
const output=join(here,'r08-actual-file-wait-'+revision),lockPath=join(here,'c06-native-run.lock'),lock=openSync(lockPath,'wx')
writeFileSync(lock,JSON.stringify({pid:process.pid,at:new Date().toISOString(),revision})+'\n');process.once('exit',()=>{closeSync(lock);unlinkSync(lockPath)})
await mkdir(output)
const sha=async p=>createHash('sha256').update(await readFile(p)).digest('hex'),load=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''))
const build=await load(join(candidate,'native-build-result.json'));assert.equal(build.exit_code,0)
assert.equal(execFileSync('git',['diff','--name-only',build.source_commit,'HEAD','--','crates','Cargo.toml','Cargo.lock'],{cwd:root,encoding:'utf8'}).trim(),'')
assert.equal(execFileSync('git',['diff','--name-only','HEAD','--','crates','Cargo.toml','Cargo.lock'],{cwd:root,encoding:'utf8'}).trim(),'')
const binary=build.binaries.find(b=>b.name==='rovai-host.exe');assert.equal(await sha(binary.path),binary.sha256)
const fixture=await realpath(await mkdtemp(join(tmpdir(),'rovai-r08-real-file-wait-')))
const prepared=JSON.parse(execFileSync(binary.path,['--prepare-windows-data-root',join(fixture,'formal')],{encoding:'utf8',windowsHide:true}))
const dataDir=prepared.core,skillLibraryRoot=join(dataDir,'managed-skill-library'),mcpConfigPath=join(dataDir,'mcp.json'),home=join(fixture,'home')
for(const p of [home,join(home,'AppData/Roaming'),join(home,'AppData/Local'),join(fixture,'tmp')])await mkdir(p,{recursive:true})
const env={};for(const k of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[k])env[k]=process.env[k]
Object.assign(env,{PATH:[dirname(process.execPath),join(process.env.SystemRoot,'System32')].join(';'),HOME:home,USERPROFILE:home,APPDATA:join(home,'AppData/Roaming'),LOCALAPPDATA:join(home,'AppData/Local'),TEMP:join(fixture,'tmp'),TMP:join(fixture,'tmp'),SHELL:process.execPath,NODE_REPL_HISTORY:''})
const helperSource=join(import.meta.dirname,'canvas-owned-oplock.ps1'),helperCopy=join(output,'owned-oplock.ps1')
await copyFile(helperSource,helperCopy);await copyFile(import.meta.filename,join(output,'driver.mjs'))
const report={status:'running',checks:[],startedAt:new Date().toISOString(),fixture,dataDir,skillLibraryRoot,mcpConfigPath,binary,coreSource:build.source_commit,externalModelCalls:0,scope:'actual Windows NTFS fixture-file open/read waits in original host.upload.observe; client wait abort/deadline retain work; actual Core waiter abort is separately proved by the original compiled integration owner, not by transport cancellation here',bindings:{helper:await sha(helperCopy),driver:await sha(join(output,'driver.mjs'))}}
const record=name=>{report.checks.push({name,passed:true});console.log(JSON.stringify({check:name,passed:true}))}
const until=async(fn,label,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await pause(25)}throw Error('Actual file wait condition timed out: '+label)}
const helpers=[],raw=[],files=[],pending=[];let host
const release=async helper=>{if(helper.child.exitCode===null&&helper.child.signalCode===null)helper.child.stdin.end('release\n');await helper.closed;assert.equal(helper.child.exitCode,0,helper.stderr);assert.equal(helper.child.signalCode,null);assert.ok(helper.stdout.includes('RELEASED'));helper.released=true}
try{
 host=launchHost(binary.path,[...coreDataDirectoryArguments(dataDir),'--skill-library-root',skillLibraryRoot,'--mcp-config-path',mcpConfigPath],{cwd:root,env,windowsHide:true});report.hostPid=host.child.pid;await within(host.ready)
 report.lastStep='create isolated member; no Runtime or MCP fallback is started'
 const member=await host.request('members.create',{commandId:randomUUID(),command:{displayName:'R08 文件等待验证',teamRole:'仅本机验证',professionalResponsibilities:'不调用模型',personalityTraits:['严谨'],workingPrinciples:'只读测试文件',growthTopic:''}});assert.equal(member.status,'applied')
 const agentId=member.resultEntity.entityId,created=await host.request('threads.create',{commandId:randomUUID(),name:'R08 真实文件等待',workspace:null,memberAgentIds:[agentId],defaultLeadAgentId:agentId,collaborationMode:'peer'});assert.equal(created.status,'applied');const threadId=created.payload.threadId
 const opened=await host.request('singleChat.open',{commandId:randomUUID(),command:{threadId,agentId}});assert.equal(opened.status,'applied');const conversationId=opened.payload.conversationId
 const before=await host.request('singleChat.get',{conversationId});report.conversationId=conversationId
 const observe=path=>host.request('host.upload.observe',{commandId:randomUUID(),threadId,expectedRevision:0,target:{kind:'single_chat',conversationId},sourcePath:path,displayName:'R08 owned source.bin',mediaType:'application/octet-stream'})
 for(let n=0;n<5;n++){const path=join(fixture,'source-'+n+'.bin');await writeFile(path,Buffer.alloc(512*1024,65+n),{flag:'wx'});files.push({path,sha256:await sha(path),bytes:512*1024})}
 report.sourcesBefore=files
 for(let n=0;n<4;n++){
  const h={stdout:'',stderr:'',released:false};h.child=spawn(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helperCopy,'-SourcePath',files[n].path,'-FixtureRoot',fixture],{windowsHide:true,stdio:['pipe','pipe','pipe'],env})
  h.child.stdout.on('data',b=>h.stdout+=b);h.child.stderr.on('data',b=>h.stderr+=b);h.closed=new Promise((res,rej)=>{h.child.once('error',rej);h.child.once('close',res)});helpers.push(h)
  await until(()=>h.stdout.includes('READY'),'owned oplock ready '+n)
  raw[n]={settled:false};pending[n]=observe(files[n].path).then(v=>{raw[n]={settled:true,value:v};return v},e=>{raw[n]={settled:true,error:e};throw e});void pending[n].catch(()=>{})
  await until(()=>h.stdout.includes('BREAK')||raw[n].settled,'Core reaches source '+n);assert.ok(h.stdout.includes('BREAK'),'Core must actually trigger OS file lock '+JSON.stringify(raw[n]));assert.equal(raw[n].settled,false)
 }
 const busy=async()=>{let error;try{await observe(files[4].path)}catch(e){error=e}assert.ok(JSON.stringify(error).includes('single_chat.source_observation_busy'),JSON.stringify(error));return error}
 report.busyBefore=await busy()
 const started=performance.now();const cheap=await host.request('canvas.boards.create',{commandId:randomUUID(),command:{name:'R08 文件等待期间的真实事务'}});assert.equal(cheap.status,'applied');report.independentCommitMs=performance.now()-started;assert.ok(raw.every(r=>!r.settled))
 record('four_real_os_blocked_source_observations_hold_exact_capacity_while_independent_database_commit_completes')
 const controller=new AbortController(),cancelled=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}))
 const waitAbort=Promise.race([pending[0],cancelled]).then(()=>({unexpected:true}),error=>({name:error.name,message:error.message}))
 controller.abort(new DOMException('Owned client stopped waiting','AbortError'));report.clientAbort=await waitAbort;assert.equal(report.clientAbort.name,'AbortError');assert.equal(raw[0].settled,false);report.busyAfterClientAbort=await busy()
 let deadline;try{await Promise.race([pending[1],pause(250).then(()=>{throw new DOMException('Owned client wait deadline','TimeoutError')})])}catch(e){deadline={name:e.name,message:e.message}}
 assert.equal(deadline?.name,'TimeoutError');report.clientDeadline=deadline;assert.equal(raw[1].settled,false);report.busyAfterClientDeadline=await busy()
 record('client_wait_abort_and_deadline_cannot_release_slots_before_actual_source_file_io_finishes')
 await release(helpers[0]);const first=await pending[0];assert.equal(first.intent.sha256,files[0].sha256);assert.equal(first.intent.byteSize,files[0].bytes)
 const reusable=await observe(files[4].path);assert.equal(reusable.intent.sha256,files[4].sha256);assert.ok(raw.slice(1).every(r=>!r.settled))
 record('only_finishing_real_source_io_releases_one_slot_and_all_other_blocked_work_keeps_its_capacity')
 for(let n=1;n<helpers.length;n++)await release(helpers[n])
 const values=await Promise.all(pending);for(let n=0;n<values.length;n++)assert.equal(values[n].intent.sha256,files[n].sha256)
 assert.equal((await observe(files[4].path)).intent.sha256,files[4].sha256)
 const after=await host.request('singleChat.get',{conversationId});assert.deepEqual(after.draft,before.draft);assert.deepEqual(after.agentRuns,[])
 for(const f of files)assert.equal(await sha(f.path),f.sha256)
 const db=new DatabaseSync(join(dataDir,'rovai.sqlite'),{readOnly:true});try{report.databaseCounts={messages:db.prepare('SELECT (SELECT COUNT(*) FROM camp_message)+(SELECT COUNT(*) FROM conversation_message) n').get().n,runs:db.prepare('SELECT COUNT(*) n FROM agent_run').get().n}}finally{db.close()}
 assert.equal(report.databaseCounts.messages,0);assert.equal(report.databaseCounts.runs,0)
 record('all_slots_reuse_after_io_release_without_draft_write_source_change_message_or_agent_run')
 report.status='passed'
}catch(e){report.status='failed';report.error=e.stack??JSON.stringify(e)}finally{
 for(const h of helpers)if(!h.released)try{await release(h)}catch(e){report.status='failed';report.cleanupError=String(e)}
 await Promise.allSettled(pending)
 if(host){await host.close({timeoutMs:25000});report.hostExit={code:host.child.exitCode,signal:host.child.signalCode};await writeFile(join(output,'host-stderr.log'),host.stderr(),{flag:'wx'});if(report.hostExit.code!==0||report.hostExit.signal!==null)report.status='failed'}
 report.helpers=helpers.map(h=>({pid:h.child.pid,code:h.child.exitCode,signal:h.child.signalCode,stdout:h.stdout,stderr:h.stderr}));report.finishedAt=new Date().toISOString();await writeFile(join(output,'result.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'})
}
console.log(JSON.stringify({status:report.status,checks:report.checks.length,output}));process.exitCode=report.status==='passed'?0:1
