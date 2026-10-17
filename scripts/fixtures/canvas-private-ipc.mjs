import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const matches = (command, owner) => {
  if (command?.conversationId !== owner.conversationId) return false
  const actual = command.composerScope ?? null, expected = owner.scope ?? null
  return actual === null || expected === null ? actual === expected
    : actual.kind === expected.kind && actual.boardId === expected.boardId && actual.nodeId === expected.nodeId
}

// Test-only transport seam. Production handlers retain all authentication,
// validation and Core work. Faults apply once to an explicitly armed input.
export function installCanvasPrivateIpc(ipcMain) {
  const register = ipcMain.handle, wrapped = new Set(), requests = [], faults = [], gates = []
  let conflict = null, lostSwap = null, upload = null, send = null
  ipcMain.handle = function (channel, handler) {
    if (!['rovai:request', 'rovai:private-attachment-prepare'].includes(channel)) return register.call(this, channel, handler)
    wrapped.add(channel)
    return register.call(this, channel, async (event, ...args) => {
      const method = channel === 'rovai:request' ? args[0] : channel
      const params = channel === 'rovai:request' ? args[1] : args[0]
      const command = params?.command
      const entry = { method, commandId: params?.commandId ?? null,
        lookupCommandId: method === 'commands.reconcile' ? params?.params?.commandId ?? null : null,
        threadId: command?.threadId ?? params?.threadId ?? params?.campId ?? null,
        conversationId: command?.conversationId ?? params?.conversationId ?? params?.target?.conversationId ?? null,
        action: command?.action?.type ?? null }
      requests.push(entry)
      if (conflict && method === 'singleChat.composerDraft.mutate' && matches(command, conflict)
        && command.action?.type === 'quote' && command.action.action?.type === 'remove') {
        const armed = conflict; conflict = null
        const external = await handler(event, method, { commandId: randomUUID(), command: { ...command,
          action: { type: 'remove_attachment', attachmentRefId: armed.attachmentRefId } } })
        assert.equal(external.kind, 'value'); assert.equal(external.value.status, 'applied')
        faults.push({ kind: 'concurrent_material_change', commandId: params.commandId, result: external.value.status })
      }
      const drop = lostSwap && method === 'singleChat.composerDraft.mutate' && matches(command, lostSwap)
        && command.action?.type === 'swap_retained'
      const loss = drop ? lostSwap : null
      if (drop) lostSwap = null
      const lostReply = { kind: 'failure', failure: { kind: 'infrastructure_failure', code: 'fixture_reply_lost',
        message: '受控测试：运输回执丢失，须核对原请求。', retryable: true, generation: 0, details: {} } }
      if (loss?.beforeAccept) {
        entry.status = 'interrupted_before_dispatch'
        faults.push({ kind: 'swap_not_dispatched', commandId: params.commandId })
        return lostReply
      }
      const hold = upload && channel === 'rovai:private-attachment-prepare'
        && matches({ conversationId: params?.target?.conversationId, composerScope: params?.target?.composerScope }, upload)
      const gate = hold ? upload : null
      if (hold) upload = null
      const sendGate = send && method === 'singleChat.send' && matches(command, send) ? send : null
      if (sendGate) send = null
      const result = await handler(event, ...args)
      entry.status = channel === 'rovai:request' ? result.value?.status ?? result.kind : result.state
      entry.code = channel === 'rovai:request' ? result.value?.code ?? result.failure?.code ?? null : result.receipt?.code ?? null
      if (sendGate) {
        sendGate.observed = { params: structuredClone(params), result: structuredClone(result) }
        faults.push({ kind: 'held_send_reply', commandId: params.commandId })
        await sendGate.promise
      }
      if (drop) {
        assert.equal(result.kind, 'value'); assert.equal(result.value.status, 'applied')
        faults.push({ kind: 'lost_committed_swap_reply', commandId: params.commandId })
        return lostReply
      }
      if (gate) {
        gate.observed = { commandId: params.commandId, state: result.state, target: structuredClone(params.target) }
        faults.push({ kind: 'held_upload_reply', commandId: params.commandId, state: result.state })
        await gate.promise
      }
      return result
    })
  }
  return {
    finishRegistration() {
      ipcMain.handle = register
      assert.ok(wrapped.has('rovai:request') && wrapped.has('rovai:private-attachment-prepare'))
    },
    mark: () => requests.length,
    since: mark => structuredClone(requests.slice(mark)),
    armConflict(owner) { assert.equal(conflict, null); conflict = structuredClone(owner) },
    loseNextSwap(owner) { assert.equal(lostSwap, null); lostSwap = structuredClone(owner) },
    holdUpload(owner) {
      assert.equal(upload, null)
      let release
      const gate = { ...structuredClone(owner), observed: null, promise: new Promise(resolve => { release = resolve }),
        release() { release() } }
      gates.push(gate); upload = gate
      return gate
    },
    holdSend(owner) {
      assert.equal(send, null)
      let release
      const gate = { ...structuredClone(owner), observed: null, promise: new Promise(resolve => { release = resolve }), release() { release() } }
      gates.push(gate); send = gate
      return gate
    },
    releaseAll() { for (const gate of gates) gate.release() },
    snapshot: () => ({ requests: structuredClone(requests), faults: structuredClone(faults),
      uploads: gates.map(gate => structuredClone(gate.observed)) })
  }
}
