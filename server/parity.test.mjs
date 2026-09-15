import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { scanSources } from './import-sources.mjs'
import { runUsageScript } from './usage-script.mjs'
import { scanSessions, syncSessions, deleteSession, restoreDeletedSession, exportSessions, sessionMarkdown } from './sessions.mjs'
import { createMonitor } from './monitor.mjs'
import { switchProvider } from './providers.mjs'
import { parse } from 'smol-toml'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'radar-parity-'))
const write = async (p, v) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, typeof v === 'string' ? v : JSON.stringify(v)) }

test('all import adapters preserve separate credentials, scripts and stable unique IDs', async () => {
  const home = path.join(root, 'imports'); await fs.mkdir(path.join(home, '.cc-switch'), { recursive: true }); await fs.mkdir(path.join(home, '.codexx'), { recursive: true })
  const cc = new DatabaseSync(path.join(home, '.cc-switch/cc-switch.db'))
  cc.exec('CREATE TABLE providers(id TEXT, name TEXT, app_type TEXT, settings_config TEXT, meta TEXT, website_url TEXT)')
  const config = 'model="m"\nmodel_provider="custom"\n[model_providers.custom]\nbase_url="https://channel.example/v1"\nwire_api="responses"'
  cc.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?)').run('1','channel','codex',JSON.stringify({config,auth:{OPENAI_API_KEY:'one'}}),JSON.stringify({usage_script:{enabled:true,code:'({request:{url:"{{baseUrl}}/balance"},extractor:r=>({remaining:r.balance})})',accessToken:'pat'}}),'/topup')
  cc.close()
  const x = new DatabaseSync(path.join(home, '.codexx/codexx.db'));x.exec('CREATE TABLE providers(id TEXT,provider_name TEXT,base_url TEXT,api_key TEXT,model TEXT,wire_api TEXT,toml_config TEXT)')
  x.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?)').run('2','channel2','https://channel.example/v1','two','m','responses',config);x.close()
  await write(path.join(home,'.codex-session-delete/settings.json'),{relayProfiles:[{id:'pp',name:'pp',upstreamBaseUrl:'https://pp.example',officialMixApiKey:'pp-key',testModel:'m',configContents:config}]})
  const r = await scanSources({home}); assert.equal(r.accounts.length,3);assert.equal(new Set(r.accounts.map(a=>a.id)).size,3)
  assert.equal(r.accounts.find(a=>a.source==='CC Switch').usageScript.accessToken,'pat');assert.equal(r.accounts.find(a=>a.source==='Codex++').apiKey,'pp-key')
})
test('CC Switch scripts execute and infinite loops terminate', async () => {
  const a={baseUrl:'https://fixture.example',apiKey:'key',usageScript:{enabled:true,code:'({request:{url:"{{baseUrl}}/balance",headers:{Authorization:"Bearer {{apiKey}}"}},extractor:r=>({remaining:r.balance,unit:"USD"})})'}}
  let url, auth
  const r=await runUsageScript(a,async (u,o)=>{url=u;auth=o.headers.Authorization;return new Response(JSON.stringify({balance:7}))})
  assert.equal(url,'https://fixture.example/balance');assert.equal(auth,'Bearer key');assert.equal(r.plans[0].remaining,7)
  await assert.rejects(()=>runUsageScript({...a,usageScript:{enabled:true,code:'(()=>{while(true){} })()'}}))
})
test('305 sessions, archived data, formatting, database sync and delete/restore', async () => {
  const home=path.join(root,'sessions-test'), sessions=path.join(home,'sessions'), backup=path.join(home,'backups')
  await write(path.join(home,'config.toml'),'model_provider="new"')
  for(let i=0;i<305;i++) {
    const file=path.join(i===304?path.join(home,'archived_sessions'):sessions,`${i}.jsonl`)
    await write(file,[{type:'session_meta',payload:{id:String(i),cwd:'C:/real-project',model_provider:'old'}},{type:'response_item',payload:{role:'assistant',content:[{type:'output_text',text:'```js\nlet x = 1\n```'}]}}].map(JSON.stringify).join('\n')+'\n'); await fs.utimes(file,new Date(0),new Date(0))
  }
  const db=new DatabaseSync(path.join(home,'state_5.sqlite'));db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, model_provider TEXT, cwd TEXT);CREATE TABLE thread_items(thread_id TEXT, text TEXT)');db.prepare('INSERT INTO threads VALUES(?,?,?)').run('0','old','C:/real-project');db.prepare('INSERT INTO thread_items VALUES(?,?)').run('0','item');db.close()
  const scan=await scanSessions(sessions);assert.equal(scan.sessions.length,305);assert.equal(scan.sessions[0].cwd,'C:/real-project')
  assert.match(await sessionMarkdown(sessions,'0.jsonl'),/```js\nlet x = 1\n```/)
  const synced=await syncSessions(sessions,backup);assert.equal(synced.repaired,305);assert.equal(synced.sqliteRows,1)
  assert.equal((await exportSessions(sessions,path.join(home,'export'))).exported,305)
  const deleted=await deleteSession(sessions,backup,'0.jsonl');const check=new DatabaseSync(path.join(home,'state_5.sqlite'));assert.equal(check.prepare('SELECT count(*) n FROM threads').get().n,0);check.close()
  await restoreDeletedSession(sessions,backup,deleted.backupDir);const restored=new DatabaseSync(path.join(home,'state_5.sqlite'));assert.equal(restored.prepare('SELECT count(*) n FROM threads').get().n,1);assert.equal(restored.prepare('SELECT count(*) n FROM thread_items').get().n,1);restored.close()
})
test('background scheduling and per-channel escalation work with no browser', async () => {
  let now=1000, mailed=0, balance=9, probed=0
  let cfg={accounts:[{id:'a',baseUrl:'https://fixture.example',name:'A',rememberSecret:true,monitorEnabled:true,autoProbeIntervalMinutes:1}],alertLevels:{level1:10,level2:6,level3:1},email:{enabled:true,cooldownMinutes:60}}
  const monitor=createMonitor({dataDir:path.join(root,'monitor'),clock:()=>now,loadConfig:async()=>cfg,updateConfig:async fn=>fn(cfg),writeConfig:async c=>{cfg=c},probe:async a=>{probed++;return {id:a.id,ok:true,balanceNumber:balance}},appendHistory:async()=>{},sendEmail:async()=>{mailed++}})
  await monitor.tick();now+=61000;await monitor.tick();assert.equal(probed,1);assert.equal(mailed,1)
  now+=61000;await monitor.tick();assert.equal(mailed,1)
  balance=5;now+=61000;await monitor.tick();assert.equal(mailed,2)
  balance=0;now+=61000;await monitor.tick();assert.equal(mailed,3)
})
test('provider switch preserves existing unrelated config and official auth', async () => {
  const home=path.join(root,'provider-home');process.env.RADAR_CODEX_HOME=home
  await write(path.join(home,'config.toml'),'model="old"\n[projects."C:/work"]\ntrust_level="trusted"\n[mcp_servers.example]\nurl="https://mcp.example"')
  await write(path.join(home,'auth.json'),{tokens:{access_token:'fixture-official'}})
  await switchProvider({id:'p',baseUrl:'https://api.example/v1',textApiKey:'key',textTestModel:'m',wireApi:'responses'},root)
  const d=parse(await fs.readFile(path.join(home,'config.toml'),'utf8'));assert.equal(d.projects['C:/work'].trust_level,'trusted');assert.equal(d.mcp_servers.example.url,'https://mcp.example');assert.equal(d.model_providers[d.model_provider].experimental_bearer_token,'key')
  assert.equal(JSON.parse(await fs.readFile(path.join(home,'auth.json'),'utf8')).tokens.access_token,'fixture-official')
  delete process.env.RADAR_CODEX_HOME
})
