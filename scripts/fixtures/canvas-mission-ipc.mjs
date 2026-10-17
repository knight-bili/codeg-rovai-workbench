import assert from 'node:assert/strict'

// Owned test transport: original Main authentication and Core handlers always run.
export function installCanvasMissionIpc(ipcMain) {
  const register = ipcMain.handle, requests = [], gates = []
  let registered = false, failed = null
  const matches = (spec, method, params) => spec.method === method && spec.missionId === params?.missionId
    && (spec.fileId === undefined || spec.fileId === params?.fileId)
  ipcMain.handle = function (channel, handler) {
    if (channel !== 'rovai:request') return register.call(this, channel, handler)
    registered = true
    return register.call(this, channel, async (event, method, params) => {
      const entry = {method, params:structuredClone(params), at:Date.now()}; requests.push(entry)
      const gate = gates.find(value => !value.used && matches(value, method, params))
      if (gate) gate.used = true
      const fail = failed && matches(failed, method, params)
      if (fail) failed = null
      const result = await handler(event, method, params)
      if (method.startsWith('missions.')) entry.result = structuredClone(result)
      if (gate) { gate.observed = {params:structuredClone(params), result:structuredClone(result)}; await gate.promise }
      if (fail) {
        entry.injectedResponseFailure = true
        return {kind:'failure',failure:{kind:'infrastructure_failure',code:'fixture_refresh_reply_failed',
          message:'受控测试：读取已完成但回复失败。',retryable:true,generation:0,details:{}}}
      }
      return result
    })
  }
  return {
    finishRegistration() { ipcMain.handle = register; assert.ok(registered) },
    mark: () => requests.length,
    since: mark => structuredClone(requests.slice(mark)),
    holdNext(spec) {
      let release
      const gate = {...structuredClone(spec), used:false, observed:null, promise:new Promise(resolve => {release=resolve}), release() {release()} }
      gates.push(gate);return gate
    },
    failNext(spec) {assert.equal(failed,null);failed=structuredClone(spec)},
    releaseAll() {for(const gate of gates)gate.release()},
    snapshot: () => ({requests:structuredClone(requests),held:gates.map(value=>({method:value.method,missionId:value.missionId,fileId:value.fileId,observed:Boolean(value.observed)}))})
  }
}
