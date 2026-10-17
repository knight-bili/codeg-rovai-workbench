import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

const terminal = run => ['succeeded', 'failed', 'cancelled'].includes(run.status)
export async function waitPrivateSnapshot(rpc, conversationId, predicate, timeout = 60_000) {
  const deadline = Date.now() + timeout
  let snapshot
  do {
    snapshot = await rpc('singleChat.get', { conversationId })
    if (predicate(snapshot)) return snapshot
    await pause(100)
  } while (Date.now() < deadline)
  throw new Error(`Private workflow condition timed out: ${JSON.stringify({ conversation: snapshot?.conversation,
    runs: snapshot?.agentRuns.map(run => ({ id: run.id, status: run.status, error: run.errorCode })), pending: snapshot?.pendingInputs.items.length })}`)
}

// Shared by Native UI scenarios and their real-Core fixture preflight. All data
// is created through production commands; this never seeds pending/history rows.
export async function preparePrivateWorkflow({ rpc, config, record }) {
  const member = await rpc('members.create', { commandId: randomUUID(), command: {
    displayName: `R01 固定协议队员 ${randomUUID().slice(0, 8)}`, teamRole: '隔离页面验证',
    professionalResponsibilities: '只使用本机固定ACP协议，不连接外部服务。', personalityTraits: ['严谨'],
    workingPrinciples: '固定协议响应，测试材料仅在隔离目录。', growthTopic: '' } })
  assert.equal(member.status, 'applied')
  const agentId = member.resultEntity.entityId
  const { configureProductRuntime } = await import(config.runtime_configure_module)
  await configureProductRuntime(rpc, 'qwen-code', [agentId])
  const created = await rpc('threads.create', { commandId: randomUUID(), name: 'R01 私聊完整输入', workspace: null,
    memberAgentIds: [agentId], defaultLeadAgentId: agentId, collaborationMode: 'peer' })
  assert.equal(created.status, 'applied')
  const threadId = created.payload.threadId
  const opened = await rpc('singleChat.open', { commandId: randomUUID(), command: { threadId, agentId } })
  assert.equal(opened.status, 'applied')
  const conversationId = opened.payload.conversationId
  const primeBody = 'R01 可引用原文：甲材料对应的问题；乙材料对应的问题。'
  const initial = await rpc('singleChat.get', { conversationId })
  const sent = await rpc('singleChat.send', { commandId: randomUUID(), command: {
    threadId, conversationId, body: primeBody, draftRevision: initial.draft.revision } })
  assert.equal(sent.status, 'accepted', JSON.stringify(sent))
  const primed = await waitPrivateSnapshot(rpc, conversationId, value => value.agentRuns.length > 0 && value.agentRuns.every(terminal))
  assert.ok(primed.agentRuns.every(run => run.status === 'succeeded'), JSON.stringify(primed.agentRuns))
  const message = primed.messages.find(item => item.authorType === 'user' && item.body === primeBody)
  assert.ok(message)
  const board = await rpc('canvas.boards.create', { commandId: randomUUID(), command: { name: 'R01 完整输入与撤销' } })
  assert.equal(board.status, 'applied')
  const boardId = board.payload.board.id, scopes = []
  for (let index = 0; index < 3; index++) {
    const graph = await rpc('canvas.nodes.snapshot', { boardId })
    const pin = await rpc('canvas.nodes.apply', { commandId: randomUUID(), command: { boardId,
      expectedRevision: graph.board.revision, mutation: { type: 'create', node: { kind: 'conversation',
        title: ['甲卡完整输入', '乙卡独立输入', '只读空卡'][index], conversation: { threadId, conversationId },
        x: index * 560, y: 0, width: 520, height: 650 } } } })
    assert.equal(pin.status, 'applied')
    scopes.push({ kind: 'canvas', boardId, nodeId: pin.payload.nodeIds[0] })
  }
  record('controlled_local_acp_creates_real_private_history_and_three_unregistered_pins_without_database_seeding')
  return { threadId, conversationId, agentId, boardId, scopes, quoteMessage: message,
    primeRunIds: primed.agentRuns.map(run => run.id) }
}

export async function beginHeldPrivateRun(rpc, context, capture) {
  const { threadId, conversationId } = context
  const snapshot = await rpc('singleChat.get', { conversationId })
  const body = `ROVAI_SKILL_RECOVERY_HELD_INPUT R01 ${randomUUID()}`
  const sent = await rpc('singleChat.send', { commandId: randomUUID(), command: {
    threadId, conversationId, body, draftRevision: snapshot.draft.revision } })
  assert.equal(sent.status, 'accepted', JSON.stringify(sent))
  const held = await waitPrivateSnapshot(rpc, conversationId, value => value.agentRuns.some(run => run.status === 'running'))
  const deadline = Date.now() + 30_000
  while (!(await readFile(capture, 'utf8')).includes(body)) {
    assert.ok(Date.now() < deadline, 'the owned ACP must actually receive the held input')
    await pause(100)
  }
  return held.agentRuns.find(run => run.id === held.conversation.activeAgentRunId)?.id
}

export async function qualifyCanvasPrivateWorkflow(window, { rpc, evaluate, wait, openCanvasBoard, config, report, record, seam }) {
  assert.ok(['private-roundtrip', 'private-queue', 'private-rebind', 'private-late-upload', 'private-send', 'private-send-boundaries', 'private-core-interruption', 'private-app-interruption'].includes(config.mode))
  assert.ok(seam, 'private Native modes require an observed production IPC transport')
  window.unmaximize(); window.setContentSize(1680, 1000); window.webContents.setZoomFactor(1)
  let context
  if (config.private_app_phase === 'resume') {
    const checkpoint = await readFile(config.private_app_checkpoint)
    assert.equal(createHash('sha256').update(checkpoint).digest('hex'), config.private_app_checkpoint_sha256)
    context = JSON.parse(checkpoint).context
  } else context = await preparePrivateWorkflow({ rpc, config, record })
  report.private_workflow_context = context
  const { threadId, conversationId, boardId, scopes, quoteMessage } = context
  const ownedConversations = new Map([[conversationId, threadId]])
  const waitMain = async predicate => {
    const deadline = Date.now() + 20_000
    while (!predicate()) { assert.ok(Date.now() < deadline, 'Main fault observation timed out'); await pause(50) }
  }
  const frame = index => `document.querySelector('.canvas-conversation-frame[data-canvas-conversation-key*="${scopes[index].nodeId}"]')`
  const input = index => `${frame(index)}?.querySelector('.single-chat-composer textarea')`
  const get = scope => rpc('singleChat.get', { conversationId, composerScope: scope })
  const mutate = async (scope, action) => {
    const current = await get(scope)
    return rpc('singleChat.composerDraft.mutate', { commandId: randomUUID(), command: {
      threadId, conversationId, composerScope: scope, expectedDraftRevision: current.draft.revision, action } })
  }
  const names = value => value.attachments.map(item => item.displayName)
  const materials = value => ({ attachments: value.attachments, quotes: value.quotes })
  const addMaterial = async (scope, name, quoteText) => {
    const current = await get(scope)
    const request = { commandId: randomUUID(), threadId, expectedRevision: current.draft.revision,
      target: { kind: 'single_chat', conversationId, composerScope: scope } }
    const added = await evaluate(`window.rovai.singleChatAttachments.prepareInput(${JSON.stringify(request)},new File([${JSON.stringify(name)}],${JSON.stringify(name)},{type:'text/plain'}))`)
    assert.equal(added.state, 'recorded'); assert.equal(added.receipt.status, 'applied')
    const startScalar = [...quoteMessage.body.slice(0, quoteMessage.body.indexOf(quoteText))].length
    assert.ok(quoteMessage.body.includes(quoteText))
    const quoted = await mutate(scope, { type: 'quote', action: { type: 'add', selection: {
      messageId: quoteMessage.id, bodyAtSelection: quoteMessage.body, startScalar,
      endScalar: startScalar + [...quoteText].length, text: quoteText } } })
    assert.equal(quoted.status, 'applied', JSON.stringify(quoted))
    return get(scope)
  }
  const clickNative = async expression => {
    await wait(`Boolean((${expression})&&!(${expression}).disabled&&(${expression}).checkVisibility())`)
    await evaluate(`(()=>{(${expression}).scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`)
    const point = await evaluate(`(()=>{const element=${expression},r=element.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(!hit||!(hit===element||element.contains(hit)))throw Error('真实输入目标被遮挡');return {x:Math.round(x),y:Math.round(y)}})()`)
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) window.webContents.sendInputEvent({ type, ...point,
      ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) })
  }
  const typeBody = async (index, text, selector = input(index)) => {
    await wait(`Boolean(${selector}&&!${selector}.disabled&&!${selector}.readOnly)`)
    await evaluate(`(()=>{const input=${selector};input.focus();input.select();window.r01TrustedInputs=[];input.addEventListener('input',event=>window.r01TrustedInputs.push(event.isTrusted),{once:true});return true})()`)
    await window.webContents.insertText(text)
    await wait(`${selector}.value===${JSON.stringify(text)}`)
    assert.ok((await evaluate('window.r01TrustedInputs')).includes(true))
  }
  const open = async (index, allowPending = false) => {
    const button = `document.querySelector('[data-id="${scopes[index].nodeId}"] button[aria-label="展开对话"]')`
    await wait(`Boolean(${button}&&!${button}.disabled)`)
    await evaluate(`(()=>{${button}.click();return true})()`)
    await wait(`Boolean(${input(index)}${allowPending ? '' : `&&!${input(index)}.disabled`})`)
  }
  try {
    await openCanvasBoard(evaluate, wait, boardId)
    if (config.private_app_phase === 'resume') {
      await open(0, true); await open(1)
      await evaluate(`(()=>{document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]').click();return true})()`)
      assert.equal(createHash('sha256').update(await readFile(new URL(config.private_core_interruption_module))).digest('hex'), config.private_core_interruption_sha256)
      const { qualifyPrivateCoreInterruption } = await import(config.private_core_interruption_module)
      await qualifyPrivateCoreInterruption(window, { config, context, report, record, evaluate, wait, rpc, seam,
        openCanvasBoard, open, get, addMaterial, clickNative, typeBody, frame, input, waitMain, waitPrivateSnapshot })
      return
    }
    const readingMark = seam.mark()
    await open(2)
    const recovery = await rpc('singleChat.composerDraft.recovery', { threadId, conversationId })
    assert.ok(!recovery.items.some(item => item.kind === 'scope' && item.scope.composerScope?.nodeId === scopes[2].nodeId))
    assert.equal((await get(scopes[2])).draft.revision, 0)
    assert.equal((await get(null)).agentRuns.length, context.primeRunIds.length)
    const readingCalls = seam.since(readingMark).filter(entry => entry.threadId === threadId)
    assert.ok(!readingCalls.some(entry => ['threads.enter', 'camps.enter', 'singleChat.open', 'singleChat.send'].includes(entry.method)))
    report.readonly_calls = readingCalls
    record('actual_empty_pin_open_reads_history_without_scope_registration_enter_or_execution')
    await evaluate(`(()=>{document.querySelector('[data-id="${scopes[2].nodeId}"] button[aria-label="收起对话"]').click();return true})()`)
    await wait(`!${frame(2)}`)
    await open(0); await open(1)
    await evaluate(`(()=>{document.querySelector('.canvas-dock-panel button[aria-label="查看全部"]').click();return true})()`)
    if (config.mode === 'private-core-interruption' || config.mode === 'private-app-interruption') {
      assert.equal(createHash('sha256').update(await readFile(new URL(config.private_core_interruption_module))).digest('hex'), config.private_core_interruption_sha256)
      const { qualifyPrivateCoreInterruption } = await import(config.private_core_interruption_module)
      await qualifyPrivateCoreInterruption(window, { config, context, report, record, evaluate, wait, rpc, seam,
        openCanvasBoard, open, get, addMaterial, clickNative, typeBody, frame, input, waitMain, waitPrivateSnapshot })
      return
    }
    if (config.mode === 'private-send-boundaries') {
      assert.equal(createHash('sha256').update(await readFile(new URL(config.private_send_boundary_module))).digest('hex'), config.private_send_boundary_sha256)
      const { qualifyPrivateSendBoundaries } = await import(config.private_send_boundary_module)
      await qualifyPrivateSendBoundaries(window, { config, context, report, record, evaluate, wait, rpc, seam,
        openCanvasBoard, open, get, mutate, addMaterial, clickNative, typeBody, frame, input, ownedConversations, waitMain,
        waitPrivateSnapshot, beginHeldPrivateRun, terminal })
      return
    }
    if (config.mode === 'private-send') {
      const aFile = 'R02 仅甲卡发送.txt', bFile = 'R02 乙卡仍保留.txt', defaultFile = 'R02 默认输入保留.txt'
      await addMaterial(scopes[0], aFile, '甲材料对应的问题')
      await addMaterial(scopes[1], bFile, '乙材料对应的问题')
      await addMaterial(null, defaultFile, 'R01 可引用原文')
      const firstBody = `R02 甲卡实际发送 ${randomUUID()}`, otherBody = `R02 乙卡未发送 ${randomUUID()}`
      await typeBody(0, firstBody); await typeBody(1, otherBody)
      const beta = (await get(scopes[1])).draft, ordinary = (await get(null)).draft
      const send = index => `${frame(index)}.querySelector('.single-chat-composer button[type="submit"]')`
      await clickNative(send(0))
      const first = await waitPrivateSnapshot(rpc, conversationId, value => value.messages.some(message => message.authorType === 'user' && message.body === firstBody)
        && value.agentRuns.length === context.primeRunIds.length + 1 && value.agentRuns.every(terminal))
      assert.ok(first.agentRuns.every(run => run.status === 'succeeded'), JSON.stringify(first.agentRuns))
      await wait(`${input(0)}.value===''`)
      assert.deepEqual((await get(scopes[0])).draft.attachments, []); assert.deepEqual((await get(scopes[0])).draft.quotes, [])
      assert.deepEqual((await get(scopes[1])).draft, beta); assert.deepEqual((await get(null)).draft, ordinary)
      assert.equal(await evaluate(`${input(1)}.value`), otherBody)
      assert.equal(first.messages.filter(message => message.authorType === 'user' && message.body === firstBody).length, 1)
      record('actual_native_send_consumes_only_selected_card_body_file_and_quote_while_other_card_and_default_materials_stay_exact')
      const capturedInputs = async () => (await readFile(config.runtime_capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).flatMap(entry => {
        const prompt = (entry.params?.prompt ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
        const match = /\[CURRENT_INPUT\]\s*([\s\S]*?)\s*\[\/CURRENT_INPUT\]/.exec(prompt)
        return match ? [{ requestId: entry.requestId, input: JSON.parse(match[1]) }] : []
      })
      const selected = (await capturedInputs()).filter(entry => JSON.stringify(entry.input).includes(firstBody))
      assert.equal(selected.length, 1)
      await writeFile(join(config.evidence, 'selected-runtime-current-input.json'), JSON.stringify(selected[0], null, 2) + '\n', { flag: 'wx' })
      assert.equal(selected[0].input.message, firstBody)
      assert.equal(selected[0].input.attachments.length, 1)
      assert.equal(await readFile(selected[0].input.attachments[0], 'utf8'), aFile)
      assert.deepEqual(selected[0].input.quotes.map(quote => quote.text), ['甲材料对应的问题'])
      record('actual_owned_acp_receives_selected_card_materials_in_current_input_without_other_card_or_default_files')
      const onlyFile = 'R02 仅附件发送.txt', empty = await get(scopes[0])
      const prepared = await evaluate(`window.rovai.singleChatAttachments.prepareInput(${JSON.stringify({commandId:randomUUID(),threadId,expectedRevision:empty.draft.revision,target:{kind:'single_chat',conversationId,composerScope:scopes[0]}})},new File(['R02 attachment only'],${JSON.stringify(onlyFile)},{type:'text/plain'}))`)
      assert.equal(prepared.state, 'recorded'); assert.equal(prepared.receipt.status, 'applied')
      await wait(`${input(0)}.value===''`); await clickNative(send(0))
      const final = await waitPrivateSnapshot(rpc, conversationId, value => value.agentRuns.length === first.agentRuns.length + 1 && value.agentRuns.every(terminal))
      assert.ok(final.agentRuns.every(run => run.status === 'succeeded'), JSON.stringify(final.agentRuns))
      assert.deepEqual((await get(scopes[0])).draft.attachments, []); assert.deepEqual((await get(scopes[0])).draft.quotes, [])
      assert.deepEqual((await get(scopes[1])).draft, beta); assert.deepEqual((await get(null)).draft, ordinary)
      assert.equal(await evaluate(`${input(1)}.value`), otherBody)
      const onlyInputs = (await capturedInputs()).filter(entry => Array.isArray(entry.input.attachments) && entry.input.attachments.length === 1
        && !JSON.stringify(entry.input).includes(firstBody))
      assert.equal(onlyInputs.length, 1)
      assert.equal(onlyInputs[0].input.message, '')
      assert.equal(await readFile(onlyInputs[0].input.attachments[0], 'utf8'), 'R02 attachment only')
      assert.deepEqual(onlyInputs[0].input.quotes ?? [], [])
      await writeFile(join(config.evidence, 'attachment-only-runtime-current-input.json'), JSON.stringify(onlyInputs[0], null, 2) + '\n', { flag: 'wx' })
      report.private_send = { selectedBody: firstBody, otherBody, selectedFile: aFile, otherFile: bFile, defaultFile, attachmentOnly: onlyFile,
        beforeOtherDraft: beta, beforeDefaultDraft: ordinary, runIds: final.agentRuns.map(run => run.id), qualification: 'actual native send and fixed local ACP transport; no external model inference; PC02 default body and PC14 final Blob still separate' }
      record('actual_attachment_only_native_send_succeeds_with_its_selected_file_without_consuming_other_inputs')
      await writeFile(join(config.evidence, '01-private-send-retains-other-card.png'), (await window.webContents.capturePage()).toPNG())
      return
    }
    if (config.mode === 'private-roundtrip') {
      await addMaterial(scopes[0], 'R01 甲卡材料.txt', '甲材料对应的问题')
      const baseline = '甲卡保持的未发送正文\n撤销与重做探针', text = `${baseline}Z`
      await typeBody(0, baseline)
      await typeBody(1, '乙卡另一份未发送正文')
      window.focus(); window.webContents.focus()
      await evaluate(`(()=>{const input=${input(0)};input.focus();input.setSelectionRange(input.value.length,input.value.length);window.r01UndoEvents=[];document.addEventListener('input',event=>window.r01UndoEvents.push({type:event.inputType,trusted:event.isTrusted,value:event.target.value}),true);return true})()`)
      for(const type of ['keyDown','char','keyUp'])window.webContents.sendInputEvent({type,keyCode:'Z'})
      await wait(`${input(0)}.value===${JSON.stringify(text)}`)
      await wait(`${frame(0)}.querySelector('.single-chat-composer .message-quotes-trigger')?.textContent.includes('1')`)
      const before = await get(scopes[0]), beta = await get(scopes[1])
      await evaluate(`(()=>{window.r01Editor=${input(0)};${input(0)}.focus();return true})()`)
      assert.ok(await evaluate(`document.activeElement===${input(0)}`))
      window.webContents.undo()
      await wait(`${input(0)}.value!==${JSON.stringify(text)}`)
      const undoValue = await evaluate(`${input(0)}.value`)
      window.webContents.redo(); await wait(`${input(0)}.value===${JSON.stringify(text)}`)
      report.roundtrip_baseline = { text, undoValue, passed: true }
      record('native_private_editor_undo_redo_baseline_before_presentation_change')
      await evaluate(`(()=>{window.r01EditorMoves=[];const overlay=window.r01Editor.closest('.canvas-conversation-overlay');window.r01EditorObserver=new MutationObserver(records=>{for(const change of records)for(const node of change.removedNodes)if(node===overlay||node.contains?.(window.r01Editor))window.r01EditorMoves.push({removedEditorAncestor:true,parent:change.target.className})});window.r01EditorObserver.observe(overlay.parentNode,{childList:true,subtree:true});return true})()`)
      await clickNative(`document.querySelector('[data-id="${scopes[0].nodeId}"] .canvas-card-handle button[aria-label="移至侧边"]')`)
      await wait(`Boolean(${frame(0)}?.querySelector('button[aria-label="放回画布"]'))`)
      assert.ok(await evaluate(`${input(0)}===window.r01Editor`))
      assert.deepEqual(await evaluate('window.r01EditorMoves'), [])
      assert.deepEqual((await get(scopes[0])).draft, before.draft)
      await evaluate(`(()=>{${input(0)}.focus();return true})()`)
      window.webContents.undo(); await wait(`${input(0)}.value===${JSON.stringify(undoValue)}`)
      window.webContents.redo(); await wait(`${input(0)}.value===${JSON.stringify(text)}`)
      await clickNative(`${frame(0)}.querySelector('.canvas-conversation-heading button[aria-label="放回画布"]')`)
      await wait(`Boolean(${frame(0)}?.classList.contains('is-inline'))`)
      assert.ok(await evaluate(`${input(0)}===window.r01Editor&&${input(1)}.value==='乙卡另一份未发送正文'`))
      assert.deepEqual(await evaluate('window.r01EditorMoves'), [])
      assert.deepEqual((await get(scopes[0])).draft, before.draft)
      assert.deepEqual((await get(scopes[1])).draft, beta.draft)
      await evaluate(`(()=>{${input(0)}.focus();return true})()`)
      window.webContents.undo(); await wait(`${input(0)}.value===${JSON.stringify(undoValue)}`)
      window.webContents.redo(); await wait(`${input(0)}.value===${JSON.stringify(text)}`)
      report.roundtrip = { revision: before.draft.revision, quoteIds: before.draft.quotes.map(quote => quote.quoteId),
        attachments: names(before.draft), undoValue, restoredBody: text }
      record('same_native_inline_drawer_roundtrip_preserves_body_attachments_quote_order_revision_editor_and_preexisting_undo_redo')
      await writeFile(join(config.evidence, '01-private-full-input-roundtrip.png'), (await window.webContents.capturePage()).toPNG())
      const conflictMark = seam.mark()
      seam.armConflict({ conversationId, scope: scopes[0], attachmentRefId: before.draft.attachments[0].id })
      await clickNative(`${frame(0)}.querySelector('.single-chat-composer .message-quotes-trigger')`)
      await clickNative(`document.querySelector('.message-quotes-popover button.message-quote-remove')`)
      await waitMain(() => seam.snapshot().faults.some(fault => fault.kind === 'concurrent_material_change'))
      await wait(`Boolean(document.querySelector('.message-quotes-popover')?.innerText.includes('草稿已更新，请重试；已有问题和引用已保留。'))`)
      const cas = seam.since(conflictMark).find(entry => entry.action === 'quote')
      assert.equal(cas.status, 'rejected'); assert.equal(cas.code, 'single_chat.draft_changed')
      assert.equal(await evaluate(`${input(0)}.value`), text)
      const afterConflict = await get(scopes[0])
      assert.deepEqual(afterConflict.draft.quotes, before.draft.quotes)
      assert.deepEqual(afterConflict.draft.attachments, [])
      assert.deepEqual((await get(scopes[1])).draft, beta.draft)
      record('real_concurrent_cas_rejection_keeps_visible_local_body_and_does_not_apply_the_stale_quote_removal')
      await writeFile(join(config.evidence, '02-private-cas-preserves-input.png'), (await window.webContents.capturePage()).toPNG())
      return
    }
    if (config.mode === 'private-rebind' || config.mode === 'private-late-upload') {
      const originalBody = '原卡片尚未发送、不能转给新私聊的正文'
      await addMaterial(scopes[0], 'R01 原归属材料.txt', '甲材料对应的问题')
      await typeBody(0, originalBody)
      const original = await get(scopes[0])
      let gate
      if (config.mode === 'private-late-upload') {
        await wait(`Boolean(${frame(0)}?.querySelector('button[aria-label="添加文件"]')&&!${frame(0)}.querySelector('button[aria-label="添加文件"]').disabled)`)
        await evaluate(`(()=>{window.r01UploadInputEvents=[];const input=${frame(0)}.querySelector('input.composer-file-input');for(const type of ['input','change'])input.addEventListener(type,event=>window.r01UploadInputEvents.push({type,trusted:event.isTrusted,count:event.target.files?.length??0}),{capture:true});return true})()`)
        gate = seam.holdUpload({ conversationId, scope: scopes[0] })
        const path = join(config.evidence, '迟到上传原文件.txt')
        await writeFile(path, '只属于原私聊的迟到上传材料', { flag: 'wx' })
        const debug = window.webContents.debugger
        debug.attach('1.3')
        try {
          const { root } = await debug.sendCommand('DOM.getDocument', { depth: 0 })
          const selector = `.canvas-conversation-frame[data-canvas-conversation-key*="${scopes[0].nodeId}"] .single-chat-composer input.composer-file-input`
          const { nodeId } = await debug.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector })
          assert.ok(nodeId)
          await debug.sendCommand('DOM.setFileInputFiles', { nodeId, files: [path] })
        } finally { debug.detach() }
        await waitMain(() => Boolean(gate.observed))
        assert.equal(gate.observed.state, 'recorded')
        assert.ok(names((await get(scopes[0])).draft).includes('迟到上传原文件.txt'))
        const ended = await rpc('singleChat.end', { commandId: randomUUID(), command: { threadId, conversationId } })
        assert.equal(ended.status, 'applied')
      }
      const nextThread = await rpc('threads.create', { commandId: randomUUID(), name: 'R01 换绑后的目标', workspace: null,
        memberAgentIds: [context.agentId], defaultLeadAgentId: context.agentId, collaborationMode: 'peer' })
      assert.equal(nextThread.status, 'applied')
      const nextThreadId = nextThread.payload.threadId
      const nextOpen = await rpc('singleChat.open', { commandId: randomUUID(), command: { threadId: nextThreadId, agentId: context.agentId } })
      assert.equal(nextOpen.status, 'applied')
      const nextId = nextOpen.payload.conversationId
      assert.notEqual(nextId, conversationId, 'the replacement target must be a distinct private conversation')
      ownedConversations.set(nextId, nextThreadId)
      const graph = await rpc('canvas.nodes.snapshot', { boardId })
      const removed = await rpc('canvas.nodes.apply', { commandId: randomUUID(), command: { boardId,
        expectedRevision: graph.board.revision, mutation: { type: 'delete', nodeIds: [scopes[0].nodeId] } } })
      assert.equal(removed.status, 'applied', JSON.stringify(removed))
      const afterRemoval = await rpc('canvas.nodes.snapshot', { boardId })
      const replacement = await rpc('canvas.nodes.apply', { commandId: randomUUID(), command: { boardId,
        expectedRevision: afterRemoval.board.revision, mutation: { type: 'create', node: { kind: 'conversation',
          title: 'R01 新目标独立卡片', conversation: { threadId: nextThreadId, conversationId: nextId },
          x: 0, y: 0, width: 520, height: 650 } } } })
      assert.equal(replacement.status, 'applied', JSON.stringify(replacement))
      const replacementScope = { kind: 'canvas', boardId, nodeId: replacement.payload.nodeIds[0] }
      const replacementFrame = `document.querySelector('.canvas-conversation-frame[data-canvas-conversation-key*="${replacementScope.nodeId}"]')`
      const replacementInput = `${replacementFrame}?.querySelector('.single-chat-composer textarea')`
      // The old result arrives after its authoritative target ended and the pin
      // was removed. Existing navigation guards may retain the old editor until it
      // settles; the new input must still begin empty when explicitly reopened.
      if (gate) { gate.release(); await pause(400) }
      await openCanvasBoard(evaluate, wait, boardId)
      if (await evaluate(`Boolean(${frame(0)})`)) {
        await clickNative(`${frame(0)}.querySelector('.canvas-conversation-heading button[aria-label="收起对话"]')`)
        await wait(`!${frame(0)}`)
      }
      await clickNative(`document.querySelector('[data-id="${replacementScope.nodeId}"] button[aria-label="展开对话"]')`)
      await wait(`${replacementInput}?.value===''`)
      const getReplacement = () => rpc('singleChat.get', { conversationId: nextId, composerScope: replacementScope })
      const clean = await getReplacement()
      assert.deepEqual(clean.draft.attachments, []); assert.deepEqual(clean.draft.quotes, [])
      assert.deepEqual(clean.messages, []); assert.deepEqual(clean.agentRuns, [])
      if (gate) {
        assert.equal(await evaluate(`${replacementInput}.value`), '')
        assert.deepEqual((await getReplacement()).draft, clean.draft)
        assert.ok(!(await evaluate(`${replacementFrame}.innerText`)).includes('迟到上传原文件.txt'))
        record('late_real_upload_reply_after_ending_old_conversation_cannot_pollute_replacement_private_composer')
        await writeFile(join(config.evidence, '01-late-upload-does-not-cross-context.png'), (await window.webContents.capturePage()).toPNG())
        return
      }
      const recovered = await rpc('singleChat.composerDraft.recovery', { threadId, conversationId })
      assert.ok(recovered.items.some(item => item.kind === 'scope' && item.scope.composerScope?.nodeId === scopes[0].nodeId && item.scope.orphaned))
      const orphanDraft = (await get(scopes[0])).draft
      assert.equal(orphanDraft.revision, original.draft.revision)
      assert.equal(orphanDraft.scopeKey, original.draft.scopeKey)
      assert.deepEqual(materials(orphanDraft), materials(original.draft))
      await clickNative(`document.querySelector('[data-id="${scopes[1].nodeId}"] button[aria-label="打开完整工作区"]')`)
      await wait(`!document.querySelector('.canvas-workspace')`)
      const trigger = `[...document.querySelectorAll('.single-chat-recovery-trigger')].find(button=>button.checkVisibility()&&!button.disabled)`
      await clickNative(trigger)
      await wait(`Boolean([...document.querySelectorAll('.private-input-recovery-location')].find(row=>row.textContent.includes(${JSON.stringify(originalBody)})))`)
      const location = `[...document.querySelectorAll('.private-input-recovery-location')].find(row=>row.textContent.includes(${JSON.stringify(originalBody)}))`
      const restoreMark = seam.mark()
      await clickNative(`[...(${location}).querySelectorAll('button')].find(button=>button.textContent==='在原位置继续编辑')`)
      const restoredInput = `document.querySelector('.private-input-recovery-editor .single-chat-composer textarea')`
      await wait(`${restoredInput}?.value===${JSON.stringify(originalBody)}`)
      assert.ok(await evaluate(`Boolean(document.querySelector('.private-input-recovery-editor .attachment-open[aria-label="打开文件预览 R01 原归属材料.txt"]'))`))
      assert.ok(!seam.since(restoreMark).some(entry => ['singleChat.open', 'singleChat.send'].includes(entry.method)))
      assert.deepEqual(materials((await get(scopes[0])).draft), materials(original.draft))
      assert.deepEqual((await getReplacement()).draft, clean.draft)
      record('removed_node_restores_original_body_and_materials_in_original_private_recovery_editor_without_forwarding_to_new_target')
      await writeFile(join(config.evidence, '01-original-input-after-node-rebind.png'), (await window.webContents.capturePage()).toPNG())
      return
    }
    const activeRunId = await beginHeldPrivateRun(rpc, context, config.runtime_capture)
    assert.ok(activeRunId)
    const queue = []
    for (const [index, name, quote] of [[0, 'R01 排队甲材料.txt', '甲材料对应的问题'], [1, 'R01 排队乙材料.txt', '乙材料对应的问题']]) {
      const ready = await addMaterial(scopes[0], name, quote), body = `第${index + 1}份完整排队正文`
      const sent = await rpc('singleChat.send', { commandId: randomUUID(), command: {
        threadId, conversationId, composerScope: scopes[0], body, draftRevision: ready.draft.revision } })
      assert.equal(sent.status, 'accepted', JSON.stringify(sent))
      const snapshot = await get(scopes[0]), item = snapshot.pendingInputs.items.find(item => item.body === body)
      assert.ok(item); assert.deepEqual(materials(item), materials(ready.draft)); queue.push(item)
    }
    const row = (index, body) => `[...${frame(index)}.querySelectorAll('.single-chat-pending-queue .pending-input-row')].find(row=>row.querySelector('.pending-input-preview')?.getAttribute('title')===${JSON.stringify(body)})`
    await clickNative(`(${row(0, queue[0].body)})?.querySelector('button[aria-label="编辑待发送消息"]')`)
    await wait(`${input(0)}.value===${JSON.stringify(queue[0].body)}`)
    let current = await get(scopes[0])
    assert.deepEqual(materials(current.draft), materials(queue[0]))
    assert.ok(!current.pendingInputs.items.some(item => item.id === queue[0].id))
    record('real_pending_return_to_empty_card_restores_one_complete_body_attachment_and_quote_input')
    const original = current.draft
    await clickNative(`(${row(0, queue[1].body)})?.querySelector('button[aria-label="编辑待发送消息"]')`)
    await wait(`Boolean(${frame(0)}.querySelector('.single-chat-retained-inputs select'))`)
    current = await get(scopes[0]); assert.deepEqual(current.draft, original)
    assert.equal(await evaluate(`${input(0)}.value`), queue[0].body)
    const recovered = await rpc('singleChat.composerDraft.recovery', { threadId, conversationId })
    const saved = recovered.items.find(item => item.kind === 'retained' && item.input.body === queue[1].body)?.input
    assert.ok(saved); assert.deepEqual(materials(saved), materials(queue[1]))
    record('return_to_occupied_card_keeps_existing_complete_input_and_retains_the_other_without_mixing')
    const swap = `[...${frame(0)}.querySelectorAll('.single-chat-retained-inputs button')].find(button=>button.textContent==='切换完整输入')`
    const swapMark = seam.mark()
    seam.loseNextSwap({ conversationId, scope: scopes[0], beforeAccept: true })
    await clickNative(swap)
    const recoverButton = `[...${frame(0)}.querySelectorAll('.single-chat-retained-inputs button')].find(button=>button.textContent==='恢复原请求')`
    const retryButton = `[...${frame(0)}.querySelectorAll('.single-chat-retained-inputs button')].find(button=>button.textContent==='明确重试原请求')`
    await wait(`Boolean(${recoverButton})`)
    assert.deepEqual((await get(scopes[0])).draft, original)
    await clickNative(recoverButton)
    await wait(`Boolean(${retryButton})`)
    await clickNative(retryButton)
    await wait(`${input(0)}.value===${JSON.stringify(queue[1].body)}`)
    const attempts = seam.since(swapMark).filter(entry => entry.action === 'swap_retained')
    assert.equal(attempts.length, 2); assert.equal(attempts[0].commandId, attempts[1].commandId)
    const committed = await get(scopes[0])
    assert.deepEqual(materials(committed.draft), materials(queue[1]))
    const committedRecovery = await rpc('singleChat.composerDraft.recovery', { threadId, conversationId })
    assert.ok(committedRecovery.items.some(item => item.kind === 'retained' && item.input.body === queue[0].body
      && JSON.stringify(materials(item.input)) === JSON.stringify(materials(queue[0]))))
    record('interrupted_before_acceptance_swap_is_unknown_then_explicit_retry_reuses_original_uuid_and_swaps_once')
    seam.loseNextSwap({ conversationId, scope: scopes[0] })
    await clickNative(swap); await wait(`${input(0)}.value===${JSON.stringify(queue[1].body)}`)
    await wait(`Boolean(${recoverButton})`)
    const committedBack = await get(scopes[0]), backMark = seam.mark()
    await clickNative(recoverButton)
    await wait(`${input(0)}.value===${JSON.stringify(queue[0].body)}`)
    assert.ok(!seam.since(backMark).some(entry => entry.action === 'swap_retained'))
    assert.deepEqual((await get(scopes[0])).draft, committedBack.draft)
    assert.deepEqual(materials(committedBack.draft), materials(queue[0]))
    const back = await rpc('singleChat.composerDraft.recovery', { threadId, conversationId })
    assert.ok(back.items.some(item => item.kind === 'retained' && item.input.body === queue[1].body
      && JSON.stringify(materials(item.input)) === JSON.stringify(materials(queue[1]))))
    assert.equal((await get(scopes[0])).conversation.activeAgentRunId, activeRunId)
    assert.equal(await evaluate(`${input(1)}.value`), '')
    record('read_only_reconciliation_recovers_reverse_swap_once_preserving_both_complete_inputs_other_card_and_active_run')
    report.queue_inputs = queue
    await writeFile(join(config.evidence, '01-private-pending-complete-inputs.png'), (await window.webContents.capturePage()).toPNG())
    const leaseBody = '第三份排队消息：用于明确接管', ready = await addMaterial(scopes[1], 'R01 租约材料.txt', '甲材料对应的问题')
    const leaseSent = await rpc('singleChat.send', { commandId: randomUUID(), command: {
      threadId, conversationId, composerScope: scopes[1], body: leaseBody, draftRevision: ready.draft.revision } })
    assert.equal(leaseSent.status, 'accepted')
    const leaseItem = (await get(scopes[1])).pendingInputs.items.find(item => item.body === leaseBody)
    assert.ok(leaseItem)
    const edit = (scope, token, action) => rpc('singleChat.pendingInputs.edit', { commandId: randomUUID(), command: {
      threadId, conversationId, composerScope: scope, pendingInputId: leaseItem.id, expectedRevision: leaseItem.revision, editToken: token, action } })
    assert.equal((await edit(scopes[0], null, { type: 'begin' })).status, 'applied')
    const oldToken = (await get(scopes[0])).pendingInputs.editSession.editToken
    const working = index => `${frame(index)}?.querySelector('.single-chat-pending-editor textarea')`
    await wait(`${working(0)}?.value===${JSON.stringify(leaseBody)}`)
    await typeBody(0, '甲卡尚未保存的排队编辑', working(0))
    const other = await get(scopes[1])
    assert.equal(other.pendingInputs.editSession, null); assert.equal(other.pendingInputs.editingElsewhere, true)
    const takeover = `[...(${row(1, leaseBody)}).querySelectorAll('button')].find(button=>button.textContent==='从已保存版本接管')`
    await clickNative(takeover)
    await wait(`${working(1)}?.value===${JSON.stringify(leaseBody)}&&!${working(0)}`)
    const taken = (await get(scopes[1])).pendingInputs.editSession
    assert.ok(taken && taken.editToken !== oldToken)
    assert.equal((await edit(scopes[0], oldToken, { type: 'save', body: '旧令牌不能覆盖' })).status, 'rejected')
    assert.equal((await get(scopes[1])).pendingInputs.items.find(item => item.id === leaseItem.id).body, leaseBody)
    await typeBody(1, '乙卡接管后保存的正文', working(1))
    await clickNative(`[...${frame(1)}.querySelectorAll('.single-chat-pending-editor button')].find(button=>button.textContent==='保存排队消息')`)
    await wait(`!${working(1)}`)
    const savedPending = (await get(scopes[1])).pendingInputs.items.find(item => item.id === leaseItem.id)
    assert.equal(savedPending.body, '乙卡接管后保存的正文')
    assert.deepEqual(materials(savedPending), materials(leaseItem))
    record('actual_other_card_takeover_uses_saved_working_input_and_new_token_then_rejects_old_writer_and_saves_its_own_edit')
    await writeFile(join(config.evidence, '02-private-pending-takeover.png'), (await window.webContents.capturePage()).toPNG())
  } catch (error) {
    report.private_workflow_failure = String(error?.stack ?? error)
    console.error(report.private_workflow_failure)
    await writeFile(join(config.evidence, 'private-workflow-failure.json'), JSON.stringify({error: report.private_workflow_failure}, null, 2)+'\n', {flag:'wx'})
    throw error
  } finally {
    if (config.mode === 'private-late-upload') {
      report.upload_input_events = await evaluate('window.r01UploadInputEvents??[]').catch(error => ({ error: String(error) }))
    }
    if (config.mode === 'private-queue') {
      report.fixture_request_cleanup = []
      for (const index of [0, 1]) {
        try {
          const recover = `[...(${frame(index)}?.querySelectorAll('.single-chat-retained-inputs button')??[])].find(button=>button.textContent==='恢复原请求')`
          if (await evaluate(`Boolean(${recover})`)) {
            await evaluate(`(()=>{${recover}.click();return true})()`)
            await wait(`!(${recover})||Boolean([...${frame(index)}.querySelectorAll('.single-chat-retained-inputs button')].find(button=>button.textContent==='明确重试原请求'))`, 4_000)
            const retry = `[...${frame(index)}.querySelectorAll('.single-chat-retained-inputs button')].find(button=>button.textContent==='明确重试原请求')`
            if (await evaluate(`Boolean(${retry})`)) await evaluate(`(()=>{${retry}.click();return true})()`)
            await wait(`!(${recover})`, 4_000)
            report.fixture_request_cleanup.push({ index, settled: true })
          }
        } catch (error) { report.fixture_request_cleanup.push({ index, error: String(error) }) }
      }
    }
    if (config.mode === 'private-roundtrip') {
      try {
        report.undo_diagnostics = await evaluate(`(()=>{window.r01EditorObserver?.disconnect();return {events:window.r01UndoEvents??[],moves:window.r01EditorMoves??[],editorConnected:window.r01Editor?.isConnected??false,editorFocused:document.activeElement===window.r01Editor,body:window.r01Editor?.value??null}})()`)
      } catch (error) { report.undo_diagnostics = { error: String(error) } }
    }
    seam.releaseAll()
    for (const [id, ownerThreadId] of ownedConversations) {
      const value = await rpc('singleChat.get', { conversationId: id })
      if (value.conversation.status === 'active') {
        const ended = await rpc('singleChat.end', { commandId: randomUUID(), command: { threadId: ownerThreadId, conversationId: id } })
        assert.equal(ended.status, 'applied', JSON.stringify(ended))
      }
      await waitPrivateSnapshot(rpc, id, value => value.agentRuns.every(terminal))
    }
    record('owned_private_workflow_ends_its_conversation_and_settles_only_its_controlled_run')
  }
}
