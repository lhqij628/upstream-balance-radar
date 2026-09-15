// Read-only native RPC checks; UI interactions remain manual/Computer Use.
import fs from 'node:fs/promises'
import { discoverOfficialPage } from './cdp-bridge.mjs'
const f = JSON.parse(await fs.readFile('server/test-artifacts/official-sessions-20260913/fixtures.json', 'utf8'))
const { page } = await discoverOfficialPage(9234)
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let sequence = 0
const pending = new Map()
ws.onmessage = event => { const m = JSON.parse(event.data); const p = pending.get(m.id); if (p) { clearTimeout(p.timer); pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result) } }
async function evaluate(expression) {
  const id = ++sequence
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error('Timeout')) }, 20000)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}
async function rpc(method, params) {
  return evaluate(`new Promise((resolve,reject)=>{const id='radar-read-'+crypto.randomUUID();const timer=setTimeout(()=>{window.removeEventListener('message',on);reject(Error('Native RPC timeout'))},15000);function on(event){const d=event.data;if(d?.type!=='mcp-response')return;const m=d.message||d.response;if(m?.id!==id)return;clearTimeout(timer);window.removeEventListener('message',on);resolve(m)}window.addEventListener('message',on);window.electronBridge.sendMessageFromView({type:'mcp-request',hostId:'local',request:{id,method:${JSON.stringify(method)},params:${JSON.stringify(params)}}});})`)
}
try {
  const list = await rpc('thread/list', { limit: 20, modelProviders: null, sourceKinds: [], archived: false, useStateDbOnly: true })
  const read = await rpc('thread/read', { threadId: f.created[0].id, includeTurns: true })
  const metadata = await rpc('thread/read', { threadId: f.created[0].id, includeTurns: false })
  const turns = await rpc('thread/turns/list', { threadId: f.created[0].id, limit: 20, sortDirection: 'asc' })
  const report = { at: new Date().toISOString(), list: { error: list.error, ids: list.result?.data?.map(t => t.id) }, read: { error: read.error, turns: read.result?.thread?.turns?.length, items: read.result?.thread?.turns?.[0]?.items?.map(i => i.type) }, metadata: {error:metadata.error, historyMode:metadata.result?.thread?.historyMode}, paginated: {error:turns.error,turns:turns.result?.data?.length} }
  await fs.writeFile('server/test-artifacts/official-sessions-20260913/native-read.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { ws.close() }
