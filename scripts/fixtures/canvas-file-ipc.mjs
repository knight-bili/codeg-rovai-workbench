import assert from 'node:assert/strict'

// Observe the actual Main handler, sender validation and resource result without substituting them.
export function installCanvasFileIpc(ipcMain) {
  const register=ipcMain.handle, requests=[]
  let registered=0
  ipcMain.handle=function(channel,handler){
    if(!channel.startsWith('rovai:file-preview-'))return register.call(this,channel,handler)
    registered++
    return register.call(this,channel,async(event,...args)=>{
      const row={channel,args:structuredClone(args),at:Date.now()};requests.push(row)
      try{const result=await handler(event,...args);row.result=structuredClone(result);return result}
      catch(error){row.error=String(error);throw error}
    })
  }
  return {
    finishRegistration(){ipcMain.handle=register;assert.ok(registered>0)},
    mark:()=>requests.length,
    since:mark=>structuredClone(requests.slice(mark)),
    snapshot:()=>({requests:structuredClone(requests)}),
    releaseAll(){}
  }
}
