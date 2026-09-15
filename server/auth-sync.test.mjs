import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import express from 'express'
import { createAdminAccount } from './admin-account.mjs'
import { createAccess } from './access.mjs'
import { mergeSync, syncSnapshot, validateServerUrl, createSyncClient } from './sync.mjs'
import { createVault } from './vault.mjs'
import { createMonitor } from './monitor.mjs'

const temporary = async t => { const dir=await fs.mkdtemp(path.join(os.tmpdir(),'radar-auth-sync-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir }
const account = (id='a', extra={}) => ({id,name:id,baseUrl:`https://${id}.example`,apiKey:'fixture-key',preset:'custom',rememberSecret:true,...extra})
const cfg = (accounts=[]) => ({revision:0,accounts,alertLevels:{level1:10,level2:6,level3:1},autoProbeIntervalMinutes:1,email:{enabled:false}})

test('admin registration serializes, hashes password, persists sessions and revokes them after password change', async t=>{
  const dir=await temporary(t), admin=await createAdminAccount(dir)
  const results=await Promise.allSettled([admin.register('admin','fixture-password-123'),admin.register('other','fixture-password-456')])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  await assert.rejects(admin.login('admin','wrong'),{status:401})
  const session=await admin.login('admin','fixture-password-123',true)
  assert(admin.authenticated(session.token))
  let disk=await fs.readFile(path.join(dir,'admin-account.json'),'utf8')
  assert(!disk.includes('fixture-password-123'));assert(!disk.includes(session.token))
  const restarted=await createAdminAccount(dir)
  assert(restarted.authenticated(session.token))
  await restarted.changePassword('fixture-password-123','fixture-new-password-123')
  assert(!restarted.authenticated(session.token))
  await assert.rejects(restarted.login('admin','fixture-password-123'),{status:401})
  const next=await restarted.login('admin','fixture-new-password-123')
  await restarted.logout(next.token)
  assert(!restarted.authenticated(next.token))
  disk=await fs.readFile(path.join(dir,'admin-account.json'),'utf8')
  assert(!disk.includes('fixture-new-password-123'))
})

test('server registration requires initialization code, closes registration and disables legacy access', async t=>{
  const dir=await temporary(t), access=await createAccess({dataDir:dir,host:'127.0.0.1',mode:'server',token:'fixture-bootstrap-password-32-chars'})
  const app=express();app.use(access.middleware);app.use(express.json());app.get('/api/auth/setup',access.setup);app.post('/api/auth/register',access.register);app.post('/api/auth/login',access.login);app.post('/api/auth/logout',access.logout);app.get('/api/auth/status',access.status);app.use((err,_req,res,_next)=>res.status(err.status||500).json({error:err.message}))
  const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)))
  const base=`http://127.0.0.1:${server.address().port}`
  const post=(route,body)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  assert.equal((await (await fetch(base+'/api/auth/setup')).json()).registrationOpen,true)
  assert.equal((await post('/api/auth/register',{username:'admin',password:'fixture-password-123',setupCode:'bad'})).status,403)
  assert.equal((await post('/api/auth/register',{username:'admin',password:'short',setupCode:'fixture-bootstrap-password-32-chars'})).status,400)
  assert.equal((await post('/api/auth/register',{username:'admin',password:'fixture-password-123',setupCode:'fixture-bootstrap-password-32-chars'})).status,201)
  assert.equal((await (await fetch(base+'/api/auth/setup')).json()).registrationOpen,false)
  assert.equal((await post('/api/auth/register',{})).status,409)
  assert.equal((await fetch(base+'/api/auth/status',{headers:{Authorization:'Bearer fixture-bootstrap-password-32-chars'}})).status,401)
  const logged=await post('/api/auth/login',{username:'admin',password:'fixture-password-123'});assert.equal(logged.status,200)
  assert.match(logged.headers.get('set-cookie'),/HttpOnly/)
  const session=await logged.json(),headers={Authorization:`Bearer ${session.token}`}
  assert.equal((await fetch(base+'/api/auth/status',{headers})).status,200)
  assert.equal((await fetch(base+'/api/auth/status',{headers:{...headers,Origin:'https://foreign.example'}})).status,403)
  await fetch(base+'/api/auth/logout',{method:'POST',headers})
  assert.equal((await fetch(base+'/api/auth/status',{headers})).status,401)
})

test('sync merges independent edits, deletions, conflicts, excludes local tools and does not expose secrets in conflict labels',()=>{
  const base=syncSnapshot(cfg([account()]))
  const local=structuredClone(base),remote=structuredClone(base)
  local.accounts[0].name='local name';remote.accounts[0].rechargePath='/topup'
  const merged=mergeSync(base,local,remote)
  assert.equal(merged.conflicts.length,0);assert.equal(merged.snapshot.accounts[0].name,'local name');assert.equal(merged.snapshot.accounts[0].rechargePath,'/topup')
  local.accounts[0].apiKey='secret-left';remote.accounts[0].apiKey='secret-right'
  const conflict=mergeSync(base,local,remote)
  assert(conflict.conflicts.length);assert(!JSON.stringify(conflict.conflicts).includes('secret-left'))
  assert.equal(mergeSync(base,local,remote,'server').snapshot.accounts[0].apiKey,'secret-right')
  assert.equal(mergeSync(base,{...base,accounts:[]},base).snapshot.accounts.length,0)
  assert(mergeSync(base,{...base,accounts:[]},remote).conflicts.length)
  const projected=syncSnapshot(cfg([account('a',{providerConfig:'private-provider',sourcePath:'private-path',lastAlertLevel:3,syncManaged:true})]))
  assert.equal(projected.accounts[0].providerConfig,undefined);assert.equal(projected.accounts[0].sourcePath,undefined);assert.equal(projected.accounts[0].lastAlertLevel,undefined);assert.equal(projected.email,undefined)
  assert.equal(mergeSync(null,syncSnapshot(cfg([account('a')])),syncSnapshot(cfg([account('b')]))).snapshot.accounts.length,2)
  for(const url of ['http://public.example','https://name:secret@example.com','https://example.com/path','file:///tmp'])assert.throws(()=>validateServerUrl(url))
  assert.equal(validateServerUrl('https://example.com/'),'https://example.com')
})

test('sync client encrypts session, survives restart, protects local revision and retains channels on disconnect',async t=>{
  const dir=await temporary(t),vault=await createVault(dir)
  let local=cfg([account('a')]),serverConfig=cfg([account('b')]),online=true
  const request=async(url,options)=>{
    if(!online)throw new Error('offline')
    const route=new URL(url).pathname,body=options.body?JSON.parse(options.body):null
    if(route==='/api/auth/login')return Response.json({token:'fixture-session-secret',username:'admin',mode:'server',expiresAt:Date.now()+100000})
    if(route==='/api/auth/logout')return Response.json({ok:true})
    assert.equal(options.headers.Authorization,'Bearer fixture-session-secret')
    if(route==='/api/sync/snapshot')return Response.json({revision:serverConfig.revision,snapshot:syncSnapshot(serverConfig)})
    if(route==='/api/sync/apply'){
      if(body.revision!==serverConfig.revision)return Response.json({error:'conflict'},{status:409})
      serverConfig={...serverConfig,...body.snapshot,revision:serverConfig.revision+1};return Response.json({ok:true,revision:serverConfig.revision,snapshot:syncSnapshot(serverConfig)})
    }
    throw new Error('Unexpected route')
  }
  const args={dataDir:dir,vault,loadConfig:async()=>local,applySnapshot:async(snapshot,revision,options)=>{assert.equal(local.revision,revision);local={...local,...snapshot,revision:revision+1,accounts:snapshot.accounts.map(a=>({...a,syncManaged:options.serverManaged}))}},request}
  let sync=createSyncClient(args)
  await sync.connect({url:'https://fixture.example',username:'admin',password:'fixture-password'})
  assert.equal((await sync.run({})).ok,true);assert.equal(local.accounts.length,2);assert(local.accounts.every(a=>a.syncManaged))
  assert.equal(serverConfig.accounts.length,2)
  assert(!(await fs.readFile(path.join(dir,'server-sync.json'),'utf8')).includes('fixture-session-secret'))
  sync=createSyncClient(args)
  local.accounts[0].name='new local';serverConfig.accounts[1].name='new server'
  await sync.run({})
  assert.equal(local.accounts[1].name,'new server');assert.equal(serverConfig.accounts[0].name,'new local')
  online=false
  await assert.rejects(sync.run({}),/本机数据已保留/);assert.equal(local.accounts.length,2)
  await sync.disconnect();assert.equal(local.accounts.length,2);assert(local.accounts.every(a=>!a.syncManaged));assert.equal((await sync.status()).connected,false)
})

test('server-managed channels never schedule local probes or duplicate email',async t=>{
  const dir=await temporary(t),current=cfg([account('a',{syncManaged:true,autoProbeIntervalMinutes:1})]);let now=1000,probes=0,mails=0
  current.email={enabled:true}
  const monitor=createMonitor({dataDir:dir,clock:()=>now,loadConfig:async()=>current,updateConfig:async f=>f(current),writeConfig:async()=>{},appendHistory:async()=>{},probe:async()=>{probes++;return {ok:true,balanceNumber:1}},sendEmail:async()=>{mails++}})
  await monitor.tick();now+=120000;await monitor.tick();assert.equal(probes,0)
  await monitor.run(current.accounts[0]);assert.equal(mails,0)
})
