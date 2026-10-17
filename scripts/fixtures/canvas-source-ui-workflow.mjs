import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {setTimeout as pause} from 'node:timers/promises'

// 原Main/preload/Core与真实组件；仅通过原入口修改，无业务快照或命令回执替身。
export async function qualifyCanvasSourceUi(window,{evaluate,wait,rpc,openCanvasBoard,config,report,record}){
 window.unmaximize();window.setContentSize(1440,920);window.webContents.setZoomFactor(1)
 const kinds={folder:'工程区域',group:'项目分组',agent:'队员区域',conversation:'对话',custom:'自定义分组',note:'便签',file:'文件',terminal:'终端'}
 report.ui_artifacts=Object.keys(kinds).map(kind=>({id:'card-'+kind,path:join(config.evidence,'card-'+kind+'.png'),status:'pending'}));report.ui_cards=[]
 const checkpoint=()=>writeFile(join(config.evidence,'progress.json'),JSON.stringify({cards:report.ui_cards,artifacts:report.ui_artifacts,checks:report.checks,at:new Date().toISOString()},null,2)+'\n')
 const until=async predicate=>{const end=Date.now()+15000;while(Date.now()<end){const value=await predicate();if(value)return value;await pause(50)}throw Error('Original Core state did not reach the expected revision')}
 await checkpoint()
 const click=async expression=>{
  await wait(`Boolean((${expression})&&!(${expression}).disabled&&(${expression}).checkVisibility())`)
  await evaluate(`(()=>{(${expression}).scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});return true})()`)
  await wait(`(()=>{const node=(${expression});if(!node||node.disabled)return false;const r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return Boolean(hit&&node.contains(hit))})()`)
  const point=await evaluate(`(()=>{const node=(${expression});node.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(!hit||!node.contains(hit))throw Error('Original UI control is occluded: '+node.outerHTML.slice(0,150));return{x:Math.round(x),y:Math.round(y)}})()`)
  for(const type of ['mouseMove','mouseDown','mouseUp'])window.webContents.sendInputEvent({type,...point,...(type==='mouseMove'?{}:{button:'left',clickCount:1})})
 }
 const key=async(keyCode,modifiers=[])=>{for(const type of ['keyDown','keyUp'])window.webContents.sendInputEvent({type,keyCode,modifiers});await pause(30)}
 const button=(text,root='document')=>`Array.from(${root}.querySelectorAll('button')).find(node=>node.textContent?.trim()===${JSON.stringify(text)})`
 const menu=text=>`Array.from(document.querySelectorAll('[role="menuitem"]')).find(node=>node.textContent?.trim()===${JSON.stringify(text)})`
 const field=(label,tag='input',root='document.querySelector(".canvas-node-editor")')=>`Array.from(${root}.querySelectorAll('.field-label')).find(node=>node.textContent?.trim().startsWith(${JSON.stringify(label)}))?.querySelector('${tag}')`
 const text=async(expression,value)=>{await click(expression);await key('A',['control']);await window.webContents.insertText(value);await wait(`(${expression}).value===${JSON.stringify(value)}`)}
 const choose=async(expression,value)=>{
  const index=await evaluate(`Array.from((${expression}).options).findIndex(option=>option.value===${JSON.stringify(value)})`);assert.ok(index>=0,'original select option must exist '+value)
  await evaluate(`(()=>{(${expression}).focus();return true})()`);await key('Home');for(let n=0;n<index;n++)await key('Down')
  await wait(`(${expression}).value===${JSON.stringify(value)}`)
 }
 const settled=async()=>{await evaluate('Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().iterations)).map(animation=>animation.finished.catch(()=>undefined)))');await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')}
 const screenshot=async(id,path)=>{await settled();await writeFile(path,(await window.webContents.capturePage()).toPNG());(report.screenshots??=[]).push(path);const item=report.ui_artifacts.find(item=>item.id===id);if(item)item.status='captured';await checkpoint()}
 if(config.ui_phase==='layout'){
  assert.equal(createHash('sha256').update(await readFile(new URL(config.board_ui_module))).digest('hex'),config.board_ui_sha256)
  report.ui_artifacts=['board-list-day','board-list-night','board-delete'].map(id=>({id,path:join(config.evidence,id+'.png'),status:'pending'}))
  const {qualifyCanvasBoardUi}=await import(config.board_ui_module)
  return qualifyCanvasBoardUi(window,{evaluate,wait,rpc,config,report,record,click,key,text,button,menu,screenshot})
 }
 const profiles=await rpc('members.list'),member=profiles.find(item=>!item.removedAt);assert.ok(member);const agentId=member.agentId
 report.member_fixture='original Core bootstrap member already present in the actual interface; member creation refresh belongs to its own workflow'
 const mission=await rpc('missions.create',{commandId:randomUUID(),command:{title:'R09 原工程会话',description:'仅原卡片UI验证，不启动执行。',projectBindingKind:'directory',projectPath:config.workspace,memberAgentIds:[agentId],defaultLeadAgentId:agentId,tags:[]}});assert.equal(mission.status,'applied');const threadId=mission.payload.threadId
 const sourceFile=join(config.workspace,'R09 真实文件.txt'),sourceText='R09 原文件预览\n中文与 emoji 🙂，保留原始字节。\n';await writeFile(sourceFile,sourceText,{flag:'wx'})
 report.ui_context={agentId,threadId,missionId:mission.payload.missionId,sourceFile,sourceSha256:createHash('sha256').update(sourceText).digest('hex')}
 try{report.workspace_topology=await rpc('workspaces.worktrees',{path:config.workspace})}catch(error){report.workspace_topology_failure=error.stack??String(error)}
 assert.equal(report.workspace_topology?.schemaVersion,1,report.workspace_topology_failure)
 assert.equal(report.workspace_topology.requestedPath,config.workspace)
 assert.equal(report.workspace_topology.repositoryRoot,null)
 record('native_main_admits_original_read_only_worktree_topology_for_a_plain_directory')
 await click('document.querySelector(\'button[aria-label="无限画布"]\')');await wait('Boolean(document.querySelector(".canvas-breadcrumb-root:not(:disabled)"))')
 await click('document.querySelector(".canvas-breadcrumb-root")');await wait('Boolean(document.querySelector(".canvas-boards-home .canvas-primary-button:not(:disabled)"))')
 await click('document.querySelector(".canvas-boards-home .canvas-primary-button")');await wait('Boolean(document.querySelector(".canvas-board-dialog input[data-dialog-autofocus]"))')
 await text('document.querySelector(".canvas-board-dialog input[data-dialog-autofocus]")','R09 八类原版卡片');await click('document.querySelector(".canvas-board-dialog button[type=submit]")')
 await wait('!document.querySelector(".canvas-board-dialog")&&Boolean(document.querySelector(".canvas-board-title:not(:disabled)"))')
 const boards=await rpc('canvas.boards.list'),boardId=boards.boards.find(board=>board.name==='R09 八类原版卡片').id;report.ui_context.boardId=boardId
 const graph=()=>rpc('canvas.nodes.snapshot',{boardId})
 await click('document.querySelector(".canvas-board-title")');await click(menu('管理项目分组'));await wait('Boolean('+button('新建项目分组')+')');await click(button('新建项目分组'))
 await text('document.querySelector(".app-dialog input[data-dialog-autofocus]")','R09 原项目分组');await click(button('保存分组'));await wait('!document.querySelector(".project-groups-members")');await click(button('完成'))
 const prefs=await evaluate('window.rovai.navigationPreferences.get()'),group=prefs.projectGroups.find(group=>group.name==='R09 原项目分组');assert.ok(group);report.ui_context.groupId=group.id
 record('original_board_creation_and_project_group_management_persist_real_board_and_device_group_without_model')
 for(const [kind,label] of Object.entries(kinds)){
  report.ui_step=kind+':create';await checkpoint()
  const base=await graph();assert.equal(base.nodes.length,0)
  await click('document.querySelector(\'.canvas-dock-panel button[aria-label="添加节点"]\')');await click(menu(label));await wait('Boolean(document.querySelector(".canvas-node-editor"))')
  await wait(`document.querySelector('.canvas-node-editor select').value===${JSON.stringify(kind)}`)
  await text(field('标题'),'R09 '+label)
  const palette='.canvas-node-editor .canvas-color-choice[data-color="blue"]'
  assert.equal(await evaluate('document.querySelectorAll(".canvas-node-editor .canvas-color-choice").length'),12)
  await click(`document.querySelector('${palette}')`);await wait(`document.querySelector('${palette}').getAttribute('aria-pressed')==='true'`)
  await key('Space');await wait(`document.querySelector('${palette}').getAttribute('aria-pressed')==='false'`)
  await key('Space');await wait(`document.querySelector('${palette}').getAttribute('aria-pressed')==='true'`)
  if(kind==='folder'||kind==='terminal'){
   assert.equal(await evaluate('document.querySelector(".canvas-node-editor button[type=submit]").disabled'),true)
   await text(field('工作目录绝对路径'),config.workspace)
  }
  if(kind==='file'){
   assert.equal(await evaluate('document.querySelector(".canvas-node-editor button[type=submit]").disabled'),true)
   await text(field('文件绝对路径'),sourceFile);await choose(field('所属工程对话','select'),threadId)
  }
  if(kind==='agent')await choose(field('队员','select'),agentId)
  if(kind==='group')await choose(field('项目分组','select'),group.id)
  if(kind==='conversation'){
   const ref=await evaluate(`Array.from((${field('对话','select')}).options).find(option=>option.value.includes(${JSON.stringify(threadId)})&&!option.textContent.includes('私有')).value`);await choose(field('对话','select'),ref)
  }
  if(kind==='custom'){
   await wait('document.querySelectorAll(".canvas-editor-members input").length>0');await click('document.querySelector(".canvas-editor-members input")')
  }
  if(kind==='note')await text(field('便签内容','textarea'),'## 原版便签\n正文应贴合容器，不撑高外层。')
  if(kind==='folder')await screenshot('editor-folder',join(config.evidence,'editor-folder.png'))
  await click('document.querySelector(".canvas-node-editor button[type=submit]")');await wait('!document.querySelector(".canvas-node-editor")')
  let current=await graph();assert.equal(current.nodes.length,1);const node=current.nodes[0],nodeId=node.id;assert.equal(node.data.kind,kind);assert.equal(node.data.color,'blue')
  const selector=`.react-flow__node[data-id="${nodeId}"]`,card=`document.querySelector('${selector}')`
  await wait(`Boolean(${card})`);await click('document.querySelector(\'.canvas-dock-panel button[aria-label="查看全部"]\')');await pause(450)
  if(kind==='note'){await click(`${card}.querySelector('.canvas-note-title')`);await wait(`${card}.classList.contains('selected')`);await click('document.querySelector(\'.canvas-dock-panel button[aria-label="编辑节点"]\')')}
  else if(kind==='file'){await click(`${card}.querySelector('button[aria-label="文件节点操作"]')`);await click(menu('编辑节点'))}
  else await click(`${card}.querySelector('button[aria-label="编辑节点"]')`)
  await wait('Boolean(document.querySelector(".canvas-node-editor"))');await text(field('标题'),'R09 '+label+' 已编辑')
  const moved=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId,expectedRevision:current.board.revision,mutation:{type:'update',nodeId,patch:{x:node.data.x+35,y:node.data.y+20}}}});assert.equal(moved.status,'applied')
  await wait('document.querySelector(".canvas-node-editor").textContent.includes("画布已更新，输入仍保留")');assert.equal(await evaluate('document.querySelector(".canvas-node-editor button[type=submit]").disabled'),true)
  assert.equal(await evaluate(`(${field('标题')}).value`),'R09 '+label+' 已编辑')
  await click(button('使用最新画布版本','document.querySelector(".canvas-node-editor")'));await click('document.querySelector(".canvas-node-editor button[type=submit]")');await wait('!document.querySelector(".canvas-node-editor")')
  current=await graph();const edited=current.nodes[0];assert.equal(edited.data.title,'R09 '+label+' 已编辑');assert.equal(edited.data.x,node.data.x+35);assert.equal(edited.data.y,node.data.y+20)
  for(const binding of ['folderPath','folderGroupId','agentId','path','conversation','conversations','fileReference'])assert.deepEqual(edited.data[binding],node.data[binding],kind+' immutable '+binding)
  record('actual_'+kind+'_create_edit_color_keyboard_and_stale_revision_preserve_binding_and_latest_geometry')
  if(['folder','group','agent','custom','file','terminal'].includes(kind)){
   const closeLabel=kind==='file'?'收起预览':kind==='terminal'?'收起终端':'折叠区域',openLabel=kind==='file'?'展开预览':kind==='terminal'?'展开终端':'展开区域'
   await click(`${card}.querySelector('button[aria-label="${closeLabel}"]')`);await wait(`${card}.querySelector('.is-collapsed')!==null`);assert.equal((await graph()).nodes[0].data.collapsed,true)
   await click(`${card}.querySelector('button[aria-label="${openLabel}"]')`);await wait(`${card}.querySelector('.is-collapsed')===null`);assert.equal((await graph()).nodes[0].data.collapsed,false)
   record('actual_'+kind+'_collapse_and_reopen_keep_original_node_and_source')
  }
  await click('document.querySelector(\'.canvas-dock-panel button[aria-label="自动排列"]\')');await pause(180);await click('document.querySelector(\'.canvas-dock-panel button[aria-label="查看全部"]\')');await pause(450)
  await click('document.querySelector(\'.canvas-zoom-pill button[aria-label="恢复到 100%"]\')');await wait('document.querySelector(".canvas-zoom-readout").textContent==="100%"');await pause(180)
  if(kind==='file')await wait(`${card}.textContent.includes('R09 原文件预览')`)
  const bounds=await evaluate(`(()=>{const n=${card},m=document.querySelector('.content.canvas-content'),w=document.querySelector('.canvas-workspace'),r=n.getBoundingClientRect();return{card:r.toJSON(),viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},outerExtraX:m.scrollWidth-m.clientWidth,outerExtraY:m.scrollHeight-m.clientHeight,workspace:w.getBoundingClientRect().toJSON(),zoom:document.querySelector('.canvas-zoom-percentage')?.textContent??document.querySelector('.canvas-zoom-pill')?.textContent}})()`)
  assert.ok(bounds.outerExtraX<=1&&bounds.outerExtraY<=1);report.ui_cards.push({kind,nodeId,createRevision:node.updatedAt,editedRevision:current.board.revision,collapseApplicable:!['note','conversation'].includes(kind),bounds})
  await screenshot('card-'+kind,join(config.evidence,'card-'+kind+'.png'))
  const beforeKey=await graph();await evaluate(`(()=>{${card}.focus();return true})()`);await key('Right')
  const keyed=await until(async()=>{const value=await graph();return value.board.revision>beforeKey.board.revision?value:null}),keyNode=keyed.nodes[0];assert.equal(keyNode.data.x,beforeKey.nodes[0].data.x+5);assert.equal(keyNode.data.y,beforeKey.nodes[0].data.y)
  await key('Delete');await wait(`Boolean(${button('删除节点')})`);await click(button('删除节点'));await wait(`!document.querySelector('${selector}')`)
  assert.equal((await graph()).nodes.length,0);assert.deepEqual((await rpc('threads.open',{threadId,traceId:randomUUID()})).agentRuns,[])
  record('actual_'+kind+'_arrange_keyboard_move_and_confirmed_delete_preserve_original_business_objects')
  report.ui_cards.at(-1).deleted=true;await checkpoint()
 }
 assert.equal(createHash('sha256').update(await readFile(sourceFile)).digest('hex'),report.ui_context.sourceSha256)
 const opened=await rpc('threads.open',{threadId,traceId:randomUUID()});assert.deepEqual(opened.messages,[]);assert.deepEqual(opened.agentRuns,[])
 record('all_eight_original_card_types_complete_without_message_run_or_source_file_mutation')
 await checkpoint()
}
