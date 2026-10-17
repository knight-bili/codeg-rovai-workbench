import assert from 'node:assert/strict'
import { app, clipboard } from 'electron'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

// 只计时原生产处理器，不代替存储、不改变同步IPC或回执。
export function installNativeLoadIpc(ipcMain) {
 const on=ipcMain.on,handle=ipcMain.handle,operations=[],domainOperations=[];let registered=false,requestRegistered=false
 ipcMain.handle=function(channel,handler){
  if(channel!=='rovai:request')return handle.call(this,channel,handler)
  requestRegistered=true
  return handle.call(this,channel,async(event,method,params)=>{
   if(method!=='canvas.boards.create')return handler(event,method,params)
   const entry={commandId:params?.commandId,enteredAt:Date.now()};domainOperations.push(entry)
   const result=await handler(event,method,params);entry.coreReplyAt=Date.now();entry.status=result.value?.status??null;return result
  })
 }
 ipcMain.on=function(channel,handler){
  if(channel!=='rovai:private-input-recovery')return on.call(this,channel,handler)
  registered=true
  return on.call(this,channel,function(event,action,identity,value){
   const start=performance.now(),result=handler.call(this,event,action,identity,value)
   operations.push({at:Date.now(),action,durationMs:performance.now()-start,handlerReturnedNormally:true,bytes:action==='set'?Buffer.byteLength(JSON.stringify(value)):null})
   return result
  })
 }
 return {finishRegistration(){ipcMain.on=on;ipcMain.handle=handle;assert.ok(registered&&requestRegistered)},releaseAll(){},snapshot:()=>({operations,domainOperations})}
}
const hash=value=>createHash('sha256').update(value).digest('hex')
const stats=values=>{const s=[...values].sort((a,b)=>a-b);return {samples:s.length,p50:s[Math.max(0,Math.ceil(s.length*.5)-1)]??0,p95:s[Math.max(0,Math.ceil(s.length*.95)-1)]??0,max:s.at(-1)??0}}

export async function qualifyCanvasNativeLoad(window,{evaluate,wait,rpc,openCanvasBoard,config,report,record,seam}) {
 window.unmaximize();window.setContentSize(1440,920);window.webContents.setZoomFactor(1)
 let context
 if(config.load_phase==='prepare'){
  const member=await rpc('members.create',{commandId:randomUUID(),command:{displayName:'R08 大正文队员',teamRole:'本机正文负载',professionalResponsibilities:'不运行模型，不发送正文。',personalityTraits:['严谨'],workingPrinciples:'仅隔离测试',growthTopic:''}})
  assert.equal(member.status,'applied');const agentId=member.resultEntity.entityId
  const created=await rpc('threads.create',{commandId:randomUUID(),name:'R08 大正文输入',workspace:null,memberAgentIds:[agentId],defaultLeadAgentId:agentId,collaborationMode:'peer'});assert.equal(created.status,'applied')
  const threadId=created.payload.threadId,opened=await rpc('singleChat.open',{commandId:randomUUID(),command:{threadId,agentId}});assert.equal(opened.status,'applied')
  const conversationId=opened.payload.conversationId,board=await rpc('canvas.boards.create',{commandId:randomUUID(),command:{name:'R08 大正文与独立输入'}});assert.equal(board.status,'applied')
  const boardId=board.payload.board.id,scopes=[]
  for(let n=0;n<2;n++){
   const graph=await rpc('canvas.nodes.snapshot',{boardId}),pin=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId,expectedRevision:graph.board.revision,mutation:{type:'create',node:{kind:'conversation',title:n?'乙卡独立输入':'甲卡大正文',conversation:{threadId,conversationId},x:n*560,y:0,width:520,height:650}}}})
   assert.equal(pin.status,'applied');scopes.push({kind:'canvas',boardId,nodeId:pin.payload.nodeIds[0]})
  }
  context={agentId,threadId,conversationId,boardId,scopes}
 }else {
  const bytes=await readFile(config.load_checkpoint);assert.equal(hash(bytes),config.load_checkpoint_sha256)
  context=JSON.parse(bytes).context
 }
 report.native_load_context=context
 const frame=n=>`document.querySelector('.canvas-conversation-frame[data-canvas-conversation-key*="${context.scopes[n].nodeId}"]')`
 const input=n=>`${frame(n)}?.querySelector('.single-chat-composer textarea')`
 const open=async n=>{
  if(!await evaluate(`Boolean(${input(n)})`)){
   const button=`document.querySelector('[data-id="${context.scopes[n].nodeId}"] button[aria-label="展开对话"]')`
   await wait(`Boolean(${button}&&!${button}.disabled)`);await evaluate(`(()=>{${button}.click();return true})()`)
  }
  await wait(`Boolean(${input(n)}&&!${input(n)}.disabled&&!${input(n)}.readOnly)`)
 }
 const readInput=async n=>evaluate(`(async()=>{const text=${input(n)}.value,bytes=new TextEncoder().encode(text),digest=await crypto.subtle.digest('SHA-256',bytes);return {sha256:[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join(''),characters:text.length,bytes:bytes.length,tail:text.slice(-40)}})()`)
 const seed=async(n,text)=>{
  await evaluate(`(()=>{const input=${input(n)};input.focus();input.select();window.r08SeedEvents=[];input.addEventListener('input',event=>window.r08SeedEvents.push(event.isTrusted),{once:true});return true})()`)
  if(Buffer.byteLength(text)>1024*1024){
   const formats=clipboard.availableFormats(),supported=new Set(['text/plain','text/html','text/rtf','image/png']),saved={},buffers={}
   assert.ok(formats.every(format=>supported.has(format)),'Existing clipboard format cannot be restored safely; no mutation performed')
   if(formats.includes('text/plain'))saved.text=clipboard.readText()
   if(formats.includes('text/html'))saved.html=clipboard.readHTML()
   if(formats.includes('text/rtf'))saved.rtf=clipboard.readRTF()
   if(formats.includes('image/png'))saved.image=clipboard.readImage()
   for(const format of formats)buffers[format]=clipboard.readBuffer(format)
   const restore=()=>{clipboard.clear();if(formats.length)clipboard.write(saved);assert.deepEqual(clipboard.availableFormats().sort(),[...formats].sort());for(const format of formats)assert.ok(clipboard.readBuffer(format).equals(buffers[format]),'Original clipboard bytes must be restored');report.original_clipboard_restored=true}
   // 大文本使用用户实际粘贴入口；bulk insertText走不同的IME插入路径。超出15秒即终止本测试Renderer，先阻止迟到粘贴再恢复系统状态。
   const guard=setTimeout(()=>{report.paste_guard_triggered=true;window.webContents.forcefullyCrashRenderer();restore()},15_000)
   try{clipboard.writeText(text);window.webContents.paste();await wait(`${input(n)}.value.length===${text.length}`)}
   finally{clearTimeout(guard);restore()}
  }else{await window.webContents.insertText(text);await wait(`${input(n)}.value.length===${text.length}`)}
  assert.ok((await evaluate('window.r08SeedEvents')).includes(true))
 }
 const savedBody=async expected=>{
  const root=join(app.getPath('userData'),'private-input-recovery-v1'),found=[]
  for(const name of await readdir(root)){
   if(!name.endsWith('.json'))continue
   const path=join(root,name),bytes=await readFile(path),entry=JSON.parse(bytes)
   if(entry.value&&Object.values(entry.value).some(body=>body===expected))found.push({path,fileSha256:hash(bytes),bodySha256:hash(expected),bodyBytes:Buffer.byteLength(expected)})
  }
  assert.equal(found.length,1,'Exactly one owned native body record must contain this input')
  return found[0]
 }
 await openCanvasBoard(evaluate,wait,context.boardId);await open(0);await open(1)
 await evaluate(`(()=>{document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]').click();return true})()`);await pause(400)
 const expectedPath=join(config.workspace,'large-body-expected.txt'),other='乙卡保留自己的正文与emoji😀'
 if(config.load_phase==='prepare'){
  const large='R08 本机大正文开始\n'+('x'.repeat(79)+'\n').repeat(13108)+'R08 本机大正文末尾',keys='abcdefghijklmnop',expected=large+keys
  await seed(1,other)
  const mainGaps=[];let previous=performance.now();const heartbeat=setInterval(()=>{const now=performance.now();mainGaps.push(now-previous);previous=now},20)
  try {
   await evaluate(`(()=>{window.r08Frames=[];window.r08Inputs=[];window.r08Independent=null;window.r08LastFrame=performance.now();window.r08Measure=true;const tick=now=>{if(!window.r08Measure)return;window.r08Frames.push(now-window.r08LastFrame);window.r08LastFrame=now;requestAnimationFrame(tick)};requestAnimationFrame(tick);document.addEventListener('input',event=>{if(event.target!==${input(0)})return;window.r08Inputs.push({at:performance.timeOrigin+performance.now(),trusted:event.isTrusted,length:event.target.value.length});if(event.target.value.length>${large.length}&&window.r08Inputs.filter(row=>row.length>${large.length}).length===4&&!window.r08Independent){const commandId=crypto.randomUUID(),transaction=window.r08Independent={started:Date.now(),commandId};void window.rovai.request('canvas.boards.create',{commandId,command:{name:'R08 输入期间独立事务'}}).then(value=>{transaction.status=value.status;transaction.coreRecordedAt=Date.parse(value.recordedAt);transaction.completed=Date.now();transaction.durationMs=transaction.completed-transaction.started}).catch(error=>{transaction.error=String(error)})}});return true})()`)
   const start=performance.now();await seed(0,large);report.large_seed_ms=performance.now()-start
   const initial=await readInput(0);assert.equal(initial.sha256,hash(large));assert.ok(initial.bytes>1024*1024)
   const sent=[]
   for(let n=0;n<keys.length;n++){
    sent.push(Date.now());const keyCode=keys[n]
    window.webContents.sendInputEvent({type:'keyDown',keyCode});window.webContents.sendInputEvent({type:'char',keyCode});window.webContents.sendInputEvent({type:'keyUp',keyCode});await pause(35)
   }
   await wait(`Boolean(window.r08Independent?.completed||window.r08Independent?.error)`);await wait(`${input(0)}.value.endsWith(${JSON.stringify(keys)})`)
   await evaluate('(()=>{window.r08Measure=false;return true})()');const observed=await evaluate('({frames:window.r08Frames,inputs:window.r08Inputs,transaction:window.r08Independent})'),transaction=observed.transaction
   assert.equal(transaction.status,'applied');assert.ok(Number.isFinite(transaction.coreRecordedAt))
   const domain=seam.snapshot().domainOperations.find(row=>row.commandId===transaction.commandId);assert.equal(domain.status,'applied');transaction.mainCoreReplyAt=domain.coreReplyAt;transaction.mainCoreDurationMs=domain.coreReplyAt-domain.enteredAt
   const typed=observed.inputs.filter(row=>row.length>large.length)
   assert.equal(typed.length,keys.length);assert.ok(typed.every(row=>row.trusted))
   const latencies=typed.map((row,n)=>row.at-sent[n]);assert.ok(latencies.every(x=>x>=0))
   report.native_load_metrics={bodyBytes:Buffer.byteLength(expected),bodyCharacters:expected.length,keys:keys.length,inputEvents:typed,sentAt:sent,keyLatencyMs:stats(latencies),rendererFrameGapMs:stats(observed.frames),mainTimerGapMs:stats(mainGaps),independentTransaction:transaction,qualification:'本机约1MiB正文、16键及同场景数据；工程检查预算按键p95<250ms、主线程/帧间隔max<1000ms，不外推全部设备或正式性能SLA。'}
   assert.ok(report.native_load_metrics.keyLatencyMs.p95<250,'Observed input latency exceeded the local engineering budget')
   assert.ok(report.native_load_metrics.mainTimerGapMs.max<1000&&report.native_load_metrics.rendererFrameGapMs.max<1000,'Owned application stalled over one second')
   // 测试脚本发完输入不代表Renderer处理完输入；以真实Core回执与可信DOM事件核对交错。
   assert.ok(transaction.mainCoreReplyAt>=typed[0].at&&transaction.mainCoreReplyAt<typed.at(-1).at,'Original Main handler must receive the applied Core response during actual input handling')
   assert.equal((await readInput(0)).sha256,hash(expected));assert.equal((await readInput(1)).sha256,hash(other))
   record('actual_mebibyte_private_input_keeps_all_sixteen_trusted_keys_and_other_card_while_independent_core_transaction_completes')
   report.persisted_bodies=[await savedBody(expected),await savedBody(other)]
   assert.ok(seam.snapshot().operations.some(op=>op.action==='set'&&op.bytes>1024*1024))
   record('actual_native_synchronous_recovery_files_contain_exact_large_and_independent_bodies_before_shutdown')
   await writeFile(expectedPath,expected,{flag:'wx'})
   const checkpoint={context,expectedPath,expectedSha256:hash(expected),other,metrics:report.native_load_metrics};await writeFile(join(config.evidence,'checkpoint.json'),JSON.stringify(checkpoint,null,2)+'\n',{flag:'wx'})
  }finally{clearInterval(heartbeat);await evaluate('(()=>{window.r08Measure=false;return true})()').catch(()=>{})}
 }else {
  const checkpoint=JSON.parse(await readFile(config.load_checkpoint,'utf8')),expected=await readFile(checkpoint.expectedPath,'utf8');assert.equal(hash(expected),checkpoint.expectedSha256)
  assert.equal((await readInput(0)).sha256,hash(expected));assert.equal((await readInput(1)).sha256,hash(other))
  report.persisted_bodies=[await savedBody(expected),await savedBody(other)]
  record('fresh_app_core_restore_exact_mebibyte_body_last_native_keys_and_other_card_without_resending')
 }
 const snapshot=await rpc('singleChat.get',{conversationId:context.conversationId});assert.deepEqual(snapshot.messages,[]);assert.deepEqual(snapshot.agentRuns,[])
 record('large_private_body_checks_never_send_messages_or_start_agent_runs')
 const shot=join(config.evidence,'01-large-private-input.png');await writeFile(shot,(await window.webContents.capturePage()).toPNG());report.screenshots=[shot]
}
