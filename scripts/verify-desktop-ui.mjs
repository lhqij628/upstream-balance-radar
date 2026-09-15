import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require=createRequire(import.meta.url)
const {chromium}=require(process.env.RADAR_PLAYWRIGHT_MODULE)
const port=Number(process.env.RADAR_TEST_CDP_PORT || 9334)
const out=path.resolve('artifacts','desktop-ui-'+Date.now())
await fs.mkdir(out,{recursive:true})
const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
try {
  const pages=browser.contexts().flatMap(c=>c.pages())
  const page=pages.find(p=>p.url().includes('tauri.localhost') || p.url().startsWith('tauri:'))
  assert(page,'Radar WebView page not found')
  const errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.getByRole('heading',{name:'渠道列表',exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'连接并登录',exact:true}).count(),0)
  await page.screenshot({path:path.join(out,'desktop-channels.png')})
  const original=await page.evaluate(()=>localStorage.getItem('radar-server-url'))
  try {
    await page.evaluate(()=>localStorage.setItem('radar-server-url','https://unavailable.example.invalid'))
    await page.reload()
    await page.getByRole('heading',{name:'渠道列表',exact:true}).waitFor()
  } finally {
    await page.evaluate(value=>{if(value===null)localStorage.removeItem('radar-server-url');else localStorage.setItem('radar-server-url',value)},original)
  }
  await page.getByRole('button',{name:'服务器同步',exact:true}).click()
  await page.getByRole('heading',{name:'服务器同步',exact:true}).waitFor()
  await page.getByRole('heading',{name:'服务器同步',exact:true}).scrollIntoViewIfNeeded()
  await page.screenshot({path:path.join(out,'desktop-sync.png')})
  assert(await page.getByRole('button',{name:'连接服务器',exact:true}).isVisible())
  assert.equal(await page.getByRole('button',{name:'退出登录',exact:true}).count(),0)
  assert.deepEqual(errors,[])
  console.log(JSON.stringify({ok:true,out,checks:['Native desktop opens local channels without server login','Stale server preference does not block offline startup','Optional server sync settings visible','No renderer errors']},null,2))
} finally { await browser.close() }
