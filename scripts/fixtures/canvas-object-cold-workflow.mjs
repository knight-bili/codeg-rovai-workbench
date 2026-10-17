import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdir,readFile,writeFile,realpath} from 'node:fs/promises'
import {join,resolve,dirname} from 'node:path'
import {setTimeout as pause} from 'node:timers/promises'

export async function qualifyCanvasObjectCold(window,{evaluate,wait,rpc,openCanvasBoard,config,report,record,seam}) {
  window.unmaximize();window.setContentSize(1680,1000);window.webContents.setZoomFactor(1)
  const git=(cwd,...args)=>execFileSync(config.git_executable,['-C',cwd,...args],{encoding:'utf8',windowsHide:true}).trim()
  const ownerCore=()=>{
    const rows=JSON.parse(execFileSync(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',`$rows=@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${process.pid}' | Where-Object {$_.Name -eq 'rovai-host.exe'} | Select-Object ProcessId,ExecutablePath,CommandLine);ConvertTo-Json -InputObject $rows -Compress`],{encoding:'utf8',windowsHide:true}))
    assert.equal(rows.length,1);assert.equal(resolve(rows[0].ExecutablePath).toLowerCase(),resolve(process.env.ROVAI_HOST_BIN).toLowerCase())
    assert.ok(rows[0].CommandLine.toLowerCase().includes(join(config.data_root,'Core').toLowerCase()));return rows[0].ProcessId
  }
  const click=async expression=>{
    await wait(`Boolean((${expression})&&!(${expression}).disabled&&(${expression}).checkVisibility())`)
    await evaluate(`(()=>{(${expression}).scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`)
    const point=await evaluate(`(()=>{const node=${expression},r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(!hit||!(hit===node||node.contains(hit)))throw Error('原操作被遮挡');return{x:Math.round(x),y:Math.round(y)}})()`)
    for(const type of ['mouseMove','mouseDown','mouseUp'])window.webContents.sendInputEvent({type,...point,...(type==='mouseMove'?{}:{button:'left',clickCount:1})})
  }
  const button=(root,text)=>`[...(${root}).querySelectorAll('button')].find(node=>node.textContent===${JSON.stringify(text)})`
  const until=async predicate=>{const end=Date.now()+20_000;while(!predicate()){assert.ok(Date.now()<end,'Mission transport observation timed out');await pause(50)}}
  const rejectView=async(missionId,viewId,fileId)=>{
    let failure;try{await rpc('missions.fileDiff',{missionId,viewId,fileId})}catch(error){failure=String(error)}
    assert.ok(failure?.includes('mission.changes_refresh_required'),failure??'stale view was incorrectly accepted');return failure
  }
  let context
  if(config.object_phase==='prepare'){
    context={...report.ready_diff_context,dataRoot:config.data_root,mainPid:process.pid,corePid:ownerCore()}
    const {missionId,threadId,agentId,boardId,workspace,relativePath}=context
    const common=await realpath(resolve(workspace.worktreePath,git(workspace.worktreePath,'rev-parse','--git-common-dir')))
    const expected=await realpath(resolve(context.project,git(context.project,'rev-parse','--git-common-dir')))
    assert.equal(common,expected,'test writes must stay in the newly created owned Git repository')
    await writeFile(join(config.evidence,'cold-fixture-before.json'),JSON.stringify({path:join(workspace.workingDirectory,relativePath),before:await readFile(join(workspace.workingDirectory,relativePath),'utf8'),newFiles:Array.from({length:26},(_,i)=>`bulk/${String(i).padStart(2,'0')}.txt`)},null,2)+'\n',{flag:'wx'})
    await writeFile(join(workspace.workingDirectory,relativePath),'R05 冷启动后精确变更\n保留行\n')
    await mkdir(join(workspace.workingDirectory,'bulk'))
    for(let n=0;n<26;n++)await writeFile(join(workspace.workingDirectory,'bulk',`${String(n).padStart(2,'0')}.txt`),`R05 unique bulk ${n}\n`,{flag:'wx'})
    const task=await rpc('tasks.create',{commandId:randomUUID(),threadId,title:'R05 原历史任务',description:'重开后只定位此任务。',assigneeAgentId:agentId})
    assert.equal(task.status,'applied');context.taskId=task.payload.taskId
    assert.equal((await rpc('tasks.update',{commandId:randomUUID(),threadId,taskId:context.taskId,status:'cancelled',cancelReason:'隔离冷路由准备'})).status,'applied')
    const node=(data,x,y)=>({...data,x,y,width:360,height:240})
    const definitions={mission:node({kind:'conversation',conversation:{threadId,conversationId:null},objectReference:{kind:'mission',missionId}},420,0),
      task:node({kind:'conversation',conversation:{threadId,conversationId:null},objectReference:{kind:'task',taskId:context.taskId}},840,0),
      file:{kind:'file',path:join(context.project,relativePath),fileReference:{threadId},x:1260,y:0,width:520,height:400},
      readerA:node({kind:'conversation',conversation:{threadId,conversationId:null},title:'R05 同使命查看器甲'},0,520),
      readerB:node({kind:'conversation',conversation:{threadId,conversationId:null},title:'R05 同使命查看器乙'},840,520)}
    context.nodes={diff:context.nodeId}
    for(const [kind,data] of Object.entries(definitions)){
      const graph=await rpc('canvas.nodes.snapshot',{boardId})
      const result=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId,expectedRevision:graph.board.revision,mutation:{type:'create',node:data}}})
      assert.equal(result.status,'applied',JSON.stringify(result));context.nodes[kind]=result.payload.nodeIds[0]
    }
    context.graph=await rpc('canvas.nodes.snapshot',{boardId})
    context.originalView=await rpc('missions.changes',{missionId})
    context.runIds=(await rpc('threads.open',{threadId,traceId:randomUUID()})).agentRuns.map(run=>run.id)
    assert.equal(git(context.project,'status','--porcelain'),'')
    await writeFile(join(config.evidence,'object-context.json'),JSON.stringify(context,null,2)+'\n',{flag:'wx'})
    report.object_cold={phase:'prepare',context}
    record('owned_original_mission_cancelled_task_exact_source_file_diff_and_two_readers_persisted_without_database_seeding')
    return
  }
  assert.equal(config.object_phase,'resume')
  const bytes=await readFile(config.object_checkpoint)
  assert.equal(createHash('sha256').update(bytes).digest('hex'),config.object_checkpoint_sha256)
  context=JSON.parse(bytes);const {missionId,threadId,taskId,boardId,nodes,relativePath,workspace}=context
  assert.equal(resolve(context.dataRoot),resolve(config.data_root));assert.notEqual(process.pid,context.mainPid);assert.notEqual(ownerCore(),context.corePid)
  report.object_cold={phase:'resume',originalMainPid:context.mainPid,newMainPid:process.pid,context}
  const graph=await rpc('canvas.nodes.snapshot',{boardId})
  assert.deepEqual(graph.nodes.map(n=>({id:n.id,data:n.data})),context.graph.nodes.map(n=>({id:n.id,data:n.data})))
  assert.equal((await rpc('tasks.get',{threadId,taskId})).status,'cancelled')
  assert.equal((await rpc('missions.get',{missionId})).threadId,threadId)
  await rejectView(missionId,context.originalView.viewId,context.originalView.files[0].id)
  record('new_app_and_core_keep_exact_persisted_object_ids_while_prior_process_diff_handle_is_rejected')
  const board=async()=>{await openCanvasBoard(evaluate,wait,boardId);await wait(`document.querySelectorAll('.react-flow__node').length===6`);await click(`document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]')`)}
  const inspect=async kind=>{await board();await click(button(`document.querySelector('[data-id="${nodes[kind]}"]')`,'读取详情'));await wait(`Boolean(document.querySelector('.canvas-object-details'))`)}
  for(const kind of ['task','mission']){
    const mark=seam.mark();await inspect(kind)
    assert.equal(await evaluate(`document.querySelector('.canvas-object-details').dataset.${kind==='task'?'taskId':'missionId'}`),kind==='task'?taskId:missionId)
    await click(button("document.querySelector('.canvas-object-dialog')",'在工作区中操作'))
    await wait(`!document.querySelector('.canvas-workspace')&&Boolean(document.querySelector('${kind==='task'?`.task-detail[data-task-id="${taskId}"]`:`.mission-intro[data-mission-id="${missionId}"]`}')?.checkVisibility())`)
    assert.ok(seam.since(mark).some(row=>row.method==='threads.open'&&row.params?.threadId===threadId))
    record('fresh_app_'+kind+'_pin_opens_its_exact_original_workspace_and_object')
  }
  await board()
  await click(`document.querySelector('[data-id="${nodes.file}"] .canvas-file-actions button[aria-label="在工作区中操作"]')`)
  await wait(`!document.querySelector('.canvas-workspace')&&Boolean([...document.querySelectorAll('.file-preview-content')].find(node=>node.checkVisibility()&&node.textContent.includes('原内容甲')))`)
  await wait(`Boolean([...document.querySelectorAll('.file-preview-path-row')].find(node=>node.checkVisibility()&&node.textContent.includes('精确 #变更.txt')))`)
  record('fresh_app_source_file_pin_opens_original_source_bytes_not_the_different_mission_worktree_file')
  await writeFile(join(config.evidence,'01-cold-original-file.png'),(await window.webContents.capturePage()).toPNG())
  await inspect('diff')
  await wait(`document.querySelector('.mission-diff-reading .diff-title-wrap strong')?.textContent===${JSON.stringify(relativePath)}&&document.querySelector('.mission-diff-code')?.textContent.includes('R05 冷启动后精确变更')`)
  record('fresh_app_diff_pin_reacquires_new_view_for_exact_original_mission_and_unicode_path')
  const viewRows=()=>seam.since(0).filter(row=>row.method==='missions.changes'&&row.params.missionId===missionId&&row.result?.kind==='value')
  let current=viewRows().at(-1).result.value
  const diffDialog="document.querySelector('.mission-diff-dialog')"
  const select=async file=>{await click(`${diffDialog}.querySelector('[data-file-id="${file.id}"]')`);await wait(`${diffDialog}.querySelector('.diff-title-wrap strong')?.textContent===${JSON.stringify(file.path)}`)}
  const refresh=`${diffDialog}.querySelector('.mission-diff-read-state button')`
  const firstBulk=current.files.find(row=>row.path==='bulk/00.txt')
  await writeFile(join(config.evidence,'before-stale-injection.json'),JSON.stringify({created:join(workspace.workingDirectory,'late-after-read.txt'),priorExists:false},null,2)+'\n',{flag:'wx'})
  await writeFile(join(workspace.workingDirectory,'late-after-read.txt'),'R05 late new file\n',{flag:'wx'})
  const staleMark=seam.mark();await select(firstBulk)
  await wait(`${diffDialog}.textContent.includes('变更已过期，请刷新后查看。')`)
  assert.equal(seam.since(staleMark).filter(row=>row.method==='missions.changes').length,0)
  assert.ok(await evaluate(`!${diffDialog}.querySelector('.mission-diff-code')`))
  const rowsBeforeFailure=await evaluate(`[...${diffDialog}.querySelectorAll('[data-file-id]')].map(node=>node.dataset.fileId)`)
  seam.failNext({method:'missions.changes',missionId})
  await click(refresh)
  await wait(`document.querySelector('.canvas-object-dialog').textContent.includes('刷新失败，保留上次结果。')`)
  assert.deepEqual(await evaluate(`[...${diffDialog}.querySelectorAll('[data-file-id]')].map(node=>node.dataset.fileId)`),rowsBeforeFailure)
  assert.equal(await evaluate(`${diffDialog}.querySelector('.diff-dialog-summary > span').textContent`),`${current.files.length} 个文件`)
  await click(refresh)
  await wait(`!${refresh}.disabled&&!${diffDialog}.textContent.includes('变更已过期，请刷新后查看。')&&Boolean(${diffDialog}.querySelector('.mission-diff-code'))`)
  const refreshed=viewRows().at(-1).result.value
  assert.notEqual(refreshed.viewId,current.viewId);assert.equal(refreshed.files.length,current.files.length+1);current=refreshed
  assert.equal(await evaluate(`${diffDialog}.querySelector('.diff-dialog-summary > span').textContent`),`${current.files.length} 个文件`)
  record('actual_stale_file_view_requires_explicit_refresh_failed_refresh_keeps_old_list_and_successful_refresh_replaces_it')
  const a=current.files.find(row=>row.path==='bulk/01.txt'),b=current.files.find(row=>row.path==='bulk/02.txt')
  const gateA=seam.holdNext({method:'missions.fileDiff',missionId,fileId:a.id}),gateB=seam.holdNext({method:'missions.fileDiff',missionId,fileId:b.id}),coalesceMark=seam.mark()
  await select(a);await until(()=>Boolean(gateA.observed));await select(b);await until(()=>Boolean(gateB.observed));await select(a)
  gateA.release();await wait(`${diffDialog}.querySelector('.mission-diff-code')?.textContent.includes('R05 unique bulk 1')`)
  gateB.release();await pause(150)
  assert.equal(await evaluate(`${diffDialog}.querySelector('.diff-title-wrap strong').textContent`),a.path)
  for(const file of [a,b])assert.equal(seam.since(coalesceMark).filter(row=>row.method==='missions.fileDiff'&&row.params.fileId===file.id).length,1)
  record('actual_same_view_inflight_file_reads_coalesce_and_late_other_file_reply_does_not_replace_selection')
  const cacheFiles=current.files.filter(row=>row.path.startsWith('bulk/')).slice(0,25)
  for(const file of cacheFiles){await select(file);await wait(`Boolean(${diffDialog}.querySelector('.mission-diff-code'))`)}
  const cacheMark=seam.mark();await select(cacheFiles[0]);await wait(`Boolean(${diffDialog}.querySelector('.mission-diff-code'))`)
  assert.equal(seam.since(cacheMark).filter(row=>row.method==='missions.fileDiff'&&row.params.fileId===cacheFiles[0].id).length,1)
  record('actual_renderer_24_file_cache_evicts_after_25_distinct_files_and_rereads_the_exact_evicted_file')
  await writeFile(join(config.evidence,'02-diff-refresh-cache.png'),(await window.webContents.capturePage()).toPNG())
  await click(`${diffDialog}.querySelector('button[aria-label="关闭累计文件变更"]')`)
  await click(button("document.querySelector('.canvas-object-dialog')",'关闭'))
  await wait(`!document.querySelector('.canvas-object-dialog')`)
  const frame=key=>`document.querySelector('.canvas-conversation-frame[data-canvas-conversation-key*="${nodes[key]}"]')`
  const readerViews=[]
  for(const key of ['readerA','readerB']){
    await click(`document.querySelector('[data-id="${nodes[key]}"] button[aria-label="展开对话"]')`)
    await wait(`Boolean(${frame(key)}?.querySelector('.mission-activity-entry'))`)
    await click(`document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]')`)
    if(!await evaluate(`Boolean(${frame(key)}.querySelector('.mission-changes-disclosure')?.checkVisibility())`)){
      if(!await evaluate(`${frame(key)}.querySelector('.mission-activity-entry').checkVisibility()`)){
        await click(`${frame(key)}.querySelector('.file-preview-return')`)
        await click(`document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]')`)
      }
      await click(`${frame(key)}.querySelector('.mission-activity-entry')`)
    }
    await click(`document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]')`)
    await click(`${frame(key)}.querySelector('.mission-changes-disclosure')`)
    await wait(`Boolean(${frame(key)}.querySelector('.mission-changes-read-state'))`)
    readerViews.push(viewRows().at(-1).result.value)
  }
  const releaseMark=seam.mark()
  await click(`document.querySelector('[data-id="${nodes.readerA}"] .canvas-card-handle button[aria-label="收起对话"]')`)
  await wait(`!${frame('readerA')}`);await pause(100)
  assert.equal(seam.since(releaseMark).filter(row=>row.method==='missions.diffSession.release').length,0)
  await rpc('missions.fileDiff',{missionId,viewId:readerViews[1].viewId,fileId:readerViews[1].files[0].id})
  await click(`document.querySelector('[data-id="${nodes.readerB}"] .canvas-card-handle button[aria-label="收起对话"]')`)
  await wait(`!${frame('readerB')}`)
  await until(()=>seam.since(releaseMark).some(row=>row.method==='missions.diffSession.release'&&row.result?.kind==='value'))
  assert.equal(seam.since(releaseMark).filter(row=>row.method==='missions.diffSession.release').length,1)
  for(const view of readerViews)await rejectView(missionId,view.viewId,view.files[0].id)
  record('two_actual_mounted_mission_readers_release_core_views_only_after_last_reader_closes')
  const views=[]
  for(let n=0;n<12;n++)views.push(await rpc('missions.changes',{missionId}))
  await rpc('missions.fileDiff',{missionId,viewId:views[0].viewId,fileId:views[0].files[0].id})
  views.push(await rpc('missions.changes',{missionId}))
  await rejectView(missionId,views[1].viewId,views[1].files[0].id)
  for(const view of [views[0],views[12]])await rpc('missions.fileDiff',{missionId,viewId:view.viewId,fileId:view.files[0].id})
  await rpc('missions.diffSession.release',{missionId})
  await rejectView(missionId,views[12].viewId,views[12].files[0].id)
  record('actual_core_12_view_lru_evicts_the_untouched_handle_on_13th_insert_and_explicit_release_invalidates_remaining_handles')
  const ttl=await rpc('missions.changes',{missionId}),ttlStarted=performance.now(),waitUntil=Date.now()+600_500
  report.object_cold.ttl={viewId:ttl.viewId,startedAt:new Date().toISOString(),notBefore:new Date(waitUntil).toISOString(),contractSeconds:600}
  await writeFile(join(config.evidence,'ttl-pending.json'),JSON.stringify(report.object_cold.ttl,null,2)+'\n',{flag:'wx'})
  record('actual_core_ten_minute_view_expiry_observation_started_no_virtual_clock_or_ttl_override')
  await pause(Math.max(0,waitUntil-Date.now()))
  await rejectView(missionId,ttl.viewId,ttl.files[0].id)
  report.object_cold.ttl.elapsedMs=performance.now()-ttlStarted
  assert.ok(report.object_cold.ttl.elapsedMs>=600_000)
  record('actual_core_ten_minute_idle_view_expires_and_requests_explicit_refresh')
  assert.deepEqual((await rpc('threads.open',{threadId,traceId:randomUUID()})).agentRuns.map(row=>row.id),context.runIds)
  assert.equal(git(context.project,'status','--porcelain'),'')
  report.object_cold.external_model_calls=0
}
