import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import {spawn} from 'node:child_process'
import {setTimeout as delay} from 'node:timers/promises'
const root=await fs.mkdtemp(path.join(os.tmpdir(),'radar-server-mode-'))
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r))
const base=`http://127.0.0.1:${port}`,token='server-fixture-access-password-32-chars'
const env={...process.env,DATA_DIR:root,HOST:'127.0.0.1',PORT:String(port),RADAR_MODE:'server',RADAR_ACCESS_TOKEN:token,RADAR_USER_HOME:root,RADAR_CODEX_HOME:path.join(root,'codex'),RADAR_VAULT_KEY:''}
let child
async function start(){child=spawn(process.execPath,['server/index.mjs'],{env,stdio:'pipe',windowsHide:true});let errors='';child.stderr.on('data',b=>errors+=b);for(let i=0;i<50;i++){if(child.exitCode!==null)throw new Error(errors);try{if((await fetch(base+'/api/health')).ok)return}catch{}await delay(100)}throw new Error('Fixture start timeout: '+errors)}
async function stop(){if(!child||child.exitCode!==null)return;const closed=new Promise(r=>child.once('exit',r));child.kill();await closed}
const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'}
const get=route=>fetch(base+route,{headers})
test.after(stop)
test('server mode isolates local tools, survives restart, and locks its data directory',async()=>{
  await start()
  assert.equal((await (await fetch(base+'/api/health')).json()).mode,'server')
  assert.equal((await fetch(base+'/api/config')).status,401)
  for(const route of ['/api/sessions','/api/providers/status','/api/codex-tools/status','/api/import-sources'])assert.equal((await get(route)).status,409,route)
  const cfg=await (await get('/api/config')).json()
  const saved=await fetch(base+'/api/config',{method:'POST',headers,body:JSON.stringify({...cfg,accounts:[{id:'server-a',baseUrl:'https://fixture.example',apiKey:'server-private-fixture',alertLevels:{level1:10,level2:6,level3:1}}]})})
  assert.equal(saved.status,200)
  const duplicate=spawn(process.execPath,['server/index.mjs'],{env:{...env,PORT:String(port+1)},stdio:'pipe',windowsHide:true})
  let duplicateError='';duplicate.stderr.on('data',b=>duplicateError+=b)
  const exit=await new Promise(r=>duplicate.on('exit',r));assert.notEqual(exit,0);assert.match(duplicateError,/数据目录|lock|运行/)
  await stop();await start()
  const restored=await (await get('/api/config')).json()
  assert.equal(restored.accounts[0].apiKey,'server-private-fixture');assert.equal(restored.accounts[0].alertLevels.level2,6)
  assert.equal(restored.revision,cfg.revision+1)
  const disk=await fs.readFile(path.join(root,'config.json'),'utf8');assert(!disk.includes('server-private-fixture'))
})
