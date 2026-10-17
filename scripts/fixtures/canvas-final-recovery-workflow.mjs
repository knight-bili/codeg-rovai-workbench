import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {readFile,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {stripVTControlCharacters} from 'node:util'
import {setTimeout as pause} from 'node:timers/promises'

// 最终候选的真实App/Core冷启动；业务事实只由原Core命令建立，窗口操作使用原入口。
export async function qualifyCanvasSourceUi(window,{evaluate,wait,rpc,openCanvasBoard,config,report,record}){
 const click=async expression=>{
  await wait(`(()=>{const n=(${expression});if(!n||n.disabled)return false;const r=n.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return Boolean(h&&n.contains(h))})()`)
  const point=await evaluate(`(()=>{const r=(${expression}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  for(const type of ['mouseMove','mouseDown','mouseUp'])window.webContents.sendInputEvent({type,...point,...(type==='mouseMove'?{}:{button:'left',clickCount:1})})
 }
 const button=text=>`Array.from(document.querySelectorAll('button')).find(n=>n.textContent?.trim()===${JSON.stringify(text)})`
 const menu=text=>`Array.from(document.querySelectorAll('[role="menuitem"]')).find(n=>n.textContent?.trim()===${JSON.stringify(text)})`
 const type=async(expression,text)=>{await click(expression);for(const event of ['keyDown','keyUp'])window.webContents.sendInputEvent({type:event,keyCode:'A',modifiers:['control']});await window.webContents.insertText(text);await wait(`(${expression}).value===${JSON.stringify(text)}`)}
 const until=async predicate=>{const end=Date.now()+20000;while(Date.now()<end){const result=await predicate();if(result)return result;await pause(80)}throw Error('Actual Core state did not settle')}
 const core=()=>rpc('canvas.nodes.snapshot',{boardId:context.boardId})
 const node=kind=>context.nodes.find(n=>n.data.kind===kind)
 const terminal=()=>rpc('canvas.terminals.snapshot',{target:{boardId:context.boardId,nodeId:node('terminal').id},afterSeq:0})
 const camera=()=>evaluate(`(()=>{const m=new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform);return[m.a,m.d,m.e,m.f]})()`)
 const shot=async name=>{await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');const path=join(config.evidence,name+'.png');await writeFile(path,(await window.webContents.capturePage()).toPNG());(report.screenshots??=[]).push(path)}
 const rendered=async()=>{
  await wait(`document.querySelector('.canvas-board-title')?.getAttribute('data-board-id')===${JSON.stringify(context.boardId)}`)
  for(const item of context.nodes)await wait(`Boolean(document.querySelector('.react-flow__node[data-id="${item.id}"] article'))`)
  await wait(`Array.from(document.querySelectorAll('.canvas-card-file')).some(n=>n.textContent.includes(${JSON.stringify(context.sourceText.trim())}))`)
  await wait(`document.querySelector('.canvas-card-note')?.textContent.includes('八类冷恢复便签')`)
  await wait(`!document.querySelector('.canvas-region.is-unresolved')`)
 }
 let context
 window.unmaximize();window.setContentSize(1440,920);window.webContents.setZoomFactor(1)
 if(config.formal_phase==='prepare'){
  const profiles=await rpc('members.list'),member=profiles.find(p=>!p.removedAt);assert.ok(member)
  const mission=await rpc('missions.create',{commandId:randomUUID(),command:{title:'R10 原工程恢复',description:'只核对布局和生命周期，不投递模型。',projectBindingKind:'directory',projectPath:config.workspace,memberAgentIds:[member.agentId],defaultLeadAgentId:member.agentId,tags:[]}});assert.equal(mission.status,'applied')
  const primary=await rpc('canvas.boards.create',{commandId:randomUUID(),command:{name:'R10 八类恢复主画板'}});assert.equal(primary.status,'applied')
  const secondary=await rpc('canvas.boards.create',{commandId:randomUUID(),command:{name:'R10 独立第二画板',description:'另一个画板的布局不可串入主画板。'}});assert.equal(secondary.status,'applied')
  context={dataRoot:config.data_root,mainPid:process.pid,boardId:primary.payload.board.id,otherBoardId:secondary.payload.board.id,threadId:mission.payload.threadId,sourceFile:join(config.workspace,'R10 原文件.txt'),sourceText:'R10 八类冷恢复文件🙂\n',nodes:[]}
  await writeFile(context.sourceFile,context.sourceText,{flag:'wx'});context.sourceSha256=createHash('sha256').update(await readFile(context.sourceFile)).digest('hex')
  await openCanvasBoard(evaluate,wait,context.boardId)
  await click('document.querySelector(".canvas-board-title")');await click(menu('管理项目分组'));await click(button('新建项目分组'))
  await type('document.querySelector(".app-dialog input[data-dialog-autofocus]")','R10 恢复项目分组');await click(button('保存分组'));await wait('!document.querySelector(".project-groups-members")');await click(button('完成'))
  const preferences=await evaluate('window.rovai.navigationPreferences.get()'),group=preferences.projectGroups.find(g=>g.name==='R10 恢复项目分组');assert.ok(group);context.groupId=group.id
  const kinds=['folder','group','agent','conversation','custom','note','file','terminal']
  for(const [i,kind] of kinds.entries()){
   const snapshot=await core(),data={kind,title:`R10 ${kind}`,x:i%4*540,y:Math.floor(i/4)*390,width:kind==='conversation'?224:480,height:kind==='conversation'?132:310,
    ...(kind==='folder'?{folderPath:config.workspace}:{}),...(kind==='group'?{folderGroupId:group.id}:{}),...(kind==='agent'?{agentId:member.agentId}:{}),
    ...(kind==='conversation'?{conversation:{threadId:context.threadId,conversationId:null}}:{}),...(kind==='custom'?{conversations:[{threadId:context.threadId,conversationId:null}]}:{}),
    ...(kind==='note'?{content:'## 八类冷恢复便签\n保持原正文与原节点身份。'}:{}),...(kind==='file'?{path:context.sourceFile,fileReference:{threadId:context.threadId}}:{}),...(kind==='terminal'?{path:config.workspace}:{})}
   const created=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId:context.boardId,expectedRevision:snapshot.board.revision,mutation:{type:'create',node:data}}});assert.equal(created.status,'applied',JSON.stringify(created))
  }
  context.primary=await core();context.nodes=context.primary.nodes;assert.equal(context.nodes.length,8)
  let other=await rpc('canvas.nodes.snapshot',{boardId:context.otherBoardId})
  const pinned=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId:context.otherBoardId,expectedRevision:other.board.revision,mutation:{type:'create',node:{kind:'note',title:'第二板独立节点',content:'R10 第二画板专属',x:31,y:47,width:320,height:220}}}});assert.equal(pinned.status,'applied');context.secondary=await rpc('canvas.nodes.snapshot',{boardId:context.otherBoardId})
  await rendered();record('current_candidate_real_core_creates_all_eight_bound_types_and_independent_second_board_rendering_original_file_and_note')
  await click('document.querySelector(\'.canvas-dock-panel button[aria-label="查看全部"]\')');await pause(500)
  await click(`document.querySelector('.react-flow__node[data-id="${node('terminal').id}"] button[aria-label="启动终端"]')`)
  const running=await until(async()=>{const s=await terminal();return s.phase==='running'?s:false});context.terminalBefore=running
  const marker='R10_COLD_'+randomUUID().replaceAll('-',''),bytes=Buffer.from(`console.log(${JSON.stringify(marker)})\r`,'utf8')
  report.terminal_program={shell:process.env.SHELL,language:'Node.js REPL from the explicit isolated test SHELL; real OS PTY, no runtime model'}
  await rpc('canvas.terminals.write',{target:running.target,generation:running.generation,inputId:randomUUID(),expectedInputSequence:running.inputSequence,bytesBase64:bytes.toString('base64')})
  const output=await until(async()=>{const s=await terminal(),text=stripVTControlCharacters(Buffer.concat(s.chunks.map(c=>Buffer.from(c.bytesBase64,'base64'))).toString('utf8'));return text.split(/\r?\n/).some(line=>line.trim()===marker)?s:false})
  assert.equal(output.generation,running.generation);await rpc('canvas.terminals.stop',{target:running.target,generation:running.generation});await until(async()=>{const s=await terminal();return s.cleanupComplete?s:false})
  record('current_candidate_original_start_button_launches_real_pty_with_exact_output_then_explicit_stop_reaps_before_cold_restart')
  await openCanvasBoard(evaluate,wait,context.otherBoardId);await wait(`document.querySelector('.canvas-card-note')?.textContent.includes('R10 第二画板专属')`)
  await openCanvasBoard(evaluate,wait,context.boardId);await rendered();await click('document.querySelector(\'.canvas-dock-panel button[aria-label="查看全部"]\')');await pause(500)
  context.camera=await camera();context.primary=await core();context.nodes=context.primary.nodes
  context.boards=(await rpc('canvas.boards.list')).boards;await shot('prepare-all-eight');await writeFile(join(config.evidence,'recovery-context.json'),JSON.stringify(context,null,2)+'\n',{flag:'wx'})
  record('two_board_switch_keeps_own_nodes_and_persists_exact_primary_board_selection_camera_and_bindings_for_next_app')
 }else{
  assert.equal(config.formal_phase,'resume');assert.equal(createHash('sha256').update(await readFile(config.formal_checkpoint)).digest('hex'),config.formal_checkpoint_sha256)
  context=JSON.parse(await readFile(config.formal_checkpoint,'utf8'));assert.equal(resolve(context.dataRoot),resolve(config.data_root));assert.notEqual(process.pid,context.mainPid)
  const snapshot=await core(),other=await rpc('canvas.nodes.snapshot',{boardId:context.otherBoardId}),boards=(await rpc('canvas.boards.list')).boards
  assert.deepEqual(snapshot.board,context.primary.board);assert.deepEqual(snapshot.nodes,context.primary.nodes);assert.deepEqual(other.board,context.secondary.board);assert.deepEqual(other.nodes,context.secondary.nodes);assert.deepEqual(boards,context.boards)
  assert.equal(createHash('sha256').update(await readFile(context.sourceFile)).digest('hex'),context.sourceSha256)
  const preferences=await evaluate('window.rovai.navigationPreferences.get()');assert.ok(preferences.projectGroups.some(g=>g.id===context.groupId&&g.name==='R10 恢复项目分组'))
  record('fresh_app_core_preserve_both_board_metadata_all_eight_exact_nodes_original_file_bytes_and_device_project_group')
  await click('document.querySelector(\'button[aria-label="无限画布"]\')');await rendered()
  const restored=await camera();assert.ok(restored.every((n,i)=>Math.abs(n-context.camera[i])<(i<2?.001:2)),JSON.stringify({expected:context.camera,actual:restored}))
  record('fresh_app_original_canvas_entry_restores_selected_board_and_camera_without_test_reselection_or_fit')
  const missing=await terminal();assert.notEqual(missing.coreGeneration,context.terminalBefore.coreGeneration);assert.equal(missing.exists,false)
  report.recovery={mainPidBefore:context.mainPid,mainPidAfter:process.pid,coreGenerationBefore:context.terminalBefore.coreGeneration,coreGenerationAfter:missing.coreGeneration,terminal:missing,camera:restored}
  const thread=await rpc('threads.open',{threadId:context.threadId,traceId:randomUUID()});assert.deepEqual(thread.messages,[]);assert.deepEqual(thread.agentRuns,[])
  record('fresh_core_does_not_fabricate_a_restored_ephemeral_shell_or_replay_old_input_or_start_any_model_run')
  await shot('resumed-all-eight');await openCanvasBoard(evaluate,wait,context.otherBoardId);await wait(`document.querySelector('.canvas-card-note')?.textContent.includes('R10 第二画板专属')`)
  await openCanvasBoard(evaluate,wait,context.boardId);await rendered();record('fresh_app_can_reopen_both_original_boards_and_resolve_the_same_file_and_conversation_bindings')
 }
}
