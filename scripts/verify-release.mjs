import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createRequire } from 'node:module'

const root=path.resolve('artifacts','release-check-'+Date.now())
await fs.mkdir(root,{recursive:true})
const bootstrap='release-fixture-bootstrap-password-32', password='release-fixture-admin-password', services=[], messages=[], checks=[]
let browser, balance=8.8
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7o0AAAAASUVORK5CYII='
const listen=server=>new Promise(r=>server.listen(0,'127.0.0.1',()=>r(server.address().port)))
const eventually=async(fn,label)=>{for(let i=0;i<100;i++){if(await fn())return;await delay(150)}throw new Error(label)}
const upstream=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json')
  if(req.url==='/api/status')return res.end(JSON.stringify({success:true,data:{quota_per_unit:500000,quota_display_type:'USD'}}))
  if(req.url==='/api/user/self')return res.end(JSON.stringify({success:true,data:{quota:balance*500000}}))
  if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'fixture-text'},{id:'gpt-image-2'}]}))
  if(req.url==='/v1/chat/completions')return res.end(JSON.stringify({choices:[{message:{content:'pong'}}]}))
  if(req.url==='/v1/images/generations')return res.end(JSON.stringify({data:[{b64_json:png}]}))
  res.statusCode=404;res.end('{}')
})
// A bounded SMTP fixture receives real Nodemailer deliveries without sending external mail.
const sockets=new Set()
const smtp=net.createServer(socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.setEncoding('utf8');socket.write('220 fixture ESMTP\r\n')
  let buffer='',dataMode=false,mail=[]
  socket.on('data',chunk=>{
    buffer+=chunk
    let end
    while((end=buffer.indexOf('\r\n'))>=0){
      const line=buffer.slice(0,end);buffer=buffer.slice(end+2)
      if(dataMode){if(line==='.') {messages.push(mail.join('\r\n'));dataMode=false;mail=[];socket.write('250 accepted\r\n')}else mail.push(line);continue}
      if(/^EHLO|^HELO/.test(line))socket.write('250-fixture\r\n250 AUTH PLAIN\r\n')
      else if(/^AUTH/.test(line))socket.write('235 authenticated\r\n')
      else if(line==='DATA'){dataMode=true;socket.write('354 end with dot\r\n')}
      else if(line==='QUIT')socket.end('221 bye\r\n')
      else socket.write('250 OK\r\n')
    }
  })
})
const upstreamPort=await listen(upstream),smtpPort=await listen(smtp)
async function start(name,mode){
  const probe=net.createServer(),port=await listen(probe);await new Promise(r=>probe.close(r))
  const dataDir=path.join(root,name),base=`http://127.0.0.1:${port}`
  await fs.mkdir(dataDir,{recursive:true})
  const env={...process.env,DATA_DIR:dataDir,RADAR_MODE:mode,HOST:'127.0.0.1',PORT:String(port),RADAR_ACCESS_TOKEN:bootstrap,RADAR_VAULT_KEY:'',RADAR_CODEX_HOME:path.join(root,'codex'),RADAR_USER_HOME:root,RADAR_CODEX_DEBUG_PORT:'0',RADAR_PUBLIC_URL:'',RADAR_ALLOWED_ORIGINS:''}
  const child=spawn(process.execPath,['server/index.mjs'],{env,stdio:'pipe',windowsHide:true})
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d)
  const entry={child,base,name,mode,dataDir,token:bootstrap,stop:async()=>{if(child.exitCode===null&&child.signalCode===null){const exit=new Promise(r=>child.once('exit',r));child.kill();await exit}await fs.writeFile(path.join(root,name+'.log'),output)}}
  services.push(entry)
  await eventually(async()=>{if(child.exitCode!==null)throw new Error(output);try{return(await fetch(base+'/api/health')).ok}catch{return false}},'Service startup')
  return entry
}
async function api(service,route,body,expected=200){
  const r=await fetch(service.base+route,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)})
  const d=await r.json();assert.equal(r.status,expected,`${route}: ${JSON.stringify(d)}`);return d
}
async function save(service,patch){const config=await api(service,'/api/config');return api(service,'/api/config',{...config,...patch})}
try{
  let server=await start('server','server'),local=await start('desktop','local')
  await api(server,'/api/auth/register',{username:'admin',password,setupCode:bootstrap},201)
  server.token=(await api(server,'/api/auth/login',{username:'admin',password})).token
  await api(server,'/api/sessions',undefined,409)
  const fixture={id:'fixture-a',name:'验收渠道',baseUrl:`http://127.0.0.1:${upstreamPort}`,preset:'newapi_profile',apiKey:'fixture-pat',textApiKey:'fixture-api-key',rememberSecret:true,userId:'1',autoProbeIntervalMinutes:.01,textTestModel:'fixture-text',wireApi:'chat',rechargePath:'/wallet'}
  await save(local,{accounts:[fixture]})
  await save(server,{email:{enabled:true,smtpHost:'127.0.0.1',smtpPort,smtpSsl:false,username:'fixture@example.test',password:'fixture-smtp',sender:'fixture@example.test',recipients:'receiver@example.test'}})
  await api(local,'/api/sync-client/connect',{url:server.base,username:'admin',password,serverMonitoring:true})
  assert.equal((await api(local,'/api/sync-client/run',{})).ok,true)
  assert.equal((await api(server,'/api/config')).accounts.length,1)
  assert.equal((await api(local,'/api/config')).accounts[0].syncManaged,true)
  checks.push('HTTP two-service registration and initial sync')
  await eventually(()=>messages.length===1,'No-browser first alert')
  balance=5.5;await eventually(()=>messages.length===2,'Second tier alert')
  balance=.5;await eventually(()=>messages.length===3,'Third tier alert')
  assert(messages.every(m=>m.includes('multipart/alternative')))
  checks.push('Autonomous server polling and three actual SMTP deliveries without browser')
  await eventually(async()=>(await api(local,'/api/monitor/status')).results['fixture-a']?.balanceNumber===.5,'Remote balances visible locally')
  assert.equal((await api(local,'/api/monitor/status')).results['fixture-a'].balanceNumber,.5)
  assert.equal((await api(server,'/api/models',{account:fixture})).models.length,2)
  assert.equal((await api(server,'/api/text-test',{account:fixture})).ok,true)
  const image=await api(server,'/api/image-test',{request:{account:fixture,model:'gpt-image-2',prompt:'fixture',size:'1024x1024'}})
  assert.equal(image.imageB64,png)
  checks.push('Model listing, text response and generated image payload')
  const before=await api(server,'/api/config')
  await save(server,{accounts:before.accounts.map(a=>({...a,name:'服务器改名'}))})
  await api(local,'/api/sync-client/run',{})
  assert.equal((await api(local,'/api/config')).accounts[0].name,'服务器改名')
  await save(local,{accounts:[{...(await api(local,'/api/config')).accounts[0],name:'本机冲突'}]})
  await save(server,{accounts:[{...(await api(server,'/api/config')).accounts[0],name:'服务器冲突'}]})
  assert.equal((await api(local,'/api/sync-client/run',{})).ok,false)
  assert.equal((await api(local,'/api/sync-client/run',{resolution:'server'})).ok,true)
  checks.push('Remote edits, conflict detection and explicit conflict resolution')
  const serverToken=server.token;await server.stop();server=await start('server','server');server.token=serverToken
  assert.equal((await api(server,'/api/config')).accounts.length,1)
  await delay(5500);assert.equal(messages.length,3)
  checks.push('Server restart retains login, channels and alert deduplication')
  await api(local,'/api/sync-client/disconnect',{})
  assert.equal((await api(local,'/api/config')).accounts[0].syncManaged,false)
  checks.push('Disconnect retains local channels and enables independent mode')
  const playwrightPath=process.env.RADAR_PLAYWRIGHT_MODULE
  if(playwrightPath){
    const require=createRequire(import.meta.url),{chromium}=require(playwrightPath)
    browser=await chromium.launch({headless:true,channel:'chrome'})
    const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[]
    page.on('pageerror',e=>errors.push(e.message))
    await page.goto(server.base)
    await page.getByLabel('用户名',{exact:true}).fill('admin');await page.getByLabel('密码',{exact:true}).fill(password)
    await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('heading',{name:'渠道列表',exact:true}).waitFor()
    assert.equal(await page.getByRole('button',{name:'会话管理',exact:false}).count(),0)
    await page.screenshot({path:path.join(root,'web-channels-desktop.png'),fullPage:true})
    await page.reload();await page.getByRole('heading',{name:'渠道列表',exact:true}).waitFor()
    await page.getByRole('button',{name:'设置',exact:false}).first().click()
    await page.getByRole('heading',{name:'账户密码',exact:true}).waitFor()
    await page.screenshot({path:path.join(root,'web-settings.png'),fullPage:true})
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(root,'web-mobile.png'),fullPage:true})
    await page.getByLabel('功能页',{exact:true}).selectOption('channels')
    await page.getByRole('heading',{name:'渠道列表',exact:true}).waitFor()
    await page.screenshot({path:path.join(root,'web-channels-mobile.png'),fullPage:true})
    assert(await page.locator('.balance-cell strong').first().isVisible())
    const balanceBox=await page.locator('.balance-cell strong').first().boundingBox()
    assert(balanceBox&&balanceBox.width>0&&balanceBox.x>=0&&balanceBox.x+balanceBox.width<=390)
    await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByRole('button',{name:'登录',exact:true}).waitFor()
    assert.deepEqual(errors,[])
    checks.push('Browser login, reload session, server-only navigation, settings, mobile render and logout')
    const signup=await start('signup','server')
    await page.goto(signup.base)
    await page.getByRole('button',{name:'注册并登录',exact:true}).waitFor()
    await page.screenshot({path:path.join(root,'web-register-mobile.png'),fullPage:true})
    await page.getByLabel('用户名',{exact:true}).fill('newadmin')
    await page.getByLabel('密码',{exact:true}).fill(password)
    await page.getByLabel('确认密码',{exact:true}).fill(password)
    await page.getByLabel('部署初始化码',{exact:true}).fill(bootstrap)
    await page.getByRole('button',{name:'注册并登录',exact:true}).click()
    await page.getByRole('heading',{name:'渠道列表',exact:true}).waitFor()
    assert.equal((await api(signup,'/api/auth/setup')).registrationOpen,false)
    checks.push('First administrator registration through mobile UI and registration closure')
    await context.close()
  }
  await fs.writeFile(path.join(root,'result.json'),JSON.stringify({ok:true,checks,smtpMessages:messages.length},null,2))
  console.log(JSON.stringify({ok:true,checks,root},null,2))
}finally{
  await browser?.close()
  for(const service of services)await service.stop()
  for(const socket of sockets)socket.destroy()
  await new Promise(r=>smtp.close(r));await new Promise(r=>upstream.close(r))
}
