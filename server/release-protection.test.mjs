import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { radarFetch, testToken } from './test-client.mjs'
const root=await fs.mkdtemp(path.join(os.tmpdir(),'radar-protection-'))
Object.assign(process.env,{DATA_DIR:root,RADAR_USER_HOME:root,RADAR_CODEX_HOME:path.join(root,'codex'),RADAR_CODEX_DEBUG_PORT:'0',HOST:'127.0.0.1'})
const {app}=await import('./index.mjs')
const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`
const post=(body)=>radarFetch(base+'/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
test.after(()=>new Promise(r=>server.close(r)))
test('anonymous reads, writes and foreign-origin traffic are denied',async()=>{
  assert.equal((await fetch(base+'/api/config')).status,401)
  assert.equal((await fetch(base+'/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401)
  assert.equal((await radarFetch(base+'/api/config',{headers:{Origin:'https://untrusted.example'}})).status,403)
  assert.equal((await fetch(base+'/api/health')).status,200)
})
test('login issues expiring session, logout revokes it, invalid token fails',async()=>{
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:testToken})});assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/HttpOnly/)
  const d=await login.json();const headers={Authorization:`Bearer ${d.token}`};assert(d.expiresAt>Date.now())
  assert.equal((await fetch(base+'/api/config',{headers})).status,200)
  await fetch(base+'/api/auth/logout',{method:'POST',headers});assert.equal((await fetch(base+'/api/config',{headers})).status,401)
})
test('simultaneous first reads and competing clients preserve one config revision',async()=>{
  const reads=await Promise.all(Array.from({length:8},()=>radarFetch(base+'/api/config')))
  assert(reads.every(r=>r.status===200))
  const cfg=await reads[0].json()
  const writes=await Promise.all(['first','second'].map(name=>post({...cfg,accounts:[{id:'race',name,baseUrl:'https://fixture.example'}]})))
  assert.deepEqual(writes.map(r=>r.status).sort(),[200,409])
  const current=await (await radarFetch(base+'/api/config')).json()
  assert.equal(current.revision,cfg.revision+1)
  assert.equal(current.accounts.length,1)
})
test('channel saves do not overwrite separately saved local Codex settings',async()=>{
  const stale=await (await radarFetch(base+'/api/config')).json()
  const r=await radarFetch(base+'/api/codex-tools/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tools:{enhanceEnabled:false}})})
  assert.equal(r.status,200);assert.equal((await post(stale)).status,200)
  assert.equal((await (await radarFetch(base+'/api/config')).json()).codexTools.enhanceEnabled,false)
})
test('vault stores ciphertext, rejects stale writes and preserves deleted channel',async()=>{
  assert.equal((await post({accounts:[{id:'a',baseUrl:'https://a.example',apiKey:'fixture-private-a'},{id:'b',baseUrl:'https://b.example'}]})).status,200)
  const stale=await (await radarFetch(base+'/api/config')).json()
  const disk=await fs.readFile(path.join(root,'config.json'),'utf8');assert(!disk.includes('fixture-private-a'));assert.equal(JSON.parse(disk).radarEncrypted,1)
  assert.equal((await post({...stale,accounts:[stale.accounts[0]],allowAccountRemoval:true})).status,200)
  assert.equal((await post(stale)).status,409)
  assert.equal((await (await radarFetch(base+'/api/config')).json()).accounts.length,1)
  assert.equal((await post({accounts:[],alertLevels:{level1:1,level2:6,level3:10}})).status,400)
})
test('corrupt ciphertext fails closed rather than replacing channels',async()=>{
  const file=path.join(root,'config.json'),before=await fs.readFile(file,'utf8');const d=JSON.parse(before);d.tag=Buffer.alloc(16).toString('base64');await fs.writeFile(file,JSON.stringify(d))
  assert.equal((await radarFetch(base+'/api/config')).status,500);assert.equal((await fs.readFile(file,'utf8')),JSON.stringify(d));await fs.writeFile(file,before)
})
