// Integration audit of the installed official application in an isolated profile.
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { createEnhancer } from './enhancer.mjs'

const auditRoot = process.env.OFFICIAL_AUDIT_ROOT
if (!auditRoot || !path.basename(auditRoot).startsWith('radar-official-codex-')) throw Error('Set OFFICIAL_AUDIT_ROOT to the isolated test directory')
const port = Number(process.env.OFFICIAL_AUDIT_PORT || 9234)
process.env.RADAR_CODEX_DEBUG_PORT = String(port)
const output = path.resolve(process.env.OFFICIAL_AUDIT_OUTPUT || 'server/test-artifacts/official-codex-bridge-fixed')
await fs.mkdir(output, { recursive: true })
const sessionRoot = path.join(auditRoot, 'codex-home', 'sessions')
await fs.mkdir(sessionRoot, { recursive: true })
const liveConfig = await (await fetch('http://127.0.0.1:8789/api/config')).json()
const config = { accounts: [], codexTools: structuredClone(liveConfig.codexTools) }
await fs.writeFile(path.join(auditRoot, 'codex-home', 'config.toml'), 'model="fixture-audit-model"\nmodel_provider="openai"\n')
const requests = [], consoleErrors = []
let enhancer
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.end(); return }
  res.setHeader('Content-Type', 'application/json')
  if (req.url !== '/api/enhancer/bridge') { res.statusCode = 404; res.end('{}'); return }
  let text = ''; for await (const chunk of req) text += chunk
  try { const body = JSON.parse(text); const r = await enhancer.bridge(body.route, body.payload); requests.push({ route: body.route, status: r?.status ?? null, settingsValid: body.route === '/settings/get' ? ['launchMode', 'enhancementsEnabled', 'providerSyncEnabled'].some(k => k in r) : undefined }); res.end(JSON.stringify(r)) }
  catch (e) { requests.push({ error: e.message }); res.statusCode = 500; res.end(JSON.stringify({ error: e.message })) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const apiBase = 'http://127.0.0.1:' + server.address().port
enhancer = createEnhancer({ dataDir: path.join(auditRoot, 'radar'), sessionRoot, apiBase, loadConfig: async () => config, updateConfig: async fn => fn(config), writeConfig: async c => fs.writeFile(path.join(auditRoot, 'audit-config.json'), JSON.stringify(c)), listModels: async () => [] })
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find(t => t.type === 'page' && t.url === 'app://-/index.html')
if (!page) throw Error('Official app://-/index.html target absent')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let sequence = 0
const pending = new Map()
socket.onmessage = event => {
  const msg = JSON.parse(event.data)
  if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push({ type: 'exception', text: msg.params.exceptionDetails.text, description: msg.params.exceptionDetails.exception?.description?.slice(0, 500) })
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') consoleErrors.push({ type: 'log', text: msg.params.entry.text.slice(0, 500) })
  const p = pending.get(msg.id); if (p) { clearTimeout(p.timer); pending.delete(msg.id); msg.error ? p.reject(Error(msg.error.message)) : p.resolve(msg.result) }
}
function call(method, params = {}) { return new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out')) }, 10000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })) }) }
async function evaluate(expression) { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.text); return r.result.value }
const observation = `({title:document.title,url:location.href,loginVisible:/Sign in|登录|Log in/.test(document.body.innerText),marker:!!window.__UBR_CODEX_ENHANCER__,menuCount:document.querySelectorAll('#codex-plus-menu').length,backendIndicator:document.querySelector('[data-codex-backend-indicator]')?.dataset.status,threadRows:document.querySelectorAll('[data-app-action-sidebar-thread-id]').length,deleteButtons:document.querySelectorAll('.codex-delete-button').length,exportButtons:document.querySelectorAll('.codex-export-button').length,moveButtons:document.querySelectorAll('.codex-project-move-button').length,timelines:document.querySelectorAll('.codex-conversation-timeline').length,scanFailures:(window.__codexSessionDeleteScanFailures||[]).slice(0,4),patches:Object.fromEntries(Object.keys(window).filter(k=>k.startsWith('__codex')&&/Installed$/.test(k)).map(k=>[k,window[k]]))})`
const report = { at: new Date().toISOString(), target: { title: page.title, url: page.url, port }, apiBase, profile: auditRoot }
try {
  await call('Runtime.enable'); await call('Log.enable')
  report.before = await evaluate(observation)
  report.injection = await enhancer.apply({ launch: false })
  await new Promise(resolve => setTimeout(resolve, 3000))
  report.after = await evaluate(observation)
  report.pageBridgeProbe = await evaluate(`(async()=>{try{let r=await window.__codexSessionDeleteBridge('/settings/get',{});return {ok:true,settingsAcceptedByRenderer:typeof r.enhancementsEnabled==='boolean',mode:r.launchMode}}catch(e){return {ok:false,error:e.message}}})()`)
  report.roundTrip = await evaluate(`(async()=>{
    const bridge=window.__codexSessionDeleteBridge;
    const original=await bridge('/settings/get',{});
    try {
      const changed=await bridge('/settings/set',{enhancementsEnabled:false,codexAppSessionDelete:!original.codexAppSessionDelete});
      const read=await bridge('/settings/get',{});
      const [catalog,status]=await Promise.all([bridge('/codex-model-catalog',{}),bridge('/backend/status',{})]);
      return {masterSwitchSaved:changed.enhancementsEnabled===false&&read.enhancementsEnabled===false,featureSaved:read.codexAppSessionDelete===!original.codexAppSessionDelete,modelsAreStrings:catalog.models.every(m=>typeof m==='string'),currentModel:catalog.model,defaultModel:catalog.default_model,models:catalog.models,backendStatus:status.status};
    } finally { await bridge('/settings/set',original); }
  })()`)
  report.reapply = await enhancer.apply({ launch: false })
  report.reapplyHandshake = await evaluate("window.__codexSessionDeleteBridge('/backend/status',{}).then(r=>r.status)")
  report.concurrentReplies = await evaluate("Promise.all(Array.from({length:12},()=>window.__codexSessionDeleteBridge('/settings/get',{}))).then(rows=>rows.length===12&&rows.every(r=>typeof r.enhancementsEnabled==='boolean'))")
  await new Promise(resolve => setTimeout(resolve, 1000))
  report.after = await evaluate(observation)
  report.features = []
  for (const [feature, enabled] of Object.entries(config.codexTools.features)) {
    report.features.push({ feature, enabled, menuInjected: report.after.menuCount > 0, acceptance: !report.pageBridgeProbe.ok ? 'BLOCKED: browser bridge failure' : !report.pageBridgeProbe.settingsAcceptedByRenderer ? 'FAIL: renderer rejects backend settings' : 'UNVERIFIED' })
  }
  report.requests = requests
  report.errors = consoleErrors
  const screenshot = await call('Page.captureScreenshot', { format: 'png' })
  await fs.writeFile(path.join(output, 'official-after-injection.png'), Buffer.from(screenshot.data, 'base64'))
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ target: report.target, before: report.before, injected: report.injection.ok, after: report.after, bridge: report.pageBridgeProbe, roundTrip:report.roundTrip, reapply:report.reapplyHandshake, concurrentReplies:report.concurrentReplies, requests: requests.slice(0, 12), errors: consoleErrors.slice(0, 8), report: output }, null, 2))
} finally {
  enhancer.close()
  socket.close()
  server.closeAllConnections(); server.close()
}
