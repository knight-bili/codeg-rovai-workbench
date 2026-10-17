import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, realpath, appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

async function createProbe(config) {
  const core = await realpath(join(config.data_root, 'Core'))
  const trace = async (stage, details = {}) => appendFile(join(config.evidence, 'interruption-trace.jsonl'), JSON.stringify({stage, at: new Date().toISOString(), ...details})+'\n')
  const query = (sql, params) => {
    const code = "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1],{readOnly:true});try{console.log(JSON.stringify(db.prepare(process.argv[2]).all(...JSON.parse(process.argv[3]))))}finally{db.close()}"
    return JSON.parse(execFileSync(process.env.ROVAI_ACCEPTANCE_NODE, ['--no-warnings','--input-type=module','-e',code,join(core,'rovai.sqlite'),sql,JSON.stringify(params)], {encoding:'utf8',windowsHide:true}))
  }
  const ownerProcess = async () => {
    const ps = `$rows=@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${process.pid}' | Where-Object {$_.Name -eq 'rovai-host.exe'} | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine);ConvertTo-Json -InputObject $rows -Compress`
    const rows = JSON.parse(execFileSync(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-NonInteractive','-Command',ps], {encoding:'utf8',windowsHide:true}))
    assert.equal(rows.length, 1)
    const child = rows[0]
    assert.equal(child.ParentProcessId, process.pid)
    assert.equal(resolve(child.ExecutablePath).toLowerCase(), resolve(process.env.ROVAI_HOST_BIN).toLowerCase())
    assert.ok(child.CommandLine.toLowerCase().includes(core.toLowerCase()))
    return child
  }
  const frozen = async runId => {
    const rows = query('SELECT m.id AS manifest_id,m.agent_run_id,m.rendered_payload_blob_id,m.current_input_source_json,b.sha256,b.byte_size,b.storage_relative_path,d.id AS delivery_id,d.status AS delivery_status,d.dynamic_payload_digest,d.dispatch_started_at,d.accepted_at,r.execution_epoch,r.status AS run_status,r.last_error_code,r.cancel_reason_code FROM context_manifest m JOIN managed_blob b ON b.id=m.rendered_payload_blob_id JOIN runtime_input_delivery d ON d.context_manifest_id=m.id JOIN agent_run r ON r.id=m.agent_run_id WHERE m.agent_run_id=?',[runId])
    if (!rows.length) return null
    assert.equal(rows.length, 1)
    const row = rows[0], bytes = await readFile(join(core,'managed-blobs',row.storage_relative_path))
    assert.equal(bytes.length,row.byte_size); assert.equal(createHash('sha256').update(bytes).digest('hex'),row.sha256)
    return {row,bytes}
  }
  const captured = async body => (await readFile(config.runtime_capture,'utf8')).trim().split('\n').map(JSON.parse).filter(entry => {
    const text = entry.params.prompt.filter(part => part.type === 'text').map(part => part.text).join('\n')
    const match = /\[CURRENT_INPUT\]\s*([\s\S]*?)\s*\[\/CURRENT_INPUT\]/.exec(text)
    return match && JSON.parse(match[1]).message === body
  })
  const until = async predicate => {
    const deadline = Date.now()+30_000
    for (;;) { const value = await predicate(); if(value)return value; assert.ok(Date.now()<deadline,'Core interruption observation timed out'); await pause(100) }
  }
  return { core, query, trace, ownerProcess, frozen, captured, until }
}

// Actual isolated Core process loss. Never infers not_accepted from silence.
export async function qualifyPrivateCoreInterruption(window, tools) {
  if (tools.config.private_app_phase) return qualifyPrivateAppInterruption(window, tools)
  const { config, context, report, record, evaluate, wait, rpc, seam, openCanvasBoard, open, get, addMaterial,
    clickNative, typeBody, frame, input, waitMain, waitPrivateSnapshot } = tools
  const { conversationId, boardId, scopes } = context
  const { trace, ownerProcess, frozen, captured, until } = await createProbe(config)
  const immutable = value => Object.fromEntries(Object.entries(value).filter(([key])=>!['delivery_status','run_status','last_error_code','cancel_reason_code'].includes(key)))
  const results = []
  await addMaterial(scopes[1],'R04 另一卡始终保留.txt','乙材料对应的问题')
  const otherBody='R04 Core退出不能清空另一卡正文'; await typeBody(1,otherBody)
  for (const boundary of ['before_native_confirmation','after_native_confirmation']) {
    await addMaterial(scopes[0],`R04 ${boundary}.txt`,'甲材料对应的问题')
    const marker = boundary==='before_native_confirmation'?'ROVAI_SKILL_RECOVERY_SILENT_HELD_INPUT':'ROVAI_R04_CONFIRMED_COMPLETED_INPUT'
    const body=`${marker} R04 ${randomUUID()}`; await typeBody(0,body)
    const beta=(await get(scopes[1])).draft, count=(await get(null)).agentRuns.length
    const gate=seam.holdSend({conversationId,scope:scopes[0]}), mark=seam.mark()
    await clickNative(`${frame(0)}.querySelector('.single-chat-composer button[type="submit"]')`)
    await waitMain(()=>Boolean(gate.observed))
    assert.equal(gate.observed.result.kind,'value'); assert.equal(gate.observed.result.value.status,'accepted')
    const commandId=gate.observed.params.commandId, runId=gate.observed.result.value.payload.agentRunId; assert.ok(runId)
    const before=await until(async()=>{
      const value=await frozen(runId); if(!value||!(await captured(body)).length)return null
      return boundary==='before_native_confirmation'
        ? value.row.delivery_status==='prepared'&&value.row.dispatch_started_at&&value.row.accepted_at===null?value:null
        : value.row.delivery_status==='accepted'&&value.row.accepted_at&&value.row.run_status==='succeeded'?value:null
    })
    const received=await captured(body); assert.equal(received.length,1)
    assert.ok(received[0].params.prompt.some(part=>part.type==='text'&&part.text.includes(before.bytes.toString('utf8'))))
    await writeFile(join(config.evidence,boundary+'-before.txt'),before.bytes,{flag:'wx'})
    await trace('frozen', {boundary, commandId, runId})
    const supervisor=await evaluate('window.rovai.supervisor.getSnapshot()')
    await trace('supervisor_before', {supervisor})
    const old=await ownerProcess()
    await trace('owner_before', {old})
    assert.equal(supervisor.fullCoreState,'ready')
    assert.equal(before.row.run_status,boundary==='before_native_confirmation'?'running':'succeeded')
    process.kill(old.ProcessId,'SIGKILL')
    await trace('core_killed', {pid:old.ProcessId})
    await wait(`window.rovai.supervisor.getSnapshot().then(value=>value.generation>${supervisor.generation}&&value.fullCoreState==='ready')`,60_000)
    const next=await ownerProcess(); assert.notEqual(next.ProcessId,old.ProcessId)
    await trace('core_restarted', {next})
    await waitPrivateSnapshot(rpc,conversationId,value=>['succeeded','failed','cancelled'].includes(value.agentRuns.find(run=>run.id===runId)?.status))
    const after=await frozen(runId); assert.deepEqual(immutable(after.row),immutable(before.row)); assert.deepEqual(after.bytes,before.bytes)
    // Single Chat v1.3 stops the interrupted reply; it never joins public Runtime replay.
    assert.equal(after.row.run_status,boundary==='before_native_confirmation'?'cancelled':'succeeded')
    assert.equal(after.row.cancel_reason_code,boundary==='before_native_confirmation'?'core_restarted':null)
    assert.equal(after.row.last_error_code,null)
    await trace('frozen_after', {row:after.row})
    assert.equal(after.row.delivery_status,boundary==='before_native_confirmation'?'delivery_unknown':'accepted')
    await openCanvasBoard(evaluate,wait,boardId)
    for(const index of [0,1])if(!await evaluate(`Boolean(${frame(index)})`))await open(index)
    const recover=`[...${frame(0)}.querySelectorAll('button')].find(button=>button.textContent==='恢复原请求')`
    await wait(`${input(0)}.value===''||Boolean(${recover})`)
    if(await evaluate(`Boolean(${recover})`))await clickNative(recover)
    await wait(`${input(0)}.value===''`)
    const lookup=seam.since(mark).filter(entry=>entry.method==='commands.reconcile'&&entry.lookupCommandId===commandId)
    assert.ok(lookup.length,'restored production input must actually reconcile the original command')
    assert.deepEqual((await get(scopes[1])).draft,beta); assert.equal(await evaluate(`${input(1)}.value`),otherBody)
    gate.release(); await pause(250)
    assert.equal(seam.since(mark).filter(entry=>entry.method==='singleChat.send').length,1)
    assert.equal((await captured(body)).length,1); assert.equal((await get(null)).agentRuns.length,count+1)
    await writeFile(join(config.evidence,boundary+'-after.txt'),after.bytes,{flag:'wx'})
    const outcome={boundary,classification:boundary==='before_native_confirmation'?'dispatched_confirmation_unknown_not_proven_unaccepted':'confirmed_accepted_at_standard_acp_terminal_not_running_acceptance',commandId,runId,oldCorePid:old.ProcessId,newCorePid:next.ProcessId,before:before.row,after:after.row,originalLookups:lookup.length,inputCount:1}
    results.push(outcome); await writeFile(join(config.evidence,boundary+'.json'),JSON.stringify(outcome,null,2)+'\n',{flag:'wx'})
    record('actual_core_kill_'+boundary+'_preserves_frozen_blob_original_receipt_and_other_card_without_redispatch')
  }
  report.private_core_interruption={results,scope:'actual Core kill and production Desktop generation rebuild; entire-App hard exit remains separate; no external model'}
  await writeFile(join(config.evidence,'01-core-restart-original-input-reconciled.png'),(await window.webContents.capturePage()).toPNG())
}

async function qualifyPrivateAppInterruption(window, tools) {
  const { config, context, report, record, evaluate, wait, rpc, seam, get, addMaterial, clickNative,
    typeBody, frame, input, waitMain, waitPrivateSnapshot } = tools
  const { conversationId, scopes } = context
  const { ownerProcess, frozen, captured, until } = await createProbe(config)
  if (config.private_app_phase === 'prepare') {
    await addMaterial(scopes[1], 'R04 整App退出乙卡保留.txt', '乙材料对应的问题')
    const otherBody = `R04 整App硬退出保留末字 ${randomUUID()}`
    await typeBody(1, otherBody)
    const beta = (await get(scopes[1])).draft
    await addMaterial(scopes[0], 'R04 整App退出甲卡已发送.txt', '甲材料对应的问题')
    const body = `ROVAI_SKILL_RECOVERY_SILENT_HELD_INPUT R04 整App ${randomUUID()}`
    await typeBody(0, body)
    const count = (await get(null)).agentRuns.length, gate = seam.holdSend({conversationId, scope:scopes[0]})
    await clickNative(`${frame(0)}.querySelector('.single-chat-composer button[type="submit"]')`)
    await waitMain(() => Boolean(gate.observed))
    assert.equal(gate.observed.result.kind, 'value'); assert.equal(gate.observed.result.value.status, 'accepted')
    const runId = gate.observed.result.value.payload.agentRunId, commandId = gate.observed.params.commandId
    const before = await until(async () => {
      const value = await frozen(runId)
      return value?.row.delivery_status === 'prepared' && value.row.dispatch_started_at && value.row.accepted_at === null
        && (await captured(body)).length === 1 ? value : null
    })
    const core = await ownerProcess()
    const checkpoint = { context, beta, otherBody, body, runId, commandId, runCount:count+1, before:before.row,
      appPid:process.pid, corePid:core.ProcessId, coreExecutable:core.ExecutablePath, dataRoot:config.data_root,
      originalSend:gate.observed.params, phase:'ready_for_intentional_whole_app_sigkill', at:new Date().toISOString() }
    await writeFile(join(config.evidence, 'frozen-before.txt'), before.bytes, {flag:'wx'})
    await writeFile(join(config.evidence, 'checkpoint.json'), JSON.stringify(checkpoint,null,2)+'\n', {flag:'wx'})
    await writeFile(join(config.evidence, '01-before-whole-app-hard-exit.png'), (await window.webContents.capturePage()).toPNG())
    // Deliberately bypass planned shutdown and leave original send reply unresolved.
    // No storage flush, graceful navigation, manual draft save or synthetic DB writes.
    process.kill(process.pid, 'SIGKILL')
    await new Promise(() => {})
  }
  assert.equal(config.private_app_phase, 'resume')
  const checkpointBytes = await readFile(config.private_app_checkpoint)
  assert.equal(createHash('sha256').update(checkpointBytes).digest('hex'), config.private_app_checkpoint_sha256)
  const prior = JSON.parse(checkpointBytes)
  assert.deepEqual(context, prior.context); assert.equal(resolve(config.data_root), resolve(prior.dataRoot))
  assert.notEqual(process.pid, prior.appPid)
  const next = await ownerProcess(); assert.notEqual(next.ProcessId, prior.corePid)
  await waitPrivateSnapshot(rpc, conversationId, value => value.agentRuns.find(run => run.id === prior.runId)?.status === 'cancelled')
  const after = await frozen(prior.runId)
  const immutable = row => Object.fromEntries(Object.entries(row).filter(([key]) => !['delivery_status','run_status','last_error_code','cancel_reason_code'].includes(key)))
  assert.deepEqual(immutable(after.row), immutable(prior.before))
  assert.equal(after.row.delivery_status, 'delivery_unknown'); assert.equal(after.row.accepted_at, null)
  assert.equal(after.row.cancel_reason_code, 'core_restarted')
  assert.deepEqual(after.bytes, await readFile(join(config.private_app_prepare_evidence, 'frozen-before.txt')))
  const recover = `[...${frame(0)}.querySelectorAll('button')].find(button=>button.textContent==='恢复原请求')`
  await wait(`${input(0)}.value===''||Boolean(${recover})`)
  if (await evaluate(`Boolean(${recover})`)) await clickNative(recover)
  await wait(`${input(0)}.value===''`)
  const requests = seam.since(0), lookups = requests.filter(entry => entry.method === 'commands.reconcile' && entry.lookupCommandId === prior.commandId)
  assert.ok(lookups.length, 'fresh App must reconcile the original persisted send command')
  assert.ok(!requests.some(entry => entry.method === 'singleChat.send'), 'fresh App must never redispatch the accepted command')
  assert.equal((await captured(prior.body)).length, 1)
  assert.equal((await get(null)).agentRuns.length, prior.runCount)
  assert.deepEqual((await get(scopes[1])).draft, prior.beta)
  assert.equal(await evaluate(`${input(1)}.value`), prior.otherBody)
  const ownDraft = (await get(scopes[0])).draft
  assert.equal(ownDraft.attachments.length, 0); assert.equal(ownDraft.quotes.length, 0)
  record('actual_whole_app_sigkill_then_fresh_app_restores_other_card_body_and_materials_without_manual_flush')
  record('fresh_app_reconciles_persisted_original_send_uuid_without_redispatch_or_refreezing_unknown_input')
  report.private_app_interruption = { originalAppPid:prior.appPid, newAppPid:process.pid, originalCorePid:prior.corePid,
    newCorePid:next.ProcessId, commandId:prior.commandId, runId:prior.runId, originalLookups:lookups.length, before:prior.before,
    after:after.row, promptCount:1, storageFlush:false, gracefulShutdown:false, scope:'actual owned Windows App and Core loss; local fixed ACP; no external inference' }
  await writeFile(join(config.evidence, 'frozen-after.txt'), after.bytes, {flag:'wx'})
  await writeFile(join(config.evidence, '01-after-whole-app-hard-exit.png'), (await window.webContents.capturePage()).toPNG())
}
