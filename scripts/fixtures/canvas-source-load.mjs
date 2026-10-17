import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {mkdir,readFile,writeFile,rename,realpath} from 'node:fs/promises'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {Script} from 'node:vm'
import {DatabaseSync} from 'node:sqlite'
import {setTimeout as pause} from 'node:timers/promises'

export async function qualifyCanvasSourceLoad({request,fixture,dataDir,evidence,report,record}){
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
 const until=async(predicate,label)=>{const deadline=Date.now()+30000;while(Date.now()<deadline){const value=await predicate();if(value)return value;await pause(40)}throw Error('R08 condition timed out: '+label)}
 const readJson=async path=>{try{return JSON.parse(await readFile(path,'utf8'))}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error}}
 const owned=path=>{const suffix=relative(fixture,resolve(path));assert.ok(suffix&&!isAbsolute(suffix)&&suffix!=='..'&&!suffix.startsWith('..\\')&&!suffix.startsWith('../'));return path}
 const tree=owned(join(fixture,'source-tree')),large=owned(join(fixture,'large-source.bin')),deep=owned(join(fixture,'deep-tree'))
 await mkdir(tree);await mkdir(deep)
 const fileBytes=Buffer.alloc(20*1024*1024,0x61);await writeFile(large,fileBytes,{flag:'wx'})
 const treeFiles=[]
 for(let batch=0;batch<20;batch++){
  const directory=join(tree,String(batch).padStart(2,'0'));await mkdir(directory)
  await Promise.all(Array.from({length:75},async(_,n)=>{const name=String(n).padStart(2,'0')+'.txt',bytes=Buffer.alloc(1024,(batch+n)%255);await writeFile(join(directory,name),bytes,{flag:'wx'});treeFiles.push({path:relative(tree,join(directory,name)),bytes:bytes.length,sha256:hash(bytes)})}))
 }
 let leaf=deep;for(let n=0;n<34;n++){leaf=join(leaf,'d');await mkdir(leaf)}await writeFile(join(leaf,'leaf.txt'),'R08 depth boundary\n',{flag:'wx'})
 const sourceManifest={large:{path:large,bytes:fileBytes.length,sha256:hash(fileBytes)},tree:{path:tree,files:treeFiles.length,bytes:treeFiles.reduce((sum,file)=>sum+file.bytes,0),entries:treeFiles},deep:{path:deep,depth:34}}
 await writeFile(join(evidence,'source-fixture-before.json'),JSON.stringify(sourceManifest,null,2)+'\n',{flag:'wx'})
 const member=await request('members.create',{commandId:randomUUID(),command:{displayName:'R08 只读负载队员',teamRole:'本机材料观察',professionalResponsibilities:'不调用模型、不发送消息。',personalityTraits:['严谨'],workingPrinciples:'仅隔离材料和终端',growthTopic:''}})
 assert.equal(member.status,'applied');const agentId=member.resultEntity.entityId,contexts=[]
 for(let n=0;n<9;n++){
  const created=await request('threads.create',{commandId:randomUUID(),name:'R08 观察位置 '+n,workspace:null,memberAgentIds:[agentId],defaultLeadAgentId:agentId,collaborationMode:'peer'});assert.equal(created.status,'applied')
  const opened=await request('singleChat.open',{commandId:randomUUID(),command:{threadId:created.payload.threadId,agentId}});assert.equal(opened.status,'applied')
  contexts.push({threadId:created.payload.threadId,conversationId:opened.payload.conversationId})
 }
 report.sourceLoad={contexts,sourceManifest:{large:sourceManifest.large,tree:{path:tree,files:treeFiles.length,bytes:sourceManifest.tree.bytes}},latencies:{}}
 const attach=(context,path,displayName,revision=0)=>request('singleChat.sourceAttachments.addFromPath',{conversationId:context.conversationId,expectedDraftRevision:revision,sourcePath:path,displayName,mediaType:path===large?'application/octet-stream':null})
 let completed=0
 const startedAt=performance.now(),pending=contexts.slice(0,8).map((context,n)=>attach(context,n<4?tree:large,'R08 material '+n).then(value=>({ok:true,value,index:n}),error=>({ok:false,error:JSON.stringify(error),index:n})).finally(()=>{completed++}))
 const writeStarted=performance.now(),cheap=await request('canvas.boards.create',{commandId:randomUUID(),command:{name:'R08 扫描时的独立事务'}})
 assert.equal(cheap.status,'applied');report.sourceLoad.latencies.independentCommitMs=performance.now()-writeStarted;report.sourceLoad.unfinishedAtIndependentCommit=8-completed
 assert.ok(completed<8,'independent database command must finish while real source requests are still pending')
 const firstBatch=await Promise.all(pending),busy=firstBatch.filter(row=>!row.ok)
 assert.ok(busy.length>0,'actual source load did not reach the production four-worker limit')
 assert.ok(firstBatch.some(row=>row.ok))
 for(const row of busy)assert.ok(row.error.includes('single_chat.source_observation_busy'),row.error)
 for(const row of firstBatch)if(row.ok)assert.equal(row.value.draft.attachments.length,1)
 report.sourceLoad.firstBatch=firstBatch.map(row=>({index:row.index,ok:row.ok,error:row.error??null}));report.sourceLoad.latencies.batchMs=performance.now()-startedAt
 record('real_directory_and_large_file_observations_exhaust_bounded_worker_capacity_without_blocking_an_independent_database_commit')
 for(const row of busy)await attach(contexts[row.index],row.index<4?tree:large,'R08 material '+row.index)
 for(const context of contexts.slice(0,8)){const snapshot=await request('singleChat.get',{conversationId:context.conversationId});assert.equal(snapshot.draft.attachments.length,1);assert.deepEqual(snapshot.agentRuns,[])}
 const database=new DatabaseSync(join(dataDir,'rovai.sqlite'),{readOnly:true})
 try{
  const observations=contexts.slice(0,8).map(context=>({conversationId:context.conversationId,rows:database.prepare('SELECT observation_json FROM single_chat_source_observation WHERE conversation_id=?').all(context.conversationId).map(row=>JSON.parse(row.observation_json))}))
  for(const [n,item] of observations.entries()){
   assert.equal(item.rows.length,1);const value=item.rows[0]
   assert.equal(value.byteSize,n<4?sourceManifest.tree.bytes:fileBytes.length)
   assert.equal(value.fileCount,n<4?treeFiles.length:1)
   if(n>=4)assert.equal(value.contentDigest,sourceManifest.large.sha256)
  }
  report.sourceLoad.persistedObservations=observations
 }finally{database.close()}
 record('real_core_persists_complete_directory_file_counts_and_large_file_sha_after_busy_requests_can_be_retried')
 const before=await request('singleChat.get',{conversationId:contexts[8].conversationId})
 let failure;try{await attach(contexts[8],deep,'R08 too deep')}catch(error){failure=JSON.stringify(error)}
 assert.ok(failure?.includes('single_chat.attachment_source_changed'),failure??'over-deep source unexpectedly accepted')
 report.sourceLoad.overDepthPublicRejection=JSON.parse(failure)
 const after=await request('singleChat.get',{conversationId:contexts[8].conversationId});assert.deepEqual(after.draft,before.draft)
 await attach(contexts[8],large,'R08 valid after rejection')
 record('actual_over_depth_source_is_rejected_without_mutating_materials_or_leaking_the_worker_slot')
 const context=contexts[0],graph=await request('canvas.nodes.snapshot',{boardId:cheap.payload.board.id})
 const node=await request('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId:graph.board.id,expectedRevision:graph.board.revision,mutation:{type:'create',node:{kind:'conversation',conversation:{threadId:context.threadId,conversationId:context.conversationId},x:0,y:0,width:520,height:600}}}})
 assert.equal(node.status,'applied');const scope={kind:'canvas',boardId:graph.board.id,nodeId:node.payload.nodeIds[0]}
 const mutate=async(action,id=randomUUID())=>{const snapshot=await request('singleChat.get',{conversationId:context.conversationId,composerScope:scope});return request('singleChat.composerDraft.mutate',{commandId:id,command:{...context,composerScope:scope,expectedDraftRevision:snapshot.draft.revision,action}})}
 assert.equal((await mutate({type:'register_scope'})).status,'applied')
 const legacy=await request('singleChat.get',{conversationId:context.conversationId}),target=await request('singleChat.get',{conversationId:context.conversationId,composerScope:scope})
 const original={commandId:randomUUID(),command:{...context,composerScope:scope,expectedDraftRevision:target.draft.revision,action:{type:'adopt_legacy_materials',expectedSourceRevision:legacy.draft.revision,targetBody:''}}}
 const receipt=await request('singleChat.composerDraft.mutate',original);assert.equal(receipt.status,'applied',JSON.stringify(receipt))
 assert.equal(await realpath(tree),tree);const backup=owned(join(fixture,'source-tree-before-replay'));assert.equal(await realpath(resolve(backup,'..')),await realpath(fixture))
 await writeFile(join(evidence,'source-before-temporary-move.json'),JSON.stringify({from:tree,to:backup,manifestSha256:hash(await readFile(join(evidence,'source-fixture-before.json')))},null,2)+'\n',{flag:'wx'})
 let moved=false
 try{await rename(owned(tree),backup);moved=true;const replay=await request('singleChat.composerDraft.mutate',structuredClone(original));assert.deepEqual(replay,receipt)}finally{if(moved)await rename(backup,owned(tree))}
 record('recorded_original_uuid_replays_without_rescanning_an_unavailable_large_directory_or_moving_materials_again')
 const terminalGraph=await request('canvas.nodes.snapshot',{boardId:graph.board.id}),terminal=await request('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId:graph.board.id,expectedRevision:terminalGraph.board.revision,mutation:{type:'create',node:{kind:'terminal',path:fixture,x:560,y:0,width:480,height:320}}}})
 assert.equal(terminal.status,'applied');const terminalTarget={boardId:graph.board.id,nodeId:terminal.payload.nodeIds[0]},empty=await request('canvas.terminals.snapshot',{target:terminalTarget})
 const launched=await request('canvas.terminals.start',{target:terminalTarget,coreGeneration:empty.coreGeneration,requestId:randomUUID(),expectedGeneration:null,cols:80,rows:24})
 await until(async()=>{const snapshot=await request('canvas.terminals.snapshot',{target:terminalTarget,generation:launched.generation});assert.notEqual(snapshot.phase,'failed',snapshot.issue);return snapshot.phase==='running'},'log producer PTY ready')
 let sequence=0
 const send=async source=>{new Script(source);const inputId=randomUUID();let receipt=await request('canvas.terminals.write',{target:terminalTarget,generation:launched.generation,inputId,expectedInputSequence:sequence,bytesBase64:Buffer.from(source+'\r').toString('base64')});if(['queued','pending'].includes(receipt.status))receipt=await until(async()=>{const snapshot=await request('canvas.terminals.snapshot',{target:terminalTarget,generation:launched.generation});return snapshot.inputs.find(row=>row.inputId===inputId&&!['queued','pending'].includes(row.status))},'flood control receipt');assert.equal(receipt.status,'written');assert.equal(receipt.sequence,++sequence)}
 const proof=join(evidence,'flood-proof.json'),progress=join(evidence,'flood-progress.json'),stop=join(evidence,'flood-stopped.json'),nonce=randomUUID()
 await send(`var r08Active=true,r08Bytes=0,r08Next=1024*1024;require('node:fs').writeFileSync(${JSON.stringify(proof)},JSON.stringify({nonce:${JSON.stringify(nonce)},pid:process.pid,ppid:process.ppid,tty:process.stdin.isTTY}));function r08Pump(){if(!r08Active)return;r08Bytes+=8192;if(r08Bytes>=r08Next){r08Next+=1024*1024;require('node:fs').writeFileSync(${JSON.stringify(progress)},JSON.stringify({nonce:${JSON.stringify(nonce)},bytes:r08Bytes}))}if(process.stdout.write(Buffer.alloc(8192,65)))setImmediate(r08Pump);else process.stdout.once('drain',r08Pump)}r08Pump();`)
 const actual=await until(async()=>{const value=await readJson(proof);return value?.nonce===nonce?value:null},'actual log producer identity');assert.equal(actual.tty,true);report.sourceLoad.floodProcess=actual
 const produced=await until(async()=>{const value=await readJson(progress);return value?.nonce===nonce&&value.bytes>=1024*1024?value:null},'at least one MiB actual stdout')
 const replay=await request('canvas.terminals.snapshot',{target:terminalTarget,generation:launched.generation,afterSeq:0}),bytes=Buffer.concat(replay.chunks.map(chunk=>Buffer.from(chunk.bytesBase64,'base64')))
 assert.ok(bytes.length<=128*1024);assert.ok(replay.chunks.length<=2048&&replay.chunks.every(chunk=>Buffer.from(chunk.bytesBase64,'base64').length<=8192));assert.equal(replay.gap,true);assert.ok(replay.firstAvailableSeq>1)
 const latency=performance.now();assert.equal((await request('canvas.boards.create',{commandId:randomUUID(),command:{name:'R08 日志洪流中的独立事务'}})).status,'applied')
 report.sourceLoad.latencies.floodCommitMs=performance.now()-latency
 const resizeStart=performance.now();assert.equal((await request('canvas.terminals.resize',{target:terminalTarget,generation:launched.generation,cols:100,rows:30})).resized,true);report.sourceLoad.latencies.floodResizeMs=performance.now()-resizeStart
 await send(`r08Active=false;require('node:fs').writeFileSync(${JSON.stringify(stop)},JSON.stringify({nonce:${JSON.stringify(nonce)},pid:process.pid,bytes:r08Bytes}));`)
 const stopped=await until(async()=>{const value=await readJson(stop);return value?.nonce===nonce&&value.pid===actual.pid?value:null},'stdin reaches shell during actual stdout flood')
 report.sourceLoad.flood={producedBeforeRead:produced.bytes,producedAtStop:stopped.bytes,retainedBytes:bytes.length,firstAvailableSeq:replay.firstAvailableSeq,throughSeq:replay.throughSeq,gap:replay.gap}
 record('actual_stdout_flood_keeps_a_128kib_replay_gap_and_does_not_starve_database_commit_resize_or_stdin')
 await request('canvas.terminals.stop',{target:terminalTarget,generation:launched.generation})
 await until(async()=>{const value=await request('canvas.terminals.snapshot',{target:terminalTarget,generation:launched.generation});return value.cleanupComplete},'actual flooded terminal tree cleanup')
 assert.equal(hash(await readFile(large)),sourceManifest.large.sha256)
 for(const item of treeFiles)assert.equal(hash(await readFile(join(tree,item.path))),item.sha256)
 for(const item of contexts){const snapshot=await request('singleChat.get',{conversationId:item.conversationId});assert.deepEqual(snapshot.agentRuns,[]);assert.deepEqual(snapshot.messages,[])}
 record('load_checks_preserve_all_original_source_bytes_and_create_no_messages_or_model_runs')
}
