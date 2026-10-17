import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {writeFile,readFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {join} from 'node:path'
import {setTimeout as pause} from 'node:timers/promises'

export async function qualifyCanvasBoardUi(window,{evaluate,wait,rpc,config,report,record,click,key,text,button,menu,screenshot}){
 report.board_ui={boards:[],layouts:[],menuKeys:[]}
 const checkpoint=()=>writeFile(join(config.evidence,'layout-progress.json'),JSON.stringify({board_ui:report.board_ui,checks:report.checks,artifacts:report.ui_artifacts,at:new Date().toISOString()},null,2)+'\n')
 for(let n=0;n<12;n++){
  const created=await rpc('canvas.boards.create',{commandId:randomUUID(),command:{name:'R09 原列表 '+String(n).padStart(2,'0'),description:n===0?'用于检查描述自然排布和最后一项可达。'.repeat(7):'原版紧凑画板卡片',color:n%2?'blue':null}});assert.equal(created.status,'applied');const board=created.payload.board
  if(n===0){const graph=await rpc('canvas.nodes.snapshot',{boardId:board.id}),added=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId:board.id,expectedRevision:graph.board.revision,mutation:{type:'create',node:{kind:'note',title:'纵向轮廓',content:'真实便签',x:0,y:0,width:150,height:1000}}}});assert.equal(added.status,'applied')}
  report.board_ui.boards.push(board.id)
 }
 const targetId=report.board_ui.boards[0]
 await click('document.querySelector(\'button[aria-label="无限画布"]\')');await wait('Boolean(document.querySelector(".canvas-breadcrumb-root:not(:disabled)"))');await click('document.querySelector(".canvas-breadcrumb-root")')
 await wait('document.querySelectorAll(".canvas-board-item").length===12')
 const originalAppearance=await evaluate('window.rovai.appearance.get()');report.board_ui.originalAppearance=originalAppearance
 try{
  for(const theme of ['day','night']){
   await evaluate(`window.rovai.appearance.setPreference(${JSON.stringify(theme)})`);await wait(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`)
   window.setContentSize(1040,700);await pause(200)
   const list='document.querySelector(".canvas-board-scroll")'
   const p=await evaluate(`(()=>{const r=${list}.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
   await evaluate('(()=>{window.r09Wheel=[];document.querySelector(".canvas-board-scroll").addEventListener("wheel",event=>window.r09Wheel.push({trusted:event.isTrusted,dy:event.deltaY}),{passive:true});return true})()')
   let direction=-1;const wheelSteps=[]
   for(let step=0;step<16;step++){
    const before=await evaluate(`${list}.scrollTop`)
    window.webContents.sendInputEvent({type:'mouseMove',...p});window.webContents.sendInputEvent({type:'mouseWheel',...p,modifiers:[],deltaX:0,deltaY:direction*1200,canScroll:true});await pause(120)
    const after=await evaluate(`${list}.scrollTop`);wheelSteps.push({before,after,direction})
    if(step===0&&after===before)direction=1
    if(await evaluate(`${list}.scrollTop+${list}.clientHeight>=${list}.scrollHeight-1`))break
   }
   report.board_ui.wheelSteps??=[];report.board_ui.wheelSteps.push({theme,steps:wheelSteps})
   const metrics=await evaluate(`(()=>{const main=document.querySelector('.content.canvas-content'),work=document.querySelector('.canvas-workspace'),list=${list},last=list.querySelector('.canvas-board-create'),r=list.getBoundingClientRect(),b=last.getBoundingClientRect();return{theme:document.documentElement.dataset.theme,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},padding:[getComputedStyle(main).paddingTop,getComputedStyle(main).paddingRight,getComputedStyle(main).paddingBottom,getComputedStyle(main).paddingLeft],outerExtraX:main.scrollWidth-main.clientWidth,outerExtraY:main.scrollHeight-main.clientHeight,widthGap:Math.abs(main.getBoundingClientRect().width-work.getBoundingClientRect().width),heightGap:Math.abs(main.getBoundingClientRect().height-work.getBoundingClientRect().height),listExtraY:list.scrollHeight-list.clientHeight,scrollTop:list.scrollTop,lastVisible:b.top>=r.top-1&&b.bottom<=r.bottom+1,wheel:window.r09Wheel,cards:Array.from(document.querySelectorAll('.canvas-board-item')).map(card=>({height:card.getBoundingClientRect().height,copy:card.querySelector('.canvas-board-copy').getBoundingClientRect().height,preview:card.querySelector('.canvas-board-preview').getBoundingClientRect().height}))}})()`)
   report.board_ui.layouts.push(metrics);await checkpoint()
   assert.deepEqual(metrics.padding,['0px','0px','0px','0px']);assert.ok(metrics.outerExtraX<=1&&metrics.outerExtraY<=1&&metrics.widthGap<=1&&metrics.heightGap<=1);assert.ok(metrics.listExtraY>0&&metrics.scrollTop>0&&metrics.lastVisible,JSON.stringify(metrics));assert.ok(metrics.wheel.some(event=>event.trusted));assert.ok(Math.max(...metrics.cards.map(c=>c.height))-Math.min(...metrics.cards.map(c=>c.height))<=1)
   await screenshot('board-list-'+theme,join(config.evidence,'board-list-'+theme+'.png'));record('actual_'+theme+'_small_window_keeps_compact_equal_cards_single_scroll_and_trusted_wheel_reaches_last_create_button');await checkpoint()
  }
  window.setContentSize(1440,920);await pause(180)
  const tile=`document.querySelector('.canvas-board-tile[data-board-id="${targetId}"]')`
  await click(tile);await wait(`document.querySelector('.canvas-board-title')?.dataset.boardId===${JSON.stringify(targetId)}`);await click('document.querySelector(".canvas-breadcrumb-root")');await wait(`Boolean(${tile})`)
  await evaluate(`(()=>{${tile}.scrollIntoView({block:'center'});${tile}.focus();window.r09MenuKeys=[];${tile}.addEventListener('keydown',event=>window.r09MenuKeys.push({key:event.key,code:event.code,trusted:event.isTrusted}));return true})()`)
  assert.equal(createHash('sha256').update(await readFile(config.windows_menu_script)).digest('hex'),config.windows_menu_sha256)
  report.board_ui.menuInput=JSON.parse(execFileSync(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',config.windows_menu_script,'-OwnedPid',String(process.pid),'-Hwnd',window.getNativeWindowHandle().readBigUInt64LE().toString(),'-DataRoot',config.data_root],{encoding:'utf8',windowsHide:true}))
  await pause(100);report.board_ui.menuKeys=await evaluate('window.r09MenuKeys');await checkpoint();await wait('Boolean(document.querySelector(".canvas-board-context-menu"))');assert.ok(report.board_ui.menuKeys.some(event=>event.key==='ContextMenu'&&event.trusted))
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".canvas-board-context-menu [role=menuitem]")).map(node=>node.textContent.trim())'),['打开画板','编辑画板','删除画板'])
  await key('Escape');await wait(`!document.querySelector('.canvas-board-context-menu')&&document.activeElement===${tile}`);record('actual_windows_menu_key_opens_original_board_actions_and_escape_restores_exact_focus')
  await click(tile);await wait(`document.querySelector('.canvas-board-title')?.dataset.boardId===${JSON.stringify(targetId)}`)
  await click('document.querySelector(".canvas-board-title")');await click(menu('编辑画板'));await wait('Boolean(document.querySelector(".canvas-board-dialog input[data-dialog-autofocus]"))')
  const editedName='R09 画板原编辑 已保存'
  await text('document.querySelector(".canvas-board-dialog input[data-dialog-autofocus]")',editedName)
  const original=(await rpc('canvas.boards.list')).boards.find(board=>board.id===targetId)
  const external=await rpc('canvas.boards.update',{commandId:randomUUID(),command:{boardId:targetId,expectedRevision:original.revision,name:original.name,description:'外部实际更新，核对后继续',color:original.color}});assert.equal(external.status,'applied')
  await wait('document.querySelector(".canvas-board-dialog").textContent.includes("画板已有新修改，输入仍保留")');assert.equal(await evaluate('document.querySelector(".canvas-board-dialog button[type=submit]").disabled'),true);assert.equal(await evaluate('document.querySelector(".canvas-board-dialog input").value'),editedName)
  await click(button('使用最新画布版本','document.querySelector(".canvas-board-dialog")'));await click('document.querySelector(".canvas-board-dialog button[type=submit]")');await wait('!document.querySelector(".canvas-board-dialog")')
  const saved=(await rpc('canvas.boards.list')).boards.find(board=>board.id===targetId);assert.equal(saved.name,editedName);record('actual_board_edit_preserves_input_during_external_revision_and_saves_only_after_explicit_latest_version')
  await click('document.querySelector(".canvas-board-title")');await click(menu('删除画板'));await wait('Boolean(document.querySelector(".canvas-board-dialog"))');await wait('document.querySelector(".canvas-board-dialog").textContent.includes("将删除 1 个节点。")');await screenshot('board-delete',join(config.evidence,'board-delete.png'))
  await click(button('取消','document.querySelector(".canvas-board-dialog")'));await wait('!document.querySelector(".canvas-board-dialog")');assert.equal((await rpc('canvas.nodes.snapshot',{boardId:targetId})).nodes.length,1)
  await click('document.querySelector(".canvas-board-title")');await click(menu('删除画板'));await wait('Boolean(document.querySelector(".canvas-board-dialog"))');await click('document.querySelector(".canvas-board-dialog button[type=submit]")');await wait('!document.querySelector(".canvas-board-dialog")&&Boolean(document.querySelector(".canvas-board-title:not(:disabled)"))')
  const remaining=await rpc('canvas.boards.list');assert.equal(remaining.boards.length,11);assert.ok(!remaining.boards.some(board=>board.id===targetId));const fallback=await evaluate('document.querySelector(".canvas-board-title").dataset.boardId');assert.ok(remaining.boards.some(board=>board.id===fallback));record('actual_current_board_delete_warns_exact_count_cancel_preserves_then_confirm_selects_a_real_remaining_board')
  report.board_ui.fallbackBoardId=fallback
  await click('document.querySelector(".canvas-breadcrumb-root")');await wait('Boolean(document.querySelector(".canvas-boards-home"))');await text('document.querySelector("input[aria-label=搜索画板]")','R09 不存在的画板');await wait('document.querySelector(".canvas-board-grid").textContent.includes("没有匹配的画板")');record('actual_board_search_empty_state_keeps_the_original_board_catalog')
 }finally{
  await evaluate(`window.rovai.appearance.setPreference(${JSON.stringify(originalAppearance.preference)})`).catch(()=>{});await checkpoint()
 }
}
