import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdir,readFile,writeFile,rename,realpath} from 'node:fs/promises'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {pathToFileURL} from 'node:url'
import {setTimeout as pause} from 'node:timers/promises'

export async function qualifyCanvasFileResources(window,{evaluate,wait,rpc,openCanvasBoard,config,report,record,seam}){
  window.unmaximize();window.setContentSize(1680,1000);window.webContents.setZoomFactor(1)
  const root=resolve(config.file_fixture_directory),phase=config.file_phase
  const owned=path=>{const suffix=relative(root,resolve(path));assert.ok(suffix&&!isAbsolute(suffix)&&suffix!=='..'&&!suffix.startsWith('..\\')&&!suffix.startsWith('../'));return path}
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
  const fp=(method,params)=>evaluate(`window.rovai.filePreview.${method}(${JSON.stringify(params)})`)
  const card=id=>`document.querySelector('[data-id="${id}"] .canvas-card')`
  const fit=()=>click(`document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]')`)
  const click=async expression=>{
    await wait(`Boolean((${expression})&&!(${expression}).disabled&&(${expression}).checkVisibility())`)
    await evaluate(`(()=>{(${expression}).scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`)
    const point=await evaluate(`(()=>{const node=${expression},r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(!hit||!(hit===node||node.contains(hit)))throw Error('原操作被遮挡');return{x:Math.round(x),y:Math.round(y)}})()`)
    for(const type of ['mouseMove','mouseDown','mouseUp'])window.webContents.sendInputEvent({type,...point,...(type==='mouseMove'?{}:{button:'left',clickCount:1})})
  }
  const corePid=()=>{
    const rows=JSON.parse(execFileSync(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',`$rows=@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${process.pid}' | Where-Object {$_.Name -eq 'rovai-host.exe'} | Select-Object ProcessId,ExecutablePath,CommandLine);ConvertTo-Json -InputObject $rows -Compress`],{encoding:'utf8',windowsHide:true}))
    assert.equal(rows.length,1);assert.equal(resolve(rows[0].ExecutablePath).toLowerCase(),resolve(process.env.ROVAI_HOST_BIN).toLowerCase())
    assert.ok(rows[0].CommandLine.toLowerCase().includes(join(config.data_root,'Core').toLowerCase()));return rows[0].ProcessId
  }
  const capture=async name=>{const path=join(config.evidence,name+'.png');await writeFile(path,(await window.webContents.capturePage()).toPNG());(report.screenshots??=[]).push(path)}
  const rows=()=>seam.since(0)
  const openedFile=path=>rows().filter(row=>row.result?.ok&&row.result.value?.kind==='file_preview'&&row.args[0]?.rawReference===pathToFileURL(path).href).at(-1)?.result.value.file
  const siteFor=file=>rows().filter(row=>row.channel==='rovai:file-preview-prepare-html-site'&&row.args[0]?.handleId===file.handleId&&row.result?.ok).at(-1)?.result.value
  const inspectHtml=async(id,identity)=>{
    await wait(`${card(id)}?.querySelector('.file-preview-html-stage')?.dataset.documentState==='loaded'&&${card(id)}.querySelector('.file-preview-html-stage').dataset.channelState==='connected'`,30000)
    const src=await evaluate(`${card(id)}.querySelector('iframe.file-preview-html').src`),origin=new URL(src).origin
    let found
    const probe=randomUUID(),bounded=promise=>Promise.race([promise,pause(1000).then(()=>null)])
    const deadline=Date.now()+15000
    while(Date.now()<deadline&&!found){
      const candidates=window.webContents.mainFrame.framesInSubtree.filter(frame=>{try{return new URL(frame.url).origin===origin}catch{return false}})
      for(const frame of candidates)await bounded(frame.executeJavaScript(`(()=>{if(window.__r06ProbeHandler)removeEventListener('message',window.__r06ProbeHandler);window.__r06ProbeHandler=event=>{if(event.source===parent&&event.data?.r06FrameProbe===${JSON.stringify(probe)})window.__r06FrameProbe=${JSON.stringify(probe)}};addEventListener('message',window.__r06ProbeHandler);return true})()`).catch(()=>null))
      await evaluate(`(()=>{${card(id)}.querySelector('iframe.file-preview-html').contentWindow.postMessage({r06FrameProbe:${JSON.stringify(probe)}},${JSON.stringify(origin)});return true})()`)
      await pause(50)
      for(const frame of candidates){
        try{
          const doc=await bounded(frame.executeJavaScript(`({matched:window.__r06FrameProbe===${JSON.stringify(probe)},identity:document.querySelector('#identity')?.textContent,bridge:typeof window.rovai,node:typeof window.require,csp:document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content})`))
          if(!doc?.matched||doc.identity!==identity)continue
          assert.equal(doc.bridge,'undefined');assert.equal(doc.node,'undefined');assert.equal(doc.csp,config.file_author_csp)
          found={origin,frameId:frame.frameTreeNodeId,...doc};break
        }catch(error){if(error.code==='ERR_ASSERTION')throw error}
      }
      if(!found)await pause(100)
    }
    for(const frame of window.webContents.mainFrame.framesInSubtree.filter(frame=>{try{return new URL(frame.url).origin===origin}catch{return false}}))await bounded(frame.executeJavaScript(`(()=>{removeEventListener('message',window.__r06ProbeHandler);delete window.__r06ProbeHandler;delete window.__r06FrameProbe;return true})()`).catch(()=>null))
    assert.ok(found,'actual author document not found: '+identity);return found
  }
  let context
  if(phase==='prepare'){
    await mkdir(root)
    const projects=[]
    for(const label of ['A','B']){
      const directory=join(root,'Thread-'+label);await mkdir(directory);assert.equal(await realpath(directory),directory)
      const path=owned(join(directory,'同名 #资料.txt')),body=`R06 Thread ${label} 独有原文\n`
      await writeFile(path,body,{flag:'wx'});projects.push({directory,path,body})
    }
    const html=[]
    for(let n=0;n<5;n++){
      const path=owned(join(projects[0].directory,`页面 ${n} #原文.html`)),identity=`R06 HTML ${n}`
      const body=`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${config.file_author_csp}"><title>${identity}</title></head><body><h1 id="identity">${identity}</h1><p>保持原文件、原会话和原生隔离页面。</p></body></html>`
      await writeFile(path,body,{flag:'wx'});html.push({path,body,identity})
    }
    const member=await rpc('members.create',{commandId:randomUUID(),command:{displayName:'R06 文件资源队员',teamRole:'只读文件验证',professionalResponsibilities:'不执行模型。',personalityTraits:['严谨'],workingPrinciples:'仅隔离工程文件',growthTopic:''}})
    assert.equal(member.status,'applied',JSON.stringify(member));const agentId=member.resultEntity.entityId
    for(const [index,project] of projects.entries()){
      const created=await rpc('threads.create',{commandId:randomUUID(),name:`R06 文件来源 ${index}`,workspace:{projectPath:project.directory},memberAgentIds:[agentId],defaultLeadAgentId:agentId,collaborationMode:'peer'})
      assert.equal(created.status,'applied',JSON.stringify(created));project.threadId=created.payload.threadId
    }
    const board=await rpc('canvas.boards.create',{commandId:randomUUID(),command:{name:'R06 跨Thread与HTML资源'}})
    assert.equal(board.status,'applied',JSON.stringify(board));const boardId=board.payload.board.id
    context={dataRoot:config.data_root,root,projects,html,boardId,agentId,mainPid:process.pid,corePid:corePid()}
    const create=async(file,index)=>{
      const graph=await rpc('canvas.nodes.snapshot',{boardId}),created=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId,expectedRevision:graph.board.revision,mutation:{type:'create',node:{kind:'file',path:file.path,fileReference:{threadId:file.threadId??projects[0].threadId},x:index%3*580,y:Math.floor(index/3)*470,width:550,height:440}}}})
      assert.equal(created.status,'applied',JSON.stringify(created));return created.payload.nodeIds[0]
    }
    for(const [index,file] of projects.entries())file.nodeId=await create(file,index)
    await openCanvasBoard(evaluate,wait,boardId);await fit()
    for(const file of projects)await wait(`${card(file.nodeId)}?.textContent.includes(${JSON.stringify(file.body.trim())})`,30000)
    const files=projects.map(file=>openedFile(file.path));assert.ok(files.every(Boolean));assert.notEqual(files[0].handleId,files[1].handleId);assert.notEqual(files[0].previewKey,files[1].previewKey)
    const foreign=await fp('restore',{kind:'camp_workspace',threadId:projects[0].threadId,rawReference:pathToFileURL(projects[1].path).href})
    assert.equal(foreign.ok,true,JSON.stringify(foreign));assert.equal(foreign.value.file.pathPresentation,'external')
    assert.notEqual(foreign.value.file.previewKey,files[1].previewKey)
    const missingThread=['0','1','2'].map(last=>projects[0].threadId.slice(0,-1)+last).find(id=>projects.every(project=>project.threadId!==id))
    const missing=await fp('restore',{kind:'camp_workspace',threadId:missingThread,rawReference:pathToFileURL(projects[0].path).href})
    assert.equal(missing.ok,false,JSON.stringify(missing));report.missing_thread_denial=missing.error
    report.explicit_external_reference={pathPresentation:foreign.value.file.pathPresentation,previewKeyIsThreadScoped:true,rule:'docs/ui/components/file-preview.md:46; existing explicit absolute file preview remains allowed'}
    for(const file of projects)assert.ok(await evaluate(`${card(file.nodeId)}.textContent.includes(${JSON.stringify(file.body.trim())})`))
    record('actual_two_thread_same_filename_previews_keep_distinct_contents_and_keys_preserve_explicit_external_paths_and_reject_missing_thread')
    await capture('01-cross-thread-sources')
    const documents=[]
    for(let n=0;n<4;n++){
      html[n].nodeId=await create(html[n],n+2);await fit();documents.push(await inspectHtml(html[n].nodeId,html[n].identity))
    }
    assert.equal(new Set(documents.map(doc=>doc.origin)).size,4)
    for(const file of html.slice(0,4)){file.handle=openedFile(file.path);assert.ok(file.handle);file.site=siteFor(file.handle);assert.ok(file.site)}
    record('actual_four_distinct_html_documents_load_with_original_csp_without_native_bridges')
    html[4].nodeId=await create(html[4],6);await fit()
    await wait(`${card(html[4].nodeId)}?.textContent.includes('预览资源不足')||${card(html[4].nodeId)}?.textContent.includes('窗口上限')`)
    assert.equal(await evaluate(`document.querySelectorAll('iframe.file-preview-html').length`),4)
    for(const doc of documents)assert.ok(window.webContents.mainFrame.framesInSubtree.some(frame=>frame.frameTreeNodeId===doc.frameId))
    record('fifth_distinct_visible_html_is_bounded_without_replacing_the_four_current_documents')
    const remove=async id=>{
      await click(`${card(id)}.querySelector('button[aria-label="文件节点操作"]')`)
      await click(`[...document.querySelectorAll('.canvas-card-menu [role="menuitem"]')].find(node=>node.textContent==='移除文件节点')`)
      await click(`document.querySelector('[role="dialog"] .danger-button')`)
      await wait(`!${card(id)}`);await fit()
    }
    await remove(html[0].nodeId)
    await click(`[...${card(html[4].nodeId)}.querySelectorAll('[role="alert"] button')].find(node=>node.textContent==='重试')`)
    await inspectHtml(html[4].nodeId,html[4].identity)
    const releaseDeadline=Date.now()+20000
    while(Date.now()<releaseDeadline&&!rows().some(row=>row.channel==='rovai:file-preview-release-html-site'&&row.args[0]?.previewId===html[0].site.previewId&&row.result?.released===true))await pause(50)
    assert.ok(rows().some(row=>row.channel==='rovai:file-preview-release-html-site'&&row.args[0]?.previewId===html[0].site.previewId&&row.result?.released===true),'original HTML site was not released')
    assert.ok(!window.webContents.mainFrame.framesInSubtree.some(frame=>frame.frameTreeNodeId===documents[0].frameId),'removed author document is still alive')
    const retained=rows().filter(row=>row.channel==='rovai:file-preview-retention').at(-1)?.args[0]
    assert.ok(retained&&retained.handles.length<=64)
    const cached=retained.handles.find(row=>row.handleId===html[0].handle.handleId)
    if(cached)assert.equal(cached.visible,false)
    report.html_release={originalSiteReleased:true,originalDocumentRemoved:true,cachedSourceHandleRetained:Boolean(cached),retainedHandleCount:retained.handles.length,qualification:'File Preview v13/v14 retain bounded source/read snapshots separately from the four live HTML documents and sites'}
    for(const doc of documents.slice(1))assert.ok(window.webContents.mainFrame.framesInSubtree.some(frame=>frame.frameTreeNodeId===doc.frameId))
    assert.equal(sha(await readFile(html[0].path)),sha(Buffer.from(html[0].body)))
    record('removing_one_html_pin_releases_its_document_and_site_then_retry_admits_the_fifth_and_preserves_other_documents_and_source')
    await capture('02-window-html-budget')
    const mirrors=await rpc('canvas.boards.create',{commandId:randomUUID(),command:{name:'R06 同源HTML呈现预算'}})
    assert.equal(mirrors.status,'applied');context.mirrorBoardId=mirrors.payload.board.id;context.mirrorIds=[]
    for(let n=0;n<6;n++){
      const graph=await rpc('canvas.nodes.snapshot',{boardId:context.mirrorBoardId}),created=await rpc('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId:context.mirrorBoardId,expectedRevision:graph.board.revision,mutation:{type:'create',node:{kind:'file',path:html[1].path,fileReference:{threadId:projects[0].threadId},x:n%3*580,y:Math.floor(n/3)*470,width:550,height:440}}}})
      assert.equal(created.status,'applied');context.mirrorIds.push(created.payload.nodeIds[0])
    }
    await openCanvasBoard(evaluate,wait,context.mirrorBoardId);await fit()
    await wait(`document.querySelectorAll('iframe.file-preview-html').length===4&&[...document.querySelectorAll('.canvas-file-preview')].filter(node=>node.textContent.includes('窗口上限')).length===2`)
    record('same_html_file_mirrors_also_obey_four_actual_presentations_instead_of_only_counting_shared_handles')
    const mark=seam.mark();await remove(context.mirrorIds[0])
    await wait(`${card(context.mirrorIds[4])}?.querySelector('iframe.file-preview-html')&&document.querySelectorAll('iframe.file-preview-html').length===4`)
    assert.equal((await fp('readText',{handleId:html[1].handle.handleId,expectedGeneration:html[1].handle.contentGeneration})).ok,true)
    assert.ok(!seam.since(mark).some(row=>row.channel==='rovai:file-preview-release'&&row.args[0]?.handleId===html[1].handle.handleId))
    record('closing_one_same_source_mirror_admits_the_waiting_presentation_without_releasing_its_other_readers')
    context.savedNodes=(await rpc('canvas.nodes.snapshot',{boardId})).nodes.map(node=>({id:node.id,data:node.data}))
    context.oldHandles=rows().flatMap(row=>row.result?.ok&&row.result.value?.kind==='file_preview'?[row.result.value.file]:[])
  }else{
    const bytes=await readFile(config.file_checkpoint);assert.equal(sha(bytes),config.file_checkpoint_sha256);context=JSON.parse(bytes)
    assert.equal(resolve(context.dataRoot),resolve(config.data_root));assert.equal(resolve(context.root),root)
    assert.notEqual(context.mainPid,process.pid);assert.notEqual(context.corePid,corePid())
    for(const file of context.oldHandles)assert.equal((await fp('readText',{handleId:file.handleId,expectedGeneration:file.contentGeneration})).ok,false)
    const graph=await rpc('canvas.nodes.snapshot',{boardId:context.boardId});assert.deepEqual(graph.nodes.map(node=>({id:node.id,data:node.data})),context.savedNodes)
    await openCanvasBoard(evaluate,wait,context.boardId);await fit()
    const [a,b]=context.projects
    await wait(`${card(b.nodeId)}?.textContent.includes(${JSON.stringify(b.body.trim())})`,30000)
    if(phase==='resume'){
      await wait(`${card(a.nodeId)}?.textContent.includes(${JSON.stringify(a.body.trim())})`,30000)
      for(const html of context.html.slice(1))await inspectHtml(html.nodeId,html.identity)
      record('fresh_app_core_restore_exact_cross_thread_file_and_html_references_with_new_capabilities')
      owned(a.path);assert.equal(sha(await readFile(a.path)),sha(Buffer.from(a.body)))
      context.missingBackup=owned(a.path+'.r06-before-missing')
      await writeFile(join(config.evidence,'source-before-missing.json'),JSON.stringify({path:a.path,backup:context.missingBackup,body:a.body,sha256:sha(await readFile(a.path))},null,2)+'\n',{flag:'wx'})
      await rename(a.path,context.missingBackup)
      record('owned_source_snapshot_saved_before_testing_missing_file_in_next_fresh_process')
    }else{
      assert.equal(phase,'missing')
      await wait(`${card(a.nodeId)}?.querySelector('[role="alert"]')||${card(a.nodeId)}?.textContent.includes('不存在')||${card(a.nodeId)}?.textContent.includes('无法')`,30000)
      assert.ok(!await evaluate(`${card(a.nodeId)}.textContent.includes(${JSON.stringify(a.body.trim())})||${card(a.nodeId)}.textContent.includes(${JSON.stringify(b.body.trim())})`))
      assert.ok((await rpc('canvas.nodes.snapshot',{boardId:context.boardId})).nodes.some(node=>node.id===a.nodeId&&node.data.path===a.path&&node.data.fileReference.threadId===a.threadId))
      record('fresh_process_missing_source_keeps_original_pin_and_error_without_cached_body_or_other_thread_fallback')
      assert.equal(sha(await readFile(owned(context.missingBackup))),sha(Buffer.from(a.body)))
      await rename(context.missingBackup,owned(a.path))
      await click(`[...${card(a.nodeId)}.querySelectorAll('button')].find(node=>node.textContent==='重试')`)
      await wait(`${card(a.nodeId)}.textContent.includes(${JSON.stringify(a.body.trim())})`,30000)
      for(const html of context.html.slice(1))await inspectHtml(html.nodeId,html.identity)
      record('explicit_retry_revalidates_restored_original_file_and_keeps_other_thread_and_html_sources_intact')
      await capture('01-missing-source-restored')
    }
    context.mainPid=process.pid;context.corePid=corePid()
  }
  for(const project of context.projects){const opened=await rpc('threads.open',{threadId:project.threadId,traceId:randomUUID()});assert.deepEqual(opened.messages,[]);assert.deepEqual(opened.agentRuns,[])}
  report.file_resources={phase,boardId:context.boardId,threadIds:context.projects.map(file=>file.threadId),external_model_calls:0,mainPid:process.pid,corePid:corePid()}
  if(phase!=='missing')await writeFile(join(config.evidence,'file-context.json'),JSON.stringify(context,null,2)+'\n',{flag:'wx'})
  record('file_resource_checks_never_send_messages_or_start_model_runs')
}
