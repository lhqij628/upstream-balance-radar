import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {createMonitor} from './monitor.mjs'
test('editing a probe type or credential invalidates the previous displayed balance',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'radar-identity-'))
  const cfg={accounts:[{id:'a',baseUrl:'https://fixture.example',preset:'sub2api_billing',apiKey:'key-a',rememberSecret:true}],email:{enabled:false}}
  const args={dataDir,loadConfig:async()=>cfg,updateConfig:async f=>f(cfg),writeConfig:async()=>{},probe:async a=>({id:a.id,ok:true,balanceNumber:1.5,unit:'倍率'}),appendHistory:async()=>{},sendEmail:async()=>{throw new Error('must not send')}}
  const monitor=createMonitor(args)
  await monitor.run({...cfg.accounts[0]});assert.equal((await monitor.status()).results.a.balanceNumber,1.5)
  cfg.accounts[0].preset='newapi_profile';assert.equal((await monitor.status()).results.a,undefined)
  await monitor.run({...cfg.accounts[0]});assert((await monitor.status()).results.a)
  cfg.accounts[0].apiKey='key-b';assert.equal((await monitor.status()).results.a,undefined)
  assert.equal((await createMonitor(args).status()).results.a,undefined)
})
