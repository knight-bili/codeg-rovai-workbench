import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, unlink, realpath } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'

// Qualification only: production UI/IPC/Core owns every command. SQLite is
// opened read-only solely to compare durable input bytes and locate owned sources.
export async function qualifyPrivateSendBoundaries(window, tools) {
  const { config, context, report, record, evaluate, wait, rpc, seam, openCanvasBoard, open, get, mutate,
    addMaterial, clickNative, typeBody, frame, input, ownedConversations, waitMain, waitPrivateSnapshot, beginHeldPrivateRun, terminal } = tools
  const { threadId, conversationId, boardId, scopes, agentId, quoteMessage } = context
  const core = await realpath(join(config.data_root, 'Core'))
  const query = (sql, params) => {
    assert.ok(process.env.ROVAI_ACCEPTANCE_NODE)
    const code = "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1],{readOnly:true}); try{console.log(JSON.stringify(db.prepare(process.argv[2]).all(...JSON.parse(process.argv[3]))))}finally{db.close()}"
    return JSON.parse(execFileSync(process.env.ROVAI_ACCEPTANCE_NODE, ['--no-warnings', '--input-type=module', '-e', code,
      join(core, 'rovai.sqlite'), sql, JSON.stringify(params)], { encoding: 'utf8', windowsHide: true }))
  }
  const captures = async () => (await readFile(config.runtime_capture, 'utf8')).trim().split('\n').map(JSON.parse).flatMap(entry => {
    const text = (entry.params?.prompt ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
    const match = /\[CURRENT_INPUT\]\s*([\s\S]*?)\s*\[\/CURRENT_INPUT\]/.exec(text)
    return match ? [{ requestId: entry.requestId, text, input: JSON.parse(match[1]) }] : []
  })
  const send = index => `${frame(index)}.querySelector('.single-chat-composer button[type="submit"]')`
  const defaultInput = `([...document.querySelectorAll('.single-chat-composer textarea')].find(element=>!element.closest('.canvas-conversation-frame')&&element.checkVisibility()))`
  const defaultOpen = async () => {
    await clickNative(`document.querySelector('[data-id="${scopes[0].nodeId}"] button[aria-label="打开完整工作区"]')`)
    await wait(`Boolean(${defaultInput}&&!${defaultInput}.disabled&&!${defaultInput}.readOnly)`)
    await wait(`([...document.querySelectorAll('[data-single-chat-owner="${conversationId}"]')].some(element=>!element.closest('.canvas-conversation-frame')&&element.checkVisibility()))`)
  }
  const canvasOpen = async () => {
    await openCanvasBoard(evaluate, wait, boardId)
    for (const index of [0, 1]) {
      await wait(`Boolean(${frame(index)})||Boolean(document.querySelector('[data-id="${scopes[index].nodeId}"] button[aria-label="展开对话"]:not(:disabled)'))`)
      if (!await evaluate(`Boolean(${frame(index)})`)) await open(index)
      await wait(`Boolean(${input(index)}&&!${input(index)}.disabled&&!${input(index)}.readOnly)`)
    }
  }
  const waitBodyRun = body => waitPrivateSnapshot(rpc, conversationId, value => value.messages.some(message => message.authorType === 'user' && message.body === body) && value.agentRuns.every(terminal))
  const alphaBody = `R02 最终材料输入 ${randomUUID()}`, betaBody = `R02 乙卡一直保留 ${randomUUID()}`, defaultBody = `R02 默认位置独立正文 ${randomUUID()}`
  const alphaFile = 'R02 多引用甲源.txt', betaFile = 'R02 并行乙源.txt', ordinaryFile = 'R02 默认源.txt'
  await addMaterial(scopes[0], alphaFile, '甲材料对应的问题')
  const earlierExcerpt = 'R01 可引用原文'
  assert.equal((await mutate(scopes[0], { type: 'quote', action: { type: 'add', selection: { messageId: quoteMessage.id,
    bodyAtSelection: quoteMessage.body, startScalar: 0, endScalar: [...earlierExcerpt].length, text: earlierExcerpt } } })).status, 'applied')
  await addMaterial(scopes[1], betaFile, '乙材料对应的问题'); await addMaterial(null, ordinaryFile, earlierExcerpt)
  await typeBody(0, alphaBody); await typeBody(1, betaBody)
  const alpha = (await get(scopes[0])).draft, beta = (await get(scopes[1])).draft, ordinary = (await get(null)).draft
  await defaultOpen(); await typeBody(0, defaultBody, defaultInput); await canvasOpen()
  assert.equal(await evaluate(`${input(0)}.value`), alphaBody); assert.equal(await evaluate(`${input(1)}.value`), betaBody)
  await clickNative(send(0)); const alphaSent = await waitBodyRun(alphaBody)
  const alphaMessage = alphaSent.messages.find(message => message.authorType === 'user' && message.body === alphaBody)
  const alphaRun = alphaSent.agentRuns.find(run => !context.primeRunIds.includes(run.id))
  assert.ok(alphaRun && alphaMessage); assert.equal(alphaRun.status, 'succeeded')
  assert.deepEqual((await get(scopes[1])).draft, beta); assert.deepEqual((await get(null)).draft, ordinary)
  await defaultOpen(); assert.equal(await evaluate(`${defaultInput}.value`), defaultBody)
  await clickNative(`${defaultInput}.closest('.single-chat-composer').querySelector('button[type="submit"]')`)
  const defaultSent = await waitBodyRun(defaultBody)
  assert.deepEqual((await get(null)).draft.attachments, []); assert.deepEqual((await get(null)).draft.quotes, [])
  assert.deepEqual((await get(scopes[1])).draft, beta); assert.equal(await evaluate(`${defaultInput}.value`), '')
  await canvasOpen(); assert.equal(await evaluate(`${input(1)}.value`), betaBody)
  record('actual_default_and_canvas_bodies_remain_independent_across_navigation_and_both_real_send_paths')

  const defaultRun = defaultSent.agentRuns.find(run => !context.primeRunIds.includes(run.id) && run.id !== alphaRun.id)
  assert.ok(defaultRun); assert.equal(defaultRun.status, 'succeeded')
  const finalRows = query('SELECT manifest.agent_run_id,manifest.formatter_version,manifest.context_manifest_version,blob.sha256,blob.byte_size,blob.storage_relative_path,delivery.dynamic_payload_digest,delivery.status FROM context_manifest manifest JOIN managed_blob blob ON blob.id=manifest.rendered_payload_blob_id JOIN runtime_input_delivery delivery ON delivery.context_manifest_id=manifest.id WHERE manifest.agent_run_id IN (?,?)', [alphaRun.id, defaultRun.id])
  assert.equal(finalRows.length, 2)
  const row = finalRows.find(item => item.agent_run_id === alphaRun.id), baseline = finalRows.find(item => item.agent_run_id === defaultRun.id)
  assert.equal(row.formatter_version, baseline.formatter_version); assert.equal(row.context_manifest_version, baseline.context_manifest_version)
  const blobPath = resolve(core, 'managed-blobs', row.storage_relative_path), blob = await readFile(blobPath), text = blob.toString('utf8')
  assert.equal(createHash('sha256').update(blob).digest('hex'), row.sha256); assert.equal(blob.length, row.byte_size)
  assert.equal(row.dynamic_payload_digest, `sha256:${row.sha256}`); assert.equal(row.status, 'accepted')
  const received = (await captures()).filter(entry => entry.input.message === alphaBody)
  assert.equal(received.length, 1); assert.ok(received[0].text.includes(text), 'actual ACP must receive the complete immutable final Blob verbatim')
  assert.equal(received[0].input.attachments.length, 1); assert.equal(await readFile(received[0].input.attachments[0], 'utf8'), alphaFile)
  assert.deepEqual(received[0].input.quotes.map(quote => quote.text), alpha.quotes.map(quote => quote.text))
  assert.deepEqual(received[0].input.quotes.map(quote => quote.text), ['甲材料对应的问题', earlierExcerpt])
  const sections = text.match(/\[[A-Z_]+\]/g), required = ['[SELF_ACTIVE_TASKS]', '[RUN_FACTS]', '[ROVAI_ADDITIONAL_SKILLS]', '[ROVAI_SKILL_PACKS]', '[SINGLE_CHAT_GUIDANCE]', '[CURRENT_INPUT]']
  assert.deepEqual(sections.filter(section => required.includes(section)), required)
  assert.ok(sections.every(section => required.includes(section) || section === '[COLLABORATION_STATE]'))
  for (const id of [boardId, ...scopes.map(scope => scope.nodeId)]) assert.ok(!text.includes(id))
  const badKeys = new Set(['boardId', 'nodeId', 'scopeKey', 'composerScope', 'canvasId'])
  const inspect = value => { if (!value || typeof value !== 'object') return; for (const [key, child] of Object.entries(value)) { assert.ok(!badKeys.has(key)); inspect(child) } }
  inspect(received[0].input)
  await writeFile(join(config.evidence, 'final-blob-verbatim.txt'), blob, { flag: 'wx' })
  await writeFile(join(config.evidence, 'final-blob-runtime-comparison.json'), JSON.stringify({ row, baseline, requestId: received[0].requestId, sections, input: received[0].input, quoteIds: alpha.quotes.map(quote => quote.quoteId) }, null, 2) + '\n', { flag: 'wx' })
  record('durable_final_blob_digest_bytes_sections_and_two_quote_order_match_actual_acp_without_canvas_identity_fields')

  const beforeWrongQuote = (await get(scopes[0])).draft
  const removedForeign = await mutate(scopes[0], { type: 'quote', action: { type: 'remove', quoteId: beta.quotes[0].quoteId } })
  assert.equal(removedForeign.status, 'rejected'); assert.equal(removedForeign.code, 'quote.not_found')
  assert.deepEqual((await get(scopes[0])).draft, beforeWrongQuote); assert.deepEqual((await get(scopes[1])).draft, beta)
  const foreignThread = await rpc('threads.create', { commandId: randomUUID(), name: 'R02 越权引用来源', workspace: null, memberAgentIds: [agentId], defaultLeadAgentId: agentId, collaborationMode: 'peer' })
  assert.equal(foreignThread.status, 'applied')
  const foreignThreadId = foreignThread.payload.threadId
  const foreignOpened = await rpc('singleChat.open', { commandId: randomUUID(), command: { threadId: foreignThreadId, agentId } })
  assert.equal(foreignOpened.status, 'applied')
  const foreignId = foreignOpened.payload.conversationId; ownedConversations.set(foreignId, foreignThreadId)
  const foreignBody = `R02 另一私聊的引用 ${randomUUID()}`, foreignInitial = await rpc('singleChat.get', { conversationId: foreignId })
  assert.equal((await rpc('singleChat.send', { commandId: randomUUID(), command: { threadId: foreignThreadId, conversationId: foreignId, body: foreignBody, draftRevision: foreignInitial.draft.revision } })).status, 'accepted')
  const foreign = await waitPrivateSnapshot(rpc, foreignId, value => value.agentRuns.length > 0 && value.agentRuns.every(terminal))
  const foreignMessage = foreign.messages.find(message => message.authorType === 'user' && message.body === foreignBody)
  assert.ok(foreignMessage)
  const invisible = await mutate(scopes[0], { type: 'quote', action: { type: 'add', selection: { messageId: foreignMessage.id, bodyAtSelection: foreignBody, startScalar: 0, endScalar: [...foreignBody].length, text: foreignBody } } })
  assert.equal(invisible.status, 'rejected'); assert.equal(invisible.code, 'quote.source_unavailable')
  assert.deepEqual((await get(scopes[0])).draft, beforeWrongQuote); assert.deepEqual((await get(scopes[1])).draft, beta)
  record('real_core_rejects_another_card_quote_id_and_another_private_conversation_source_without_mutating_either_draft')

  const beforeQueueRuns = (await get(null)).agentRuns.length, heldId = await beginHeldPrivateRun(rpc, context, config.runtime_capture)
  await addMaterial(scopes[0], 'R02 FIFO甲源.txt', earlierExcerpt)
  const fifoBodies = [`R02 原队列甲 ${randomUUID()}`, `R02 原队列乙 ${randomUUID()}`]
  for (const index of [0, 1]) { await typeBody(index, fifoBodies[index]); await clickNative(send(index)); await wait(`${input(index)}.value===''`) }
  const queued = await get(scopes[1]); assert.deepEqual(queued.pendingInputs.items.map(item => item.body), fifoBodies)
  assert.equal(queued.agentRuns.length, beforeQueueRuns + 1)
  const pending = queued.pendingInputs.items[1]
  const edit = (scope, action, token = null) => rpc('singleChat.pendingInputs.edit', { commandId: randomUUID(), command: { threadId, conversationId, composerScope: scope,
    pendingInputId: pending.id, expectedRevision: pending.revision, editToken: token, action } })
  assert.equal((await edit(scopes[1], { type: 'begin' })).status, 'applied')
  const working = (await get(scopes[1])).pendingInputs.editSession; assert.ok(working?.editToken)
  for (const action of [{ type: 'quote', action: { type: 'remove', quoteId: working.workingQuotes[0].quoteId } }, { type: 'remove_attachment', attachmentRefId: working.workingAttachments[0].id }]) {
    const denied = await edit(scopes[0], action, working.editToken)
    assert.equal(denied.status, 'rejected'); assert.equal(denied.code, 'single_chat.pending_input_edit_fenced')
    assert.deepEqual((await get(scopes[1])).pendingInputs.editSession, working)
  }
  const other = await get(scopes[0]); assert.equal(other.pendingInputs.editSession, null); assert.ok(!JSON.stringify(other).includes(working.editToken))
  assert.equal((await edit(scopes[1], { type: 'cancel' }, working.editToken)).status, 'applied')
  record('real_pending_working_copy_rejects_foreign_scope_quote_and_attachment_edits_without_exposing_its_token')
  const held = (await get(null)).agentRuns.find(run => run.id === heldId); assert.ok(held)
  const cancelled = await rpc('agentRuns.cancel', { commandId: randomUUID(), command: { threadId, agentRunId: held.id, expectedVersion: held.version } })
  assert.equal(cancelled.status, 'applied')
  const drained = await waitPrivateSnapshot(rpc, conversationId, value => value.agentRuns.length === beforeQueueRuns + 3 && value.agentRuns.every(terminal) && value.pendingInputs.items.length === 0)
  assert.equal(drained.agentRuns.find(run => run.id === heldId).status, 'cancelled')
  assert.ok(drained.agentRuns.filter(run => !defaultSent.agentRuns.some(old => old.id === run.id) && run.id !== heldId).every(run => run.status === 'succeeded'), JSON.stringify(drained.agentRuns))
  const fifoMessages = drained.messages.filter(message => message.authorType === 'user' && fifoBodies.includes(message.body))
  assert.deepEqual(fifoMessages.map(message => message.body), fifoBodies)
  assert.deepEqual((await captures()).filter(entry => fifoBodies.includes(entry.input.message)).map(entry => entry.input.message), fifoBodies)
  assert.deepEqual((await get(scopes[0])).draft.attachments, []); assert.deepEqual((await get(scopes[1])).draft.attachments, [])
  await writeFile(join(config.evidence, 'fifo-and-working-copy.json'), JSON.stringify({ heldId, queued: queued.pendingInputs.items, working, messages: fifoMessages, runIds: drained.agentRuns.map(run => run.id) }, null, 2) + '\n', { flag: 'wx' })
  record('two_actual_card_submissions_drain_through_original_private_fifo_in_order_with_one_run_per_input')

  await addMaterial(scopes[0], 'R02 发送前源检查.txt', earlierExcerpt); await addMaterial(scopes[1], 'R02 不得借用的同名源.txt', '乙材料对应的问题')
  const sourceBody = `R02 源变化后保留正文 ${randomUUID()}`
  await typeBody(0, sourceBody); await typeBody(1, 'R02 源变化不能影响乙卡正文')
  const beforeSource = await get(scopes[0]), sourceBeta = (await get(scopes[1])).draft
  const sourceRows = query('SELECT source_attachments_json FROM single_chat_composer_draft WHERE conversation_id=? AND scope_key=?', [conversationId, beforeSource.draft.scopeKey])
  assert.equal(sourceRows.length, 1)
  const source = JSON.parse(sourceRows[0].source_attachments_json)[0], path = await realpath(source.sourcePath), rel = relative(core, path)
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel)); assert.equal(source.id, beforeSource.draft.attachments[0].id)
  const originalBytes = await readFile(path)
  await writeFile(join(config.evidence, 'source-before-mutation.bin'), originalBytes, { flag: 'wx' })
  await writeFile(join(config.evidence, 'source-before-mutation.json'), JSON.stringify({ source, draft: beforeSource.draft, beta: sourceBeta, body: sourceBody }, null, 2) + '\n', { flag: 'wx' })
  const sourceFailures = []
  for (const state of ['same_size_changed', 'missing', 'same_name_replacement']) {
    if (state === 'same_size_changed') await writeFile(path, Buffer.alloc(originalBytes.length, 120))
    if (state === 'missing') await unlink(path)
    if (state === 'same_name_replacement') await writeFile(path, originalBytes, { flag: 'wx' })
    const mark = seam.mark(); await clickNative(send(0))
    await waitMain(() => seam.since(mark).some(entry => entry.method === 'singleChat.send' && entry.status === 'rejected'))
    await wait(`Boolean(${frame(0)}.querySelector('[role="alert"]'))`)
    const attempts = seam.since(mark).filter(entry => entry.method === 'singleChat.send')
    assert.equal(attempts.length, 1); assert.equal(attempts[0].status, 'rejected')
    assert.equal(attempts[0].code, state === 'missing' ? 'attachment_missing' : 'single_chat.attachment_source_changed')
    const after = await get(scopes[0])
    assert.deepEqual(after.draft, beforeSource.draft); assert.deepEqual((await get(scopes[1])).draft, sourceBeta)
    assert.equal(after.agentRuns.length, beforeSource.agentRuns.length); assert.deepEqual(after.pendingInputs.items, beforeSource.pendingInputs.items)
    assert.equal(await evaluate(`${input(0)}.value`), sourceBody)
    const outcome = { state, attempt: attempts[0], error: await evaluate(`${frame(0)}.querySelector('[role="alert"]').textContent`) }
    sourceFailures.push(outcome)
    await writeFile(join(config.evidence, `source-${state}.json`), JSON.stringify(outcome, null, 2) + '\n', { flag: 'wx' })
  }
  await writeFile(join(config.evidence, 'source-change-rejections.json'), JSON.stringify(sourceFailures, null, 2) + '\n', { flag: 'wx' })
  record('actual_native_send_rejects_changed_missing_and_same_name_replaced_sources_with_input_materials_and_other_card_preserved')
  report.private_send_boundaries = { cases: ['PC02', 'PC11', 'PC14', 'PC15', 'PC16'], finalBlob: row.sha256, fifoBodies, sourceFailures,
    qualification: 'actual production Desktop/Core plus fixed local ACP; read-only SQLite evidence; no external model inference or database seeding' }
  await writeFile(join(config.evidence, '01-private-source-failure-preserves-input.png'), (await window.webContents.capturePage()).toPNG())
}
