import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {realpath} from 'node:fs/promises'
import {Script} from 'node:vm'
import {setTimeout as pause} from 'node:timers/promises'

export async function qualifyCanvasTerminalCapacity({native,web,reconnect,directory,evidence,report,record,helpers}){
  const until=async(predicate,label)=>{const deadline=Date.now()+30000;while(Date.now()<deadline){const value=await predicate();if(value)return value;await pause(80)}throw Error('Terminal condition timed out: '+label)}
  const readJson=async path=>{try{return JSON.parse(await readFile(path,'utf8'))}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error}}
  const board=await native('canvas.boards.create',{commandId:randomUUID(),command:{name:'R07 真实PTY容量与连接'}})
  assert.equal(board.status,'applied',JSON.stringify(board));const boardId=board.payload.board.id,targets=[],sessions=[]
  const sourceDirectory=await realpath(directory)
  for(let n=0;n<17;n++){
    const graph=await native('canvas.nodes.snapshot',{boardId}),created=await native('canvas.nodes.apply',{commandId:randomUUID(),command:{boardId,expectedRevision:graph.board.revision,mutation:{type:'create',node:{kind:'terminal',path:sourceDirectory,x:n%4*500,y:Math.floor(n/4)*340,width:480,height:300}}}})
    assert.equal(created.status,'applied',JSON.stringify(created));targets.push({boardId,nodeId:created.payload.nodeIds[0]})
  }
  assert.equal((await native('canvas.nodes.snapshot',{boardId})).terminalVersion,1)
  const start=async(target,expectedGeneration=null,request=native)=>{
    const before=await request('canvas.terminals.snapshot',{target})
    const command={target,coreGeneration:before.coreGeneration,requestId:randomUUID(),expectedGeneration,cols:80,rows:24}
    const initial=await request('canvas.terminals.start',command)
    const snapshot=await until(async()=>{const value=await request('canvas.terminals.snapshot',{target,generation:initial.generation});assert.notEqual(value.phase,'failed',value.issue);return value.phase==='running'?value:null},'real session running')
    assert.equal(snapshot.launchRequestId,command.requestId)
    const session={target,command,generation:snapshot.generation,coreGeneration:snapshot.coreGeneration,sequence:snapshot.inputSequence}
    sessions.push(session);return session
  }
  const write=async(session,bytes,request=native)=>{
    const command={target:session.target,generation:session.generation,inputId:randomUUID(),expectedInputSequence:session.sequence,bytesBase64:Buffer.from(bytes).toString('base64')}
    let receipt=await request('canvas.terminals.write',command)
    if(['queued','pending'].includes(receipt.status))receipt=await until(async()=>{const state=await request('canvas.terminals.snapshot',{target:session.target,generation:session.generation});return state.inputs.find(row=>row.inputId===command.inputId&&!['queued','pending'].includes(row.status))},'actual stdin receipt')
    assert.equal(receipt.status,'written',JSON.stringify(receipt));assert.equal(receipt.sequence,++session.sequence)
    return {command,receipt}
  }
  const code=async(session,source,request=native)=>{new Script(source);return write(session,Buffer.from(source+'\r'),request)}
  const prove=async(session,index)=>{
    const path=join(evidence,`shell-${index}.json`),nonce=randomUUID()
    await code(session,`require('node:fs').writeFileSync(${JSON.stringify(path)},JSON.stringify({nonce:${JSON.stringify(nonce)},pid:process.pid,ppid:process.ppid,cwd:process.cwd(),tty:process.stdin.isTTY}));`)
    const proof=await until(async()=>{const value=await readJson(path);return value?.nonce===nonce?value:null},'actual PTY process proof')
    assert.equal(proof.tty,true);assert.equal(await realpath(proof.cwd),sourceDirectory);session.proof=proof;return proof
  }
  const stop=async session=>{
    await native('canvas.terminals.stop',{target:session.target,generation:session.generation})
    await until(async()=>{const state=await native('canvas.terminals.snapshot',{target:session.target,generation:session.generation});return state.cleanupComplete?state:null},'actual process cleanup')
  }
  const reject=async(promise,code)=>{let failure;try{await promise}catch(error){failure=JSON.stringify(error)}assert.ok(failure?.includes(code),failure??'unexpectedly accepted');return failure}
  for(let n=0;n<16;n++){
    const session=await start(targets[n]);await prove(session,n)
    console.log(JSON.stringify({progress:'real_pty_capacity',started:n+1,total:16}))
  }
  const firstSixteen=structuredClone(sessions),tree=await helpers();assert.equal(tree.length,16)
  assert.equal(new Set(firstSixteen.map(session=>session.proof.pid)).size,16)
  for(const session of firstSixteen)assert.ok(tree.some(helper=>helper.ProcessId===session.proof.ppid),'shell parent must be an actual owned PTY helper')
  report.terminal_capacity={boardId,sourceDirectory,sessions:firstSixteen,actualHelpers:tree}
  record('sixteen_actual_owned_helpers_have_unique_interactive_pty_shells_at_original_cwd')
  const before17=await native('canvas.terminals.snapshot',{target:targets[16]})
  const denied={target:targets[16],coreGeneration:before17.coreGeneration,requestId:randomUUID(),expectedGeneration:null,cols:80,rows:24}
  await reject(native('canvas.terminals.start',denied),'canvas_terminal.capacity_exhausted')
  assert.equal((await helpers()).length,16);assert.equal((await native('canvas.terminals.snapshot',{target:targets[16]})).exists,false)
  record('seventeenth_actual_start_is_rejected_without_creating_an_extra_helper_or_session')
  await stop(sessions[0]);assert.equal((await helpers()).length,15)
  const seventeenth=await start(targets[16],null,web);await prove(seventeenth,16);assert.equal((await helpers()).length,16)
  const replay=await native('canvas.terminals.start',sessions[0].command);assert.equal(replay.generation,sessions[0].generation);assert.equal(replay.cleanupComplete,true)
  const retry={...sessions[0].command,requestId:randomUUID(),expectedGeneration:sessions[0].generation}
  await reject(native('canvas.terminals.start',retry),'canvas_terminal.capacity_exhausted')
  record('reclaimed_slot_admits_another_real_shell_and_replaying_a_finished_start_does_not_reopen_it')
  const counter=join(evidence,'once-counter.json'),nonce=randomUUID()
  const source=`require('node:fs').writeFileSync(${JSON.stringify(counter)},JSON.stringify({nonce:${JSON.stringify(nonce)},count:(require('node:fs').existsSync(${JSON.stringify(counter)})?JSON.parse(require('node:fs').readFileSync(${JSON.stringify(counter)},'utf8')).count:0)+1}));`
  const original=await code(seventeenth,source,web)
  await until(async()=>{const value=await readJson(counter);return value?.nonce===nonce&&value.count===1},'first stdin side effect')
  const beforeReconnect=await web('canvas.terminals.snapshot',{target:seventeenth.target,generation:seventeenth.generation})
  await reconnect()
  const afterReconnect=await web('canvas.terminals.snapshot',{target:seventeenth.target,generation:seventeenth.generation,afterSeq:beforeReconnect.throughSeq})
  assert.equal(afterReconnect.coreGeneration,beforeReconnect.coreGeneration);assert.equal(afterReconnect.generation,beforeReconnect.generation);assert.equal(afterReconnect.launchRequestId,beforeReconnect.launchRequestId)
  assert.equal(afterReconnect.inputSequence,beforeReconnect.inputSequence)
  const duplicate=await web('canvas.terminals.write',original.command);assert.deepEqual(duplicate,original.receipt)
  const barrier=join(evidence,'reconnect-barrier.json')
  await code(seventeenth,`require('node:fs').writeFileSync(${JSON.stringify(barrier)},JSON.stringify({nonce:${JSON.stringify(nonce)},pid:process.pid}));`,web)
  await until(async()=>{const value=await readJson(barrier);return value?.nonce===nonce&&value.pid===seventeenth.proof.pid},'reconnected original shell barrier')
  assert.equal((await readJson(counter)).count,1);assert.equal((await helpers()).length,16)
  report.terminal_capacity.reconnect={sameCore:true,sameGeneration:true,samePid:true,duplicateEffectCount:1,cursor:beforeReconnect.throughSeq}
  record('real_listener_stop_new_login_and_http_reconnect_resume_original_shell_cursor_and_input_receipt_without_reexecution')
  const chinese=join(evidence,'utf8-split.txt'),chineseBody='汉字🙂\n'
  const chineseSource=`require('node:fs').writeFileSync(${JSON.stringify(chinese)},${JSON.stringify(chineseBody)},'utf8');\r`
  new Script(chineseSource.trim());const bytes=Buffer.from(chineseSource),split=bytes.indexOf(Buffer.from('汉'))+1
  assert.ok(split>0&&split<bytes.length);await write(seventeenth,bytes.subarray(0,split),web);await write(seventeenth,bytes.subarray(split),web)
  await until(async()=>{try{return (await readFile(chinese)).equals(Buffer.from(chineseBody))}catch(error){if(error.code==='ENOENT')return false;throw error}},'split UTF8 actual shell file')
  record('actual_pty_preserves_chinese_and_emoji_bytes_split_inside_a_utf8_character_not_an_ime_qualification')
  await stop(seventeenth)
  const restarted=await start(targets[0],sessions[0].generation);await prove(restarted,17)
  assert.notEqual(restarted.generation,sessions[0].generation)
  await reject(native('canvas.terminals.write',{...original.command,target:targets[0],generation:sessions[0].generation}),'canvas_terminal.stale_generation')
  assert.equal((await native('canvas.terminals.snapshot',{target:targets[0]})).generation,restarted.generation)
  record('explicit_reopen_uses_new_generation_and_late_old_generation_input_cannot_reach_it')
  report.terminal_capacity.finalLive=sessions.filter(session=>session!==sessions[0]&&session!==seventeenth)
  assert.equal(report.terminal_capacity.finalLive.length,16)
  await writeFile(join(evidence,'sessions-before-shutdown.json'),JSON.stringify(report.terminal_capacity.finalLive,null,2)+'\n',{flag:'wx'})
  return {targets,sessions,coreGeneration:restarted.coreGeneration}
}
