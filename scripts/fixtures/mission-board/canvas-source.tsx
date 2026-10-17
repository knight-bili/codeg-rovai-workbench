import React from 'react'
import type { CanvasGraphSnapshot, CanvasNodeKind, ResolvedTheme } from '@contracts'
import { CanvasSurface } from '../../../apps/desktop/src/renderer/src/CanvasSurface'
import { CanvasWorkspace } from '../../../apps/desktop/src/renderer/src/CanvasWorkspace'
import { CanvasFolderProvider } from '../../../apps/desktop/src/renderer/src/CanvasFolderProvider'
import { ThreadClientProvider, type ThreadClient } from '../../../apps/desktop/src/renderer/src/camp-client'

// Diagnostic observations only: do not swallow browser errors or defer library callbacks.
export function instrumentCanvasResize() {
 const native=window.ResizeObserver, trace:unknown[]=[], errors:unknown[]=[]
 ;(window as any).canvasResize={trace,errors}
 window.ResizeObserver=class extends native {
  constructor(callback:ResizeObserverCallback){
   const origin=new Error().stack
   super((entries,observer)=>{
    trace.push({origin,entries:entries.map(entry=>({target:entry.target.className,width:entry.contentRect.width,height:entry.contentRect.height}))})
    if(trace.length>32)trace.shift()
    callback.call(observer,entries,observer)
   })
  }
 }
 window.addEventListener('error',event=>{if(event.message.includes('ResizeObserver')){errors.push({message:event.message,trace:trace.slice(-6)});if(errors.length>6)errors.shift()}})
}

export function CanvasSourceFixture({client,theme,list=false}:{client:ThreadClient;theme:ResolvedTheme;list?:boolean}){
 const board={id:'canvas-source-fixture',name:'源码卡片布局',description:null,color:null,revision:1,createdAt:'2026-10-16T00:00:00Z',updatedAt:'2026-10-16T00:00:00Z'}
 const kinds:CanvasNodeKind[]=[...Array<CanvasNodeKind>(64).fill('conversation'),'note','custom','file','terminal']
 const graph:CanvasGraphSnapshot={board,throughGlobalSequence:1,nodes:kinds.map((kind,i)=>({id:`source-node-${i}`,boardId:board.id,
  createdAt:board.createdAt,updatedAt:board.updatedAt,data:{kind,title:kind==='conversation'?`中文长标题 ${i} 保留四行内容与紧凑操作，核对缩放后的卡片布局`:null,
   color:kind==='note'?'orange':null,x:(i%8)*250,y:Math.floor(i/8)*165,width:kind==='conversation'?224:360,height:kind==='conversation'?132:260,
   collapsed:false,gridColumns:0,gridRows:0,path:null,folderPath:null,folderGroupId:null,agentId:null,runtimeKind:null,
   conversation:kind==='conversation'?{threadId:'source-thread',conversationId:null}:null,conversations:[],
   content:kind==='note'?'便笺正文应保持原版密度，双击可以编辑。':null}}))}
 const boards=Array.from({length:10},(_,i)=>({...board,id:`source-board-${i}`,name:`源码画板 ${i} 中文长标题`,
  description:i%3===0?'整理需求\n保留两行说明':i%3===1?'一行说明':null}))
 const sourceClient={...client,presentationScope:'canvas-source-fixture',request:async(method:string,params?:{boardId?:string})=>{
  if(method==='app.info')return {dataDir:'source-fixture-only'}
  if(method==='canvas.references.page')return {schemaVersion:1,throughGlobalSequence:1,items:[],upperThreadId:null,nextAfterThreadId:null}
  if(method==='canvas.boards.list')return {throughGlobalSequence:1,boards,summaries:boards.map((board,i)=>({boardId:board.id,revision:1,nodeCount:1,terminalCount:0,preview:[{kind:'note',x:0,y:0,width:320,height:i===0?2400:260,color:'orange'}]}))}
  if(method==='canvas.nodes.snapshot'){
   if(!list)await new Promise(resolve=>setTimeout(resolve,120))
   return list?{board:boards.find(board=>board.id===params?.boardId),throughGlobalSequence:1,nodes:[]}:graph
  }
  throw new Error(`Unexpected source fixture request: ${method}`)
 }} as ThreadClient
 return <div className="canvas-workspace" style={{height:'100vh'}}><ThreadClientProvider client={sourceClient}><CanvasFolderProvider client={sourceClient}>
  {list?<CanvasWorkspace agents={[]} theme={theme} onOpenReference={()=>{}}/>
   :<CanvasSurface boardId={board.id} scope={{host:'source-fixture',core:'source-fixture'}} agents={[]} theme={theme} onOpenReference={()=>{}}/>}
 </CanvasFolderProvider></ThreadClientProvider></div>
}
