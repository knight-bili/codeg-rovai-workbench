import assert from 'node:assert/strict'
import test from 'node:test'
import {installCanvasMissionIpc} from '../fixtures/canvas-mission-ipc.mjs'

function fixture() {
  const handlers=new Map(), calls=[]
  const ipc={handle(channel,handler){handlers.set(channel,handler)}},original=ipc.handle
  const seam=installCanvasMissionIpc(ipc)
  ipc.handle('rovai:request',async(event,method,params)=>{calls.push({event,method,params});return {kind:'value',value:{viewId:params.missionId}}})
  ipc.handle('other',()=> 'untouched');seam.finishRegistration();assert.equal(ipc.handle,original)
  return {seam,calls,invoke:(method,params)=>handlers.get('rovai:request')({owner:'actual-sender'},method,params),other:()=>handlers.get('other')()}
}
test('holds one exact Mission file reply after the original handler and keeps unrelated requests unchanged',async()=>{
  const f=fixture(),gate=f.seam.holdNext({method:'missions.fileDiff',missionId:'own',fileId:'a'})
  assert.equal(f.other(),'untouched')
  await f.invoke('missions.fileDiff',{missionId:'foreign',fileId:'a'})
  await f.invoke('missions.fileDiff',{missionId:'own',fileId:'b'})
  assert.equal(gate.observed,null)
  let completed=false
  const pending=f.invoke('missions.fileDiff',{missionId:'own',fileId:'a',viewId:'original'}).then(value=>{completed=true;return value})
  await Promise.resolve();await Promise.resolve()
  assert.equal(f.calls.length,3);assert.equal(f.calls[2].event.owner,'actual-sender');assert.equal(completed,false)
  assert.equal(gate.observed.params.viewId,'original');assert.equal(gate.observed.result.value.viewId,'own')
  f.seam.releaseAll();assert.equal((await pending).kind,'value');assert.equal(completed,true)
})
test('fails only one exact refresh reply after the original Core read without retrying it',async()=>{
  const f=fixture();f.seam.failNext({method:'missions.changes',missionId:'own'})
  assert.equal((await f.invoke('missions.changes',{missionId:'foreign'})).kind,'value')
  assert.equal((await f.invoke('missions.changes',{missionId:'own'})).kind,'failure')
  assert.equal((await f.invoke('missions.changes',{missionId:'own'})).kind,'value')
  assert.equal(f.calls.length,3)
  assert.equal(f.seam.since(0).filter(value=>value.injectedResponseFailure).length,1)
})
