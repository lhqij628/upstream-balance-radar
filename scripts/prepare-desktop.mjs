import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'), out=path.join(root,'src-tauri/resources')
await fs.mkdir(out,{recursive:true})
await fs.cp(path.join(root,'server'),path.join(out,'server'),{recursive:true,filter:async p=>{const stat=await fs.lstat(p),name=path.basename(p);return !(stat.isDirectory()&&/^data($|-)|^test-artifacts$/.test(name))&&!/test|acceptance|audit/.test(name)}})
const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'))
await fs.writeFile(path.join(out,'package.json'),JSON.stringify({name:'balance-radar-desktop-service',version:pkg.version,type:'module',private:true,overrides:pkg.pnpm?.overrides,dependencies:Object.fromEntries(Object.entries(pkg.dependencies).filter(([k])=>!k.startsWith('@tauri')&&!k.startsWith('react')))},null,2))
execFileSync(process.platform==='win32'?'npm.cmd':'npm',['install','--omit=dev','--ignore-scripts','--registry=https://registry.npmjs.org'],{cwd:out,stdio:'inherit',shell:process.platform==='win32'})
await fs.copyFile(process.execPath,path.join(out,'node.exe'))
const smokeRoot=await fs.mkdtemp(path.join(os.tmpdir(),'radar-package-smoke-'))
execFileSync(path.join(out,'node.exe'),['--input-type=module','-e',"await import('./server/index.mjs');console.log('Packaged backend module imports passed')"],{cwd:out,stdio:'inherit',windowsHide:true,env:{...process.env,DATA_DIR:smokeRoot,RADAR_USER_HOME:smokeRoot,RADAR_CODEX_HOME:path.join(smokeRoot,'codex'),HOST:'127.0.0.1',RADAR_MODE:'local',RADAR_VAULT_KEY:'',RADAR_ACCESS_TOKEN:''}})
console.log('Desktop backend prepared without user data: '+out)
