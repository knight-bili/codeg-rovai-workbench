import assert from 'node:assert/strict'
import test from 'node:test'
import {installCanvasFileIpc} from '../fixtures/canvas-file-ipc.mjs'

test('observes original file sender, result and rejection without replacing or retrying the handler',async()=>{
  const handlers=new Map(),event={sender:'actual-window'},calls=[]
  const ipc={handle(channel,handler){handlers.set(channel,handler)}},original=ipc.handle
  const seam=installCanvasFileIpc(ipc),result={ok:true,value:{handleId:'original'}}
  ipc.handle('rovai:file-preview-restore',async(sender,input)=>{calls.push({sender,input});if(input.reject)throw Error('original sender rejected');return result})
  ipc.handle('other',()=> 'unwrapped');seam.finishRegistration()
  assert.equal(ipc.handle,original);assert.equal(handlers.get('other')(),'unwrapped')
  const input={threadId:'A'};assert.equal(await handlers.get('rovai:file-preview-restore')(event,input),result)
  assert.equal(calls[0].sender,event);assert.equal(calls[0].input,input)
  await assert.rejects(handlers.get('rovai:file-preview-restore')(event,{reject:true}),/original sender rejected/)
  assert.equal(calls.length,2);assert.equal(seam.since(0)[0].result.value.handleId,'original')
  assert.match(seam.since(1)[0].error,/original sender rejected/)
})
