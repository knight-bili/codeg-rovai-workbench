import assert from 'node:assert/strict'
import { app,ipcMain } from 'electron'
import { mkdir,readFile,writeFile,stat } from 'node:fs/promises'
import { basename,join,resolve } from 'node:path'
import { randomUUID,createHash } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'
import { execFileSync } from 'node:child_process'

const config=JSON.parse(await readFile(process.env.ROVAI_C06_NATIVE_CONFIG,'utf8'))
const report={source_commit:config.source_commit,scope:'production Main/preload/Core; direct Electron native input events',checks:[],status:'running',started_at:new Date().toISOString()}
await mkdir(config.evidence,{recursive:false})
let started=false
const privateModes=['private-roundtrip','private-queue','private-rebind','private-late-upload','private-send','private-send-boundaries','private-core-interruption','private-app-interruption']
let privateWorkflow,privateIpc
let objectWorkflow, fileWorkflow, terminalWorkflow, nativeLoadWorkflow, notificationWorkflow, sourceUiWorkflow
const record=(name,details={})=>{report.checks.push({name,passed:true,...details});console.log(JSON.stringify({check:name,passed:true}))}
async function openCanvasBoard(evaluate,wait,boardId){
 await evaluate(`(()=>{document.querySelector('button[aria-label="无限画布"]').click();return true})()`)
 await wait(`Boolean(document.querySelector('.canvas-breadcrumb-root:not(:disabled)'))`)
 await wait(`Boolean(document.querySelector('.canvas-board-title')||document.querySelector('.canvas-boards-home'))`)
 if(await evaluate(`Boolean(document.querySelector('.canvas-board-title[data-board-id="${boardId}"]'))`)){
  await wait(`Boolean(document.querySelector('.canvas-board-title[data-board-id="${boardId}"]:not(:disabled)')&&document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]'))`)
  return
 }
 await evaluate(`(()=>{document.querySelector('.canvas-breadcrumb-root').click();return true})()`)
 await wait(`Boolean(document.querySelector('.canvas-board-tile[data-board-id="${boardId}"]:not(:disabled)'))`,40_000)
 await evaluate(`(()=>{document.querySelector('.canvas-board-tile[data-board-id="${boardId}"]').click();return true})()`)
 await wait(`Boolean(document.querySelector('.canvas-board-title[data-board-id="${boardId}"]:not(:disabled)')&&document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]'))`)
}
app.on('browser-window-created',(_event,window)=>{
 if(started)return;started=true
 window.webContents.once('did-finish-load',()=>{void qualify(window)})
})
async function qualify(window){
 report.renderer_errors=[]
 window.webContents.on('console-message',(details,...legacy)=>{
  const level=details.level??legacy[0],message=details.message??legacy[1]
  if((level==='error'||typeof level==='number'&&level>=2)&&typeof message==='string')report.renderer_errors.push(message.slice(0,2000))
  if(report.renderer_errors.length>8)report.renderer_errors.shift()
 })
 const evaluate=async expression=>{
  const result=await window.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await (${expression})}}catch(error){return {ok:false,error:String(error?.stack??error?.message??JSON.stringify(error))}}})()`,true)
  if(!result.ok)throw Error(result.error)
  return result.value
 }
 const wait=async(expression,timeout=20_000)=>{const until=Date.now()+timeout;while(Date.now()<until){if(await evaluate(expression))return;await pause(100)}throw Error('Native condition timed out: '+expression)}
 const rpc=(method,params={})=>evaluate(`window.rovai.request(${JSON.stringify(method)},${JSON.stringify(params)})`)
 try{
  if(privateModes.includes(config.mode)||config.mode==='object-cold'||config.mode==='file-resources'||config.mode==='terminal-input'||config.mode==='native-load'||config.mode==='native-notifications'||config.mode==='source-ui'){
   await wait(`window.rovai?.onboarding&&window.rovai.onboarding.get().then(value=>value.status!=='uninitialized')`,60_000)
   const initial=await evaluate('window.rovai.onboarding.get()')
   if(initial.status!=='completed'){
    if(initial.step==='welcome')await evaluate('window.rovai.onboarding.completeWelcome()')
    if(['welcome','member'].includes(initial.step))await evaluate('window.rovai.onboarding.completeMemberSelection()')
    const deferred=await evaluate('window.rovai.onboarding.deferRuntimeSetup()')
    assert.equal(deferred.status,'completed');assert.equal(deferred.origin,'runtime_deferred')
    report.onboarding_preparation={before:initial.status,after:deferred.status,origin:deferred.origin,qualification:'fixture setup only; not first-use flow qualification'}
    const loaded=new Promise(resolve=>window.webContents.once('did-finish-load',resolve));window.webContents.reload();await loaded
   }
  }
  await evaluate(`(()=>{window.nativeRuntimeErrors=[];window.addEventListener('error',event=>window.nativeRuntimeErrors.push({message:event.message,stack:String(event.error?.stack??'')}));return true})()`)
  if(config.capture_resize_observers){
   report.resize_observer_scope='opt-in callback observations; no suppression or rescheduling; performance timing is diagnostic only'
   await evaluate(`(()=>{
    const Native=window.ResizeObserver,trace=[],errors=[];window.nativeResizeObservations={trace,errors};
    window.ResizeObserver=class extends Native{constructor(callback){const origin=new Error().stack;super((entries,observer)=>{
     trace.push({at:performance.now(),origin,total:entries.length,entries:entries.slice(0,8).map(entry=>({id:entry.target.getAttribute('data-id'),target:String(entry.target.className),width:entry.contentRect.width,height:entry.contentRect.height}))});
     if(trace.length>32)trace.shift();callback.call(observer,entries,observer);
    })}};
    window.addEventListener('error',event=>{if(event.message.includes('ResizeObserver')){errors.push({message:event.message,trace:trace.slice(-6)});if(errors.length>6)errors.shift()}});
    return true;
   })()`)
  }
  window.show();window.focus();window.webContents.focus()
  await wait(`window.rovai&&document.querySelector('button[aria-label="无限画布"]')?.disabled===false`,60_000)
  if(config.mode==='source-ui'){
   await sourceUiWorkflow.qualifyCanvasSourceUi(window,{evaluate,wait,rpc,openCanvasBoard,config,report,record})
   report.runtime_errors=await evaluate('window.nativeRuntimeErrors')
   report.unexpected_runtime_errors=report.runtime_errors.filter(error=>!error.message.includes('ResizeObserver loop'))
   assert.deepEqual(report.unexpected_runtime_errors,[])
   report.status='passed';return
  }
  if(config.mode==='object-cold'){
   if(config.object_phase==='prepare')await qualifyReadyDiff(window,{evaluate,wait,rpc})
   await objectWorkflow.qualifyCanvasObjectCold(window,{evaluate,wait,rpc,openCanvasBoard,config,report,record,seam:privateIpc})
   report.status='passed';return
  }
  if(config.mode==='file-resources'){
   await fileWorkflow.qualifyCanvasFileResources(window,{evaluate,wait,rpc,openCanvasBoard,config,report,record,seam:privateIpc})
   report.status='passed';return
  }
  if(privateModes.includes(config.mode)){
   const {qualifyCanvasPrivateWorkflow}=privateWorkflow
   report.scope='production Main/preload/Core with owned controlled ACP; actual private editor and complete queue input transitions; no external model'
   await qualifyCanvasPrivateWorkflow(window,{evaluate,wait,rpc,openCanvasBoard,config,report,record,seam:privateIpc})
   report.status='passed'
   return
  }
  if(config.mode==='materials'){
   report.scope='production Main/preload/Core; private composer scopes and Native byte preparation; no model'
   await qualifyMaterials({evaluate,rpc})
   report.status='passed'
   return
  }
  if(config.mode==='materials-reopen'){
   report.scope='production Main/preload/Core; cold private material recovery and authorized file reads; no model'
   await qualifyMaterialReopen({evaluate,rpc})
   report.status='passed'
   return
  }
  if(config.mode==='objects'){
   report.scope='production Main/preload/Core; exact Mission/Task/Diff/file workspace navigation; no model'
   await qualifyObjects(window,{evaluate,wait,rpc})
   report.status='passed'
   return
  }
  if(config.mode==='private-ui'){
   report.scope='production Main/preload/Core; actual scoped attachment card opens exact source in canvas; no model'
   await qualifyPrivateUi(window,{evaluate,wait,rpc})
   report.status='passed'
   return
  }
  if(config.mode==='visual'){
   report.scope='production Main/preload/Core; Codeg canvas creation and rendered visual states; no model'
   await qualifyCanvasVisual(window,{evaluate,wait,rpc})
   report.status='passed'
   return
  }
  if(config.mode==='board-list'){
   report.scope='production Main/preload/Core; actual board summaries, original list menus, delete warning and cancel; no terminal start or model'
   await qualifyBoardList(window,{evaluate,wait,rpc})
   report.status='passed'
   return
  }
  if(config.mode==='files'){
   report.scope='production Main/preload/Core; real file cards and author HTML lifecycle'
   await qualifyFiles(window,{evaluate,wait,rpc})
   report.status='passed'
   return
  }
  if(config.mode==='notes'){
   report.scope='production Main/preload/Core; real paper drag, inline note edit, revision conflict and leave guard; no model'
   await qualifyNotes(window,{evaluate,wait,rpc})
   report.status='passed'
   return
  }
  if(config.mode==='mirrors'||config.mode==='mirrors-reopen'){
   report.scope='production Main/preload/Core; same private conversation on two exact canvas pins, independent drafts and stable editors; no model'
   await qualifyMirrors(window,{evaluate,wait,rpc})
   report.status='passed'
   return
  }
  if(config.mode==='renderer-crash'){
   report.scope='production Main/preload/Core; forced isolated renderer termination followed by explicit reload; no App/Core crash or model'
   await qualifyRendererCrash(window,{evaluate,wait,rpc})
   report.status='passed'
   return
  }
  if(config.mode==='public-multi'){
   report.scope='production Main/preload/Core; three public cards across two existing Threads, native focus/input, reader listener release and 64 rendered summary cards; no model'
   await qualifyPublicMulti(window,{evaluate,wait,rpc})
   report.status='passed'
   return
  }
  if(config.mode==='ready-diff'){
   report.scope='production Main/preload/Core and real Git worktree/Diff with owned controlled ACP protocol; no external model or database seeding'
   await qualifyReadyDiff(window,{evaluate,wait,rpc})
   report.status='passed'
   return
  }
  if(config.mode==='public-cold'){
   report.scope='fresh production App/Core process; persisted public pin drafts and 64 summary nodes; explicit board/card reopening; no model'
   await qualifyPublicCold(window,{evaluate,wait,rpc})
   report.status='passed'
   return
  }
  if(config.mode==='native-notifications'){
   report.scope='production Main/preload/Core with owned fixed local ACP; actual public/private notification visibility and observer cleanup; no external model or notification database seeding'
   await notificationWorkflow.qualifyCanvasNotifications(window,{evaluate,wait,rpc,openCanvasBoard,config,report,record,seam:privateIpc})
   report.status='passed';return
  }
  if(config.mode==='native-load'){
   report.scope='production Main/preload/Core; real large private editor input, synchronous durable save and actual frame/event-loop measurements; no model'
   await nativeLoadWorkflow.qualifyCanvasNativeLoad(window,{evaluate,wait,rpc,openCanvasBoard,config,report,record,seam:privateIpc})
   report.status='passed';return
  }
  if(config.mode==='terminal-input'){
   report.scope='production Main/preload/Core; physical Windows IME, actual clipboard and terminal remount; no model'
   await terminalWorkflow.qualifyCanvasTerminalInput(window,{evaluate,wait,rpc,openCanvasBoard,config,report,record,seam:privateIpc})
   report.status='passed';return
  }
  const boards=await rpc('canvas.boards.list'),board=boards.boards.find(board=>board.name==='C06 真实桌面画布')
  assert.ok(board)
  const graph=await rpc('canvas.nodes.snapshot',{boardId:board.id}),terminal=graph.nodes.find(node=>node.data.kind==='terminal')
  assert.ok(terminal)
  const target={boardId:board.id,nodeId:terminal.id}
  await openCanvasBoard(evaluate,wait,board.id)
  await wait(`document.querySelectorAll('.react-flow__node').length===3`)
  record('production_canvas_route_and_persisted_nodes',{board_id:board.id})
  const resized=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId:board.id,expectedRevision:graph.board.revision,mutation:{type:'update',nodeId:terminal.id,patch:{width:260}}}})
  assert.equal(resized.status,'applied',JSON.stringify(resized))
  await wait(`(()=>{const toolbar=document.querySelector('.canvas-terminal-toolbar');return toolbar&&Math.abs(toolbar.offsetWidth-258)<=2&&toolbar.querySelectorAll('button').length===6})()`)
  report.terminal_toolbar=await evaluate(`(()=>{const toolbar=document.querySelector('.canvas-terminal-toolbar'),rect=toolbar.getBoundingClientRect();return {width:toolbar.offsetWidth,extraX:toolbar.scrollWidth-toolbar.clientWidth,buttons:[...toolbar.querySelectorAll('button')].map(button=>({name:button.getAttribute('aria-label'),visible:button.getBoundingClientRect().left>=rect.left&&button.getBoundingClientRect().right<=rect.right}))}})()`)
  assert.ok(report.terminal_toolbar.extraX<=1&&report.terminal_toolbar.buttons.every(button=>button.visible))
  record('minimum_width_terminal_preserves_six_visible_named_controls_without_outer_scroll')
  await wait(`(()=>{const button=[...document.querySelectorAll('.canvas-terminal button')].find(button=>(button.getAttribute('aria-label')||button.textContent.trim())==='启动终端');return button&&!button.disabled})()`,15_000)
  await evaluate(`(()=>{[...document.querySelectorAll('.canvas-terminal button')].find(button=>(button.getAttribute('aria-label')||button.textContent.trim())==='启动终端').click();return true})()`)
  await wait(`(()=>{const button=[...document.querySelectorAll('.canvas-terminal button')].find(button=>(button.getAttribute('aria-label')||button.textContent.trim())==='粘贴');return button&&!button.disabled})()`,30_000)
  window.show();window.focus();window.webContents.focus()
  await evaluate(`(()=>{window.nativeKeys=[];for(const type of ['keydown','keypress','input'])document.addEventListener(type,event=>{if(event.target?.classList?.contains('xterm-helper-textarea'))window.nativeKeys.push({type,key:event.key,trusted:event.isTrusted})},true);document.querySelector('.canvas-terminal .xterm-helper-textarea').focus();return true})()`)
  const before=await rpc('canvas.terminals.snapshot',{target})
  for(const keyCode of '2+3'){
   window.webContents.sendInputEvent({type:'keyDown',keyCode})
   window.webContents.sendInputEvent({type:'char',keyCode})
   window.webContents.sendInputEvent({type:'keyUp',keyCode})
  }
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'})
  window.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'})
  const until=Date.now()+12_000
  let after
  while(Date.now()<until){after=await rpc('canvas.terminals.snapshot',{target,afterSeq:0});const text=stripVTControlCharacters(Buffer.concat(after.chunks.map(chunk=>Buffer.from(chunk.bytesBase64,'base64'))).toString('utf8'));if(/(?:^|\r?\n)5(?:\r?\n|$)/.test(text))break;await pause(100)}
  report.native_keys=await evaluate('window.nativeKeys')
  report.input_sequence={before:before.inputSequence,after:after.inputSequence}
  report.output=stripVTControlCharacters(Buffer.concat(after.chunks.map(chunk=>Buffer.from(chunk.bytesBase64,'base64'))).toString('utf8'))
  assert.ok(after.inputSequence>before.inputSequence,JSON.stringify(report))
  assert.match(report.output,/(?:^|\r?\n)5(?:\r?\n|$)/)
  record('native_electron_keyboard_reaches_real_pty_and_calculates_five',{input_sequence:after.inputSequence})
  await wait(`Boolean(document.querySelector('.canvas-terminal .xterm-screen')?.textContent.includes('2+3'))&&[...document.querySelectorAll('.canvas-terminal .xterm-rows > div')].some(row=>row.textContent?.trim()==='5')`,8_000)
  record('real_pty_result_is_painted_in_production_terminal_reader')
  const shot=join(config.evidence,'native-output.png');await writeFile(shot,(await window.webContents.capturePage()).toPNG());report.screenshot=shot
  await evaluate(`(()=>{[...document.querySelectorAll('.canvas-terminal button')].find(button=>(button.getAttribute('aria-label')||button.textContent.trim())==='停止终端').click();return true})()`)
  await wait(`window.rovai.request('canvas.terminals.snapshot',{target:${JSON.stringify(target)}}).then(value=>value.cleanupComplete===true)`)
  record('native_terminal_stop_completes_process_cleanup')
  const finalGraph=await rpc('canvas.nodes.snapshot',{boardId:board.id})
  const restored=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId:board.id,expectedRevision:finalGraph.board.revision,mutation:{type:'update',nodeId:terminal.id,patch:{width:terminal.data.width}}}})
  assert.equal(restored.status,'applied',JSON.stringify(restored))
  report.status='passed'
 }catch(error){report.status='failed';report.error=String(error.stack??error);report.runtime_errors=await evaluate('window.nativeRuntimeErrors').catch(()=>null);report.native_keys=await evaluate('window.nativeKeys').catch(()=>null);report.dom=await evaluate('document.body.innerText.slice(-2500)').catch(()=>null);if(config.mode==='source-ui'||(report.screenshots?.length??0)<3){const path=join(config.evidence,'failure.png');await writeFile(path,(await window.webContents.capturePage()).toPNG()).then(()=>{(report.screenshots??=[]).push(path)}).catch(()=>{})}}
 finally{
  if(privateIpc){privateIpc.releaseAll();report.private_ipc=privateIpc.snapshot()}
  if(config.capture_resize_observers)report.resize_observations=await evaluate('window.nativeResizeObservations').catch(()=>null)
  if(report.status==='failed')await evaluate(`(()=>{document.querySelector('.canvas-board-dialog .app-dialog-close:not(:disabled)')?.click();return true})()`).catch(()=>{})
  if(report.status==='failed'&&config.mode==='source-ui'){
   report.fixture_editor_cleanup=await evaluate(`(()=>{const dialog=document.querySelector('.canvas-node-editor'),button=dialog?.querySelector('.app-dialog-footer .quiet-button:not(:disabled)');if(!dialog)return 'no_fixture_editor';if(!button)return 'fixture_editor_locked';button.click();return 'original_fixture_editor_cancel_requested'})()`).catch(()=> 'renderer_unavailable')
   if(report.fixture_editor_cleanup==='original_fixture_editor_cancel_requested')await wait('!document.querySelector(".canvas-node-editor")').catch(()=>{})
  }
  if(report.status==='failed'&&config.mode==='ready-diff')await evaluate(`(()=>{document.querySelector('.mission-diff-dialog button[aria-label="关闭累计文件变更"]')?.click();document.querySelector('.canvas-object-dialog .app-dialog-close')?.click();return true})()`).catch(()=>{})
  if(report.status==='failed'&&report.crash_context?.nodeIds?.[2]){
   const noteId=report.crash_context.nodeIds[2]
   report.fixture_note_cleanup=await evaluate(`(()=>{const button=document.querySelector('[data-id="${noteId}"] .canvas-note-status button:not(:disabled)');if(!button)return 'no_visible_fixture_note';button.click();return 'requested_own_note_save'})()`).catch(()=> 'renderer_unavailable')
   if(report.fixture_note_cleanup==='requested_own_note_save')await wait(`!document.querySelector('[data-id="${noteId}"] .canvas-note-status')`).catch(()=>{})
  }
  report.finished_at=new Date().toISOString();await writeFile(join(config.evidence,'result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,evidence:config.evidence}));process.exitCode=report.status==='passed'?0:1;app.quit()
 }
}
async function qualifyBoardList(window,{evaluate,wait,rpc}){
 window.unmaximize();window.setContentSize(1440,920);window.webContents.setZoomFactor(1)
 const created=await rpc('canvas.boards.create',{commandId:randomUUID(),command:{name:`C06 原列表菜单 ${config.evidence.split(/[\\/]/).at(-1)}`,description:'同事务轮廓和真实节点数量',color:'blue'}})
 assert.equal(created.status,'applied',JSON.stringify(created));const boardId=created.payload.board.id
 const seed=[{kind:'note',content:'列表轮廓不应读取这段正文',x:-100,y:0,width:320,height:260,color:'orange'},
  {kind:'note',content:'第二张纸',x:260,y:60,width:320,height:260},
  {kind:'terminal',path:config.workspace,x:620,y:0,width:480,height:300}]
 for(const node of seed){const graph=await rpc('canvas.nodes.snapshot',{boardId});const result=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId,expectedRevision:graph.board.revision,mutation:{type:'create',node}}});assert.equal(result.status,'applied',JSON.stringify(result))}
 const graph=await rpc('canvas.nodes.snapshot',{boardId}),terminal=graph.nodes.find(node=>node.data.kind==='terminal')
 report.board_list_context={boardId,nodeIds:graph.nodes.map(node=>node.id),terminalId:terminal.id,revision:graph.board.revision}
 const list=await rpc('canvas.boards.list'),summary=list.summaries.find(item=>item.boardId===boardId)
 assert.equal(summary.revision,graph.board.revision);assert.equal(summary.nodeCount,3);assert.equal(summary.terminalCount,1);assert.equal(summary.preview.length,3)
 assert.equal(summary.preview[0].kind,'terminal');assert.ok(!JSON.stringify(summary).includes(seed[0].content))
 const again=await rpc('canvas.boards.list');assert.equal(again.throughGlobalSequence,list.throughGlobalSequence)
 record('real_core_list_returns_exact_same_revision_counts_and_geometry_without_advancing_event_sequence')
 await openCanvasBoard(evaluate,wait,boardId)
 await wait(`(()=>{const ids=${JSON.stringify(graph.nodes.map(node=>node.id))};return ids.every(id=>document.querySelector('.react-flow__node[data-id="'+id+'"]'))&&!document.querySelector('.canvas-breadcrumb-root').disabled})()`)
 report.list_navigation=await evaluate(`({title:document.querySelector('.canvas-board-title')?.dataset.boardId,rootDisabled:document.querySelector('.canvas-breadcrumb-root')?.disabled,nodes:[...document.querySelectorAll('.react-flow__node')].map(node=>node.dataset.id)})`)
 await evaluate(`(()=>{document.querySelector('.canvas-breadcrumb-root').click();return true})()`)
 const tile=`.canvas-board-tile[data-board-id="${boardId}"]`
 await wait(`Boolean(document.querySelector('${tile}'))`)
 await wait(`document.querySelector('${tile}').closest('.canvas-board-item').querySelectorAll('.canvas-board-preview rect').length===3`)
 assert.ok((await evaluate(`document.querySelector('${tile}').closest('.canvas-board-item').querySelector('.canvas-board-meta').textContent`)).includes('3 个节点'))
 record('actual_board_card_draws_three_authoritative_footprints_and_exact_node_count')
 const click=async(selector,button='left')=>{const point=await evaluate(`(()=>{const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)}})()`);window.webContents.sendInputEvent({type:'mouseMove',...point});window.webContents.sendInputEvent({type:'mouseDown',...point,button,clickCount:1});window.webContents.sendInputEvent({type:'mouseUp',...point,button,clickCount:1})}
 const key=async(keyCode,modifiers=[])=>{window.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});window.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers})}
 await click(tile,'right');await wait(`Boolean(document.querySelector('.canvas-board-context-menu'))`)
 assert.deepEqual(await evaluate(`[...document.querySelectorAll('.canvas-board-context-menu [role="menuitem"]')].map(item=>item.textContent.trim())`),['打开画板','编辑画板','删除画板'])
 await key('Escape');await wait(`!document.querySelector('.canvas-board-context-menu')&&document.activeElement===document.querySelector('${tile}')`)
 record('trusted_right_click_opens_original_actions_and_escape_restores_the_exact_board_button')
 await key('F10',['shift']);await wait(`Boolean(document.querySelector('.canvas-board-context-menu'))`)
 record('trusted_shift_f10_opens_the_same_board_context_actions')
 await click('.canvas-board-context-menu [role="menuitem"]:last-child')
 await wait(`Boolean(document.querySelector('.canvas-board-dialog'))`)
 const text=await evaluate(`document.querySelector('.canvas-board-dialog').innerText`)
 assert.ok(text.includes('将删除 3 个节点。')&&text.includes('其中有 1 张终端卡；删除时会关闭仍在运行的终端。'))
 assert.equal(await evaluate(`document.querySelector('.canvas-board-dialog button[type="submit"]').disabled`),false)
 record('delete_confirmation_uses_the_exact_board_revision_node_count_and_terminal_card_warning')
 await evaluate(`Promise.all(document.querySelector('.canvas-board-dialog').getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>undefined)))`)
 await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
 await writeFile(join(config.evidence,'01-original-board-delete-warning.png'),(await window.webContents.capturePage()).toPNG())
 await evaluate(`(()=>{[...document.querySelectorAll('.canvas-board-dialog button')].find(item=>item.textContent==='取消').click();return true})()`)
 await wait(`!document.querySelector('.canvas-board-dialog')`)
 const unchanged=await rpc('canvas.nodes.snapshot',{boardId});assert.equal(unchanged.board.revision,graph.board.revision);assert.equal(unchanged.nodes.length,3)
 assert.equal((await rpc('canvas.terminals.snapshot',{target:{boardId,nodeId:terminal.id},generation:null,afterSeq:0})).exists,false)
 record('menu_and_cancel_preserve_all_nodes_and_never_start_a_terminal')
 await click(`${tile} ~ .canvas-board-menu-trigger`)
 await wait(`Boolean(document.querySelector('.canvas-card-menu [role="menuitem"]'))`)
 await evaluate(`(()=>{[...document.querySelectorAll('.canvas-card-menu [role="menuitem"]')].find(item=>item.textContent==='编辑画板').click();return true})()`)
 await wait(`document.querySelector('.canvas-board-dialog input')?.value===${JSON.stringify(created.payload.board.name)}`)
 await evaluate(`(()=>{[...document.querySelectorAll('.canvas-board-dialog button')].find(item=>item.textContent==='取消').click();return true})()`)
 await wait(`!document.querySelector('.canvas-board-dialog')`)
 record('separate_overflow_menu_keeps_edit_action_without_nested_buttons_or_a_write')
 assert.equal(await evaluate(`document.querySelectorAll('.canvas-board-item button button').length`),0)
 report.board_card_geometry=await evaluate(`(()=>{const card=document.querySelector('${tile}').closest('.canvas-board-item');const box=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {class:e.className,width:r.width,height:r.height,minHeight:s.minHeight,flex:s.flex,aspectRatio:s.aspectRatio,gridAutoRows:s.gridAutoRows}};return {grid:box(card.parentElement),card:box(card),preview:box(card.querySelector('.canvas-board-preview')),svg:box(card.querySelector('.canvas-board-preview > svg')),copy:box(card.querySelector('.canvas-board-copy')),children:[...card.querySelector('.canvas-board-copy').children].map(box)}})()`)
 report.board_list_copy_bounds=await evaluate(`(()=>{return [...document.querySelectorAll('.canvas-board-item')].map(card=>{const copy=card.querySelector('.canvas-board-copy'),s=getComputedStyle(copy),children=[...copy.children],p=copy.querySelector('p');return {boardId:card.querySelector('.canvas-board-tile').dataset.boardId,copy:copy.getBoundingClientRect().height,intrinsic:children.reduce((sum,child)=>sum+child.getBoundingClientRect().height,0)+parseFloat(s.paddingTop)+parseFloat(s.paddingBottom)+parseFloat(s.gap)*(children.length-1),descriptionLength:p?.textContent.length??0,descriptionHeight:p?.getBoundingClientRect().height??0,lineClamp:p?getComputedStyle(p).webkitLineClamp:null}})})()`)
 await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
 await writeFile(join(config.evidence,'02-real-board-list.png'),(await window.webContents.capturePage()).toPNG())
}

async function qualifyCanvasVisual(window,{evaluate,wait,rpc}){
 window.unmaximize();window.setContentSize(1440,920)
 window.webContents.setZoomFactor(1)
 await evaluate(`(()=>{document.querySelector('button[aria-label="无限画布"]').click();return true})()`)
 await wait(`Boolean(document.querySelector('.canvas-breadcrumb-root:not(:disabled)'))`)
 await evaluate(`(()=>{document.querySelector('.canvas-breadcrumb-root').click();return true})()`)
 await wait(`Boolean(document.querySelector('.canvas-boards-home .canvas-primary-button:not(:disabled)'))`)
 report.visual_states=[]
 const capture=async name=>{
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
  await pause(150)
  const metrics=await evaluate(`(()=>{const box=selector=>document.querySelector(selector)?.getBoundingClientRect().toJSON();return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},font:{family:getComputedStyle(document.body).fontFamily,rootSize:getComputedStyle(document.documentElement).fontSize},theme:document.documentElement.dataset.theme,workspace:box('.canvas-workspace'),dialog:box('.canvas-board-dialog'),canvas:box('.canvas-flow-stage'),dock:box('.canvas-toolbar'),zoom:box('.canvas-zoom-pill')}})()`)
  const path=join(config.evidence,name+'.png');await writeFile(path,(await window.webContents.capturePage()).toPNG())
  ;(report.screenshots??=[]).push(path);report.visual_states.push({state:name,path,metrics})
 }
 const before=await rpc('canvas.boards.list'),beforeIds=new Set(before.boards.map(board=>board.id))
 report.home_state=before.boards.length?'existing_boards':'no_boards'
 report.container_fit=await evaluate(`(()=>{const main=document.querySelector('.content.canvas-content'),work=document.querySelector('.canvas-workspace'),style=getComputedStyle(main),a=main.getBoundingClientRect(),b=work.getBoundingClientRect();return {padding:[style.paddingTop,style.paddingRight,style.paddingBottom,style.paddingLeft],extraScrollX:main.scrollWidth-main.clientWidth,extraScrollY:main.scrollHeight-main.clientHeight,widthGap:Math.abs(a.width-b.width),heightGap:Math.abs(a.height-b.height)}})()`)
 assert.deepEqual(report.container_fit.padding,['0px','0px','0px','0px'])
 assert.ok(report.container_fit.extraScrollX<=1&&report.container_fit.extraScrollY<=1&&report.container_fit.widthGap<=1&&report.container_fit.heightGap<=1)
 await capture('00-board-home')
 record('real_canvas_home_keeps_existing_boards_and_opens_creation',{boards:before.boards.length})
 window.setContentSize(1040,700)
 await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
 report.small_window=await evaluate(`(()=>{const main=document.querySelector('.content.canvas-content'),grid=document.querySelector('.canvas-board-grid'),list=document.querySelector('.canvas-board-scroll')??grid,last=grid.lastElementChild;list.scrollTop=list.scrollHeight;return {viewport:{width:innerWidth,height:innerHeight},scrollOwner:list.className,outerExtraX:main.scrollWidth-main.clientWidth,outerExtraY:main.scrollHeight-main.clientHeight,listExtraY:list.scrollHeight-list.clientHeight,listScrollTop:list.scrollTop,lastVisible:last.getBoundingClientRect().bottom<=list.getBoundingClientRect().bottom+1}})()`)
 assert.ok(report.small_window.outerExtraX<=1&&report.small_window.outerExtraY<=1)
 assert.ok(report.small_window.listExtraY>0&&report.small_window.listScrollTop>0&&report.small_window.lastVisible)
 record('small_window_keeps_one_real_scroll_owner_and_last_board_reachable',report.small_window)
 window.setContentSize(1440,920)
 await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
 await evaluate(`(()=>{document.querySelector('.canvas-boards-home .canvas-primary-button').click();return true})()`)
 await wait(`Boolean(document.querySelector('.canvas-board-dialog input[data-dialog-autofocus]'))`)
 await evaluate(`Promise.all(document.querySelector('.canvas-board-dialog').getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>undefined)))`)
 assert.equal(await evaluate(`document.querySelectorAll('.canvas-board-dialog .canvas-color-choice').length`),12)
 report.dialog_style=await evaluate(`(()=>{const panel=document.querySelector('.canvas-board-dialog'),input=panel.querySelector('input'),style=getComputedStyle(panel);return {width:panel.getBoundingClientRect().width,padding:style.paddingTop,radius:style.borderRadius,inputRadius:getComputedStyle(input).borderRadius}})()`)
 assert.equal(report.dialog_style.width,448);assert.equal(report.dialog_style.padding,'24px');assert.equal(report.dialog_style.radius,'28px');assert.equal(report.dialog_style.inputRadius,'999px')
 await capture('01-board-dialog')
 await evaluate(`(()=>{document.querySelector('.canvas-board-dialog .canvas-color-choice[data-color="blue"]').click();return true})()`)
 await wait(`document.querySelector('.canvas-board-dialog .canvas-color-choice[data-color="blue"]').getAttribute('aria-pressed')==='true'`)
 await evaluate(`(()=>{document.querySelector('.canvas-board-dialog .canvas-color-choice[data-color="blue"]').click();document.querySelector('.canvas-board-dialog input[data-dialog-autofocus]').focus();return true})()`)
 await wait(`document.querySelector('.canvas-board-dialog .canvas-color-choice[data-color="blue"]').getAttribute('aria-pressed')==='false'`)
 await window.webContents.insertText('test')
 await wait(`document.querySelector('.canvas-board-dialog input[data-dialog-autofocus]').value==='test'`)
 record('real_creation_form_has_twelve_swatches_and_repicking_clears_color')
 await evaluate(`(()=>{document.querySelector('.canvas-board-dialog button[type="submit"]').click();return true})()`)
 await wait(`!document.querySelector('.canvas-board-dialog')&&document.querySelector('.canvas-empty-hint h3')?.textContent==='画布还是空的'`)
 const after=await rpc('canvas.boards.list'),created=after.boards.filter(board=>!beforeIds.has(board.id))
 assert.equal(created.length,1);assert.equal(created[0].name,'test');assert.ok(!created[0].color)
 await wait(`document.querySelector('.canvas-board-title')?.dataset.boardId===${JSON.stringify(created[0].id)}`)
 const graph=await rpc('canvas.nodes.snapshot',{boardId:created[0].id});assert.equal(graph.nodes.length,0)
 report.visual_board_id=created[0].id
 await capture('02-empty-board')
 record('real_creation_persists_one_empty_board_and_displays_codeg_canvas_chrome',{board_id:created[0].id})
}
async function qualifyFiles(window,{evaluate,wait,rpc}){
 const requests=new Set(),network=[]
 window.webContents.debugger.attach('1.3')
 window.webContents.debugger.on('message',(_event,method,params)=>{
  if(method==='Network.requestWillBeSent'){
   let url;try{url=new URL(params.request.url)}catch{return}
   if(!url.hostname.startsWith('preview-')||!url.hostname.endsWith('.localhost'))return
   requests.add(params.requestId)
   network.push({method,path:url.pathname.replace(/(\/start\/)[^/]+/,'$1<local-capability>'),redirect_status:params.redirectResponse?.status})
  }else if(requests.has(params.requestId)&&method==='Network.responseReceived')network.push({method,status:params.response.status})
  else if(requests.has(params.requestId)&&method==='Network.responseReceivedExtraInfo')network.push({method,status:params.statusCode,blocked_cookie_reasons:params.blockedCookies?.map(cookie=>cookie.blockedReasons)})
  else if(requests.has(params.requestId)&&method==='Network.loadingFailed')network.push({method,error:params.errorText,blocked_reason:params.blockedReason})
 })
 report.preview_network=network
 await window.webContents.debugger.sendCommand('Network.enable')
 const created=await rpc('canvas.boards.create',{commandId:randomUUID(),command:{name:'C06 文件与 HTML'}})
 assert.equal(created.status,'applied',JSON.stringify(created))
 const boardId=created.payload.board.id,nodeIds=[]
 for(const [index,path] of [config.text_file,config.html_file].entries()){
  const graph=await rpc('canvas.nodes.snapshot',{boardId})
  const applied=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId,expectedRevision:graph.board.revision,mutation:{type:'create',node:{kind:'file',path,fileReference:{threadId:config.thread_id},x:index*560,y:0,width:520,height:520}}}})
  assert.equal(applied.status,'applied',JSON.stringify(applied));nodeIds.push(applied.payload.nodeIds[0])
 }
 report.board_id=boardId;report.node_ids=nodeIds
 await openCanvasBoard(evaluate,wait,boardId)
 await wait(`document.querySelectorAll('.react-flow__node').length===2`)
 await evaluate(`(()=>{document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]').click();return true})()`)
 const textCard=`document.querySelector('[data-id="${nodeIds[0]}"] .canvas-card')`
 const htmlCard=`document.querySelector('[data-id="${nodeIds[1]}"] .canvas-card')`
 await wait(`${textCard}?.textContent.includes('C06 真实文件权限')`,25_000)
 record('actual_canvas_text_card_preserves_unicode_and_literal_hash_file_name')
 await wait(`Boolean(${htmlCard}?.querySelector('iframe.file-preview-html')?.src)`,25_000)
 const entryUrl=await evaluate(`${htmlCard}.querySelector('iframe.file-preview-html').src`)
 report.html_entry_url=entryUrl
 const origin=new URL(entryUrl).origin
 let frame,initial
 const deadline=Date.now()+20_000
 const probe=randomUUID()
 while(Date.now()<deadline){
  const candidates=window.webContents.mainFrame.framesInSubtree.filter(item=>{try{return new URL(item.url).origin===origin}catch{return false}})
  for(const item of candidates)await item.executeJavaScript(`(()=>{if(window.__c06ProbeHandler)removeEventListener('message',window.__c06ProbeHandler);window.__c06ProbeHandler=event=>{if(event.source===parent&&event.data?.c06FrameProbe===${JSON.stringify(probe)})window.__c06FrameProbe=${JSON.stringify(probe)}};addEventListener('message',window.__c06ProbeHandler);return true})()`).catch(()=>{})
  await evaluate(`(()=>{${htmlCard}.querySelector('iframe.file-preview-html').contentWindow.postMessage({c06FrameProbe:${JSON.stringify(probe)}},${JSON.stringify(origin)});return true})()`)
  await pause(100)
  for(const item of candidates)if(await item.executeJavaScript(`window.__c06FrameProbe===${JSON.stringify(probe)}`).catch(()=>false))frame=item
  if(frame){initial=await frame.executeJavaScript(`({title:document.title,ready:document.readyState,counter:document.querySelector('#counter')?.textContent,color:document.querySelector('#counter')?getComputedStyle(document.querySelector('#counter')).color:null,bridge:typeof window.rovai,node:typeof window.require,csp:document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content})`).catch(()=>null);if(initial?.ready==='complete'&&(initial?.color==='rgb(23, 101, 155)'||initial?.title==='无法加载页面'))break}
  await pause(100)
 }
 for(const item of window.webContents.mainFrame.framesInSubtree.filter(item=>{try{return new URL(item.url).origin===origin}catch{return false}}))await item.executeJavaScript(`(()=>{removeEventListener('message',window.__c06ProbeHandler);delete window.__c06ProbeHandler;delete window.__c06FrameProbe;return true})()`).catch(()=>{})
 report.frame_urls=window.webContents.mainFrame.framesInSubtree.map(item=>item.url)
 report.frame_details=await Promise.all(window.webContents.mainFrame.framesInSubtree.filter(item=>{try{return new URL(item.url).origin===origin}catch{return false}}).map(async item=>({name:item.name,id:item.frameTreeNodeId,document:await item.executeJavaScript(`({name:window.name,title:document.title,ready:document.readyState,counter:document.querySelector('#counter')?.textContent,color:document.querySelector('#counter')?getComputedStyle(document.querySelector('#counter')).color:null})`).catch(error=>String(error))})))
 report.iframe_presentations=await evaluate(`[...document.querySelectorAll('iframe.file-preview-html')].map(frame=>({name:frame.name,inCard:Boolean(frame.closest('.canvas-file-preview')),hidden:frame.hidden,width:frame.getBoundingClientRect().width,height:frame.getBoundingClientRect().height}))`)
 report.preview_cookies=(await window.webContents.session.cookies.get({url:entryUrl})).map(cookie=>({name:cookie.name,secure:cookie.secure,httpOnly:cookie.httpOnly,sameSite:cookie.sameSite}))
 report.html_initial=initial
 assert.equal(initial?.title,'C06 HTML 保留作者页面',JSON.stringify(initial))
 assert.equal(initial.counter,'0');assert.equal(initial.color,'rgb(23, 101, 155)')
 assert.equal(initial.bridge,'undefined');assert.equal(initial.node,'undefined')
 assert.equal(initial.csp,config.author_csp)
 report.html_initial=initial
 record('actual_html_card_loads_author_css_js_and_keeps_csp_without_native_bridge')
 const documentId=frame.frameTreeNodeId
 await frame.executeJavaScript(`(()=>{document.querySelector('#increment').click();return true})()`)
 assert.equal(await frame.executeJavaScript(`document.querySelector('#counter').textContent`),'1')
 record('author_html_interaction_executes_in_actual_preview')
 const capture=async name=>{const path=join(config.evidence,name+'.png');await writeFile(path,(await window.webContents.capturePage()).toPNG());(report.screenshots??=[]).push(path)}
 await capture('01-text-and-interactive-html')
 report.host_html_state=await evaluate(`({...${htmlCard}.querySelector('.file-preview-html-stage').dataset})`)
 await wait(`${htmlCard}.querySelector('.file-preview-html-stage')?.dataset.documentState==='loaded'&&${htmlCard}.querySelector('.file-preview-html-stage')?.dataset.channelState==='connected'`,15_000)
 record('author_document_has_confirmed_loaded_state_and_connected_host_channel')
 report.card_layout=await evaluate(`(()=>{const card=${htmlCard},header=card.querySelector('.canvas-card-handle').getBoundingClientRect(),icon=card.querySelector('.canvas-card-handle > .resource-reference-icon').getBoundingClientRect();return {pathRows:card.querySelectorAll('.file-preview-path-row').length,exposedPaths:card.querySelectorAll('.canvas-file-path').length,headerActions:Boolean(card.querySelector('.canvas-card-handle .canvas-file-actions button')),title:card.querySelector('.canvas-card-handle strong').title,headerHeight:header.height,iconCenterDelta:Math.abs(icon.y+icon.height/2-header.y-header.height/2)}})()`)
 assert.equal(report.card_layout.pathRows,0);assert.equal(report.card_layout.exposedPaths,0)
 assert.equal(report.card_layout.headerActions,true);assert.ok(report.card_layout.title.includes(config.html_file))
 assert.ok(report.card_layout.iconCenterDelta<=1,JSON.stringify(report.card_layout))
 record('file_card_uses_one_header_and_keeps_exact_path_available_on_hover')
 await evaluate(`(()=>{${htmlCard}.querySelector('.canvas-file-actions button[aria-label="显示源码"]').click();return true})()`)
 await wait(`${htmlCard}.querySelector('iframe.file-preview-html').hidden===true`)
 assert.equal(frame.frameTreeNodeId,documentId)
 assert.equal(await frame.executeJavaScript(`document.querySelector('#counter').textContent`),'1')
 await evaluate(`(()=>{${htmlCard}.querySelector('.canvas-file-actions button[aria-label="显示预览"]').click();return true})()`)
 await wait(`${htmlCard}.querySelector('iframe.file-preview-html').hidden===false`)
 const currentFrame=window.webContents.mainFrame.framesInSubtree.find(item=>item.frameTreeNodeId===documentId)
 assert.equal(currentFrame?.frameTreeNodeId,documentId)
 assert.equal(await currentFrame.executeJavaScript(`document.querySelector('#counter').textContent`),'1')
 assert.equal(await evaluate(`${htmlCard}.querySelector('.file-preview-html-stage').dataset.documentState`),'loaded')
 assert.equal(await evaluate(`${htmlCard}.querySelector('.file-preview-html-stage').dataset.channelState`),'connected')
 record('html_source_preview_toggle_preserves_live_document_and_author_state')
 const original=await readFile(config.text_file,'utf8')
 try{
  await writeFile(config.text_file,'C06 文件已更新，另一张 HTML 卡片保持状态。\n')
  await wait(`(()=>{const button=${textCard}.querySelector('.canvas-file-actions button[aria-label="重新读取"]');return button&&!button.disabled})()`)
  await evaluate(`(()=>{${textCard}.querySelector('.canvas-file-actions button[aria-label="重新读取"]').click();return true})()`)
  await wait(`${textCard}.textContent.includes('C06 文件已更新')`,15_000)
  assert.equal(await currentFrame.executeJavaScript(`document.querySelector('#counter').textContent`),'1')
  assert.equal(await evaluate(`${htmlCard}.querySelector('.file-preview-html-stage').dataset.documentState`),'loaded')
  assert.equal(await evaluate(`${htmlCard}.querySelector('.file-preview-html-stage').dataset.channelState`),'connected')
  record('reloading_one_actual_file_card_preserves_other_html_document')
  await capture('02-updated-text-and-retained-html')
 }finally{await writeFile(config.text_file,original)}
 await evaluate(`(()=>{${textCard}.querySelector('button[aria-label="文件节点操作"]').focus();return true})()`)
 window.webContents.sendInputEvent({type:'keyDown',keyCode:'Down'})
 window.webContents.sendInputEvent({type:'keyUp',keyCode:'Down'})
 await wait(`document.querySelectorAll('.canvas-card-menu [role="menuitem"]').length===2`)
 record('file_card_more_menu_is_reachable_with_native_keyboard')
 await evaluate(`(()=>{[...document.querySelectorAll('.canvas-card-menu [role="menuitem"]')].find(item=>item.textContent==='移除文件节点').click();return true})()`)
 await wait(`Boolean(document.querySelector('[role="dialog"] .danger-button'))`)
 await evaluate(`(()=>{document.querySelector('[role="dialog"] .danger-button').click();return true})()`)
 await wait(`!document.querySelector('[data-id="${nodeIds[0]}"]')&&Boolean(${htmlCard})`)
 assert.equal(await currentFrame.executeJavaScript(`document.querySelector('#counter').textContent`),'1')
 assert.equal(await readFile(config.text_file,'utf8'),original)
 assert.ok(!(await rpc('canvas.nodes.snapshot',{boardId})).nodes.some(node=>node.id===nodeIds[0]))
 record('core_node_deletion_removes_only_pin_and_preserves_file_and_other_html_view')
}
async function qualifyMaterials({evaluate,rpc}){
 const threadId=config.thread_id
 const opened=await rpc('singleChat.open',{commandId:randomUUID(),command:{threadId,agentId:config.agent_id}})
 assert.equal(opened.status,'applied',JSON.stringify(opened))
 const conversationId=opened.payload.conversationId
 assert.equal(typeof conversationId,'string')
 const board=await rpc('canvas.boards.create',{commandId:randomUUID(),command:{name:'C06 私聊材料隔离'}})
 assert.equal(board.status,'applied',JSON.stringify(board))
 const boardId=board.payload.board.id,scopes=[]
 for(let index=0;index<3;index++){
  const graph=await rpc('canvas.nodes.snapshot',{boardId})
  const created=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId,expectedRevision:graph.board.revision,mutation:{type:'create',node:{kind:'conversation',conversation:{threadId,conversationId},x:index*400,y:0,width:360,height:300}}}})
  assert.equal(created.status,'applied',JSON.stringify(created))
  scopes.push({kind:'canvas',boardId,nodeId:created.payload.nodeIds[0]})
 }
 report.private_context={thread_id:threadId,conversation_id:conversationId,board_id:boardId,scopes}
 const get=scope=>rpc('singleChat.get',{conversationId,composerScope:scope})
 const mutation=(scope,revision,action,commandId=randomUUID())=>({commandId,command:{threadId,conversationId,composerScope:scope,expectedDraftRevision:revision,action}})
 const mutate=async(scope,revision,action)=>rpc('singleChat.composerDraft.mutate',mutation(scope,revision,action))
 const names=draft=>draft.attachments.map(item=>item.displayName)
 const reject=async(method,params)=>{
  let response
  try{response=await rpc(method,params)}catch(error){return {rejected:true,error:String(error).slice(0,800)}}
  assert.equal(response.status,'rejected',JSON.stringify(response))
  return {rejected:true,result:response}
 }
 assert.equal((await get(scopes[2])).draft.revision,0)
 const readonly=await rpc('singleChat.composerDraft.recovery',{threadId,conversationId})
 assert.ok(!readonly.items.some(item=>item.kind==='scope'&&item.scope.composerScope?.nodeId===scopes[2].nodeId))
 record('readonly_empty_scope_does_not_register_a_recovery_scope')
 for(const scope of scopes.slice(0,2))assert.equal((await mutate(scope,0,{type:'register_scope'})).status,'applied')
 const bogus={kind:'canvas',boardId,nodeId:randomUUID()}
 report.invalid_scope=bogus
 report.invalid_scope_rejection=await reject('singleChat.composerDraft.mutate',mutation(bogus,0,{type:'register_scope'}))
 record('forged_node_scope_cannot_register_private_materials')
 const prepare=async(scope,name,text)=>{
  const current=await get(scope),request={commandId:randomUUID(),threadId,expectedRevision:current.draft.revision,target:{kind:'single_chat',conversationId,composerScope:scope}}
  const prepared=await evaluate(`window.rovai.singleChatAttachments.prepareInput(${JSON.stringify(request)},new File([${JSON.stringify(text)}],${JSON.stringify(name)},{type:'text/plain'}))`)
  assert.equal(prepared.state,'recorded',JSON.stringify(prepared));assert.equal(prepared.receipt.status,'applied',JSON.stringify(prepared))
  const reconciled=await evaluate(`window.rovai.singleChatAttachments.reconcileInput(${JSON.stringify(request)})`)
  assert.deepEqual(reconciled,prepared)
  report.preparations??=[];report.preparations.push({request,result:prepared})
  return get(scope)
 }
 let alpha=await prepare(scopes[0],'甲材料一 #中文.txt','甲卡第一份专用材料')
 alpha=await prepare(scopes[0],'甲材料二.txt','甲卡第二份专用材料')
 const beta=await prepare(scopes[1],'乙材料.txt','乙卡专用材料')
 assert.deepEqual(names(alpha.draft),['甲材料一 #中文.txt','甲材料二.txt'])
 assert.deepEqual(names(beta.draft),['乙材料.txt'])
 assert.deepEqual(names((await get(null)).draft),[])
 record('native_byte_uploads_and_receipt_lookup_keep_two_cards_and_default_draft_isolated')
 report.cross_scope_remove=await reject('singleChat.composerDraft.mutate',mutation(scopes[0],alpha.draft.revision,{type:'remove_attachment',attachmentRefId:beta.draft.attachments[0].id}))
 assert.deepEqual((await get(scopes[0])).draft,alpha.draft)
 assert.deepEqual((await get(scopes[1])).draft,beta.draft)
 record('cross_scope_remove_is_rejected_without_mutating_either_draft')
 const ids=alpha.draft.attachments.map(item=>item.id)
 const concurrent=await Promise.all([rpc('singleChat.composerDraft.mutate',mutation(scopes[0],alpha.draft.revision,{type:'reorder_attachments',attachmentRefIds:[...ids].reverse()})),rpc('singleChat.composerDraft.mutate',mutation(scopes[0],alpha.draft.revision,{type:'reorder_attachments',attachmentRefIds:ids}))])
 assert.equal(concurrent.filter(x=>x.status==='applied').length,1)
 assert.equal(concurrent.filter(x=>x.status==='rejected').length,1)
 assert.deepEqual((await get(scopes[1])).draft,beta.draft)
 record('concurrent_same_revision_mutations_apply_once_and_leave_other_card_unchanged')
 const legacy=await prepare(null,'原工作区材料.txt','原默认位置待迁入材料')
 alpha=await get(scopes[0])
 const adopted=await mutate(scopes[0],alpha.draft.revision,{type:'adopt_legacy_materials',expectedSourceRevision:legacy.draft.revision,targetBody:'甲卡原有问题正文'})
 assert.equal(adopted.status,'applied',JSON.stringify(adopted))
 assert.deepEqual(names((await get(scopes[0])).draft),names(alpha.draft))
 assert.deepEqual(names((await get(null)).draft),[])
 const recovery=await rpc('singleChat.composerDraft.recovery',{threadId,conversationId})
 const targetScopeKey=(await get(scopes[0])).draft.scopeKey
 const retained=recovery.items.find(item=>item.kind==='retained'&&item.input.scopeKey===targetScopeKey)
 assert.ok(retained,JSON.stringify(recovery))
 assert.deepEqual(names(retained.input),['原工作区材料.txt'])
 record('legacy_materials_move_to_a_complete_retained_input_when_target_is_occupied')
 alpha=await get(scopes[0])
 const swap=mutation(scopes[0],alpha.draft.revision,{type:'swap_retained',retainedInputId:retained.input.id,expectedRetainedRevision:retained.input.revision,currentBody:'甲卡原有问题正文'})
 const first=await rpc('singleChat.composerDraft.mutate',swap)
 assert.equal(first.status,'applied',JSON.stringify(first))
 const replay=await rpc('singleChat.composerDraft.mutate',swap)
 assert.deepEqual(replay,first)
 assert.deepEqual(names((await get(scopes[0])).draft),['原工作区材料.txt'])
 assert.deepEqual((await get(scopes[1])).draft,beta.draft)
 record('retained_swap_replay_preserves_original_receipt_and_other_card_materials')
 const graph=await rpc('canvas.nodes.snapshot',{boardId})
 const removed=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId,expectedRevision:graph.board.revision,mutation:{type:'delete',nodeIds:[scopes[0].nodeId]}}})
 assert.equal(removed.status,'applied',JSON.stringify(removed))
 const orphan=await rpc('singleChat.composerDraft.recovery',{threadId,conversationId})
 assert.ok(orphan.items.some(item=>item.kind==='scope'&&item.scope.composerScope?.nodeId===scopes[0].nodeId&&item.scope.orphaned))
 assert.deepEqual(names((await get(scopes[0])).draft),['原工作区材料.txt'])
 report.final_recovery=orphan
 record('deleted_pin_keeps_private_materials_recoverable_under_original_conversation')
}
async function qualifyMaterialReopen({evaluate,rpc}){
 const previous=JSON.parse(await readFile(config.previous_result,'utf8'))
 assert.equal(previous.status,'passed')
 const {thread_id:threadId,conversation_id:conversationId,scopes}=previous.private_context
 const recovery=await rpc('singleChat.composerDraft.recovery',{threadId,conversationId})
 assert.deepEqual(recovery.items,previous.final_recovery.items)
 record('cold_reopen_preserves_complete_private_material_and_orphan_recovery_entries')
 const alpha=await rpc('singleChat.get',{conversationId,composerScope:scopes[0]})
 const beta=await rpc('singleChat.get',{conversationId,composerScope:scopes[1]})
 assert.deepEqual(alpha.draft.attachments.map(x=>x.displayName),['原工作区材料.txt'])
 assert.deepEqual(beta.draft.attachments.map(x=>x.displayName),['乙材料.txt'])
 assert.deepEqual(alpha.agentRuns,[]);assert.deepEqual(alpha.messages,[])
 for(const prepared of previous.preparations){
  const receipt=await evaluate(`window.rovai.singleChatAttachments.reconcileInput(${JSON.stringify(prepared.request)})`)
  assert.deepEqual(receipt,prepared.result)
 }
 record('native_preparation_receipts_survive_process_restart_without_rebinding_or_execution')
 await evaluate(`window.rovai.filePreview.bindThread(${JSON.stringify(threadId)})`)
 const preview=async(locator,expected)=>{
  const opened=await evaluate(`window.rovai.filePreview.restore(${JSON.stringify({kind:'attachment',threadId,locator})})`)
  assert.equal(opened.ok,true,JSON.stringify(opened));assert.equal(opened.value.kind,'file_preview')
  const file=opened.value.file
  const read=await evaluate(`window.rovai.filePreview.readText(${JSON.stringify({handleId:file.handleId,expectedGeneration:file.contentGeneration})})`)
  assert.equal(read.ok,true,JSON.stringify(read));assert.equal(read.value.text,expected)
  await evaluate(`window.rovai.filePreview.release(${JSON.stringify({handleId:file.handleId})})`)
  return {kind:file.kind,fileName:file.fileName}
 }
 report.orphan_file=await preview({owner:'single_chat_scoped_composer',threadId,conversationId,composerScope:scopes[0],attachmentRefId:alpha.draft.attachments[0].id},'原默认位置待迁入材料')
 report.beta_file=await preview({owner:'single_chat_scoped_composer',threadId,conversationId,composerScope:scopes[1],attachmentRefId:beta.draft.attachments[0].id},'乙卡专用材料')
 record('production_file_reader_resolves_exact_card_owner_after_cold_reopen')
 const retained=recovery.items.find(x=>x.kind==='retained'&&x.input.scopeKey===alpha.draft.scopeKey)
 assert.ok(retained);assert.equal(retained.input.body,'甲卡原有问题正文')
 const expected={'甲材料一 #中文.txt':'甲卡第一份专用材料','甲材料二.txt':'甲卡第二份专用材料'}
 for(const attachment of retained.input.attachments)await preview({owner:'single_chat_retained',threadId,conversationId,composerScope:scopes[0],retainedInputId:retained.input.id,attachmentRefId:attachment.id},expected[attachment.displayName])
 assert.equal(retained.input.attachments.length,2)
 record('retained_input_keeps_original_body_and_each_authorized_attachment_content')
 const crossed=await evaluate(`window.rovai.filePreview.restore(${JSON.stringify({kind:'attachment',threadId,locator:{owner:'single_chat_scoped_composer',threadId,conversationId,composerScope:scopes[0],attachmentRefId:beta.draft.attachments[0].id}})})`)
 assert.equal(crossed.ok,false,JSON.stringify(crossed));report.crossed_file=crossed
 record('production_file_reader_rejects_attachment_from_a_different_card')
 assert.deepEqual((await rpc('singleChat.composerDraft.recovery',{threadId,conversationId})).items,recovery.items)
 report.private_context=previous.private_context
}
async function qualifyObjects(window,{evaluate,wait,rpc}){
 const mission=await rpc('missions.create',{commandId:randomUUID(),command:{title:'C06 原使命定位',description:'只保存使命，不启动模型。',projectBindingKind:'directory',projectPath:config.workspace,memberAgentIds:[config.agent_id],defaultLeadAgentId:config.agent_id,tags:[]}})
 assert.equal(mission.status,'applied',JSON.stringify(mission))
 const {missionId,threadId}=mission.payload
 assert.ok(missionId&&threadId,JSON.stringify(mission))
 const task=await rpc('tasks.create',{commandId:randomUUID(),threadId,title:'C06 原历史任务定位',description:'通过原对象卡片恢复这条已取消任务。',assigneeAgentId:config.agent_id})
 assert.equal(task.status,'applied',JSON.stringify(task))
 const taskId=task.payload.taskId
 assert.ok(taskId,JSON.stringify(task))
 const ended=await rpc('tasks.update',{commandId:randomUUID(),threadId,taskId,status:'cancelled',cancelReason:'本地历史任务定位检查'})
 assert.equal(ended.status,'applied',JSON.stringify(ended))
 const created=await rpc('canvas.boards.create',{commandId:randomUUID(),command:{name:'C06 原对象与工作区'}})
 assert.equal(created.status,'applied',JSON.stringify(created))
 const boardId=created.payload.board.id,nodes={}
 let toolbarChecked=false
 for(const [index,[kind,objectReference]] of [['mission',{kind:'mission',missionId}],['task',{kind:'task',taskId}],['mission_diff',{kind:'mission_diff',missionId,path:'不存在的精确路径.txt'}]].entries()){
  const graph=await rpc('canvas.nodes.snapshot',{boardId})
  const applied=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId,expectedRevision:graph.board.revision,mutation:{type:'create',node:{kind:'conversation',conversation:{threadId,conversationId:null},objectReference,x:index*380,y:0,width:360,height:240}}}})
  assert.equal(applied.status,'applied',JSON.stringify(applied));nodes[kind]=applied.payload.nodeIds[0]
 }
 const graph=await rpc('canvas.nodes.snapshot',{boardId})
 const file=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId,expectedRevision:graph.board.revision,mutation:{type:'create',node:{kind:'file',path:config.text_file,fileReference:{threadId:config.thread_id},x:0,y:300,width:520,height:400}}}})
 assert.equal(file.status,'applied',JSON.stringify(file));nodes.file=file.payload.nodeIds[0]
 report.objects={board_id:boardId,mission_id:missionId,thread_id:threadId,task_id:taskId,nodes}
 const board=async()=>{
  await openCanvasBoard(evaluate,wait,boardId)
  await wait(`document.querySelectorAll('.react-flow__node').length===4`)
  await evaluate(`(()=>{document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]').click();return true})()`)
  if(config.expect_toolbar&&!toolbarChecked){
   report.toolbar_layout=await evaluate(`(()=>{const host=document.querySelector('.canvas-boards-toolbar'),toolbar=document.querySelector('.canvas-toolbar'),stage=document.querySelector('.canvas-flow-stage'),pill=document.querySelector('.canvas-zoom-pill'),map=document.querySelector('.canvas-minimap');return {headerHeight:host.getBoundingClientRect().height,dockBottom:stage.getBoundingClientRect().bottom-toolbar.getBoundingClientRect().bottom,dockOutsideHeader:!host.contains(toolbar),mapWidth:map?.getBoundingClientRect().width,pillWidth:pill.getBoundingClientRect().width}})()`)
   assert.ok(report.toolbar_layout.headerHeight<=44&&report.toolbar_layout.dockOutsideHeader&&report.toolbar_layout.dockBottom>=8&&report.toolbar_layout.dockBottom<=24)
   assert.ok(Math.abs(report.toolbar_layout.mapWidth-report.toolbar_layout.pillWidth)<2)
   const menu=async label=>{
    await evaluate(`(()=>{document.querySelector('button[aria-label="${label}"]').focus();return true})()`)
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Down'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Down'})
    await wait(`Boolean(document.querySelector('.canvas-card-menu [role="menuitem"]'))`)
   }
   await menu('画板操作')
   report.board_menu=await evaluate(`[...document.querySelectorAll('.canvas-card-menu [role="menuitem"]')].map(item=>item.textContent)`)
   assert.ok(report.board_menu.includes('编辑画板')&&report.board_menu.includes('删除画板'))
   window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'})
   await wait(`!document.querySelector('.canvas-card-menu')`)
   await menu('画布操作')
   report.canvas_menu=await evaluate(`[...document.querySelectorAll('.canvas-card-menu [role="menuitem"]')].map(item=>item.textContent)`)
   for(const label of ['刷新关联','选中对话分组','删除所选','自动排列'])assert.ok(report.canvas_menu.includes(label))
   const visible=await evaluate(`Boolean(document.querySelector('.react-flow__minimap'))`)
   await evaluate(`(()=>{document.querySelector('.canvas-card-menu [role="menuitemcheckbox"]').click();return true})()`)
   await wait(`Boolean(document.querySelector('.react-flow__minimap'))===${!visible}`)
   await menu('画布操作')
   await evaluate(`(()=>{document.querySelector('.canvas-card-menu [role="menuitemcheckbox"]').click();return true})()`)
   await wait(`Boolean(document.querySelector('.react-flow__minimap'))===${visible}`)
   await evaluate(`(()=>{document.querySelector('button[aria-label="恢复到 100%"]').click();return true})()`)
   await wait(`document.querySelector('.canvas-zoom-readout')?.textContent==='100%'`)
   await evaluate(`(()=>{document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]').click();return true})()`)
   toolbarChecked=true;record('codeg_canvas_dock_viewport_keyboard_menus_and_minimap_toggle')
   await writeFile(join(config.evidence,'00-codeg-canvas-dock.png'),(await window.webContents.capturePage()).toPNG())
  }
 }
 const inspect=async kind=>{
  await board()
  await evaluate(`(()=>{[...document.querySelector('[data-id="${nodes[kind]}"]').querySelectorAll('button')].find(button=>button.textContent==='读取详情').click();return true})()`)
  await wait(`Boolean(document.querySelector('.canvas-object-dialog .canvas-object-details'))`)
 }
 const workspace=async()=>{
  await evaluate(`(()=>{[...document.querySelector('.canvas-object-dialog').querySelectorAll('button')].find(button=>button.textContent==='在工作区中操作').click();return true})()`)
  await wait(`!document.querySelector('.canvas-workspace')`)
 }
 await inspect('task')
 assert.equal(await evaluate(`document.querySelector('.canvas-object-details').dataset.taskId`),taskId)
 assert.ok(await evaluate(`document.querySelector('.canvas-object-details').textContent.includes('已取消')`))
 record('actual_canvas_task_pin_reads_exact_cancelled_task')
 await workspace()
 await wait(`(()=>{const task=document.querySelector('.task-detail[data-task-id="${taskId}"]');return task&&task.getBoundingClientRect().height>0})()`)
 record('actual_history_task_pin_opens_original_workspace_and_exact_task_detail')
 await inspect('mission')
 assert.equal(await evaluate(`document.querySelector('.canvas-object-details').dataset.missionId`),missionId)
 record('actual_mission_pin_reads_original_mission_id')
 await workspace()
 await wait(`(()=>{const mission=document.querySelector('.mission-intro[data-mission-id="${missionId}"]');return mission&&mission.getBoundingClientRect().height>0})()`)
 record('actual_mission_pin_opens_original_mission_workspace')
 report.delivery=await rpc('missions.delivery',{missionId})
 assert.equal(report.delivery.threadId,threadId,JSON.stringify(report.delivery))
 assert.equal(Object.hasOwn(report.delivery,'campId'),false)
 record('mission_delivery_uses_canonical_thread_identity')
 await inspect('mission_diff')
 assert.equal(await evaluate(`document.querySelector('.canvas-object-details').dataset.missionId`),missionId)
 await wait(`document.querySelector('.canvas-object-details').textContent.includes('当前使命尚无可用的 Git 工作区。')`)
 record('diff_pin_without_prepared_workspace_reports_unavailability_without_substituting_a_file')
 await evaluate(`(()=>{[...document.querySelector('.canvas-object-dialog').querySelectorAll('button')].find(button=>button.textContent==='关闭').click();return true})()`)
 await wait(`!document.querySelector('.canvas-object-dialog')`)
 const fileCard=`document.querySelector('[data-id="${nodes.file}"]')`
 await wait(`Boolean(${fileCard}?.querySelector('.canvas-file-actions button[aria-label="在工作区中操作"]'))`,25_000)
 await evaluate(`(()=>{${fileCard}.querySelector('.canvas-file-actions button[aria-label="在工作区中操作"]').click();return true})()`)
 await wait(`!document.querySelector('.canvas-workspace')&&Boolean(document.querySelector('.camp-workspace[aria-label]'))`)
 assert.ok(await evaluate(`document.querySelector('.camp-workspace[aria-label]').getAttribute('aria-label').includes('文件工程A')`))
 await wait(`Boolean([...document.querySelectorAll('.file-preview-path-row')].find(row=>row.getBoundingClientRect().height>0&&row.textContent.includes('说明 #中文.txt')))`)
 record('actual_file_pin_opens_its_original_thread_and_exact_file_tab')
 assert.equal((await rpc('tasks.get',{threadId,taskId})).status,'cancelled')
 assert.equal((await rpc('missions.get',{missionId})).missionId,missionId)
 report.no_model=true
 await writeFile(join(config.evidence,'01-original-file-workspace.png'),(await window.webContents.capturePage()).toPNG())
}
async function qualifyPrivateUi(window,{evaluate,wait,rpc}){
 const prior=JSON.parse(await readFile(config.previous_result,'utf8'))
 assert.equal(prior.status,'passed')
 const {board_id:boardId,conversation_id:conversationId,scopes}=prior.private_context
 await openCanvasBoard(evaluate,wait,boardId)
 await wait(`Boolean(document.querySelector('[data-id="${scopes[1].nodeId}"]'))`)
 await evaluate(`(()=>{document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]').click();return true})()`)
 const frame=`document.querySelector('.canvas-conversation-frame[data-canvas-conversation-key*="${scopes[1].nodeId}"]')`
 await wait(`Boolean(${frame})||[...document.querySelector('[data-id="${scopes[1].nodeId}"]').querySelectorAll('button')].some(button=>(button.getAttribute('aria-label')||button.textContent)==='展开对话'&&!button.disabled)`)
 report.private_opening=await evaluate(`(()=>{if(${frame})return 'restored_exact_node';[...document.querySelector('[data-id="${scopes[1].nodeId}"]').querySelectorAll('button')].find(button=>(button.getAttribute('aria-label')||button.textContent)==='展开对话'&&!button.disabled).click();return 'clicked_exact_node'})()`)
 await wait(`Boolean(${frame}?.querySelector('.single-chat-composer-box .attachment-open[aria-label="打开文件预览 乙材料.txt"]'))`,25_000)
 assert.ok(!(await evaluate(`${frame}.querySelector('.single-chat-composer-box').textContent`)).includes('甲材料'))
 record('actual_scoped_composer_renders_only_its_own_attachment_card')
 await evaluate(`(()=>{window.nativePrivateComposer=${frame}.querySelector('textarea');return true})()`)
 report.inline_header=await evaluate(`(()=>{const frame=${frame},header=document.querySelector('[data-id="${scopes[1].nodeId}"] .canvas-card-handle'),a=header.getBoundingClientRect(),b=frame.getBoundingClientRect(),scale=a.width/header.offsetWidth;return {duplicateHeading:Boolean(frame.querySelector('.canvas-conversation-heading')),edgeGap:Math.abs(a.bottom-b.top)/scale,widthGap:Math.abs(a.width-b.width)/scale,actions:['移至侧边','打开完整工作区','收起对话'].every(label=>header.querySelector('button[aria-label="'+label+'"]'))}})()`)
 await wait(`${frame}.querySelector('.single-chat-composer-box .attachment-open[aria-label="打开文件预览 乙材料.txt"]').disabled===false`)
 await evaluate(`(()=>{${frame}.querySelector('.single-chat-composer-box .attachment-open[aria-label="打开文件预览 乙材料.txt"]').click();return true})()`)
 await wait(`Boolean([...document.querySelectorAll('.file-preview-content')].find(element=>element.getBoundingClientRect().height>0&&element.textContent.includes('乙卡专用材料')))`,20_000)
 await pause(450)
 report.private_preview=await evaluate(`(()=>{const content=[...document.querySelectorAll('.file-preview-content')].find(element=>element.textContent.includes('乙卡专用材料')),rect=content.getBoundingClientRect(),x=rect.x+rect.width/2,y=rect.y+rect.height/2,hit=document.elementFromPoint(x,y),loading=${frame}?.querySelector('.single-chat-spinner');return {width:rect.width,height:rect.height,inViewport:x>=0&&x<innerWidth&&y>=0&&y<innerHeight,visibleAtCenter:Boolean(hit&&content.contains(hit)),loadingVisible:Boolean(loading&&loading.checkVisibility())}})()`)
 assert.equal(report.inline_header.duplicateHeading,false)
 assert.ok(report.inline_header.edgeGap<=2.1&&report.inline_header.widthGap<=2.1&&report.inline_header.actions,JSON.stringify(report.inline_header))
 assert.ok(report.private_preview.width>0&&report.private_preview.height>0&&report.private_preview.inViewport&&report.private_preview.visibleAtCenter&&!report.private_preview.loadingVisible,JSON.stringify(report.private_preview))
 record('inline_card_has_one_drag_header_and_private_preview_is_visible_above_compact_conversation')
 await writeFile(join(config.evidence,'01-private-attachment-preview.png'),(await window.webContents.capturePage()).toPNG())
 await evaluate(`(()=>{${frame}.querySelector('.file-preview-return').click();return true})()`)
 await wait(`Boolean(${frame}.querySelector('.single-chat-composer-box .attachment-open[aria-label="打开文件预览 乙材料.txt"]')?.checkVisibility())`)
 const clickNative=async expression=>{
  await wait(`Boolean((${expression})&&!(${expression}).disabled&&(${expression}).checkVisibility())`)
  const point=await evaluate(`(()=>{const button=${expression},rect=button.getBoundingClientRect(),x=rect.x+rect.width/2,y=rect.y+rect.height/2,hit=document.elementFromPoint(x,y);if(!hit||!(button===hit||button.contains(hit)))throw Error('目标操作被其他卡片遮挡');return {x:Math.round(x),y:Math.round(y)}})()`)
  window.webContents.sendInputEvent({type:'mouseMove',...point})
  window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point})
  window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point})
 }
 await clickNative(`document.querySelector('[data-id="${scopes[1].nodeId}"] .canvas-card-handle button[aria-label="移至侧边"]')`)
 await wait(`Boolean(${frame}?.querySelector('.canvas-conversation-heading button[aria-label="放回画布"]'))`)
 assert.ok(await evaluate(`${frame}.querySelector('textarea')===window.nativePrivateComposer`))
 await clickNative(`${frame}.querySelector('.canvas-conversation-heading button[aria-label="放回画布"]')`)
 await wait(`Boolean(${frame}?.classList.contains('is-inline'))&&!${frame}?.querySelector('.canvas-conversation-heading')`)
 assert.ok(await evaluate(`${frame}.querySelector('textarea')===window.nativePrivateComposer`))
 record('real_mouse_moves_private_card_between_inline_and_drawer_without_remounting_composer')
 const after=await rpc('singleChat.get',{conversationId,composerScope:scopes[1]})
 assert.deepEqual(after.agentRuns,[]);assert.deepEqual(after.messages,[])
 assert.deepEqual(after.draft.attachments.map(x=>x.displayName),['乙材料.txt'])
 record('actual_scoped_attachment_button_opens_authorized_file_without_sending_or_consuming_input')
  await wait(`(()=>{const viewport=${frame}?.querySelector('.single-chat-viewport');return viewport&&viewport.checkVisibility()&&viewport.clientHeight>0&&viewport.scrollHeight-viewport.clientHeight<=1})()`)
  report.private_empty_layout=await evaluate(`(()=>{const root=${frame},viewport=root.querySelector('.single-chat-viewport'),empty=root.querySelector('.single-chat-empty'),legacy=root.querySelector('.private-legacy-materials');return {extraY:viewport.scrollHeight-viewport.clientHeight,emptyMinHeight:getComputedStyle(empty).minHeight,legacyExpanded:legacy?.dataset.expanded,legacyHeight:legacy?.getBoundingClientRect().height}})()`)
  assert.equal(report.private_empty_layout.emptyMinHeight,'0px')
  assert.equal(report.private_empty_layout.legacyExpanded,'false')
  record('empty_private_reading_area_fits_card_and_keeps_compact_recovery_entries')
 await pause(100)
 await writeFile(join(config.evidence,'02-private-conversation-returned.png'),(await window.webContents.capturePage()).toPNG())
 report.private_context=prior.private_context
}
async function qualifyNotes(window,{evaluate,wait,rpc}){
 window.unmaximize();window.setContentSize(1440,920);window.webContents.setZoomFactor(1)
 const created=await rpc('canvas.boards.create',{commandId:randomUUID(),command:{name:'C06 原版便笺交互'}})
 assert.equal(created.status,'applied',JSON.stringify(created))
 const boardId=created.payload.board.id,ids=[]
 for(const index of [0,1]){
  const graph=await rpc('canvas.nodes.snapshot',{boardId})
  const result=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId,expectedRevision:graph.board.revision,mutation:{type:'create',node:{kind:'note',title:index?'另一张便笺':'原版便笺',content:index?'乙卡独立原文':'甲卡原文',color:index?'blue':'yellow',x:index*400,y:0,width:320,height:260}}}})
  assert.equal(result.status,'applied',JSON.stringify(result));ids.push(result.payload.nodeIds[0])
 }
 report.notes={board_id:boardId,node_ids:ids}
 await openCanvasBoard(evaluate,wait,boardId)
 await wait(`document.querySelectorAll('.canvas-note-paper').length===2`)
 const waitForViewport=async()=>{
  let lastTransform=null,stableFrames=0
  for(let attempt=0;attempt<20&&stableFrames<3;attempt++){
   const transform=await evaluate(`document.querySelector('.react-flow__viewport').style.transform`)
   stableFrames=transform===lastTransform?stableFrames+1:0;lastTransform=transform;await pause(80)
  }
  assert.ok(stableFrames>=3,'画布视口仍在动画中，不能开始拖动')
 }
 await evaluate(`(()=>{document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]').click();return true})()`)
 await waitForViewport()
 await evaluate(`(()=>{document.querySelector('button[aria-label="恢复到 100%"]').click();return true})()`)
 await wait(`document.querySelector('.canvas-zoom-readout').textContent==='100%'`)
 await waitForViewport()
 await wait(`Boolean(document.querySelector('.canvas-dock-panel button[aria-label="自动排列"]:not(:disabled)'))`)
 const card=`document.querySelector('[data-id="${ids[0]}"] .canvas-note-paper')`
 const point=async expression=>{
  await wait(`Boolean(${expression})`)
  await evaluate(`(()=>{(${expression}).scrollIntoView({block:'nearest',inline:'nearest'});return true})()`)
  return evaluate(`(()=>{const target=${expression},rect=target.getBoundingClientRect(),x=Math.round(rect.x+rect.width/2),y=Math.round(rect.y+rect.height/2),hit=document.elementFromPoint(x,y);if(!hit||!(target===hit||target.contains(hit)))throw Error('便笺目标被遮挡');return {x,y}})()`)
 }
 const mouse=(type,position,clickCount=1)=>window.webContents.sendInputEvent({type,button:'left',clickCount,...position})
 const click=async(expression,double=false)=>{
  const position=await point(expression);mouse('mouseMove',position);mouse('mouseDown',position);mouse('mouseUp',position)
  if(double){mouse('mouseDown',position,2);mouse('mouseUp',position,2)}
 }
 const start=await point(`${card}.querySelector('.canvas-note-prose')`)
 report.note_before_drag={zoomFactor:window.webContents.getZoomFactor(),start,layout:await evaluate(`(()=>{const note=${card},viewport=document.querySelector('.react-flow__viewport');return {window:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},node:note.getBoundingClientRect().toJSON(),offset:{width:note.offsetWidth,height:note.offsetHeight},viewportTransform:viewport.style.transform,computedTransform:getComputedStyle(viewport).transform,bodyZoom:getComputedStyle(document.body).zoom,rootZoom:getComputedStyle(document.documentElement).zoom,readout:document.querySelector('.canvas-zoom-readout').textContent}})()`)}
 await evaluate(`(()=>{window.noteDragEvents=[];for(const name of ['mousedown','mousemove','mouseup'])window.addEventListener(name,event=>window.noteDragEvents.push({type:event.type,buttons:event.buttons,trusted:event.isTrusted,x:event.clientX,y:event.clientY,screenX:event.screenX,screenY:event.screenY,transform:document.querySelector('.react-flow__viewport').style.transform}),true);return true})()`)
 mouse('mouseMove',start);mouse('mouseDown',start)
 await pause(50)
 // XYDrag.startDrag captures the pointer after its activation threshold, not on mouseDown.
 const activated={x:start.x+8,y:start.y+8},ended={x:activated.x+72,y:activated.y+48}
 const expectedGeometry={x:400-320,y:48}
 report.note_drag_path={pressed:start,activated,ended,drag_delta:{x:72,y:48},expected_final_position:expectedGeometry,alignment:'right edge snaps to the neighbouring note at x=400 within the existing 8px tolerance'}
 window.webContents.sendInputEvent({type:'mouseMove',...activated,modifiers:['leftButtonDown']});await pause(80)
 window.webContents.sendInputEvent({type:'mouseMove',...ended,modifiers:['leftButtonDown']});await pause(80);mouse('mouseUp',ended)
 await pause(200)
 report.note_drag_events=await evaluate('window.noteDragEvents')
 report.note_graph_after_drag=await rpc('canvas.nodes.snapshot',{boardId})
 await wait(`window.rovai.request('canvas.nodes.snapshot',{boardId:${JSON.stringify(boardId)}}).then(graph=>graph.nodes.find(node=>node.id===${JSON.stringify(ids[0])})?.data.x===${expectedGeometry.x})`)
 const moved=(await rpc('canvas.nodes.snapshot',{boardId})).nodes.find(node=>node.id===ids[0])
 assert.equal(moved.data.x+moved.data.width,400);assert.equal(moved.data.y,expectedGeometry.y)
 record('whole_note_body_native_drag_updates_exact_core_geometry_and_retains_edge_alignment')
 const type=async(text,keyboard=false)=>{
  await wait(`Boolean(document.querySelector('.canvas-dock-panel button[aria-label="自动排列"]:not(:disabled)'))`)
  if(keyboard){
   await evaluate(`(()=>{${card}.focus();return true})()`)
   window.webContents.sendInputEvent({type:'keyDown',keyCode:'F2'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'F2'})
  }else await click(`${card}.querySelector('.canvas-note-prose')`,true)
  await wait(`Boolean(${card}.querySelector('textarea'))`)
  await evaluate(`(()=>{const input=${card}.querySelector('textarea');input.focus();input.select();window.noteInputEvents=[];input.addEventListener('input',event=>window.noteInputEvents.push({trusted:event.isTrusted}));return true})()`)
  await window.webContents.insertText(text)
  await wait(`${card}.querySelector('textarea').value===${JSON.stringify(text)}`)
  assert.ok((await evaluate('window.noteInputEvents')).some(event=>event.trusted))
 }
 let saved='真实行内输入\n最后字符乙'
 await type(saved)
 await click(`document.querySelector('button[aria-label="恢复到 100%"]')`)
 await wait(`window.rovai.request('canvas.nodes.snapshot',{boardId:${JSON.stringify(boardId)}}).then(graph=>graph.nodes.find(node=>node.id===${JSON.stringify(ids[0])})?.data.content===${JSON.stringify(saved)})`)
 const after=(await rpc('canvas.nodes.snapshot',{boardId})).nodes.find(node=>node.id===ids[0])
 assert.equal(after.data.x,moved.data.x);assert.equal(after.data.y,moved.data.y)
 record('native_double_click_and_trusted_last_character_blur_save_only_note_content')
 saved='键盘进入后按Escape保存的便笺丙'
 await type(saved,true)
 window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'})
 await wait(`!${card}.querySelector('textarea')&&window.rovai.request('canvas.nodes.snapshot',{boardId:${JSON.stringify(boardId)}}).then(graph=>graph.nodes.find(node=>node.id===${JSON.stringify(ids[0])})?.data.content===${JSON.stringify(saved)})`)
 record('native_f2_edit_and_escape_save_preserve_original_note_exit_semantics')
 const local='本机冲突草稿乙',remote='远端已经保存的原文甲'
 await type(local)
 const current=await rpc('canvas.nodes.snapshot',{boardId})
 const other=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId,expectedRevision:current.board.revision,mutation:{type:'update',nodeId:ids[0],patch:{content:remote}}}})
 assert.equal(other.status,'applied',JSON.stringify(other))
 await wait(`${card}.querySelector('.canvas-note-status details')?.textContent.includes(${JSON.stringify(remote)})`)
 await click(`document.querySelector('button[aria-label="恢复到 100%"]')`)
 const conflict=(await rpc('canvas.nodes.snapshot',{boardId})).nodes.find(node=>node.id===ids[0])
 assert.equal(conflict.data.content,remote)
 report.note_drafts=await evaluate(`Object.entries(localStorage).filter(([key])=>key.startsWith('rovai.canvas.note-draft.v1:')).map(([key,value])=>({key,value:JSON.parse(value)}))`)
 assert.ok(report.note_drafts.some(item=>item.value.text===local&&item.value.baseline===saved))
 record('remote_note_revision_keeps_saved_text_and_local_draft_without_silent_overwrite')
 await click(`document.querySelector('button[aria-label="队员"]')`)
 assert.ok(await evaluate(`Boolean(document.querySelector('.canvas-workspace')&&${card})`))
 record('dirty_note_prevents_ordinary_navigation_until_explicit_resolution')
 await click(`${card}.querySelector('.canvas-note-status summary')`)
 assert.ok(await evaluate(`${card}.querySelector('.canvas-note-status details').open`))
 await click(`${card}.querySelector('.canvas-note-status button')`)
 await wait(`window.rovai.request('canvas.nodes.snapshot',{boardId:${JSON.stringify(boardId)}}).then(graph=>graph.nodes.find(node=>node.id===${JSON.stringify(ids[0])})?.data.content===${JSON.stringify(local)})`)
 await wait(`!${card}.querySelector('.canvas-note-status')`)
 const final=await rpc('canvas.nodes.snapshot',{boardId})
 assert.equal(final.nodes.find(node=>node.id===ids[1]).data.content,'乙卡独立原文')
 assert.ok(!(await evaluate(`Object.values(localStorage).map(value=>{try{return JSON.parse(value)}catch{return null}}).filter(Boolean)`)).some(value=>value.text===local&&value.baseline===remote))
 record('explicit_review_saves_local_note_and_clears_only_its_draft_preserving_other_note')
 await writeFile(join(config.evidence,'01-note-paper-after-conflict.png'),(await window.webContents.capturePage()).toPNG())
}
async function qualifyMirrors(window,{evaluate,wait,rpc}){
 window.unmaximize();window.setContentSize(1680,1000);window.webContents.setZoomFactor(1)
 let context
 if(config.mode==='mirrors-reopen'){
  const previous=JSON.parse(await readFile(config.mirror_previous_result,'utf8'))
  assert.equal(previous.status,'passed');context=previous.mirror_context
 }else{
  const prior=JSON.parse(await readFile(config.previous_result,'utf8'))
  assert.equal(prior.status,'passed')
  const {thread_id:threadId,conversation_id:conversationId}=prior.private_context
  const created=await rpc('canvas.boards.create',{commandId:randomUUID(),command:{name:'C05 同会话双卡'}})
  assert.equal(created.status,'applied',JSON.stringify(created))
  const boardId=created.payload.board.id,nodeIds=[]
  for(const index of [0,1]){
   const graph=await rpc('canvas.nodes.snapshot',{boardId})
   const result=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId,expectedRevision:graph.board.revision,mutation:{type:'create',node:{kind:'conversation',conversation:{threadId,conversationId},title:index?'乙卡同一私聊':'甲卡同一私聊',x:index*560,y:0,width:520,height:600}}}})
   assert.equal(result.status,'applied',JSON.stringify(result));nodeIds.push(result.payload.nodeIds[0])
  }
  context={boardId,threadId,conversationId,nodeIds,texts:['甲卡独立未发送输入',Array.from({length:40},(_,i)=>`乙卡独立长输入第${i+1}行`).join('\n')]}
 }
 report.mirror_context=context
 const {boardId,conversationId,nodeIds,texts}=context
 const frames=nodeIds.map(id=>`document.querySelector('.canvas-conversation-frame[data-canvas-conversation-key*="${id}"]')`)
 const inputs=frames.map(frame=>`${frame}?.querySelector('.single-chat-composer textarea')`)
 const open=async index=>{
  if(await evaluate(`Boolean(${inputs[index]})`))return
  await wait(`Boolean(document.querySelector('[data-id="${nodeIds[index]}"] button[aria-label="展开对话"]:not(:disabled)'))`)
  await evaluate(`(()=>{document.querySelector('[data-id="${nodeIds[index]}"] button[aria-label="展开对话"]').click();return true})()`)
  await wait(`Boolean(${inputs[index]}&&!${inputs[index]}.disabled)`)
 }
 await openCanvasBoard(evaluate,wait,boardId)
 if(config.mode==='mirrors-reopen'){
  await wait(`Boolean(${inputs[0]}&&${inputs[1]}&&${inputs[0]}.value===${JSON.stringify(texts[0])}&&${inputs[1]}.value===${JSON.stringify(texts[1])})`,30_000)
  record('cold_native_route_restores_both_exact_private_pins_and_independent_draft_bodies')
  const restored=await rpc('canvas.nodes.snapshot',{boardId})
  for(const id of nodeIds){const row=restored.nodes.find(node=>node.id===id);assert.equal(row.data.conversation.conversationId,conversationId)}
  record('cold_mirror_recovery_keeps_original_private_identity_instead_of_creating_replacements')
 }else{
  await open(0)
  await evaluate(`(()=>{window.mirrorOriginalEditor=${inputs[0]};return true})()`)
  await open(1)
  assert.ok(await evaluate(`${inputs[0]}===window.mirrorOriginalEditor&&${inputs[0]}!==${inputs[1]}`))
  await evaluate(`(()=>{window.mirrorEditors=[${inputs[0]},${inputs[1]}];return true})()`)
  record('opening_same_private_conversation_twice_preserves_first_editor_and_mounts_a_distinct_second_editor')
  for(const index of [0,1]){
   await wait(`Boolean(${inputs[index]}&&!${inputs[index]}.disabled)`)
   await evaluate(`(()=>{const input=${inputs[index]};input.focus();input.select();window.mirrorTrustedInputs=[];input.addEventListener('input',event=>window.mirrorTrustedInputs.push(event.isTrusted));return true})()`)
   await window.webContents.insertText(texts[index])
   await wait(`${inputs[index]}.value===${JSON.stringify(texts[index])}`)
   assert.ok((await evaluate('window.mirrorTrustedInputs')).some(Boolean))
  }
  for(const index of [0,1])assert.equal(await evaluate(`${inputs[index]}.value`),texts[index])
  record('trusted_input_in_each_same_thread_private_pin_remains_in_its_own_composer')
  const snapshots=[]
  for(const nodeId of nodeIds)snapshots.push(await rpc('singleChat.get',{conversationId,composerScope:{kind:'canvas',boardId,nodeId}}))
  assert.ok(snapshots[0].draft.scopeKey&&snapshots[1].draft.scopeKey&&snapshots[0].draft.scopeKey!==snapshots[1].draft.scopeKey)
  report.mirror_scope_keys=snapshots.map(snapshot=>snapshot.draft.scopeKey)
  record('actual_core_keeps_distinct_canvas_material_scopes_for_same_private_conversation')
  const scroll=await evaluate(`(()=>{const input=${inputs[1]};input.scrollTop=input.scrollHeight;return {top:input.scrollTop,extra:input.scrollHeight-input.clientHeight}})()`)
  assert.ok(scroll.extra>0&&scroll.top>0,JSON.stringify(scroll))
  await evaluate(`(()=>{document.querySelector('[data-id="${nodeIds[0]}"] button[aria-label="移至侧边"]').click();return true})()`)
  await wait(`Boolean(${frames[0]}?.querySelector('button[aria-label="放回画布"]:not(:disabled)'))`)
  assert.ok(await evaluate(`${inputs[0]}===window.mirrorEditors[0]&&${inputs[1]}===window.mirrorEditors[1]`))
  assert.ok(Math.abs(await evaluate(`${inputs[1]}.scrollTop`)-scroll.top)<=1)
  await evaluate(`(()=>{${frames[0]}.querySelector('button[aria-label="放回画布"]').click();return true})()`)
  await wait(`Boolean(${frames[0]}?.classList.contains('is-inline'))`)
  assert.ok(await evaluate(`${inputs[0]}===window.mirrorEditors[0]&&${inputs[1]}===window.mirrorEditors[1]`))
  record('moving_one_private_mirror_keeps_both_editor_instances_and_other_composer_scroll_position')
  await evaluate(`(()=>{document.querySelector('[data-id="${nodeIds[0]}"] button[aria-label="收起对话"]').click();return true})()`)
  await wait(`!${frames[0]}`)
  assert.ok(await evaluate(`${inputs[1]}===window.mirrorEditors[1]&&${inputs[1]}.value===${JSON.stringify(texts[1])}`))
  await open(0)
  await wait(`${inputs[0]}.value===${JSON.stringify(texts[0])}`)
  assert.ok(await evaluate(`${inputs[0]}!==window.mirrorEditors[0]&&${inputs[1]}===window.mirrorEditors[1]`))
  record('closing_and_reopening_one_private_pin_recovers_its_draft_without_replacing_the_other_editor')
 }
 const after=await rpc('singleChat.get',{conversationId})
 assert.deepEqual(after.messages,[]);assert.deepEqual(after.agentRuns,[])
 record('mirror_edit_and_recovery_does_not_send_messages_or_start_agent_runs')
 await evaluate(`(()=>{document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]').click();return true})()`)
 await pause(350)
 await writeFile(join(config.evidence,'01-same-private-conversation-two-cards.png'),(await window.webContents.capturePage()).toPNG())
}
async function qualifyRendererCrash(window,{evaluate,wait,rpc}){
 window.unmaximize();window.setContentSize(1680,1000);window.webContents.setZoomFactor(1)
 if(config.preflight_note_recovery_result){
  const previous=JSON.parse(await readFile(config.preflight_note_recovery_result,'utf8'))
  assert.equal(previous.status,'failed')
  const {boardId,nodeIds,note_text:noteText}=previous.crash_context
  await openCanvasBoard(evaluate,wait,boardId)
  const note=`document.querySelector('[data-id="${nodeIds[2]}"] .canvas-note-paper')`
  await wait(`${note}?.querySelector('.canvas-note-prose')?.textContent.includes(${JSON.stringify(noteText)})&&Boolean(${note}?.querySelector('.canvas-note-status button:not(:disabled)'))`)
  await evaluate(`(()=>{${note}.querySelector('.canvas-note-status button').click();return true})()`)
  await wait(`!${note}.querySelector('.canvas-note-status')`)
  const saved=(await rpc('canvas.nodes.snapshot',{boardId})).nodes.find(node=>node.id===nodeIds[2])
  assert.equal(saved.data.content,noteText)
  report.fixture_preflight={source_result:config.preflight_note_recovery_result,boardId,noteId:nodeIds[2],own_recovered_note_saved:true}
 }
 const prior=JSON.parse(await readFile(config.previous_result,'utf8'))
 assert.equal(prior.status,'passed')
 const {thread_id:threadId,conversation_id:conversationId}=prior.private_context
 const created=await rpc('canvas.boards.create',{commandId:randomUUID(),command:{name:'C05 渲染进程硬中断恢复'}})
 assert.equal(created.status,'applied',JSON.stringify(created))
 const boardId=created.payload.board.id,nodeIds=[],baseline='硬中断前已保存的便笺原文'
 for(const index of [0,1,2]){
  const graph=await rpc('canvas.nodes.snapshot',{boardId})
  const node=index===2?{kind:'note',content:baseline,title:'硬中断便笺',x:0,y:640,width:520,height:220}
   :{kind:'conversation',conversation:{threadId,conversationId},title:index?'乙卡恢复对照':'甲卡硬中断输入',x:index*560,y:0,width:520,height:600}
  const result=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId,expectedRevision:graph.board.revision,mutation:{type:'create',node}}})
  assert.equal(result.status,'applied',JSON.stringify(result));nodeIds.push(result.payload.nodeIds[0])
 }
 const frames=nodeIds.slice(0,2).map(id=>`document.querySelector('.canvas-conversation-frame[data-canvas-conversation-key*="${id}"]')`)
 const inputs=frames.map(frame=>`${frame}?.querySelector('.single-chat-composer textarea')`)
 const texts=['甲卡未发送，硬中断前最后一个字：','乙卡独立输入保持不变'],last='甲'
 report.crash_context={boardId,threadId,conversationId,nodeIds,texts:[texts[0]+last,texts[1]],baseline}
 const open=async()=>{
  await openCanvasBoard(evaluate,wait,boardId)
  for(const index of [0,1]){
   await wait(`Boolean(document.querySelector('[data-id="${nodeIds[index]}"] button[aria-label="展开对话"]:not(:disabled)'))`)
   await evaluate(`(()=>{document.querySelector('[data-id="${nodeIds[index]}"] button[aria-label="展开对话"]').click();return true})()`)
   await wait(`Boolean(${inputs[index]}&&!${inputs[index]}.disabled)`)
  }
 }
 await open()
 for(const index of [0,1]){
  await evaluate(`(()=>{${inputs[index]}.focus();${inputs[index]}.select();return true})()`)
  await window.webContents.insertText(texts[index])
  await wait(`${inputs[index]}.value===${JSON.stringify(texts[index])}`)
 }
 const crashAndReload=async(kind,insertFinal)=>{
  const before=window.webContents.getOSProcessId(),mainPid=process.pid
  let timer
  const gone=new Promise((resolve,reject)=>{
   timer=setTimeout(()=>reject(Error('Owned renderer did not emit render-process-gone')),15_000)
   window.webContents.once('render-process-gone',(_event,details)=>resolve(details))
  })
  // Do not blur, navigate, read storage, or wait between the last trusted input and fault injection.
  await insertFinal()
  window.webContents.forcefullyCrashRenderer()
  const details=await gone.finally(()=>clearTimeout(timer))
  assert.ok(['killed','crashed'].includes(details.reason),JSON.stringify(details))
  report.crashes??=[];report.crashes.push({kind,before_renderer_pid:before,main_pid:mainPid,details,recovery_action:'explicit_webContents_reload_then_open_exact_board'})
  await writeFile(join(config.evidence,'crash-events.json'),JSON.stringify(report.crashes,null,2)+'\n')
  await new Promise((resolve,reject)=>{
   const loaded=()=>{clearTimeout(timer);resolve()}
   timer=setTimeout(()=>{window.webContents.removeListener('did-finish-load',loaded);reject(Error('Owned renderer reload timed out'))},60_000)
   window.webContents.once('did-finish-load',loaded);window.webContents.reload()
  })
  await wait(`window.rovai&&document.querySelector('button[aria-label="无限画布"]')?.disabled===false`,60_000)
  const after=window.webContents.getOSProcessId()
  assert.ok(before>0&&after>0&&before!==after);assert.equal(process.pid,mainPid)
  report.crashes.at(-1).after_renderer_pid=after
  report.crashes.at(-1).landing_on_canvas=await evaluate(`Boolean(document.querySelector('.canvas-workspace'))`)
  // Main retains its original startup snapshot after a renderer reload; select the exact persisted board as on cold recovery.
  await openCanvasBoard(evaluate,wait,boardId)
  await wait(`Boolean(${inputs[0]}&&${inputs[1]}&&${inputs[0]}.value===${JSON.stringify(texts[0]+last)}&&${inputs[1]}.value===${JSON.stringify(texts[1])})`,30_000)
 }
 await evaluate(`(()=>{const input=${inputs[0]};input.focus();input.setSelectionRange(input.value.length,input.value.length);return true})()`)
 await crashAndReload('last_private_character',()=>window.webContents.insertText(last))
 record('reopening_exact_board_after_forced_renderer_termination_recovers_last_private_character_and_both_distinct_bodies')
 const note=`document.querySelector('[data-id="${nodeIds[2]}"] .canvas-note-paper')`,noteText='尚未失焦保存的便笺，最后字符：乙'
 await evaluate(`(()=>{${note}.focus();return true})()`)
 window.webContents.sendInputEvent({type:'keyDown',keyCode:'F2'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'F2'})
 await wait(`Boolean(${note}.querySelector('textarea'))`)
 await evaluate(`(()=>{${note}.querySelector('textarea').focus();${note}.querySelector('textarea').select();return true})()`)
 report.crash_context.note_text=noteText
 await crashAndReload('unblurred_note_draft',()=>window.webContents.insertText(noteText))
 await wait(`${note}?.querySelector('.canvas-note-prose')?.textContent.includes(${JSON.stringify(noteText)})&&Boolean(${note}?.querySelector('.canvas-note-status button'))`)
 const after=(await rpc('canvas.nodes.snapshot',{boardId})).nodes.find(node=>node.id===nodeIds[2])
 assert.equal(after.data.content,baseline)
 report.recovered_note=await evaluate(`Object.entries(localStorage).filter(([key])=>key.startsWith('rovai.canvas.note-draft.v1:')&&key.includes(${JSON.stringify(nodeIds[2])})).map(([key,value])=>({key,value:JSON.parse(value)}))`)
 assert.equal(report.recovered_note.length,1);assert.equal(report.recovered_note[0].value.text,noteText);assert.equal(report.recovered_note[0].value.baseline,baseline)
 record('unblurred_note_survives_forced_renderer_termination_as_a_visible_scoped_draft_without_overwriting_saved_text')
 for(const id of nodeIds.slice(0,2)){
  const graph=await rpc('canvas.nodes.snapshot',{boardId})
  assert.deepEqual(graph.nodes.find(node=>node.id===id).data.conversation,{threadId,conversationId})
 }
 const privateAfter=await rpc('singleChat.get',{conversationId})
 assert.deepEqual(privateAfter.messages,[]);assert.deepEqual(privateAfter.agentRuns,[])
 record('two_real_renderer_faults_keep_original_private_identity_and_do_not_send_or_start_model_runs')
 await evaluate(`(()=>{document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]').click();return true})()`)
 await pause(350)
 await writeFile(join(config.evidence,'01-recovered-private-cards-and-note.png'),(await window.webContents.capturePage()).toPNG())
 // Resolve this fixture's own dirty note through the existing UI so normal controlled shutdown can finish.
 await evaluate(`(()=>{${note}.querySelector('.canvas-note-status button').click();return true})()`)
 await wait(`!${note}.querySelector('.canvas-note-status')&&window.rovai.request('canvas.nodes.snapshot',{boardId:${JSON.stringify(boardId)}}).then(graph=>graph.nodes.find(node=>node.id===${JSON.stringify(nodeIds[2])})?.data.content===${JSON.stringify(noteText)})`)
}
async function qualifyPublicMulti(window,{evaluate,wait,rpc}){
 window.unmaximize();window.setContentSize(1680,1000);window.webContents.setZoomFactor(1)
 const authority=JSON.parse(await readFile(config.public_threads_evidence,'utf8'))
 const threadIds=authority.rows.map(row=>row.camp_id)
 assert.equal(threadIds.length,2);assert.equal(threadIds[0],config.thread_id);assert.notEqual(threadIds[0],threadIds[1])
 const before=await Promise.all(threadIds.map(threadId=>rpc('threads.open',{threadId,traceId:randomUUID()})))
 const original=before.map(value=>({messages:value.messages,agentRuns:value.agentRuns}))
 const created=await rpc('canvas.boards.create',{commandId:randomUUID(),command:{name:'C05 公开双Thread与镜像卡'}})
 assert.equal(created.status,'applied',JSON.stringify(created))
 const boardId=created.payload.board.id,nodeIds=[],threads=[threadIds[0],threadIds[0],threadIds[1]],texts=['公开甲卡独立输入','同Thread公开乙卡独立输入','另一Thread公开丙卡独立输入']
 for(const index of [0,1,2]){
  const graph=await rpc('canvas.nodes.snapshot',{boardId})
  const result=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId,expectedRevision:graph.board.revision,mutation:{type:'create',node:{kind:'conversation',conversation:{threadId:threads[index]},title:['公开甲卡','公开乙卡镜像','另一Thread公开丙卡'][index],x:index===1?560:0,y:index===2?640:0,width:520,height:600}}}})
  assert.equal(result.status,'applied',JSON.stringify(result));nodeIds.push(result.payload.nodeIds[0])
 }
 report.public_context={boardId,nodeIds,threads,texts}
 const frames=nodeIds.map(id=>`document.querySelector('.canvas-conversation-frame[data-canvas-conversation-key*="${id}"]')`)
 const inputs=frames.map(frame=>`${frame}?.querySelector('.structured-mention-editor[contenteditable="true"]')`)
 await openCanvasBoard(evaluate,wait,boardId)
 window.webContents.debugger.attach('1.3')
 try{
  const listeners=async()=>{
   const snapshot={}
   for(const [expression,type] of [['window','focus'],['document','visibilitychange']]){
    const remote=await window.webContents.debugger.sendCommand('Runtime.evaluate',{expression,objectGroup:'native-public-listeners'})
    const result=await window.webContents.debugger.sendCommand('DOMDebugger.getEventListeners',{objectId:remote.result.objectId})
    snapshot[type]=result.listeners.filter(listener=>listener.type===type).map(listener=>({signature:[listener.scriptId,listener.lineNumber,listener.columnNumber,listener.useCapture].join(':'),handler:listener.handler?.description?.slice(0,220)}))
   }
   await window.webContents.debugger.sendCommand('Runtime.releaseObjectGroup',{objectGroup:'native-public-listeners'})
   return snapshot
  }
  const isReader=listener=>/document\.visibilityState\s*!==\s*["']hidden["'][\s\S]*\brefresh\(\)\.catch/.test(listener.handler??'')
  report.reader_owner_match='CanvasThreadReader.tsx:34 foreground: hidden check then refresh().catch; other per-card visibility/focus hooks remain in full snapshots'
  const baseline=await listeners();report.reader_listeners=[{step:'empty_board',snapshot:baseline}]
  for(const type of ['focus','visibilitychange'])assert.equal(baseline[type].filter(isReader).length,0)
  const count=async(step,extra)=>{
   await pause(120)
   const current=await listeners();report.reader_listeners.push({step,snapshot:current})
   for(const type of ['focus','visibilitychange']){
    assert.equal(current[type].filter(isReader).length,extra,JSON.stringify({step,type,current:current[type]}))
    if(extra===0)assert.deepEqual(current[type].map(item=>item.signature).sort(),baseline[type].map(item=>item.signature).sort(),JSON.stringify({step,type,current:current[type]}))
   }
  }
  const open=async index=>{
   await wait(`Boolean(document.querySelector('[data-id="${nodeIds[index]}"] button[aria-label="展开对话"]:not(:disabled)'))`)
   await evaluate(`(()=>{document.querySelector('[data-id="${nodeIds[index]}"] button[aria-label="展开对话"]').click();return true})()`)
   await wait(`Boolean(${inputs[index]}&&${inputs[index]}.getAttribute('aria-disabled')!=='true')`)
  }
  for(const index of [0,1,2]){await open(index);await count('open_'+index,index===2?2:1)}
  record('real_public_mirrors_mount_one_focus_and_visibility_reader_per_thread')
  await evaluate(`(()=>{window.publicEditors=[${inputs.join(',')}];return true})()`)
  for(const index of [0,1,2]){
   await evaluate(`(()=>{const input=${inputs[index]};input.focus();const range=document.createRange();range.selectNodeContents(input);getSelection().removeAllRanges();getSelection().addRange(range);return true})()`)
   await window.webContents.insertText(texts[index])
   await wait(`${inputs[index]}.textContent===${JSON.stringify(texts[index])}`)
  }
  const readDrafts=`Object.entries(localStorage).filter(([key])=>key.startsWith('rovai.canvas-composer-drafts.v1:')).flatMap(([key,value])=>Object.entries(JSON.parse(value).drafts).map(([context,body])=>({key,context:JSON.parse(context.slice(7)),draft:JSON.parse(body)}))).filter(item=>item.context[2]===${JSON.stringify(boardId)})`
  // The original public Lexical composer saves through its debounce owner; DOM text is not a persistence receipt.
  await wait(`(()=>{const drafts=${readDrafts};return ${JSON.stringify(nodeIds)}.every((id,index)=>drafts.some(item=>item.context[3]===id&&item.draft.body===${JSON.stringify(texts)}[index]))})()`)
  report.public_drafts=await evaluate(readDrafts)
  assert.equal(report.public_drafts.length,3)
  for(const index of [0,1,2]){const draft=report.public_drafts.find(item=>item.context[3]===nodeIds[index]);assert.equal(draft.context[4],threads[index]);assert.equal(draft.context[5],null);assert.equal(draft.draft.body,texts[index])}
  record('trusted_public_input_uses_three_independent_pin_drafts_across_two_real_threads')
  await evaluate(`(()=>{document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]').click();return true})()`);await pause(400)
  const point=await evaluate(`(()=>{const rect=${inputs[0]}.getBoundingClientRect();return {x:Math.round(rect.left+30),y:Math.round(rect.top+12)}})()`)
  assert.ok(point.x>0&&point.y>0&&point.x<window.getContentBounds().width&&point.y<window.getContentBounds().height)
  for(const type of ['mouseDown','mouseUp'])window.webContents.sendInputEvent({type,...point,button:'left',clickCount:1})
  await wait(`document.activeElement===${inputs[0]}`)
  await evaluate(`(()=>{document.querySelector('[data-id="${nodeIds[2]}"] button[aria-label="移至侧边"]').click();return true})()`)
  await wait(`Boolean(${frames[2]}?.querySelector('button[aria-label="放回画布"]:not(:disabled)'))`)
  assert.ok(await evaluate(`document.activeElement===window.publicEditors[0]&&window.publicEditors.every((editor,index)=>editor===[${inputs.join(',')}][index])`))
  await window.webContents.insertText('焦点仍在甲')
  assert.ok(await evaluate(`${inputs[0]}.textContent.includes('焦点仍在甲')&&${inputs[1]}.textContent===${JSON.stringify(texts[1])}&&${inputs[2]}.textContent===${JSON.stringify(texts[2])}`))
  texts[0]=await evaluate(`${inputs[0]}.textContent`)
  await evaluate(`(()=>{${frames[2]}.querySelector('button[aria-label="放回画布"]').click();return true})()`)
  await wait(`Boolean(${frames[2]}?.classList.contains('is-inline'))`)
  assert.ok(await evaluate(`document.activeElement===window.publicEditors[0]&&window.publicEditors.every((editor,index)=>editor===[${inputs.join(',')}][index])`))
  record('native_mouse_focus_and_trusted_typing_stay_on_original_public_editor_during_other_thread_layout_roundtrip')
  const close=async index=>{
   await wait(`Boolean(${frames[index]}?.querySelector('button[aria-label="收起对话"]:not(:disabled)')||document.querySelector('[data-id="${nodeIds[index]}"] button[aria-label="收起对话"]:not(:disabled)'))`)
   await evaluate(`(()=>{document.querySelector('[data-id="${nodeIds[index]}"] button[aria-label="收起对话"]')?.click();return true})()`)
   await wait(`!${frames[index]}`)
  }
  await close(1);await count('close_mirror_keep_thread_a',2)
  assert.ok(await evaluate(`${inputs[0]}===window.publicEditors[0]&&${inputs[2]}===window.publicEditors[2]`))
  await close(0);await count('close_last_thread_a',1)
  assert.ok(await evaluate(`${inputs[2]}===window.publicEditors[2]&&${inputs[2]}.textContent===${JSON.stringify(texts[2])}`))
  await close(2);await count('close_last_thread_b',0)
  record('closing_public_mirrors_releases_only_last_thread_reader_and_all_owned_focus_visibility_listeners')
  for(const index of [0,1,2]){await open(index);await wait(`${inputs[index]}.textContent===${JSON.stringify(texts[index])}`)}
  record('public_pin_close_reopen_recovers_each_exact_draft_without_merging_same_or_different_threads')
  await evaluate(`(()=>{document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]').click();return true})()`);await pause(350)
  await writeFile(join(config.evidence,'01-public-two-threads-three-cards.png'),(await window.webContents.capturePage()).toPNG())
  for(const index of [0,1,2])await close(index)
  await count('all_reopened_cards_closed',0)
 }finally{window.webContents.debugger.detach()}
 const after=await Promise.all(threadIds.map(threadId=>rpc('threads.open',{threadId,traceId:randomUUID()})))
 for(const [index,snapshot] of after.entries()){assert.deepEqual(snapshot.messages,original[index].messages);assert.deepEqual(snapshot.agentRuns,original[index].agentRuns)}
 record('public_multi_card_input_and_navigation_do_not_publish_messages_or_start_agent_runs')
 const summary=await rpc('canvas.boards.create',{commandId:randomUUID(),command:{name:'C05 真实64摘要卡'}})
 assert.equal(summary.status,'applied',JSON.stringify(summary))
 const summaryBoardId=summary.payload.board.id,summaryIds=[]
 for(let index=0;index<64;index++){
  const graph=await rpc('canvas.nodes.snapshot',{boardId:summaryBoardId})
  const result=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId:summaryBoardId,expectedRevision:graph.board.revision,mutation:{type:'create',node:{kind:'conversation',conversation:{threadId:threadIds[index%2]},title:`第${index+1}张真实摘要卡：独立布局与原Thread引用`,x:(index%8)*248,y:Math.floor(index/8)*156,width:224,height:132}}}})
  assert.equal(result.status,'applied',JSON.stringify(result));summaryIds.push(result.payload.nodeIds[0])
 }
 report.summary_context={boardId:summaryBoardId,nodeIds:summaryIds,threads:threadIds}
 await openCanvasBoard(evaluate,wait,summaryBoardId)
 await wait(`document.querySelectorAll('.react-flow__node').length===64`)
 assert.equal(await evaluate(`document.querySelectorAll('.canvas-conversation-frame').length`),0)
 record('actual_production_board_renders_64_persisted_summary_cards_without_mounting_conversation_editors')
 await evaluate(`(()=>{document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]').click();return true})()`);await pause(400)
 report.summary_frame_intervals=await evaluate(`new Promise(resolve=>{const intervals=[];let last=performance.now();const next=now=>{intervals.push(now-last);last=now;if(intervals.length===60)resolve(intervals);else requestAnimationFrame(next)};requestAnimationFrame(next)})`)
 const intervals=[...report.summary_frame_intervals].sort((a,b)=>a-b)
 report.summary_frame_metrics={sample_frames:intervals.length,median_ms:intervals[Math.floor(intervals.length/2)],p95_ms:intervals[Math.ceil(intervals.length*.95)-1],max_ms:intervals.at(-1),qualification:'真实64摘要卡静态帧间隔采样，不是64个展开工作区、终端窗口上限或全交互帧率资格'}
 report.summary_viewport_before=await evaluate(`(()=>{window.summaryWheel=[];window.addEventListener('wheel',event=>window.summaryWheel.push({trusted:event.isTrusted,deltaX:event.deltaX,deltaY:event.deltaY}),true);return {transform:document.querySelector('.react-flow__viewport').style.transform,zoom:document.querySelector('.canvas-zoom-readout').textContent}})()`)
 const point=await evaluate(`(()=>{const rect=document.querySelector('.canvas-flow-stage').getBoundingClientRect();return {x:Math.round(rect.left+12),y:Math.round(rect.top+12)}})()`)
 window.webContents.sendInputEvent({type:'mouseWheel',...point,deltaY:100,deltaX:0,canScroll:true})
 // Both original Codeg and this surface use panOnScroll: a plain wheel pans, it does not change the zoom percentage.
 await wait(`document.querySelector('.react-flow__viewport').style.transform!==${JSON.stringify(report.summary_viewport_before.transform)}`)
 report.summary_viewport_after=await evaluate(`({transform:document.querySelector('.react-flow__viewport').style.transform,zoom:document.querySelector('.canvas-zoom-readout').textContent,wheel:window.summaryWheel})`)
 assert.equal(report.summary_viewport_after.zoom,report.summary_viewport_before.zoom);assert.ok(report.summary_viewport_after.wheel.some(event=>event.trusted))
 const final=await rpc('canvas.nodes.snapshot',{boardId:summaryBoardId})
 assert.deepEqual(final.nodes.map(node=>node.id).sort(),summaryIds.slice().sort())
 record('native_wheel_pans_actual_64_card_viewport_without_mutating_or_losing_persisted_nodes')
 await writeFile(join(config.evidence,'02-real-64-summary-cards.png'),(await window.webContents.capturePage()).toPNG())
}
async function qualifyReadyDiff(window,{evaluate,wait,rpc}){
 window.unmaximize();window.setContentSize(1680,1000);window.webContents.setZoomFactor(1)
 const project=config.ready_diff_repository,relativePath='src/精确 #变更.txt',otherPath='src/另一处变更.txt',newPath='src/未跟踪.txt'
 const baseline='原内容甲\n保留行\n',updated='新内容乙\n保留行\n'
 const git=(cwd,...args)=>execFileSync(config.git_executable,['-C',cwd,...args],{encoding:'utf8',windowsHide:true}).trim()
 await mkdir(project);await mkdir(join(project,'src'))
 await writeFile(join(project,relativePath),baseline);await writeFile(join(project,otherPath),'另一文件原文\n')
 git(project,'init','-b','main');git(project,'config','user.name','工程测试');git(project,'config','user.email','fixture@example.invalid');git(project,'config','core.autocrlf','false')
 git(project,'add','.');git(project,'commit','-m','保存差异跳转测试的初始文件')
 const base=git(project,'rev-parse','HEAD')
 const member=await rpc('members.create',{commandId:randomUUID(),command:{displayName:'C02 本地协议工作区队员 '+basename(project),teamRole:'隔离工程测试',professionalResponsibilities:'本地协议响应，不连接外部模型。',personalityTraits:['严谨'],workingPrinciples:'固定协议夹具',growthTopic:''}})
 assert.equal(member.status,'applied',JSON.stringify(member));const agentId=member.resultEntity.entityId
 const {configureProductRuntime}=await import(config.runtime_configure_module)
 report.controlled_runtime=await configureProductRuntime(rpc,'qwen-code',[agentId])
 record('owned_controlled_acp_passes_original_product_runtime_gate_without_external_model')
 const created=await rpc('missions.create',{commandId:randomUUID(),command:{title:'C02 可用Git的精确Diff定位',description:'验证真实Core工作区准备与精确文件差异定位。',projectBindingKind:'directory',projectPath:project,memberAgentIds:[agentId],defaultLeadAgentId:agentId,tags:[]}})
 assert.equal(created.status,'applied',JSON.stringify(created));const {missionId,threadId}=created.payload
 report.ready_diff_context={missionId,threadId,agentId,project,relativePath,otherPath,newPath,base}
 const started=await rpc('missions.start',{commandId:randomUUID(),command:{missionId}})
 assert.equal(started.status,'accepted',JSON.stringify(started))
 await wait(`window.rovai.request('missions.delivery',{missionId:${JSON.stringify(missionId)}}).then(value=>value.git&&value.workspace?.state==='ready')`,60_000)
 const delivery=await rpc('missions.delivery',{missionId}),workspace=delivery.workspace
 assert.equal(workspace.missionId,missionId);assert.equal(workspace.threadId,threadId);assert.equal(workspace.baseSha,base)
 assert.equal(git(workspace.worktreePath,'rev-parse','HEAD'),base);assert.notEqual(workspace.worktreePath,project)
 report.ready_diff_context.workspace=workspace
 await wait(`window.rovai.request('threads.open',{threadId:${JSON.stringify(threadId)},traceId:${JSON.stringify(randomUUID())}}).then(value=>value.agentRuns.length>0&&value.agentRuns.every(run=>['succeeded','failed','cancelled'].includes(run.status)))`,60_000)
 report.controlled_run=await rpc('threads.open',{threadId,traceId:randomUUID()})
 assert.ok(report.controlled_run.agentRuns.every(run=>run.status==='succeeded'),JSON.stringify(report.controlled_run.agentRuns))
 record('real_core_prepares_managed_git_worktree_at_recorded_base_and_settles_controlled_protocol_run')
 const beforeIndex=git(workspace.worktreePath,'ls-files','--stage','-z')
 const indexPath=resolve(workspace.worktreePath,git(workspace.worktreePath,'rev-parse','--git-path','index'))
 const readIndex=async()=>({path:indexPath,sha256:createHash('sha256').update(await readFile(indexPath)).digest('hex'),mtime_ns:String((await stat(indexPath,{bigint:true})).mtimeNs)})
 const beforeIndexFile=await readIndex()
 await writeFile(join(config.evidence,'git-fixture-before.json'),JSON.stringify({workspace,files:{[relativePath]:await readFile(join(workspace.workingDirectory,relativePath),'utf8'),[otherPath]:await readFile(join(workspace.workingDirectory,otherPath),'utf8')},index:beforeIndex,index_file:beforeIndexFile},null,2)+'\n',{flag:'wx'})
 await writeFile(join(workspace.workingDirectory,relativePath),updated);await writeFile(join(workspace.workingDirectory,otherPath),'另一文件已修改\n');await writeFile(join(workspace.workingDirectory,newPath),'新建未跟踪文件\n')
 const changes=await rpc('missions.changes',{missionId});assert.equal(changes.diffError,null);assert.ok(changes.viewId)
 assert.deepEqual(changes.files.map(file=>file.path).sort(),[relativePath,otherPath,newPath].sort())
 const target=changes.files.find(file=>file.path===relativePath),diff=await rpc('missions.fileDiff',{missionId,viewId:changes.viewId,fileId:target.id})
 assert.equal(diff.file.path,relativePath);assert.ok(diff.patch.includes('-原内容甲')&&diff.patch.includes('+新内容乙'))
 assert.equal(git(workspace.worktreePath,'ls-files','--stage','-z'),beforeIndex);assert.deepEqual(await readIndex(),beforeIndexFile);assert.equal(git(project,'status','--porcelain'),'')
 report.real_changes=changes;report.real_diff=diff
 record('actual_core_git_diff_includes_exact_unicode_path_and_untracked_file_without_writing_real_index_or_source_checkout')
 const board=await rpc('canvas.boards.create',{commandId:randomUUID(),command:{name:'C02 可用工作区Diff卡'}})
 assert.equal(board.status,'applied',JSON.stringify(board));const boardId=board.payload.board.id
 const graph=await rpc('canvas.nodes.snapshot',{boardId}),pin=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId,expectedRevision:graph.board.revision,mutation:{type:'create',node:{kind:'conversation',conversation:{threadId,conversationId:null},objectReference:{kind:'mission_diff',missionId,path:relativePath},title:'精确文件变更',x:0,y:0,width:360,height:240}}}})
 assert.equal(pin.status,'applied',JSON.stringify(pin));const nodeId=pin.payload.nodeIds[0]
 Object.assign(report.ready_diff_context,{boardId,nodeId})
 const inspect=async()=>{
  await openCanvasBoard(evaluate,wait,boardId)
  await wait(`(()=>{const row=document.querySelector('[data-id="${nodeId}"]');return Boolean(row&&[...row.querySelectorAll('button')].find(button=>button.textContent==='读取详情'&&!button.disabled))})()`)
  await evaluate(`(()=>{[...document.querySelector('[data-id="${nodeId}"]').querySelectorAll('button')].find(button=>button.textContent==='读取详情').click();return true})()`)
  await wait(`document.querySelector('.canvas-object-details')?.dataset.missionId===${JSON.stringify(missionId)}`)
 }
 const close=async()=>{
  await evaluate(`(()=>{document.querySelector('.mission-diff-dialog button[aria-label="关闭累计文件变更"]')?.click();return true})()`)
  await wait(`!document.querySelector('.mission-diff-dialog')`)
  await evaluate(`(()=>{[...document.querySelector('.canvas-object-dialog').querySelectorAll('button')].find(button=>button.textContent==='关闭').click();return true})()`)
  await wait(`!document.querySelector('.canvas-object-dialog')`)
 }
 await inspect()
 await wait(`document.querySelector('.mission-diff-reading .diff-title-wrap strong')?.textContent===${JSON.stringify(relativePath)}&&document.querySelector('.mission-diff-code')?.textContent.includes('新内容乙')&&document.querySelector('.mission-diff-code')?.textContent.includes('原内容甲')`)
 assert.ok(await evaluate(`Boolean(document.querySelector('.mission-diff-dialog [data-file-id="${target.id}"][aria-selected="true"]'))`))
 record('actual_canvas_diff_pin_opens_original_mission_diff_view_and_exact_unicode_file_with_visible_before_after_lines')
 await writeFile(join(config.evidence,'01-ready-git-exact-diff.png'),(await window.webContents.capturePage()).toPNG())
 await close()
 await writeFile(join(config.evidence,'git-fixture-before-restore.json'),JSON.stringify({path:join(workspace.workingDirectory,relativePath),content:await readFile(join(workspace.workingDirectory,relativePath),'utf8')},null,2)+'\n',{flag:'wx'})
 await writeFile(join(workspace.workingDirectory,relativePath),baseline)
 await inspect()
 await wait(`document.querySelectorAll('.canvas-object-dialog .changes-tree-row.is-file').length===2`)
 assert.equal(await evaluate(`document.querySelector('.mission-diff-reading')!==null`),false)
 assert.equal(await evaluate(`document.querySelectorAll('.canvas-object-dialog [data-file-id][aria-selected="true"]').length`),0)
 record('formerly_changed_pinned_path_becoming_clean_keeps_original_pin_and_does_not_substitute_another_changed_file')
 await writeFile(join(config.evidence,'02-no-fallback-after-target-clean.png'),(await window.webContents.capturePage()).toPNG())
 await close()
 assert.equal(git(workspace.worktreePath,'ls-files','--stage','-z'),beforeIndex)
 const afterIndexFile=await readIndex();assert.deepEqual(afterIndexFile,beforeIndexFile)
 report.index_file_before=beforeIndexFile;report.index_file_after=afterIndexFile
 await writeFile(join(config.evidence,'git-index-after.json'),JSON.stringify(afterIndexFile,null,2)+'\n',{flag:'wx'})
 const final=await rpc('canvas.nodes.snapshot',{boardId});assert.equal(final.nodes.find(node=>node.id===nodeId).data.objectReference.path,relativePath)
 report.final_changes=await rpc('missions.changes',{missionId});assert.equal(report.final_changes.files.length,2)
 report.external_model_calls=0
}
async function qualifyPublicCold(window,{evaluate,wait,rpc}){
 window.unmaximize();window.setContentSize(1680,1000);window.webContents.setZoomFactor(1)
 const previous=JSON.parse(await readFile(config.public_previous_result,'utf8'));assert.equal(previous.status,'passed');assert.equal(previous.source_commit,config.source_commit)
 const summary=previous.summary_context,context=previous.public_context
 report.cold_context={...context,main_pid:process.pid,renderer_pid:window.webContents.getOSProcessId(),recovery:'fresh App; explicit board and card reopening, not automatic expanded-pin restoration'}
 await openCanvasBoard(evaluate,wait,summary.boardId)
 await wait(`document.querySelectorAll('.react-flow__node').length===64`)
 const graph=await rpc('canvas.nodes.snapshot',{boardId:summary.boardId});assert.deepEqual(graph.nodes.map(node=>node.id).sort(),summary.nodeIds.slice().sort())
 record('fresh_app_restores_64_exact_persisted_summary_nodes_without_recreating_references')
 await openCanvasBoard(evaluate,wait,context.boardId)
 const inputs=context.nodeIds.map(id=>`document.querySelector('.canvas-conversation-frame[data-canvas-conversation-key*="${id}"]')?.querySelector('.structured-mention-editor[contenteditable="true"]')`)
 for(const [index,id] of context.nodeIds.entries()){
  await wait(`Boolean(document.querySelector('[data-id="${id}"] button[aria-label="展开对话"]:not(:disabled)'))`)
  await evaluate(`(()=>{document.querySelector('[data-id="${id}"] button[aria-label="展开对话"]').click();return true})()`)
  await wait(`${inputs[index]}?.textContent===${JSON.stringify(context.texts[index])}`)
 }
 assert.ok(await evaluate(`new Set([${inputs.join(',')}]).size===3`))
 record('fresh_app_explicitly_reopened_public_pins_restore_three_distinct_bodies_including_previous_native_focus_input')
 for(const threadId of new Set(context.threads)){const projection=await rpc('threads.open',{threadId,traceId:randomUUID()});assert.deepEqual(projection.messages,[]);assert.deepEqual(projection.agentRuns,[])}
 record('public_cold_reopening_keeps_original_two_threads_without_sending_messages_or_starting_model_runs')
 await evaluate(`(()=>{document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]').click();return true})()`);await pause(350)
 await writeFile(join(config.evidence,'01-cold-public-pin-drafts.png'),(await window.webContents.capturePage()).toPNG())
}
if(config.mode==='source-ui'){
 assert.equal(createHash('sha256').update(await readFile(new URL(config.source_ui_module))).digest('hex'),config.source_ui_sha256)
 sourceUiWorkflow=await import(config.source_ui_module)
}
if(config.mode==='native-notifications'){
 assert.equal(createHash('sha256').update(await readFile(new URL(config.notification_module))).digest('hex'),config.notification_sha256)
 for(const [key,specification] of [['ROVAI_QWEN_BIN',config.controlled_launcher],['ROVAI_ACCEPTANCE_SCRIPT',config.controlled_script]]){
  assert.equal(process.env[key],specification.path);assert.equal(createHash('sha256').update(await readFile(specification.path)).digest('hex'),specification.sha256)
 }
 assert.equal(process.env.ROVAI_SKILL_RECOVERY_CAPTURE,config.runtime_capture)
 notificationWorkflow=await import(config.notification_module)
 privateIpc=notificationWorkflow.installNotificationIpc(ipcMain)
}
if(config.mode==='native-load'){
 assert.equal(createHash('sha256').update(await readFile(new URL(config.native_load_module))).digest('hex'),config.native_load_sha256)
 nativeLoadWorkflow=await import(config.native_load_module)
 privateIpc=nativeLoadWorkflow.installNativeLoadIpc(ipcMain)
}
if(config.mode==='terminal-input'){
 assert.equal(createHash('sha256').update(await readFile(new URL(config.terminal_input_module))).digest('hex'),config.terminal_input_sha256)
 assert.equal(createHash('sha256').update(await readFile(config.windows_input_script)).digest('hex'),config.windows_input_sha256)
 terminalWorkflow=await import(config.terminal_input_module)
 privateIpc=terminalWorkflow.installTerminalInputIpc(ipcMain)
}
if(config.mode==='file-resources'){
 for(const key of ['file_workflow','file_ipc'])assert.equal(createHash('sha256').update(await readFile(new URL(config[key+'_module']))).digest('hex'),config[key+'_sha256'])
 fileWorkflow=await import(config.file_workflow_module)
 privateIpc=(await import(config.file_ipc_module)).installCanvasFileIpc(ipcMain)
}
if(config.mode==='object-cold'){
 for(const key of ['object_workflow','object_ipc'])assert.equal(createHash('sha256').update(await readFile(new URL(config[key+'_module']))).digest('hex'),config[key+'_sha256'])
 for(const [key,specification] of [['ROVAI_QWEN_BIN',config.controlled_launcher],['ROVAI_ACCEPTANCE_SCRIPT',config.controlled_script]]){
  assert.equal(process.env[key],specification.path);assert.equal(createHash('sha256').update(await readFile(specification.path)).digest('hex'),specification.sha256)
 }
 assert.equal(process.env.ROVAI_SKILL_RECOVERY_CAPTURE,config.runtime_capture)
 objectWorkflow=await import(config.object_workflow_module)
 privateIpc=(await import(config.object_ipc_module)).installCanvasMissionIpc(ipcMain)
}
if(privateModes.includes(config.mode)){
 for(const [url,hash] of [[config.private_workflow_module,config.private_workflow_sha256],[config.private_ipc_module,config.private_ipc_sha256]]){
  const file=new URL(url);assert.equal(file.protocol,'file:')
  assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),hash)
 }
 for(const [key,specification] of [['ROVAI_QWEN_BIN',config.controlled_launcher],['ROVAI_ACCEPTANCE_SCRIPT',config.controlled_script]]){
  assert.ok(specification?.path&&specification.sha256);assert.equal(process.env[key],specification.path)
  assert.equal(createHash('sha256').update(await readFile(specification.path)).digest('hex'),specification.sha256)
 }
 assert.equal(process.env.ROVAI_SKILL_RECOVERY_CAPTURE,config.runtime_capture)
 privateWorkflow=await import(config.private_workflow_module)
 const {installCanvasPrivateIpc}=await import(config.private_ipc_module)
 privateIpc=installCanvasPrivateIpc(ipcMain)
}
await import(config.production_main)
privateIpc?.finishRegistration()
