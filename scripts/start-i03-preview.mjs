import {spawn,execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFile,mkdir,access} from 'node:fs/promises'
import {dirname,join,resolve,sep} from 'node:path'
import {pathToFileURL} from 'node:url'
import {assertUserDataIsIsolated} from './lib/dev-desktop.mjs'

// 只启动已核对的本机开发预览；不编译、不安装、不共享日常数据或模型身份。
export async function previewConfiguration(){
 if(process.platform!=='win32')throw Error('当前开发预览入口只核定 Windows；其他平台继续按矩阵验证。')
 const repositoryRoot=resolve(import.meta.dirname,'..'),directory=join(repositoryRoot,'integration/local/i03-preview-rc25')
 const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')),app=join(directory,'app')
 if(manifest.candidate!=='fusion-i03-rc.25')throw Error('开发预览版本不匹配，请保留原预览目录。')
 const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex')
 for(const item of manifest.files){const path=resolve(app,item.path);if(!path.startsWith(app+sep))throw Error('开发预览清单包含目录外路径。');if(await hash(path)!==item.sha256)throw Error('开发预览文件已变化：'+item.path)}
 const dataRoot=assertUserDataIsIsolated(join(directory,'user-data-v2')),home=join(directory,'isolation/home'),temporary=join(directory,'isolation/tmp')
 const electron=join(repositoryRoot,'node_modules/electron/dist/electron.exe');await access(electron)
 const env={};for(const key of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key]
 Object.assign(env,{PATH:[dirname(process.execPath),'E:/software/encoding/common/Git/bin',join(process.env.SystemRoot,'System32')].join(';'),HOME:home,USERPROFILE:home,APPDATA:join(home,'AppData/Roaming'),LOCALAPPDATA:join(home,'AppData/Local'),TEMP:temporary,TMP:temporary,SHELL:process.env.COMSPEC??join(process.env.SystemRoot,'System32/cmd.exe'),NODE_REPL_HISTORY:'',ROVAI_ALLOW_ISOLATED_INSTANCE:'1',ROVAI_DISABLE_AUTO_UPDATE_CHECKS:'1',ROVAI_HOST_BIN:join(app,'resources/bin/windows-x64/rovai-host.exe')})
 return {candidate:manifest.candidate,repositoryRoot,app,electron,dataRoot,skillLibraryRoot:join(dataRoot,'Core/managed-skill-library'),mcpConfigPath:join(dataRoot,'Core/mcp.json'),args:[app,`--user-data-dir=${dataRoot}`],env,manifest}
}

export async function preparePreviewHome(config){
 // Chromium会在Main之前触碰显式目录，须先由原生helper创建受保护布局。
 const prepared=JSON.parse(execFileSync(config.env.ROVAI_HOST_BIN,['--prepare-windows-data-root',config.dataRoot],{env:config.env,encoding:'utf8',windowsHide:true}))
 if(resolve(prepared.root)!==resolve(config.dataRoot)||resolve(prepared.core)!==resolve(config.dataRoot,'Core'))throw Error('开发预览原生目录准备结果不匹配。')
 for(const path of [config.env.HOME,config.env.APPDATA,config.env.LOCALAPPDATA,config.env.TEMP])await mkdir(path,{recursive:true})
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{
  const config=await previewConfiguration()
  if(process.argv.includes('--print-config'))console.log(JSON.stringify({candidate:config.candidate,app:config.app,dataRoot:config.dataRoot,skillLibraryRoot:config.skillLibraryRoot,mcpConfigPath:config.mcpConfigPath,channel:'isolated_development_preview'},null,2))
  else{
   await preparePreviewHome(config);console.log('正在启动 I03 开发预览。预览数据与日常应用分开保存。')
   const child=spawn(config.electron,config.args,{cwd:config.repositoryRoot,env:config.env,windowsHide:true,stdio:'inherit'})
   process.exitCode=await new Promise((resolveExit,reject)=>{child.once('error',reject);child.once('exit',code=>resolveExit(code??1))})
  }
 }catch(error){console.error('开发预览启动失败：'+String(error.message??error));process.exitCode=1}
}
