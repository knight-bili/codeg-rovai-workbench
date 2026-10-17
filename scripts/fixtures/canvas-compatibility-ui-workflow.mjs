import assert from 'node:assert/strict'
import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

// 明确的兼容合同注入：真实Core处理全部请求后，只省略旧版本没有声明的字段。
// 不伪造旧Host二进制、不改Core命令结果或数据库，不授予真实旧服务整体验证资格。
const register = ipcMain.handle, requests = [], omitted = []
ipcMain.handle = function (channel, handler) {
  return register.call(this, channel, channel !== 'rovai:request' ? handler : async (event, method, params) => {
    requests.push({ method, commandId: params?.commandId ?? null })
    const result = await handler(event, method, params)
    if (result.kind !== 'value') return result
    if (method === 'canvas.boards.list') {
      const { summaries, ...value } = result.value; omitted.push({ method, fields: ['summaries'] }); return { ...result, value }
    }
    if (method === 'canvas.nodes.snapshot') {
      const { objectReferenceVersion, fileReferenceVersion, terminalVersion, memberTransferVersion, ...value } = result.value
      value.nodes = value.nodes.map(row => { if (row.data.kind !== 'file') return row; const { fileReference, ...data } = row.data; return { ...row, data } })
      omitted.push({ method, fields: ['objectReferenceVersion', 'fileReferenceVersion', 'terminalVersion', 'memberTransferVersion', 'file.fileReference'] })
      return { ...result, value }
    }
    return result
  })
}

export async function qualifyCanvasSourceUi(window, { evaluate, wait, rpc, openCanvasBoard, config, report, record }) {
  ipcMain.handle = register
  report.compatibility = { scope: '实际App/Core中的旧协议缺字段受控注入；不是运行旧Host二进制。', omitted, layouts: [] }
  const checkpoint = () => writeFile(join(config.evidence, 'progress.json'), JSON.stringify({ checks: report.checks, compatibility: report.compatibility, at: new Date().toISOString() }, null, 2) + '\n')
  const click = async selector => {
    await wait(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)return false;const r=n.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return h&&n.contains(h)})()`)
    const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) window.webContents.sendInputEvent({ type, ...point, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) })
  }
  const profiles = await rpc('members.list'), member = profiles.find(p => !p.removedAt); assert.ok(member)
  const mission = await rpc('missions.create', { commandId: randomUUID(), command: { title: 'R09 原布局与兼容来源', description: '不启动执行', projectBindingKind: 'directory', projectPath: config.workspace, memberAgentIds: [member.agentId], defaultLeadAgentId: member.agentId, tags: [] } }); assert.equal(mission.status, 'applied')
  const threadId = mission.payload.threadId, file = join(config.workspace, 'R09-compatibility.txt'); await writeFile(file, '兼容检查保留原文件\n', { flag: 'wx' })
  const board = await rpc('canvas.boards.create', { commandId: randomUUID(), command: { name: 'R09 八类日间与旧协议' } }); assert.equal(board.status, 'applied'); const boardId = board.payload.board.id
  const kinds = ['folder', 'group', 'agent', 'conversation', 'custom', 'note', 'file', 'terminal']
  const nodes = []
  for (const [i, kind] of kinds.entries()) {
    const graph = await rpc('canvas.nodes.snapshot', { boardId })
    const node = { kind, title: `R09 ${kind}`, x: i % 4 * 540, y: Math.floor(i / 4) * 390, width: kind === 'conversation' ? 224 : 480, height: kind === 'conversation' ? 132 : 310,
      ...(kind === 'folder' ? { folderPath: config.workspace } : {}), ...(kind === 'group' ? { folderGroupId: 'r09-explicitly-unavailable-device-group' } : {}),
      ...(kind === 'agent' ? { agentId: member.agentId } : {}), ...(kind === 'conversation' ? { conversation: { threadId, conversationId: null } } : {}),
      ...(kind === 'custom' ? { conversations: [{ threadId, conversationId: null }] } : {}), ...(kind === 'note' ? { content: '## 原便签\n正文与卡片边界应保持原版密度。' } : {}),
      ...(kind === 'file' ? { path: file, fileReference: { threadId } } : {}), ...(kind === 'terminal' ? { path: config.workspace } : {}) }
    const created = await rpc('canvas.nodes.apply', { commandId: randomUUID(), command: { boardId, expectedRevision: graph.board.revision, mutation: { type: 'create', node } } }); assert.equal(created.status, 'applied', JSON.stringify(created)); nodes.push({ kind, id: created.payload.nodeIds[0] })
  }
  report.compatibility.nodes = nodes; report.compatibility.boardId = boardId
  const before = requests.length
  window.unmaximize(); window.setContentSize(1440, 920); window.webContents.setZoomFactor(1)
  await openCanvasBoard(evaluate, wait, boardId)
  await wait('document.querySelectorAll(".react-flow__node:not([data-id*=member])").length>=8')
  await wait('document.querySelector(".canvas-terminal-issue")?.textContent.includes("请升级服务后重试")')
  assert.equal(await evaluate(`document.querySelector('.canvas-terminal button[aria-label="启动终端"]').disabled`), true)
  record('missing_terminal_capability_shows_original_upgrade_guidance_and_disables_start_without_any_terminal_rpc')
  await click('.canvas-dock-panel button[aria-label="添加节点"]')
  await wait(`document.querySelectorAll('[role="menuitem"]').length>0`)
  const entry = await evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(n=>n.textContent.trim()==='文件')?.getBoundingClientRect().toJSON()`); assert.ok(entry)
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) window.webContents.sendInputEvent({ type, x: Math.round(entry.x + entry.width / 2), y: Math.round(entry.y + entry.height / 2), ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) })
  await wait('Boolean(document.querySelector(".canvas-node-editor"))')
  const options = await evaluate('Array.from(document.querySelector(".canvas-node-editor select").options).filter(o=>["file","mission","task","mission_diff"].includes(o.value)).map(o=>({value:o.value,disabled:o.disabled}))')
  assert.equal(options.length, 4); assert.ok(options.every(o => o.disabled)); assert.equal(await evaluate('document.querySelector(".canvas-node-editor button[type=submit]").disabled'), true)
  report.compatibility.disabledOptions = options; await click('.canvas-node-editor .app-dialog-footer .quiet-button')
  await wait('!document.querySelector(".canvas-node-editor")')
  record('missing_object_and_file_capabilities_disable_original_creation_choices_and_submit_without_writing')
  await click('.canvas-breadcrumb-root'); await wait('Boolean(document.querySelector(".canvas-boards-home"))')
  const copy = await evaluate('document.querySelector(".canvas-board-copy").innerText'); assert.ok(copy.includes('统计暂不可用')); assert.ok(!copy.includes('0 个节点')); report.compatibility.unknownStats = copy
  record('missing_board_summary_is_explicitly_unknown_in_original_list_instead_of_a_fabricated_zero')
  await openCanvasBoard(evaluate, wait, boardId)
  const appearance = await evaluate('window.rovai.appearance.get()')
  try {
    for (const [theme, size] of [['day', [1440, 920]], ['night', [1040, 702]], ['day', [1040, 702]]]) {
      await evaluate(`window.rovai.appearance.setPreference(${JSON.stringify(theme)})`); await wait(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`); window.setContentSize(...size)
      await click('.canvas-dock-panel button[aria-label="查看全部"]'); await pause(500)
      const metrics = await evaluate(`(()=>{const root=document.querySelector('.canvas-workspace'),stage=document.querySelector('.canvas-flow-stage').getBoundingClientRect();return{theme:${JSON.stringify(theme)},viewport:[innerWidth,innerHeight],outerX:root.scrollWidth-root.clientWidth,outerY:root.scrollHeight-root.clientHeight,zoom:document.querySelector('.canvas-zoom-readout').textContent,cards:${JSON.stringify(nodes)}.map(n=>{const host=document.querySelector('.react-flow__node[data-id="'+n.id+'"]'),card=host.querySelector('article'),r=card.getBoundingClientRect();return{kind:n.kind,width:r.width,height:r.height,insideStage:r.left>=stage.left-1&&r.top>=stage.top-1&&r.right<=stage.right+1&&r.bottom<=stage.bottom+1,extraX:card.scrollWidth-card.clientWidth,extraY:card.scrollHeight-card.clientHeight}})}})()`)
      report.compatibility.layouts.push(metrics); await checkpoint(); assert.equal(metrics.outerX, 0); assert.equal(metrics.outerY, 0); assert.ok(metrics.cards.every(c => c.insideStage && c.extraX <= 1 && c.extraY <= 1), JSON.stringify(metrics))
      const image = join(config.evidence, `eight-${theme}-${size[0]}.png`); await writeFile(image, (await window.webContents.capturePage()).toPNG()); (report.screenshots ??= []).push(image)
    }
  } finally { await evaluate(`window.rovai.appearance.setPreference(${JSON.stringify(appearance.preference)})`) }
  record('actual_eight_original_card_types_fit_after_original_fit_action_in_day_night_and_small_window_without_outer_scroll')
  const forbidden = requests.slice(before).filter(r => r.method.startsWith('canvas.terminals.') || r.method === 'canvas.nodes.apply' || /\.send$/.test(r.method))
  assert.deepEqual(forbidden, []); report.compatibility.forbiddenRequests = forbidden; await checkpoint()
  record('compatibility_ui_does_not_bypass_missing_capabilities_or_mutate_the_original_eight_nodes')
}
