import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

// 只旁路记录原Main请求与真实Core回执；不替换通知事实、可见性或确认结果。
export function installNotificationIpc(ipcMain) {
 const original=ipcMain.handle.bind(ipcMain),calls=[]
 ipcMain.handle=(channel,handler)=>original(channel,channel==='rovai:request'?async(event,method,params)=>{
  const entry={method,params,enteredAt:Date.now()}
  if(method.startsWith('notifications.')||method.includes('reader'))calls.push(entry)
  try{const result=await handler(event,method,params);entry.returnedAt=Date.now();entry.result=result;return result}
  catch(error){entry.error=String(error);throw error}
 }:handler)
 return {finishRegistration(){ipcMain.handle=original},releaseAll(){ipcMain.handle=original},snapshot(){return {calls}}}
}

// 观察原生Observer/事件订阅的实际注册和释放，不改变回调、调度或命中结果。
function installObserverAudit() {
 const original={resize:window.ResizeObserver,mutation:window.MutationObserver,add:EventTarget.prototype.addEventListener,remove:EventTarget.prototype.removeEventListener},rows=[],listeners=[]
 const own=()=>String(new Error().stack).includes('observeCanvasNotificationVisibility')
 const wrap=Native=>class extends Native {
  constructor(callback){super(callback);this.audit=own()?{active:false}:null;if(this.audit)rows.push(this.audit)}
  observe(...args){const value=super.observe(...args);if(this.audit)this.audit.active=true;return value}
  disconnect(){super.disconnect();if(this.audit)this.audit.active=false}
 }
 window.ResizeObserver=wrap(original.resize);window.MutationObserver=wrap(original.mutation)
 const capture=options=>typeof options==='boolean'?options:Boolean(options?.capture)
 EventTarget.prototype.addEventListener=function(type,listener,options){
  const value=Reflect.apply(original.add,this,[type,listener,options])
  if(own()&&!listeners.some(row=>row.active&&row.target===this&&row.type===type&&row.listener===listener&&row.capture===capture(options)))listeners.push({target:this,type,listener,capture:capture(options),active:true})
  return value
 }
 EventTarget.prototype.removeEventListener=function(type,listener,options){
  const value=Reflect.apply(original.remove,this,[type,listener,options]);for(const row of listeners)if(row.target===this&&row.type===type&&row.listener===listener&&row.capture===capture(options))row.active=false;return value
 }
 window.r08NotificationAudit={snapshot:()=>({observers:rows.filter(row=>row.active).length,listeners:listeners.filter(row=>row.active).length,totalObservers:rows.length,totalListeners:listeners.length}),restore:()=>{window.ResizeObserver=original.resize;window.MutationObserver=original.mutation;EventTarget.prototype.addEventListener=original.add;EventTarget.prototype.removeEventListener=original.remove}}
 return window.r08NotificationAudit.snapshot()
}

export async function qualifyCanvasNotifications(window,{evaluate,wait,rpc,openCanvasBoard,config,report,record,seam}) {
 assert.equal(createHash('sha256').update(await readFile(new URL(config.runtime_configure_module))).digest('hex'),config.runtime_configure_sha256)
 const mcp=await rpc('mcp.config.get')
 assert.equal(mcp.exists,true);assert.deepEqual(mcp.servers,[]);assert.equal(mcp.permissionIssue,false);assert.ok(mcp.fileIssue==null)
 assert.equal(mcp.path.replaceAll('\\','/').toLowerCase(),config.mcp_config_path.replaceAll('\\','/').toLowerCase())
 report.fixture_mcp_native_initialization={path:mcp.path,servers:0,permissionIssue:mcp.permissionIssue,sha256:createHash('sha256').update(await readFile(config.mcp_config_path)).digest('hex')}
 const {configureProductRuntime}=await import(config.runtime_configure_module)
 const member=await rpc('members.create',{commandId:randomUUID(),command:{displayName:'R08 本机通知队员',teamRole:'通知工程验证',professionalResponsibilities:'仅本机固定ACP协议',personalityTraits:['严谨'],workingPrinciples:'不连接外部服务',growthTopic:''}})
 assert.equal(member.status,'applied');const agentId=member.resultEntity.entityId
 await configureProductRuntime(rpc,'qwen-code',[agentId])
 const board=await rpc('canvas.boards.create',{commandId:randomUUID(),command:{name:'R08 真实通知可见性'}});assert.equal(board.status,'applied');const boardId=board.payload.board.id,contexts=[]
 for(const [index,kind] of ['public','private'].entries()){
  const created=await rpc('threads.create',{commandId:randomUUID(),name:`R08 ${kind} 通知`,workspace:null,memberAgentIds:[agentId],defaultLeadAgentId:agentId,collaborationMode:'peer'});assert.equal(created.status,'applied');const threadId=created.payload.threadId
  let conversationId=null
  if(kind==='private'){const opened=await rpc('singleChat.open',{commandId:randomUUID(),command:{threadId,agentId}});assert.equal(opened.status,'applied');conversationId=opened.payload.conversationId}
  const graph=await rpc('canvas.nodes.snapshot',{boardId}),conversation={threadId,...(conversationId?{conversationId}:{})}
  const pin=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId,expectedRevision:graph.board.revision,mutation:{type:'create',node:{kind:'conversation',title:`R08 ${kind} 通知卡`,conversation,x:index*580,y:0,width:540,height:680}}}});assert.equal(pin.status,'applied')
  contexts.push({kind,threadId,conversationId,nodeId:pin.payload.nodeIds[0],x:index*580})
 }
 report.notification_context={boardId,agentId,contexts};report.notification_scenarios=[]
 const until=async predicate=>{const end=Date.now()+30_000;while(Date.now()<end){const result=await predicate();if(result)return result;await pause(100)}throw Error('Actual notification state did not reach the expected condition')}
 const frame=context=>`document.querySelector('.canvas-conversation-frame[data-canvas-conversation-key*="${context.nodeId}"]')`
 const button=(context,label)=>`document.querySelector('[data-id="${context.nodeId}"] button[aria-label="${label}"]')`
 const click=async expression=>{
  await wait(`Boolean((${expression})&&!(${expression}).disabled&&(${expression}).checkVisibility())`)
  const point=await evaluate(`(()=>{const node=(${expression});node.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(!hit||!node.contains(hit))throw Error('Actual menu/control is occluded');return {x:Math.round(x),y:Math.round(y)}})()`)
  for(const type of ['mouseMove','mouseDown','mouseUp'])window.webContents.sendInputEvent({type,...point,...(type==='mouseMove'?{}:{button:'left',clickCount:1})})
 }
 const fit=async()=>{await click(`document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]')`);await pause(450)}
 const open=async context=>{if(!await evaluate(`Boolean(${frame(context)})`))await click(button(context,'展开对话'));await wait(`Boolean(${frame(context)}?.querySelector('${context.kind==='private'?'.single-chat-composer textarea':'.structured-mention-editor'}'))`)}
 const close=async context=>{await click(button(context,'收起对话'));await wait(`!${frame(context)}`)}
 const move=async(context,x)=>{
  const graph=await rpc('canvas.nodes.snapshot',{boardId}),changed=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId,expectedRevision:graph.board.revision,mutation:{type:'update',nodeId:context.nodeId,patch:{x}}}});assert.equal(changed.status,'applied')
  await wait(`(()=>{const node=document.querySelector('.react-flow__node[data-id="${context.nodeId}"]');return node&&Math.abs(new DOMMatrix(getComputedStyle(node).transform).m41-${x})<1})()`)
 }
 const inbox=()=>rpc('notifications.inbox',{filter:'all',limit:100})
 const snapshot=context=>context.kind==='private'?rpc('singleChat.get',{conversationId:context.conversationId}):rpc('threads.open',{threadId:context.threadId,traceId:randomUUID()})
 const send=async(context,label)=>{
  const before=await snapshot(context),body=`R08 ${context.kind} ${label} ${randomUUID()}`
  const sent=context.kind==='private'?await rpc('singleChat.send',{commandId:randomUUID(),command:{threadId:context.threadId,conversationId:context.conversationId,body,draftRevision:before.draft.revision}}):await rpc('thread.messages.send',{commandId:randomUUID(),threadId:context.threadId,content:{version:2,segments:[{kind:'text',text:body}]},sourceAttachments:[],quotes:[],replyToThreadMessageId:null,execution:{taskId:null,purpose:'R08 本机通知可见性验证',completionRole:'required'}})
  assert.equal((sent.commandResult??sent).status,'accepted',JSON.stringify(sent))
  const after=await until(async()=>{const view=await snapshot(context),runs=view.agentRuns.filter(run=>!before.agentRuns.some(old=>old.id===run.id));return runs.length&&runs.every(run=>['succeeded','failed','cancelled'].includes(run.status))?{view,runs}:false})
  assert.equal(after.runs.length,1);assert.equal(after.runs[0].status,'succeeded',JSON.stringify(after.runs))
  const runId=after.runs[0].id
  const turnId=after.runs[0].threadTurnId
  const episode=await until(async()=>{const state=await inbox();return state.items.find(item=>item.thread.id===context.threadId&&(item.agentRunId===runId||item.primaryAction.agentRunId===runId||item.primaryAction.singleChat?.agentRunId===runId||turnId&&item.threadTurnId===turnId))})
  return {runId,threadTurnId:episode.threadTurnId,episodeId:episode.id,body}
 }
 const acknowledged=target=>seam.snapshot().calls.filter(call=>call.method==='notifications.acknowledgeVisibleSources'&&(call.params?.command?.visibleAgentRunIds?.includes(target.runId)||target.threadTurnId&&call.params?.command?.visibleThreadTurnIds?.includes(target.threadTurnId)))
 const stateFor=async target=>(await inbox()).items.find(item=>item.id===target.episodeId)
 const assertUnread=async(context,target,label)=>{
  const observations=[]
  for(const delay of [0,300,700,1000]){await pause(delay);const state=await stateFor(target);assert.ok(state?.unread,`${context.kind} ${label} notification was acknowledged without visible source`);assert.equal(acknowledged(target).length,0);observations.push({at:Date.now(),unread:state.unread,changeSequence:state.changeSequence})}
  return observations
 }
 const assertRead=async(context,target)=>{
  // 原Attention合同要求公屏完成通知的具体Run实际可见；仅看到公开消息不等于看过执行。
  if(context.kind==='public'&&!await evaluate(`Boolean(${frame(context)}?.querySelector('.execution-drawer')?.checkVisibility())`)){
   if(!await evaluate(`Boolean(${frame(context)}?.querySelector('.run-pulse-chip[data-agent-id="${agentId}"]')?.checkVisibility())`))await click(`Array.from(${frame(context)}.querySelectorAll('button')).find(node=>node.textContent?.trim().startsWith('执行'))`)
   await click(`${frame(context)}.querySelector('.run-pulse-chip[data-agent-id="${agentId}"]')`)
  }
  await wait(`Boolean(${frame(context)}?.querySelector('[data-agent-run-id="${target.runId}"]'))`)
  await until(async()=>{const state=await stateFor(target);return state&&!state.unread&&acknowledged(target).some(call=>call.result?.value?.status==='applied')})
 }
 const screenshot=async name=>{const path=join(config.evidence,name);await writeFile(path,(await window.webContents.capturePage()).toPNG());(report.screenshots??=[]).push(path)}
 await openCanvasBoard(evaluate,wait,boardId)
 const baseline=await evaluate(`(${installObserverAudit.toString()})()`);assert.equal(baseline.observers,0);assert.equal(baseline.listeners,0)
 try{
  for(const context of contexts)await open(context)
  await fit();await wait('document.hasFocus()&&document.visibilityState==="visible"')
  report.observers_open=await evaluate('window.r08NotificationAudit.snapshot()');assert.ok(report.observers_open.observers>0&&report.observers_open.listeners>0)
  for(const context of contexts){
   const visible=await send(context,'visible');await assertRead(context,visible)
   report.notification_scenarios.push({kind:context.kind,state:'visible',...visible,read:true});record(`actual_${context.kind}_visible_canvas_reply_is_acknowledged_by_original_core_command`)
   await click('document.querySelector(".canvas-board-title")');await click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(node=>node.textContent?.includes('编辑画板'))`);await wait('Boolean(document.querySelector(".canvas-board-dialog"))')
   const occluded=await send(context,'occluded'),hiddenSamples=await assertUnread(context,occluded,'occluded')
   if(context.kind==='private')await screenshot('01-occluded-real-notification.png')
   await click(`Array.from(document.querySelectorAll('.canvas-board-dialog button')).find(node=>node.textContent?.trim()==='取消')`);await wait('!document.querySelector(".canvas-board-dialog")');await assertRead(context,occluded)
   report.notification_scenarios.push({kind:context.kind,state:'occluded_then_uncovered',...occluded,hiddenSamples,read:true});record(`actual_${context.kind}_reply_stays_unread_under_real_dialog_then_acknowledges_when_uncovered`)
   await move(context,5000)
   await wait(`(()=>{const r=${frame(context)}.getBoundingClientRect();return r.left>=window.innerWidth||r.right<=0})()`)
   const outside=await send(context,'offviewport'),outsideSamples=await assertUnread(context,outside,'offviewport')
   await move(context,context.x);await fit();await assertRead(context,outside)
   report.notification_scenarios.push({kind:context.kind,state:'offviewport_then_returned',...outside,hiddenSamples:outsideSamples,read:true});record(`actual_${context.kind}_reply_stays_unread_outside_viewport_then_acknowledges_after_return`)
   await close(context)
   const closed=await send(context,'closed'),closedSamples=await assertUnread(context,closed,'closed')
   await open(context);await fit();await assertRead(context,closed)
   report.notification_scenarios.push({kind:context.kind,state:'closed_then_reopened',...closed,hiddenSamples:closedSamples,read:true});record(`actual_${context.kind}_closed_card_cannot_acknowledge_new_reply_and_reopen_reads_original_run`)
  }
  await screenshot('02-visible-public-private-notifications.png')
  for(const context of contexts)await close(context)
  await until(async()=>{const current=await evaluate('window.r08NotificationAudit.snapshot()');return current.observers===0&&current.listeners===0})
  report.observers_closed=await evaluate('window.r08NotificationAudit.snapshot()')
  record('all_canvas_notification_mutation_resize_observers_and_window_visual_viewport_listeners_release_after_close')
  const captured=(await readFile(config.runtime_capture,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).map(entry=>{
   const text=(entry.params?.prompt??[]).filter(part=>part.type==='text').map(part=>part.text).join('\n'),current=/\[(CURRENT_INPUT|RUN_INPUT)\]\s*([\s\S]*?)\s*\[\/\1\]/.exec(text)
   return current?JSON.parse(current[2]):null
  }).filter(Boolean)
  for(const scenario of report.notification_scenarios)assert.equal(captured.filter(input=>JSON.stringify(input).includes(scenario.body)).length,1)
  record('all_eight_reply_inputs_reach_owned_fixed_local_acp_exactly_once_without_external_model_or_database_seeding')
 }finally{report.observers_final=await evaluate('window.r08NotificationAudit.snapshot()').catch(()=>null);await evaluate('(()=>{window.r08NotificationAudit.restore();return true})()').catch(()=>{})}
}
