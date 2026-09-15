// Acceptance audit. All mutations are confined to a fresh temporary fixture home.
// Does not operate on the user's Codex home or install plugins.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createEnhancer } from './enhancer.mjs'
import { scanSessions, repairSessions, syncSessions } from './sessions.mjs'

const output = path.resolve(process.env.FEATURE_AUDIT_OUTPUT || 'server/test-artifacts/session-plugin-acceptance')
await fs.mkdir(output, { recursive: true })
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'radar-feature-acceptance-'))
const sessionRoot = path.join(root, 'fixture-home', 'sessions')
const dataDir = path.join(root, 'radar')
const backupDir = path.join(dataDir, 'session-backups')
await fs.mkdir(sessionRoot, { recursive: true })
const dbFile = path.join(root, 'fixture-home', 'state_5.sqlite')
const db = new DatabaseSync(dbFile)
db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY, cwd TEXT, model_provider TEXT, title TEXT, archived INTEGER, rollout_path TEXT);
CREATE TABLE thread_dynamic_tools(thread_id TEXT, name TEXT);
CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT);`)
const indexFile = path.join(root, 'fixture-home', 'session_index.jsonl')
await fs.writeFile(indexFile, '')
await fs.writeFile(path.join(root, 'fixture-home', 'config.toml'), 'model="gpt-6-astra"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Audit provider"\n')
const features = ['pluginMarket','forcePluginEntry','forcePluginInstall','modelWhitelist','fastButton','sessionDelete','markdownExport','sessionProjectMove','conversationTimeline','centeredWidth','rememberThreadPosition','zedRemoteOpen','scriptMarket','recommendedContent','installMaintenance']
const config = { accounts: [], codexTools: { enhanceEnabled: true, mode: 'full', features: Object.fromEntries(features.map(k => [k, true])) } }
const launchedUrls = []
const options = { dataDir, sessionRoot, apiBase: 'http://127.0.0.1:1', loadConfig: async () => config, updateConfig: async fn => fn(config), writeConfig: async c => fs.writeFile(path.join(root, 'config.json'), JSON.stringify(c)), listModels: async () => [], openExternal: async url => { launchedUrls.push(url); return { launchAdapter: 'captured-test-boundary' } } }
const enhancer = createEnhancer(options)
const report = { at: new Date().toISOString(), root, target: 'official Codex 26.908.4834.0', boundary: 'Synthetic sessions and local SQLite; real official renderer transport when available. No logged-in workspace UI acceptance.', checks: [], artifacts: {} }
async function check(id, name, fn, layer = 'integration') {
  try { const detail = await fn(); report.checks.push({ id, name, layer, result: 'PASS', detail: detail ?? null }) }
  catch (error) { report.checks.push({ id, name, layer, result: 'FAIL', detail: error.message }) }
}
let socket, seq = 0, callBridge = (route, payload) => enhancer.bridge(route, payload)
const pending = new Map(), errors = []
function rpc(method, params = {}) { return new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timeout')) }, 10000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })) }) }
async function evaluate(expression) { const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }
const renderer = await fs.readFile(new URL('./vendor/codex-plus-plus/renderer-inject.js', import.meta.url), 'utf8')
const old = new Date(Date.now() - 60000)
async function fixture({ archived = false, title = 'Fixture conversation', recent = false, corrupt = false } = {}) {
  const id = randomUUID(), dir = archived ? path.join(root, 'fixture-home', 'archived_sessions') : sessionRoot
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `rollout-2026-09-13-${id}.jsonl`), cwd = path.join(root, 'project-a')
  const rows = [
    { timestamp: '2026-09-13T01:00:00.000Z', type: 'session_meta', payload: { id, cwd, model_provider: 'fixture', title } },
    { timestamp: '2026-09-13T01:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'First line\nSecond line 中文' }] } },
    { timestamp: '2026-09-13T01:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '```js\nconst n = 1;\n```\nAnswer' }] } },
  ]
  const text = rows.map(x => JSON.stringify(x)).join('\n') + '\n' + (corrupt ? '{invalid\n' : '')
  await fs.writeFile(file, text)
  if (!recent) await fs.utimes(file, old, old)
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run(id, cwd, 'fixture', title, Number(archived), file)
  db.prepare('INSERT INTO thread_dynamic_tools VALUES(?,?)').run(id, 'fixture-tool')
  await fs.appendFile(indexFile, JSON.stringify({ id, thread_name: title, updated_at: '2026-09-13T01:00:02.000Z' }) + '\n')
  return { id, file, text, cwd, title }
}
const thread = id => db.prepare('SELECT * FROM threads WHERE id=?').get(id)
const exists = async file => !!(await fs.stat(file).catch(() => null))
try {
  try {
    const pages = await (await fetch('http://127.0.0.1:9234/json/list', { signal: AbortSignal.timeout(2000) })).json()
    const page = pages.find(p => p.type === 'page' && p.url === 'app://-/index.html')
    if (!page) throw Error('Official target absent')
    process.env.RADAR_CODEX_DEBUG_PORT = '9234'
    socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    socket.onmessage = e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); const p = pending.get(m.id); if (p) { clearTimeout(p.timer); pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result) } }
    await rpc('Runtime.enable')
    const applied = await enhancer.apply({ launch: false })
    assert.equal(applied.ok, true, applied.message)
    callBridge = (route, payload = {}) => evaluate(`window.__codexSessionDeleteBridge(${JSON.stringify(route)},${JSON.stringify(payload)})`)
    report.transport = { mode: 'official-renderer CDP binding', port: 9234, url: page.url }
  } catch (e) { report.transport = { mode: 'direct-backend only', reason: e.message } }

  await check('B01', 'Bridge settings round trip', async () => { const s = await callBridge('/settings/get'); assert.equal(s.launchMode, 'patch'); assert.equal(s.enhancementsEnabled, true) })
  const active = await fixture(), archived = await fixture({ archived: true, title: 'Unique archived fixture' })
  await check('S01', 'Scan active and archived sessions with message counts', async () => { const s = await scanSessions(sessionRoot); assert.equal(s.sessions.length, 2); assert(s.sessions.every(x => x.messages === 2)); assert(s.sessions.some(x => x.id === archived.id)) })
  await check('S02', 'Markdown preserves roles, multiline content and code fences', async () => { const r = await callBridge('/export-markdown', { session_id: active.id }); assert.equal(r.status, 'exported'); assert(r.filename.endsWith('.md')); assert(r.markdown.includes('First line\nSecond line 中文')); assert(r.markdown.includes('```js\nconst n = 1;\n```')); assert(r.markdown.includes('## Assistant')); await fs.writeFile(path.join(output, 'exported-fixture.md'), r.markdown) })
  await check('S03', 'Markdown preserves per-message timestamps', async () => { const r = await callBridge('/export-markdown', { session_id: active.id }); assert(r.markdown.includes('2026-09-13T01:00:01'), 'Message timestamp absent from Markdown') })
  await check('S04', 'Archived row title resolves to session ID', async () => { const r = await callBridge('/archived-thread', { title: archived.title }); assert.equal(r.session_id, archived.id, JSON.stringify(r)) })
  const moved = await fixture({ title: 'Move fixture' }), target = path.join(root, 'project-b')
  await fs.mkdir(target)
  let moveResult
  await check('S05', 'Move updates rollout and SQLite workspace', async () => { moveResult = await callBridge('/move-thread-workspace', { session_id: moved.id, target_cwd: target }); assert.equal(JSON.parse((await fs.readFile(moved.file, 'utf8')).split('\n')[0]).payload.cwd, target); assert.equal(thread(moved.id).cwd, target) })
  await check('S06', 'Move response matches official injected consumer', async () => { assert(renderer.includes('result.status !== "moved"')); assert.equal(moveResult.status, 'moved', JSON.stringify(moveResult)) }, 'consumer-contract')
  const busy = await fixture({ recent: true })
  await check('S07', 'Recent session move preserves file and reports failure', async () => { const r = await callBridge('/move-thread-workspace', { session_id: busy.id, target_cwd: target }); assert.equal(await fs.readFile(busy.file, 'utf8'), busy.text); assert.equal(r.status, 'failed', JSON.stringify(r)) })
  await check('S08', 'Thread sort key and bulk key match', async () => { const a = await callBridge('/thread-sort-key', { session_id: active.id }); const b = await callBridge('/thread-sort-keys', { sessions: [{ session_id: active.id }] }); assert.equal(a.updated_at, b.sort_keys[0].updated_at); assert(a.updated_at > 0) })
  let deletion
  await check('S09', 'Delete removes rollout, thread and thread_id children; creates undo backup', async () => { deletion = await callBridge('/delete', { session_id: active.id }); assert.equal(deletion.status, 'local_deleted'); assert.equal(await exists(active.file), false); assert.equal(thread(active.id), undefined); assert.equal(db.prepare('SELECT count(*) AS n FROM thread_dynamic_tools WHERE thread_id=?').get(active.id).n, 0); assert.equal(await fs.readFile(path.join(deletion.undo_token, 'session.jsonl'), 'utf8'), active.text) })
  await check('S10', 'Delete removes session index reference', async () => { const rows = (await fs.readFile(indexFile, 'utf8')).trim().split('\n').map(JSON.parse); assert.equal(rows.some(x => x.id === active.id), false, 'session_index.jsonl still contains deleted ID') })
  await check('S11', 'Undo restores exact rollout and SQLite records', async () => { const r = await callBridge('/undo', { undo_token: deletion.undo_token }); assert.equal(r.status, 'undone'); assert.equal(await fs.readFile(active.file, 'utf8'), active.text); assert.equal(thread(active.id).cwd, active.cwd); assert.equal(db.prepare('SELECT count(*) AS n FROM thread_dynamic_tools WHERE thread_id=?').get(active.id).n, 1) })
  await check('S12', 'Repeated undo protects existing session', async () => { await assert.rejects(() => callBridge('/undo', { undo_token: deletion.undo_token })); assert.equal(await fs.readFile(active.file, 'utf8'), active.text) })
  const parent = await fixture(), child = await fixture()
  db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run(parent.id, child.id)
  await check('S13', 'Delete cleans parent/child thread relation', async () => { await callBridge('/delete', { session_id: parent.id }); assert.equal(db.prepare('SELECT count(*) AS n FROM thread_spawn_edges WHERE parent_thread_id=?').get(parent.id).n, 0, 'Orphan parent_thread_id remains') })
  await check('S14', 'Unknown session reports failure', async () => { const r = await callBridge('/delete', { session_id: randomUUID() }); assert.equal(r.status, 'failed') })
  await check('S15', 'Undo rejects outside backup directory', async () => { await assert.rejects(() => callBridge('/undo', { undo_token: path.join(root, 'outside') }), /路径越界/) })
  const sync = await fixture()
  await check('S16', 'Provider sync persists rollout and database', async () => { const r = await syncSessions(sessionRoot, backupDir, { ids: [sync.id], provider: 'new-fixture' }); assert.equal(r.ok, true); assert.equal(thread(sync.id).model_provider, 'new-fixture'); assert.equal(JSON.parse((await fs.readFile(sync.file, 'utf8')).split('\n')[0]).payload.model_provider, 'new-fixture') })
  const broken = await fixture({ corrupt: true })
  await check('S17', 'Repair removes malformed line and preserves valid messages with backup', async () => { const r = await repairSessions(sessionRoot, backupDir); assert.equal(r.repaired, 1); assert.equal(r.removedLines, 1); const now = await fs.readFile(broken.file, 'utf8'); assert.equal(now, broken.text.replace('{invalid\n', '')); assert.equal(await fs.readFile(path.join(r.backupDir, 'files', path.basename(broken.file)), 'utf8'), broken.text) })
  const recentBroken = await fixture({ recent: true, corrupt: true })
  await check('S18', 'Repair accurately reports skipped active file', async () => { const r = await repairSessions(sessionRoot, backupDir); assert.equal(await fs.readFile(recentBroken.file, 'utf8'), recentBroken.text); assert.equal(r.removedLines, 0, JSON.stringify(r)); assert.equal(r.ok, false) })
  await check('P01', 'Plugin feature settings persist in full and compatible modes', async () => { for (const mode of ['relay', 'patch']) { const r = await callBridge('/settings/set', { launchMode: mode, codexAppPluginMarketplaceUnlock: true, codexAppPluginEntryUnlock: true, codexAppForcePluginInstall: true }); assert.equal(r.launchMode, mode); assert.equal(r.codexAppForcePluginInstall, true) } }, 'settings-only')
  await check('P02', 'Current Codex version supplied for plugin compatibility strategy', async () => { const r = await callBridge('/settings/get'); assert.equal(typeof r.codexAppVersion, 'string', 'codexAppVersion absent; strategy is unknown') }, 'consumer-contract')
  const scriptsFile = path.join(dataDir, 'codex-enhancer', 'user-scripts.json')
  await fs.mkdir(path.dirname(scriptsFile), { recursive: true })
  await fs.writeFile(scriptsFile, JSON.stringify({ enabled: true, scripts: [{ key: 'fixture-script', name: 'Acceptance fixture', enabled: true, source: 'user', status: 'not_loaded', code: 'window.__radarAcceptanceScriptRan=true;' }] }))
  await check('U01', 'Script global and per-item toggles persist', async () => { await callBridge('/user-scripts/set-enabled', { enabled: false }); await callBridge('/user-scripts/set-script-enabled', { key: 'fixture-script', enabled: false }); const other = createEnhancer(options); try { const r = await other.bridge('/user-scripts/list'); assert.equal(r.enabled, false); assert.equal(r.scripts[0].enabled, false) } finally { other.close() } })
  await check('U02', 'Script reload loads and executes enabled script', async () => { await callBridge('/user-scripts/set-enabled', { enabled: true }); await callBridge('/user-scripts/set-script-enabled', { key: 'fixture-script', enabled: true }); const r = await callBridge('/user-scripts/reload'); const marker = report.transport.mode.startsWith('official') ? await evaluate('window.__radarAcceptanceScriptRan===true') : false; assert.equal(marker, true, 'reloaded=' + r.reloaded + '; status=' + r.scripts[0].status + '; execution marker=' + marker) })
  await check('U03', 'Script delete persists removal', async () => { await callBridge('/user-scripts/delete', { key: 'fixture-script' }); assert.equal((await callBridge('/user-scripts/list')).scripts.length, 0) })
  await check('Z01', 'Zed remote status includes installation detection', async () => { const r = await callBridge('/zed-remote/status'); assert.equal(r.status, 'ok'); assert.equal(typeof r.zedCliFound, 'boolean'); return { installed: r.zedCliFound, message: r.message } })
  for (const [id, name, route] of [['M01','Open manager','/manager/open'],['M02','Open developer tools','/devtools/open']]) await check(id, name, async () => { const r = await callBridge(route, {}); assert.equal(r.status, 'ok', r.message); assert(launchedUrls.includes(r.url)); if (id === 'M01') assert.equal(r.url, options.apiBase); else assert(new URL(r.url).searchParams.get('ws')?.startsWith('127.0.0.1:9234/')); return 'OS launch boundary captured; not a browser UI assertion' }, 'launcher-contract')
  await check('A01', 'Recommended content matches renderer ads schema', async () => { const r = await callBridge('/ads'); assert(Array.isArray(r.ads), 'Expected ads array; received ' + JSON.stringify(r)) }, 'consumer-contract')
  await check('C01', 'Model catalog uses current configured model and string IDs', async () => { await enhancer.models(); const r = await callBridge('/codex-model-catalog'); assert.equal(r.model, 'gpt-6-astra'); assert(r.models.includes('gpt-6-astra')); assert(r.models.every(x => typeof x === 'string')); assert.equal(r.responses_api.status, 'unknown') })
  report.staticEvidence = { fastSupportedModels: renderer.match(/codexServiceTierSupportedFastModels = new Set\(([^\n]+)\)/)?.[1], scriptFeatureMappedInRenderer: /scriptMarket:|userScripts: "codexAppUserScripts"/.test(renderer), recommendedFeatureMappedInRenderer: /recommendedContent: "codexAppRecommendedContent"/.test(renderer), installMaintenanceFeatureMappedInRenderer: /installMaintenance: "codexAppInstallMaintenance"/.test(renderer) }

  if (report.transport.mode.startsWith('official')) {
    await enhancer.apply({ launch: false })
    await new Promise(r => setTimeout(r, 1200))
    report.official = await evaluate(`({url:location.href,title:document.title,loginVisible:/Sign in|登录|Log in/.test(document.body.innerText),threadRows:document.querySelectorAll('[data-app-action-sidebar-thread-id]').length,menuCount:document.querySelectorAll('#codex-plus-menu').length,backendIndicator:document.querySelector('[data-codex-backend-indicator]')?.dataset.status,scriptMarker:window.__radarAcceptanceScriptRan===true,assets:[...document.scripts].map(x=>x.src).concat([...document.querySelectorAll('link[href]')].map(x=>x.href),performance.getEntriesByType('resource').map(x=>x.name)).filter(x=>/app-server-manager-signals-|setting-storage-/.test(x)),patchState:Object.fromEntries(Object.keys(window).filter(k=>k.startsWith('__codex')&&/Installed$|StrategyLogged$/.test(k)).map(k=>[k,window[k]]))})`)
    await check('P03', 'Current official native dispatcher and setting protocol work without legacy module names', async () => {
      const r = await evaluate('(async()=>{const a=window.__radarOfficialAdapter;await a?.ready;return {capabilities:a?.capabilities,version:a?.version,hooked:window.__radarOfficialRequestHooks===true,setting:await a.hostCall("get-setting",{params:{key:"default-service-tier"}})}})()')
      assert.equal(r.capabilities.dispatcher, true); assert.equal(r.capabilities.hostSettings, true); assert.equal(r.hooked, true); assert(r.version); assert.equal(typeof r.setting, 'object'); return r
    }, 'official-runtime-integration')
    await check('B02', 'Repair refreshes the connected renderer and script status', async () => {
      const r = await callBridge('/backend/repair')
      assert.equal(r.status, 'ok'); assert(Array.isArray(r.scripts))
    }, 'official-runtime-integration')
    await check('B03', 'Official renderer reload reconnects automatically', async () => {
      await rpc('Page.reload')
      const deadline = Date.now() + 15000
      let connected = false
      while (Date.now() < deadline) {
        try { connected = await evaluate('typeof window.__codexSessionDeleteBridge === "function" && window.__radarOfficialRequestHooks === true'); if (connected) break } catch {}
        await new Promise(r => setTimeout(r, 250))
      }
      assert.equal(connected, true, 'Automatic reconnect did not restore the current official document')
      const s = await callBridge('/settings/get'); assert.equal(typeof s.enhancementsEnabled, 'boolean'); assert(s.codexAppVersion)
      assert.equal((await enhancer.status()).injectorAlive, true)
    }, 'official-runtime-integration')
    const shot = await rpc('Page.captureScreenshot', { format: 'png' })
    await fs.writeFile(path.join(output, 'official-renderer.png'), Buffer.from(shot.data, 'base64'))
    report.artifacts.screenshot = 'official-renderer.png'
    report.errors = errors.slice(0, 15)
  }
  for (const [id, name] of [['UI01','Official sidebar delete/undo and refresh'],['UI02','Official Markdown download'],['UI03','Official project move and navigation'],['UI04','Plugin marketplace list and install/use/uninstall'],['UI05','Plugin entry and install buttons'],['UI06','Timeline navigation'],['UI07','Centered conversation width'],['UI08','Remember thread scroll position'],['UI09','Model selection and real Responses request'],['UI10','Fast service tier selection']]) report.checks.push({ id, name, layer: 'logged-in-official-ui', result: 'UNVERIFIED', detail: 'Isolated official renderer is at login; no real workspace conversation/plugin UI. Backend fixtures do not prove this UI effect.' })
} finally {
  enhancer.close(); socket?.close(); for (const p of pending.values()) clearTimeout(p.timer); db.close()
  report.counts = Object.fromEntries(['PASS','FAIL','UNVERIFIED'].map(x => [x, report.checks.filter(c => c.result === x).length]))
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2))
  const md = ['# 会话与插件逐项验收', '', `时间：${report.at}`, `目标：${report.target}`, `传输：${report.transport?.mode}`, '', '仅使用临时会话和 SQLite。官方独立实例停留在登录页；通过项限定于所标注层级，未声明登录后的页面操作通过。', '', '| 编号 | 功能 | 层级 | 结果 | 证据 |', '|---|---|---|---|---|', ...report.checks.map(c => `| ${c.id} | ${c.name} | ${c.layer} | ${c.result} | ${String(c.detail ?? 'Assertions passed').replaceAll('|',' / ').replaceAll('\n',' ').slice(0,1500)} |`), '', '完整请求结果、临时样本目录、官方页面状态见 results.json；截图见 official-renderer.png。', '', '复跑：在隔离官方实例开放 9234 后，于 E:\\upstream-balance-tauri 执行 node server/feature-acceptance.mjs。没有官方实例时仅测试后端，并明确标注传输降级。']
  await fs.writeFile(path.join(output, '验收明细.md'), md.join('\n'))
  console.log(JSON.stringify({ counts: report.counts, transport: report.transport, checks: report.checks.map(({id,name,result,detail}) => ({id,name,result,detail})), official: report.official, output }, null, 2))
}
process.exitCode = report.checks.some(x => x.result === 'FAIL') ? 1 : 0
