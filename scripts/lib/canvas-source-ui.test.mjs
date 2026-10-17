import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp,mkdir,readFile,writeFile,cp} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import test from 'node:test'
import react from '@vitejs/plugin-react'
import electron from 'electron'
import {build} from 'vite'
import {admitElectronIntegrationTest} from './electron-sandbox-capability.mjs'

test('Canvas source cards and embedded Mission search retain their own sizing and selection', {timeout:180_000},async t=>{
 if(!admitElectronIntegrationTest(t))return
 const root=resolve(import.meta.dirname,'../..'),source=join(root,'scripts/fixtures/mission-board'),fixture=await mkdtemp(join(tmpdir(),'rovai-canvas-source-ui-'))
 await mkdir(join(fixture,'home'),{recursive:true})
 console.log(`Automatic acceptance: ${fixture}; isolated Renderer only, no Core/SQLite/Skill Library/MCP/Runtime`)
 const entry=join(fixture,'canvas-source.cjs')
 await cp(join(source,'canvas-source.cjs'),entry,{errorOnExist:true,force:false})
 const manifest=[]
 for(const path of ['apps/desktop/src/renderer/src/styles.css','apps/desktop/src/renderer/src/canvas.css','apps/desktop/src/renderer/src/CanvasSurface.tsx','apps/desktop/src/renderer/src/CanvasNote.tsx','apps/desktop/src/renderer/src/CanvasObjectDialog.tsx','apps/desktop/src/renderer/src/MissionDelivery.tsx','apps/desktop/src/renderer/src/CanvasWorkspace.tsx','apps/desktop/src/renderer/src/CanvasBoardPreview.tsx','apps/desktop/src/renderer/src/canvas-boards-controller.ts','scripts/fixtures/mission-board/renderer.tsx','scripts/fixtures/mission-board/canvas-source.tsx','scripts/fixtures/mission-board/canvas-source.cjs','scripts/lib/canvas-source-ui.test.mjs']){
  const bytes=await readFile(join(root,path));manifest.push({path,sha256:createHash('sha256').update(bytes).digest('hex')})
 }
 await writeFile(join(fixture,'source-files.json'),JSON.stringify(manifest,null,2)+'\n')
 await build({configFile:false,root:source,base:'./',logLevel:'error',plugins:[react()],resolve:{alias:{'@contracts':join(root,'packages/contracts/src/index.ts')}},build:{outDir:join(fixture,'renderer'),minify:false}})
 const results=[]
 const modes=(process.env.ROVAI_CANVAS_SOURCE_MODES??'diff,resize,boards').split(',')
 assert(modes.length&&modes.every(mode=>['diff','resize','boards'].includes(mode)))
 for(const theme of ['day','night'])for(const mode of modes){
  const userData=join(fixture,`${mode}-${theme}`),env={}
  for(const key of ['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH'])if(process.env[key])env[key]=process.env[key]
  Object.assign(env,{HOME:join(fixture,'home'),USERPROFILE:join(fixture,'home'),ELECTRON_DISABLE_SECURITY_WARNINGS:'true'})
  const child=spawn(electron,[entry,join(fixture,'renderer/index.html'),userData,mode,theme,...(process.platform==='linux'?['--no-sandbox']:[])],{env,windowsHide:true,stdio:['ignore','pipe','pipe']})
  const closed=once(child,'close');let output='';child.stdout.on('data',bytes=>{output+=bytes});child.stderr.on('data',bytes=>{output+=bytes})
  let deadline=false;const timer=setTimeout(()=>{deadline=true;child.kill('SIGKILL')},50_000)
  let code,signal;try{[code,signal]=await closed}finally{clearTimeout(timer)}
  await writeFile(join(fixture,`${mode}-${theme}.log`),output)
  const report=JSON.parse(await readFile(join(userData,'result.json'),'utf8'))
  results.push({mode,theme,code,signal,deadline,status:report.status,checks:report.checks,resizeErrors:report.resize?.errors.length})
  console.log(JSON.stringify(results.at(-1)))
 }
 await writeFile(join(fixture,'summary.json'),JSON.stringify(results,null,2)+'\n')
 for(const file of manifest)assert.equal(createHash('sha256').update(await readFile(join(root,file.path))).digest('hex'),file.sha256,file.path)
 assert(results.every(result=>result.code===0&&!result.deadline&&result.status==='passed'),JSON.stringify({fixture,results}))
})
