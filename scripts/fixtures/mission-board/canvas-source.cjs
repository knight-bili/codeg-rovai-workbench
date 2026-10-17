const assert=require('node:assert/strict')
const {mkdirSync,writeFileSync}=require('node:fs')
const {join,isAbsolute}=require('node:path')
const {app,BrowserWindow}=require('electron')
const [renderer,userData,mode='diff',theme='day']=process.argv.slice(2)
assert(isAbsolute(renderer)&&isAbsolute(userData))
mkdirSync(userData,{recursive:true});app.setPath('userData',userData);app.setPath('sessionData',join(userData,'session'))
app.whenReady().then(async()=>{
 const window=new BrowserWindow({show:false,width:1440,height:920,useContentSize:true,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}})
 const read=expression=>window.webContents.executeJavaScript(expression,true)
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
 const wait=async expression=>{for(let i=0;i<160;i++){if(await read(expression))return;await pause(50)}throw Error('Timed out: '+expression)}
 const report={mode,theme,scope:'production Renderer with closed memory projections; no Core, Git, PTY or model',checks:[],status:'running'}
 try{
  await window.loadFile(renderer,{query:{[{diff:'canvasDiff',resize:'canvasResize',boards:'canvasBoards'}[mode]]:'1',theme}})
  if(mode==='diff'){
   await wait(`Boolean(document.querySelector('.canvas-object-dialog .changes-tree-search input'))`)
   await pause(300)
   const geometry=()=>read(`(()=>{const input=document.querySelector('.canvas-object-dialog .changes-tree-search input'),shell=input.parentElement,a=input.getBoundingClientRect(),b=shell.getBoundingClientRect(),style=getComputedStyle(input);return {inputHeight:a.height,shellHeight:b.height,top:a.top,innerTop:b.top+shell.clientTop,bottom:a.bottom,innerBottom:b.top+shell.clientTop+shell.clientHeight,border:style.borderTopWidth,background:style.backgroundColor,minHeight:style.minHeight,fontSize:style.fontSize}})()`)
   report.before=await geometry()
   await window.webContents.capturePage().then(image=>writeFileSync(join(userData,'before.png'),image.toPNG()))
   assert.equal(report.before.border,'0px','The original composite search owns the single border')
   assert(report.before.top>=report.before.innerTop-.5&&report.before.bottom<=report.before.innerBottom+.5,'Search input must fit the original search container')
   assert.equal(report.before.fontSize,'12px','The original composite search keeps its own text density')
   await read(`(()=>{document.querySelector('.changes-tree-search input').focus();return true})()`)
   report.focused=await geometry();assert.equal(report.focused.border,'0px')
   assert(report.focused.top>=report.focused.innerTop-.5&&report.focused.bottom<=report.focused.innerBottom+.5,'Focused input must also fit its container')
   report.checks.push('composite_search_keeps_one_border_and_fits_dialog_at_rest_and_focus')
   // Unrelated dialog fields must keep their original form treatment.
   report.control=await read(`(()=>{const input=document.createElement('input');document.querySelector('.canvas-object-dialog').append(input);const style=getComputedStyle(input);const result={border:style.borderTopWidth,minHeight:style.minHeight};input.remove();return result})()`)
   assert(Number.parseFloat(report.control.border)>0);assert.equal(report.control.minHeight,'40px')
   report.checks.push('ordinary_dialog_fields_keep_their_existing_border_and_height')
  }else if(mode==='boards'){
   await wait(`Boolean(document.querySelector('.canvas-board-title:not(:disabled)'))`)
   await read(`document.querySelector('.canvas-breadcrumb-root').click()`)
   await wait(`document.querySelectorAll('.canvas-board-item').length===10`)
   report.layouts=[]
   for(const [width,height] of [[1040,700],[1440,920]]){
    window.setContentSize(width,height);await wait(`window.innerWidth===${width}&&window.innerHeight===${height}`)
    await read(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
    const layout=await read(`(()=>{const cards=[...document.querySelectorAll('.canvas-board-item')];const list=document.querySelector('.canvas-board-scroll');return {width:innerWidth,height:innerHeight,outerExtra:document.documentElement.scrollHeight-innerHeight,horizontalExtra:list.scrollWidth-list.clientWidth,cards:cards.map(card=>{const preview=card.querySelector('.canvas-board-preview'),copy=card.querySelector('.canvas-board-copy'),style=getComputedStyle(copy),children=[...copy.children];return {height:card.getBoundingClientRect().height,previewHeight:preview.getBoundingClientRect().height,copyHeight:copy.getBoundingClientRect().height,intrinsicCopy:children.reduce((sum,child)=>sum+child.getBoundingClientRect().height,0)+parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)+parseFloat(style.gap)*(children.length-1)}})}})()`)
    report.layouts.push(layout)
    const copyHeight=Math.max(...layout.cards.map(card=>card.intrinsicCopy))
    assert(layout.cards.every(card=>card.height<=card.previewHeight+copyHeight+3),'Cards must fit their preview and compact copy without blank filler')
    assert(Math.max(...layout.cards.map(card=>card.height))-Math.min(...layout.cards.map(card=>card.height))<1,'All original grid rows keep equal card heights')
    assert(layout.outerExtra<=1&&layout.horizontalExtra<=1,'Only the board list may scroll vertically')
   }
   report.checks.push('original_board_cards_fit_their_content_and_keep_equal_rows_at_two_window_sizes')
   report.lastTile=await read(`(()=>{const list=document.querySelector('.canvas-board-scroll'),last=document.querySelector('.canvas-board-create');list.scrollTop=list.scrollHeight;return {scrollTop:list.scrollTop,visible:last.getBoundingClientRect().bottom<=list.getBoundingClientRect().bottom+1}})()`)
   assert(report.lastTile.scrollTop>0&&report.lastTile.visible)
   report.checks.push('one_scroll_owner_keeps_the_last_create_tile_reachable')
   await read(`document.querySelector('.canvas-board-scroll').scrollTop=0`)
   report.runtimeErrors=await read(`window.missionQA.errors`);assert.deepEqual(report.runtimeErrors,[])
  }else{
   await wait(`document.querySelectorAll('.canvas-conversation-summary').length===64`)
   for(const [width,height] of [[1000,700],[1440,920],[820,620],[1280,800]]){
    window.setContentSize(width,height);await wait(`window.innerWidth===${width}&&window.innerHeight===${height}`)
    for(const label of ['恢复到 100%','放大画布','缩小画布','查看全部']){
     await read(`document.querySelector('button[aria-label="${label}"]').click()`);await pause(200)
    }
   }
   report.resize=await read(`window.canvasResize`)
   report.runtimeErrors=await read(`window.missionQA.errors`)
   assert.deepEqual(report.runtimeErrors.filter(error=>!error.includes('ResizeObserver')),[],'Unexpected Renderer errors are not a passing layout result')
   assert.deepEqual(report.resize.errors,[],'Loading and viewport transitions must not leave ResizeObserver notifications undelivered')
   report.geometry=await read(`(()=>{const style=selector=>{const e=document.querySelector(selector),s=getComputedStyle(e);return {fontSize:s.fontSize,lineHeight:s.lineHeight,cursor:s.cursor,userSelect:s.userSelect}};return {note:style('.canvas-note-prose > .safe-markdown'),body:style('.canvas-card-file .canvas-card-body'),header:style('.canvas-card-file .canvas-card-handle'),count:document.querySelectorAll('.canvas-conversation-summary').length,zoom:document.querySelector('.canvas-zoom-readout').textContent}})()`)
   assert.equal(report.geometry.note.fontSize,'13px');assert.equal(report.geometry.body.userSelect,'text');assert.equal(report.geometry.header.userSelect,'none')
   assert.equal(report.geometry.count,64)
   report.checks.push('source_card_density_selection_and_64_summaries_survive_window_and_zoom_changes')
  }
  report.status='passed'
  await window.webContents.capturePage().then(image=>writeFileSync(join(userData,'final.png'),image.toPNG()))
 }catch(error){report.status='failed';report.error=String(error.stack??error);await window.webContents.capturePage().then(image=>writeFileSync(join(userData,'failure.png'),image.toPNG()))}
 writeFileSync(join(userData,'result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,mode,theme,checks:report.checks,resizeErrors:report.resize?.errors.length,error:report.error}))
 window.destroy();app.exit(report.status==='passed'?0:1)
}).catch(error=>{console.error(error);app.exit(1)})
