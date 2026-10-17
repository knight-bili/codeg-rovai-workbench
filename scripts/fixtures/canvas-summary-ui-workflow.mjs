import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as pause } from 'node:timers/promises'

// 只用实际Core命令、事件投影和原组件。ACP为隔离的固定本地协议进程，不连接模型服务。
export async function qualifyCanvasSourceUi(window, { evaluate, wait, rpc, openCanvasBoard, config, report, record }) {
  for (const [name, expected] of [['ROVAI_QWEN_BIN', config.controlled_launcher], ['ROVAI_ACCEPTANCE_SCRIPT', config.controlled_script]]) {
    assert.equal(process.env[name], expected.path)
    assert.equal(createHash('sha256').update(await readFile(expected.path)).digest('hex'), expected.sha256)
  }
  assert.equal(process.env.ROVAI_SKILL_RECOVERY_CAPTURE, config.runtime_capture)
  assert.equal(createHash('sha256').update(await readFile(new URL(config.runtime_configure_module))).digest('hex'), config.runtime_configure_sha256)
  const mcp = await rpc('mcp.config.get')
  assert.ok(mcp.exists && !mcp.permissionIssue && mcp.fileIssue == null); assert.deepEqual(mcp.servers, [])
  const { configureProductRuntime } = await import(config.runtime_configure_module)
  const created = await rpc('members.create', { commandId: randomUUID(), command: { displayName: 'R09 本机摘要队员', teamRole: '摘要工程验证', professionalResponsibilities: '固定本地协议，无外部推理', personalityTraits: ['严谨'], workingPrinciples: '保持实际来源', growthTopic: '' } })
  assert.equal(created.status, 'applied'); const agentId = created.resultEntity.entityId
  await configureProductRuntime(rpc, 'qwen-code', [agentId])
  const setModel = async model => {
    const profile = await rpc('members.get', { agentId }), selected = await rpc('members.runtime.set', { commandId: randomUUID(), command: { agentId, expectedVersion: profile.version, adapterKind: 'qwen-code', model, permissions: profile.runtimeConfiguration.permissions } })
    assert.equal(selected.status, 'applied', JSON.stringify(selected))
  }
  await setModel({ mode: 'explicit', modelId: 'fixture-model', options: {} })
  const git = (...args) => execFileSync(config.git_executable, args, { cwd: config.workspace, encoding: 'utf8', windowsHide: true })
  git('init', '-b', 'r09-summary-source'); git('config', 'user.name', 'R09 Local'); git('config', 'user.email', 'r09@example.invalid')
  await writeFile(join(config.workspace, 'R09-summary.txt'), '原分支摘要来源\n', { flag: 'wx' }); git('add', 'R09-summary.txt'); git('commit', '-m', '准备真实分支摘要')
  const mission = await rpc('missions.create', { commandId: randomUUID(), command: { title: '四行标题'.repeat(30), description: 'R09 原摘要与分支', projectBindingKind: 'directory', projectPath: config.workspace, memberAgentIds: [agentId], defaultLeadAgentId: agentId, tags: [] } })
  assert.equal(mission.status, 'applied')
  const other = await rpc('threads.create', { commandId: randomUUID(), name: 'R09 独立第二会话', workspace: null, memberAgentIds: [agentId], defaultLeadAgentId: agentId, collaborationMode: 'peer', activationState: 'active' })
  assert.equal(other.status, 'applied')
  const contexts = []
  for (const threadId of [mission.payload.threadId, other.payload.threadId]) {
    const privateChat = await rpc('singleChat.open', { commandId: randomUUID(), command: { threadId, agentId } }); assert.equal(privateChat.status, 'applied')
    contexts.push({ threadId, conversationId: null }, { threadId, conversationId: privateChat.payload.conversationId })
  }
  const board = await rpc('canvas.boards.create', { commandId: randomUUID(), command: { name: 'R09 动态真实摘要' } }); assert.equal(board.status, 'applied')
  const boardId = board.payload.board.id
  for (const [index, context] of contexts.entries()) {
    const graph = await rpc('canvas.nodes.snapshot', { boardId })
    const pin = await rpc('canvas.nodes.apply', { commandId: randomUUID(), command: { boardId, expectedRevision: graph.board.revision, mutation: { type: 'create', node: { kind: 'conversation', conversation: context, x: index % 2 * 280, y: Math.floor(index / 2) * 190, width: 224, height: 132 } } } })
    assert.equal(pin.status, 'applied'); context.nodeId = pin.payload.nodeIds[0]
  }
  report.summary = { boardId, agentId, contexts, states: [], models: [], visuals: [], frameObservations: [] }
  const checkpoint = () => writeFile(join(config.evidence, 'progress.json'), JSON.stringify({ checks: report.checks, summary: report.summary, at: new Date().toISOString() }, null, 2) + '\n')
  const until = async predicate => { const end = Date.now() + 30000; while (Date.now() < end) { const value = await predicate(); if (value) return value; await pause(60) } throw Error('Actual Core state did not settle') }
  const click = async selector => {
    await wait(`Boolean(document.querySelector(${JSON.stringify(selector)})?.checkVisibility())`)
    await wait(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !n.disabled&&h&&n.contains(h)})()`)
    const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) window.webContents.sendInputEvent({ type, ...point, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) })
  }
  const node = c => `.react-flow__node[data-id="${c.nodeId}"]`
  const view = c => c.conversationId ? rpc('singleChat.get', { conversationId: c.conversationId }) : rpc('threads.open', { threadId: c.threadId, traceId: randomUUID() })
  const activeRuns = v => v.agentRuns.filter(run => ['queued', 'running', 'waiting'].includes(run.status))
  const states = async (label, flags) => {
    const page = await rpc('canvas.references.page', { limit: 200 })
    const projected = contexts.map(c => { const t = page.items.find(t => t.threadId === c.threadId); return c.conversationId ? t.privateConversations.find(p => p.conversationId === c.conversationId).hasActiveRun : t.publicActiveRunCount > 0 })
    assert.deepEqual(projected, flags)
    await wait(`${JSON.stringify(contexts.map(c => node(c)))}.every((s,i)=>document.querySelector(s+' .canvas-summary-status')?.getAttribute('data-active')===${JSON.stringify(flags.map(String))}[i])`)
    report.summary.states.push({ label, projected, flags, through: page.throughGlobalSequence }); await checkpoint()
  }
  const sendHeld = async c => {
    const before = await view(c), body = 'ROVAI_SKILL_RECOVERY_HELD_INPUT R09 摘要 ' + randomUUID()
    const result = c.conversationId ? await rpc('singleChat.send', { commandId: randomUUID(), command: { threadId: c.threadId, conversationId: c.conversationId, body, draftRevision: before.draft.revision } }) : await rpc('thread.messages.send', { commandId: randomUUID(), threadId: c.threadId, content: { version: 2, segments: [{ kind: 'text', text: body }] }, sourceAttachments: [], quotes: [], replyToThreadMessageId: null, execution: { taskId: null, purpose: '固定本地摘要工程验证', completionRole: 'required' } })
    assert.equal((result.commandResult ?? result).status, 'accepted', JSON.stringify(result))
    const after = await until(async () => { const v = await view(c); const runs = activeRuns(v).filter(run => !before.agentRuns.some(old => old.id === run.id)); return runs.length === 1 && runs[0].status === 'running' ? runs[0] : false })
    c.runId = after.id
  }
  const cancel = async c => {
    const run = (await view(c)).agentRuns.find(run => run.id === c.runId)
    const receipt = await rpc('agentRuns.cancel', { commandId: randomUUID(), command: { threadId: c.threadId, agentRunId: run.id, expectedVersion: run.version } }); assert.notEqual(receipt.status, 'rejected', JSON.stringify(receipt))
    await until(async () => (await view(c)).agentRuns.find(run => run.id === c.runId)?.status === 'cancelled')
  }
  window.unmaximize(); window.setContentSize(1440, 920); window.webContents.setZoomFactor(1)
  await openCanvasBoard(evaluate, wait, boardId); await click('.canvas-dock-panel button[aria-label="查看全部"]'); await pause(450); await click('.canvas-viewport-panel button[aria-label="恢复到 100%"]'); await pause(200)
  await states('initial', [false, false, false, false])
  await wait(`document.querySelector('${node(contexts[0])} .canvas-summary-kind')?.textContent.includes('配置：fixture-model')`)
  await wait(`document.querySelector('${node(contexts[0])} .canvas-summary-branch')?.textContent==='r09-summary-source'`)
  record('actual_core_configuration_before_any_run_and_exact_real_git_branch_are_visible_in_original_summary')
  try {
    await sendHeld(contexts[0]); await states('A public only', [true, false, false, false])
    await sendHeld(contexts[1]); await states('A public and A private', [true, true, false, false])
    await sendHeld(contexts[2]); await states('A public private and B public', [true, true, true, false])
    await cancel(contexts[0]); await states('A public cancelled while A private B public stay', [false, true, true, false])
    await cancel(contexts[1]); await states('A private cancelled while B public stays', [false, false, true, false])
    await cancel(contexts[2]); await states('all terminal', [false, false, false, false])
    record('actual_interleaved_two_thread_public_private_activity_and_independent_cancellation_update_original_status_dots')
    await setModel({ mode: 'runtime_default' })
    await wait(`document.querySelector('${node(contexts[3])} .canvas-summary-kind')?.textContent==='私有对话'`)
    for (const c of contexts.slice(0, 3)) await wait(`document.querySelector('${node(c)} .canvas-summary-kind')?.textContent.includes('最近：fixture-model')`)
    report.summary.models = await evaluate(`${JSON.stringify(contexts.map(c => node(c)))}.map(s=>({label:document.querySelector(s+' .canvas-summary-kind')?.textContent,title:document.querySelector(s+' .canvas-summary-kind')?.title}))`)
    record('actual_frozen_run_model_stays_distinct_from_changed_current_configuration_and_private_without_run_has_no_foreign_history')
    const preference = await evaluate('window.rovai.appearance.get()')
    try {
      for (const [theme, size, zoom] of [['day', [1440, 920], 100], ['night', [1040, 702], 83], ['day', [1040, 702], 120]]) {
        await evaluate(`window.rovai.appearance.setPreference(${JSON.stringify(theme)})`); await wait(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`); window.setContentSize(...size)
        const zoomButton = '.canvas-viewport-panel button[aria-label="恢复到 100%"]'; await click(zoomButton); await pause(200)
        if (zoom !== 100) await click(`.canvas-viewport-panel button[aria-label="${zoom > 100 ? '放大画布' : '缩小画布'}"]`)
        await wait(`document.querySelector('.canvas-zoom-readout')?.textContent===${JSON.stringify(zoom+'%')}`)
        await pause(450)
        const metrics = await evaluate(`(()=>{const root=document.querySelector('.canvas-workspace'),r=root.getBoundingClientRect(),cards=${JSON.stringify(contexts.map(c => node(c)))}.map(s=>{const card=document.querySelector(s+' .canvas-conversation-summary'),title=card.querySelector('.canvas-summary-title'),style=getComputedStyle(title),r=card.getBoundingClientRect();return{width:r.width,height:r.height,clamp:style.webkitLineClamp,titleHeight:title.getBoundingClientRect().height,lineHeight:parseFloat(style.lineHeight),title:title.title}});return{theme:${JSON.stringify(theme)},zoom:${zoom},outerX:root.scrollWidth-root.clientWidth,outerY:root.scrollHeight-root.clientHeight,viewport:{width:innerWidth,height:innerHeight},cards}})()`)
        report.summary.visuals.push(metrics); await checkpoint(); assert.equal(metrics.outerX, 0); assert.equal(metrics.outerY, 0); assert.ok(metrics.cards.every(c => c.clamp === '4'))
        const path = join(config.evidence, `summary-${theme}-${zoom}.png`); await writeFile(path, (await window.webContents.capturePage()).toPNG()); (report.screenshots ??= []).push(path)
      }
    } finally { await evaluate(`window.rovai.appearance.setPreference(${JSON.stringify(preference.preference)})`) }
    record('original_four_line_long_title_and_metadata_keep_local_canvas_layout_across_day_night_small_window_and_original_83_120_zoom_steps')
    window.setContentSize(1440, 920); await click('.canvas-dock-panel button[aria-label="查看全部"]'); await pause(450)
    await click(`${node(contexts[0])} button[aria-label="展开对话"]`)
    const frame = `.canvas-conversation-frame[data-canvas-conversation-key*="${contexts[0].nodeId}"]`
    await wait(`Boolean(document.querySelector('${frame} .structured-mention-editor'))`)
    await click('.canvas-dock-panel button[aria-label="查看全部"]'); await pause(450)
    const frames = await evaluate(`new Promise(resolve=>{const rows=[];let previous=performance.now();function frame(now){const stage=document.querySelector('.canvas-flow-stage').getBoundingClientRect(),editor=document.querySelector('${frame} .structured-mention-editor'),r=editor.getBoundingClientRect(),hit=document.elementFromPoint(r.x+Math.min(12,r.width/2),r.y+Math.min(12,r.height/2));rows.push({gap:now-previous,stage:[stage.width,stage.height],editor:[r.x,r.y,r.width,r.height],hit:Boolean(hit&&editor.contains(hit))});previous=now;if(rows.length<12)requestAnimationFrame(frame);else resolve(rows)}requestAnimationFrame(frame)})`)
    report.summary.frameObservations = frames; await checkpoint(); assert.ok(frames.every(f => f.hit && f.editor[2] > 0 && f.editor[3] > 0))
    assert.deepEqual(frames.at(-1).stage, frames.at(-2).stage)
    await click(`${frame} .structured-mention-editor`); const body = 'R09 尺寸观察后的真实输入🙂'; await window.webContents.insertText(body)
    await wait(`document.querySelector('${frame} .structured-mention-editor').textContent===${JSON.stringify(body)}`)
    report.summary.inputAfterFrames = body; record('actual_post_expansion_frames_keep_visible_editor_hit_and_stable_stage_then_trusted_input_reaches_original_composer')
  } finally {
    for (const c of contexts) for (const run of activeRuns(await view(c))) {
      await rpc('agentRuns.cancel', { commandId: randomUUID(), command: { threadId: c.threadId, agentRunId: run.id, expectedVersion: run.version } })
    }
    await checkpoint()
  }
}
