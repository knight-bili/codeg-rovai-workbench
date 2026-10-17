import assert from 'node:assert/strict'
import { clipboard } from 'electron'
import { execFile } from 'node:child_process'
import { promisify, stripVTControlCharacters } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'

export function installTerminalInputIpc(ipcMain) {
 const register=ipcMain.handle,requests=[],faults=[];let target=null,registered=false
 ipcMain.handle=function(channel,handler){
  if(channel!=='rovai:request')return register.call(this,channel,handler)
  registered=true
  return register.call(this,channel,async(event,method,params)=>{
   requests.push({method,target:params?.target??null})
   if(target&&method==='canvas.terminals.snapshot'&&params?.target?.boardId===target.boardId&&params.target.nodeId===target.nodeId){
    faults.push({kind:'controlled_terminal_read_transport_failure',target:{...target}})
    return {kind:'failure',failure:{kind:'infrastructure_failure',code:'fixture_terminal_connection_unavailable',message:'受控测试：终端连接暂不可用。',retryable:true,generation:0,details:{}}}
   }
   return handler(event,method,params)
  })
 }
 return {finishRegistration(){ipcMain.handle=register;assert.ok(registered)},armReadFailure(value){assert.equal(target,null);target={...value}},releaseAll(){target=null},snapshot:()=>({requests,faults})}
}

export async function qualifyCanvasTerminalInput(window,{evaluate,wait,rpc,openCanvasBoard,config,report,record,seam}) {
 const invoke=promisify(execFile),failures=[]
 const hwnd=window.getNativeWindowHandle().readBigUInt64LE().toString()
 const physical=async action=>{
  const result=await invoke(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',config.windows_input_script,'-AppPid',String(process.pid),'-WindowHandle',hwnd,'-Action',action],{windowsHide:true,timeout:15_000,maxBuffer:16384})
  const value=JSON.parse(result.stdout.replace(/^\uFEFF/,''));(report.physical_input??=[]).push(value);return value
 }
 window.unmaximize();window.setContentSize(1440,920);window.webContents.setZoomFactor(1)
 const created=await rpc('canvas.boards.create',{commandId:randomUUID(),command:{name:'R07 Windows输入 '+config.revision,description:'真实输入法、剪贴板与终端重挂载',color:'blue'}})
 assert.equal(created.status,'applied');const boardId=created.payload.board.id
 const graph=await rpc('canvas.nodes.snapshot',{boardId})
 const added=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId,expectedRevision:graph.board.revision,mutation:{type:'create',node:{kind:'terminal',path:config.workspace,x:0,y:0,width:820,height:520}}}})
 assert.equal(added.status,'applied')
 const node=(await rpc('canvas.nodes.snapshot',{boardId})).nodes[0],target={boardId,nodeId:node.id},card=`.react-flow__node[data-id="${node.id}"]`
 report.terminal_input_context={boardId,target,mainPid:process.pid,workspace:config.workspace}
 const button=label=>`${card} button[aria-label="${label}"]`
 const click=async selector=>{await wait(`Boolean(document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled)`);return evaluate(`(()=>{document.querySelector(${JSON.stringify(selector)}).click();return true})()`)}
 const focus=async()=>{window.focus();window.webContents.focus();await evaluate(`(()=>{document.querySelector('${card} .xterm-helper-textarea').focus();return true})()`)}
 const enter=async()=>{await focus();await physical('enter')}
 const typeText=async text=>{for(const keyCode of text){window.webContents.sendInputEvent({type:'keyDown',keyCode});window.webContents.sendInputEvent({type:'char',keyCode});window.webContents.sendInputEvent({type:'keyUp',keyCode})}await pause(400)}
 const snapshot=()=>rpc('canvas.terminals.snapshot',{target,afterSeq:0})
 const output=async()=>stripVTControlCharacters(Buffer.concat((await snapshot()).chunks.map(x=>Buffer.from(x.bytesBase64,'base64'))).toString('utf8'))
 const waitOutput=async text=>{for(let i=0;i<80;i++){if((await output()).split(/\r?\n/).some(line=>line.trim()===text))return;await pause(100)}throw Error('Actual PTY output missing: '+text)}
 let restoreClipboard,restoreImeMode=false
 const formats=clipboard.availableFormats(),supported=new Set(['text/plain','text/html','text/rtf','image/png'])
 const clipboardAvailable=formats.every(x=>supported.has(x))
 if(clipboardAvailable){
  const original={},originalBytes={}
  if(formats.includes('text/plain'))original.text=clipboard.readText()
  if(formats.includes('text/html'))original.html=clipboard.readHTML()
  if(formats.includes('text/rtf'))original.rtf=clipboard.readRTF()
  if(formats.includes('image/png'))original.image=clipboard.readImage()
  for(const format of formats)originalBytes[format]=clipboard.readBuffer(format)
  restoreClipboard=()=>{clipboard.clear();if(formats.length)clipboard.write(original);assert.deepEqual(clipboard.availableFormats().sort(),[...formats].sort(),'Clipboard formats must be restored');for(const format of formats)assert.ok(clipboard.readBuffer(format).equals(originalBytes[format]),'Clipboard payload must be restored')}
 }
 try {
  await openCanvasBoard(evaluate,wait,boardId)
  await wait(`Boolean(document.querySelector('${button('启动终端')}')&&!document.querySelector('${button('启动终端')}').disabled)`)
  await click(button('启动终端'))
  await wait(`Boolean(document.querySelector('${card} .xterm-helper-textarea')&&!document.querySelector('${button('粘贴')}').disabled)`,30_000)
  await focus()
  await evaluate(`(()=>{window.r07InputEvents=[];window.r07SyntheticEnds=[];const original=EventTarget.prototype.dispatchEvent;EventTarget.prototype.dispatchEvent=function(event){if(event.type==='compositionend'&&this.classList?.contains('xterm-helper-textarea'))window.r07SyntheticEnds.push({data:event.data,stack:new Error().stack});return original.call(this,event)};for(const name of ['compositionstart','compositionupdate','compositionend','beforeinput','input'])document.addEventListener(name,event=>{if(event.target?.classList?.contains('xterm-helper-textarea'))window.r07InputEvents.push({type:event.type,data:event.data??null,isComposing:event.isComposing??null,trusted:event.isTrusted})},true);return true})()`)
  const initial=await snapshot();assert.equal(initial.phase,'running');report.generation=initial.generation
  record('fresh_isolated_native_terminal_starts_real_pty_and_uses_original_generation')
  try {
   assert.ok(clipboardAvailable,'IME command preparation needs a safely restorable clipboard')
   const imePath=join(config.workspace,'ime-result.txt'),prefix=`require('node:fs').writeFileSync(${JSON.stringify(imePath)},"`
   let composing=false
   for(let attempt=0;attempt<2;attempt++){
    await focus();const beforePrefix=await snapshot();clipboard.writeText(prefix);await click(button('粘贴'));await pause(600)
    assert.ok((await snapshot()).inputSequence>beforePrefix.inputSequence,'Command prefix must reach the real PTY before IME qualification')
    await evaluate('(()=>{window.r07InputEvents=[];return true})()')
    const before=await snapshot();await physical('compose')
    const events=await evaluate('window.r07InputEvents'),after=await snapshot()
    ;(report.ime_attempts??=[]).push({attempt,events,beforeInputSequence:before.inputSequence,afterInputSequence:after.inputSequence})
    composing=events.some(e=>e.type==='compositionstart'&&e.trusted)&&events.some(e=>e.type==='compositionupdate'&&e.trusted)
    if(composing){assert.equal(after.inputSequence,before.inputSequence,'Uncommitted IME leaked into PTY');break}
    await physical('clear')
    if(attempt===0){await physical('toggle-ime');restoreImeMode=true}
   }
   assert.ok(composing,'Physical Pinyin did not produce trusted Windows composition events')
   await physical('commit');await pause(250)
   report.ime_events=await evaluate('window.r07InputEvents')
   report.synthetic_composition_ends=await evaluate('window.r07SyntheticEnds')
   // Chromium150的compositionend经DispatchScopedEvent队列派发，不设置trusted；开始/更新/输入仍须真实可信。
   // https://github.com/chromium/chromium/blob/150.0.7871.114/third_party/blink/renderer/core/editing/ime/input_method_controller.cc#L396
   assert.equal(report.ime_events.filter(e=>e.type==='compositionend'&&e.data==='你好').length,1)
   assert.ok(report.ime_events.some(e=>e.type==='input'&&e.trusted&&e.data==='你好'))
   assert.equal(report.synthetic_composition_ends.length,0,'Test or application JavaScript must not synthesize composition completion')
   clipboard.writeText('");console.log("R07_IME_DONE")');await click(button('粘贴'));await pause(400);await enter();await waitOutput('R07_IME_DONE')
   const bytes=await readFile(imePath);assert.deepEqual(bytes,Buffer.from('你好'))
   report.ime_file={path:imePath,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length}
   record('actual_windows_pinyin_composition_sends_no_uncommitted_bytes_and_commits_exact_chinese_once')
  } catch(error) { failures.push(String(error.stack??error));report.ime_failure=failures.at(-1);await focus();await physical('cancel').catch(()=>{});await physical('clear').catch(()=>{}) }

  if(!clipboardAvailable){report.clipboard_deferred={formats,reason:'Existing format cannot be losslessly restored; no clipboard mutation performed'};failures.push('Clipboard qualification deferred: existing unsupported format')}
  else {
   const pastePath=join(config.workspace,'剪贴板-实际提交.txt'),value='中文剪贴板😀',command=`require('node:fs').writeFileSync(${JSON.stringify(pastePath)},${JSON.stringify(value)});console.log("R07_PASTE_DONE")`
   clipboard.writeText(command);await click(button('粘贴'));await pause(400);await enter();await waitOutput('R07_PASTE_DONE')
   assert.deepEqual(await readFile(pastePath),Buffer.from(value))
   record('actual_clipboard_button_pastes_exact_chinese_and_emoji_into_real_pty')
   const marker='R07_COPY_原生中文',copyCommand=`console.log(${JSON.stringify(marker)})`
   clipboard.writeText(copyCommand);await click(button('粘贴'));await pause(400);await enter()
   await wait(`Array.from(document.querySelectorAll('${card} .xterm-rows > div')).some(row=>row.textContent?.trim()===${JSON.stringify(marker)})`)
   const rect=await evaluate(`(()=>{const row=[...document.querySelectorAll('${card} .xterm-rows > div')].find(row=>row.textContent?.trim()===${JSON.stringify(marker)}),r=row.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`)
   const y=Math.round(rect.y+rect.height/2),left=Math.round(rect.x+1),right=Math.round(rect.x+rect.width-1)
   window.webContents.sendInputEvent({type:'mouseDown',x:left,y,button:'left',clickCount:1});window.webContents.sendInputEvent({type:'mouseMove',x:right,y,button:'left'});window.webContents.sendInputEvent({type:'mouseUp',x:right,y,button:'left',clickCount:1})
   await focus();await physical('copy');assert.equal(clipboard.readText(),marker)
   record('native_terminal_selection_and_windows_copy_shortcut_write_exact_system_clipboard')
   restoreClipboard();restoreClipboard=null;report.clipboard_original_restored=true
  }
  const before=await snapshot();await click(button('收起终端'));await wait(`!document.querySelector('${card} .canvas-terminal')`)
  const collapsed=await snapshot();assert.equal(collapsed.generation,before.generation);assert.equal(collapsed.inputSequence,before.inputSequence)
  await click(button('展开终端'));await wait(`Boolean(document.querySelector('${card} .xterm-helper-textarea'))`)
  await click(button('重新读取'));await pause(700)
  const reopened=await snapshot();assert.equal(reopened.generation,before.generation);assert.equal(reopened.inputSequence,before.inputSequence)
  seam.armReadFailure(target);await click(button('重新读取'))
  await wait(`document.querySelector('${card} [role="alert"]')?.textContent.includes('受控测试：终端连接暂不可用。')&&document.querySelector('${button('粘贴')}').disabled`)
  seam.releaseAll()
  assert.equal((await snapshot()).inputSequence,before.inputSequence)
  await click(button('重新读取'));await wait(`!document.querySelector('${card} [role="alert"]')&&!document.querySelector('${button('粘贴')}').disabled`)
  const recovered=await snapshot();assert.equal(recovered.generation,before.generation);assert.equal(recovered.inputSequence,before.inputSequence)
  record('controlled_native_read_transport_error_disables_input_then_explicit_refresh_recovers_same_shell_without_replay')
  await focus();await typeText('2+3');await enter();await wait(`Array.from(document.querySelectorAll('${card} .xterm-rows > div')).some(row=>row.textContent?.trim()==='5')`)
  record('collapse_reopen_and_explicit_refresh_keep_original_shell_and_do_not_replay_old_input')
  const shot=join(config.evidence,'01-windows-terminal-input.png');await writeFile(shot,(await window.webContents.capturePage()).toPNG());report.screenshots=[shot]
 } finally {
  seam.releaseAll()
  if(restoreClipboard){try{restoreClipboard();report.clipboard_original_restored=true}catch(error){failures.push(String(error.stack??error));report.clipboard_restore_failed=true}}
  if(restoreImeMode){try{await focus();await physical('toggle-ime');report.ime_mode_restored=true}catch(error){failures.push(String(error.stack??error));report.ime_mode_restore_failed=true}}
  const value=await snapshot()
  if(value.exists&&!value.cleanupComplete){
   if(await evaluate(`Boolean(document.querySelector('${button('展开终端')}'))`))await click(button('展开终端'))
   await wait(`Boolean(document.querySelector('${button('停止终端')}')&&!document.querySelector('${button('停止终端')}').disabled)`)
   await click(button('停止终端'));await wait(`window.rovai.request('canvas.terminals.snapshot',{target:${JSON.stringify(target)}}).then(value=>value.cleanupComplete===true)`)
  }
  report.final_terminal=await snapshot();assert.equal(report.final_terminal.cleanupComplete,true)
  record('native_input_test_stops_and_reaps_its_owned_terminal')
 }
 if(failures.length)throw Error(failures.join('\n'))
}
