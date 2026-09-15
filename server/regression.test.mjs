import { radarFetch as fetch } from './test-client.mjs'
import { createVault } from './vault.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { normalizedThresholds, validAlertLevels, alertLevelForBalance } from '../src/alert-levels.ts'

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'balance-radar-test-'))
const sessionRoot = path.join(dataDir, 'codex-sessions')
process.env.CODEX_SESSIONS_DIR = sessionRoot
process.env.DATA_DIR = dataDir
process.env.LOCALAPPDATA = path.join(dataDir, 'localappdata')
// Failure-path coverage must never connect to a user's live Codex CDP page.
process.env.RADAR_CODEX_DEBUG_PORT = '0'
await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ accounts: [] }))
const { app, probeOne, quotaDisplayValue, buildResult } = await import('./index.mjs')
const testVault=await createVault(dataDir)
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
const close = (server) => new Promise((resolve) => server.close(resolve))

test('New API quota uses the upstream currency settings', () => {
  assert.deepEqual(quotaDisplayValue(12120000, { _newapi_status: { quota_per_unit: 500000, quota_display_type: 'CNY', usd_exchange_rate: 1 } }).slice(0, 2), [24.24, 'CNY eq.'])
  assert.equal(quotaDisplayValue(500000, { _newapi_status: { quota_per_unit: 500000, quota_display_type: 'CNY', usd_exchange_rate: 7.3 } })[0], 7.3)
})

test('independent levels, legacy defaults, exact boundaries and failures', () => {
  const global = { level1: 10, level2: 6, level3: 1 }
  const custom = { level1: 100, level2: 60, level3: 10 }
  assert.deepEqual(normalizedThresholds({ lowBalanceThreshold: 0, alertLevels: custom }, global), custom)
  assert.deepEqual(normalizedThresholds({ lowBalanceThreshold: 8 }, global), { level1: 8, level2: 6, level3: 1 })
  assert.equal(alertLevelForBalance(8, true, custom), 3)
  assert.equal(alertLevelForBalance(8, true, global), 1)
  assert.deepEqual([11, 10, 6, 1, 0, -1].map((v) => alertLevelForBalance(v, true, global)), [0, 1, 2, 3, 3, 3])
  assert.equal(alertLevelForBalance(0, false, global), 0)
  assert.equal(validAlertLevels({ level1: 5, level2: 6, level3: 1 }), false)
  assert.equal(validAlertLevels({ level1: 5, level2: 2, level3: 0 }), true)
  assert.equal(validAlertLevels({ level1: NaN, level2: 2, level3: 0 }), false)
})

test('fresh probes update; HTTP and business authentication failures clear balance', async () => {
  let quota = 24130000
  let expired = false
  const upstream = http.createServer((req, res) => {
    assert.match(req.headers['cache-control'], /no-cache/)
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/status') return res.end(JSON.stringify({ success: true, data: { quota_per_unit: 500000, quota_display_type: 'CNY', usd_exchange_rate: 1 } }))
    if (expired) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'Token expired' })) }
    res.end(JSON.stringify({ success: true, data: { quota } }))
  })
  const url = await listen(upstream)
  const account = { id: 'fixture', baseUrl: url, preset: 'newapi_profile', apiKey: 'fixture-pat', userId: '66' }
  try {
    assert.equal((await probeOne(account)).balanceNumber, 48.26)
    quota = 12120000
    const fresh = await probeOne(account)
    assert.equal(fresh.balanceNumber, 24.24)
    assert.ok(fresh.checkedAt)
    expired = true
    const denied = await probeOne(account)
    assert.equal(denied.ok, false)
    assert.equal(denied.balanceNumber, null)
    const business = buildResult(account, true, 48.26, 'CNY', 200, url, '', { success: false, message: 'Token expired', data: { quota: 24130000 } }, 1)
    assert.equal(business.ok, false)
    assert.equal(business.balanceDisplay, '')
    assert.equal(business.balanceNumber, null)
  } finally { await close(upstream) }
})

test('channel levels and credentials survive API save and service restart', async () => {
  let server = http.createServer(app)
  let base = await listen(server)
  const send = (body) => fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const levels = { level1: 30, level2: 15, level3: 2 }
  const accounts = [{ id: 'a', baseUrl: 'https://a.example', apiKey: 'fixture-pat', alertLevels: levels }, { id: 'b', baseUrl: 'https://b.example', lowBalanceThreshold: 7 }]
  try {
    assert.equal((await send({ accounts })).status, 200)
    await close(server)
    server = http.createServer(app)
    base = await listen(server)
    const response = await fetch(`${base}/api/config`)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const loaded = await response.json()
    assert.equal(loaded.accounts.length, 2)
    assert.deepEqual(loaded.accounts[0].alertLevels, levels)
    assert.equal(loaded.accounts[0].apiKey, 'fixture-pat')
    assert.equal(loaded.accounts[1].lowBalanceThreshold, 7)
    assert.equal(loaded.accounts[1].alertLevels, null)
    assert.equal((await send({ accounts: [{ ...accounts[0], alertLevels: { level1: 1, level2: 6, level3: 10 } }] })).status, 400)
    const after = await (await fetch(`${base}/api/config`)).json()
    assert.deepEqual(after.accounts, loaded.accounts)
  } finally { await close(server) }
})

test('Sub2API rotates RT once, persists before retry and resists stale config saves', async () => {
  let refreshCalls = 0
  let meCalls = 0
  let failBalance = false
  const upstream = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/v1/auth/refresh') {
      refreshCalls++
      let body = ''; for await (const chunk of req) body += chunk
      assert.equal(req.method, 'POST')
      assert.equal(JSON.parse(body).refresh_token, 'rt-first')
      assert.equal(req.headers.authorization, undefined)
      return res.end(JSON.stringify({ code: 0, data: { access_token: 'jwt-next', refresh_token: 'rt-next', expires_in: 900 } }))
    }
    meCalls++
    if (req.headers.authorization !== 'Bearer jwt-next') { res.statusCode = 401; return res.end(JSON.stringify({ message: 'Token expired' })) }
    if (failBalance) { res.statusCode = 500; return res.end(JSON.stringify({ message: 'temporary failure' })) }
    res.end(JSON.stringify({ code: 0, data: { balance: 42.25 } }))
  })
  const baseUrl = await listen(upstream)
  const server = http.createServer(app)
  const local = await listen(server)
  const initial = { id: 'refresh-channel', baseUrl, preset: 'sub2api_dashboard', apiKey: 'jwt-old', refreshToken: 'rt-first', autoRefresh: true, rememberSecret: true, authVersion: 0 }
  const save = (accounts) => fetch(`${local}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accounts }) })
  try {
    await save([initial])
    const results = await Promise.all([probeOne(initial), probeOne(initial)])
    assert.ok(results.every((r) => r.ok && r.balanceNumber === 42.25))
    assert.equal(refreshCalls, 1)
    assert.ok(meCalls >= 3)
    assert.ok(!results[0].rawSummary.includes('rt-next'))
    let disk = testVault.open(JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8')))
    assert.equal(disk.accounts.find((a) => a.id === initial.id).refreshToken, 'rt-next')
    assert.equal((await save([{ ...initial, name: 'Edited while refreshing' }])).status, 200)
    disk = testVault.open(JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8')))
    assert.equal(disk.accounts.find((a) => a.id === initial.id).apiKey, 'jwt-next')
    assert.equal(disk.accounts.find((a) => a.id === initial.id).name, 'Edited while refreshing')
    assert.equal((await save([{ ...initial, apiKey: 'manually-edited', authChanged: true }])).status, 409)
    const repeated = await probeOne(initial)
    assert.equal(repeated.ok, true)
    assert.equal(repeated.credentialUpdate.refreshToken, 'rt-next')
    assert.equal(refreshCalls, 1)
    failBalance = true
    const failed = await probeOne(initial)
    assert.equal(failed.balanceNumber, null)
    assert.equal(refreshCalls, 1)
    // A newly loaded module has no in-memory rotation cache; disk still has the current pair.
    const restarted = await import(`./index.mjs?restart=${Date.now()}`)
    failBalance = false
    assert.equal((await restarted.probeOne(initial)).balanceNumber, 42.25)
    assert.equal(refreshCalls, 1)
  } finally { await close(server); await close(upstream) }
})

test('Sub2API RT-only, proactive renewal, disabled refresh and invalid RT handling', async () => {
  let calls = 0
  let queries = 0
  const upstream = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/v1/auth/refresh') {
      calls++
      let body = ''; for await (const chunk of req) body += chunk
      const rt = JSON.parse(body).refresh_token
      if (rt === 'invalid-rt') { res.statusCode = 401; return res.end(JSON.stringify({ message: `expired ${rt}` })) }
      if (rt === 'malformed') return res.end(JSON.stringify({ code: 0, data: { access_token: 'partial' } }))
      return res.end(JSON.stringify({ code: 0, data: { access_token: 'valid-access', refresh_token: 'rotated-rt', expires_in: 900 } }))
    }
    queries++
    res.statusCode = req.headers.authorization === 'Bearer valid-access' ? 200 : 401
    res.end(JSON.stringify(res.statusCode === 200 ? { data: { balance: 10 } } : { message: 'Token expired' }))
  })
  const baseUrl = await listen(upstream)
  const base = { id: 'temporary', baseUrl, preset: 'sub2api_dashboard', rememberSecret: false, autoRefresh: true }
  try {
    const onlyRT = await probeOne({ ...base, apiKey: '', refreshToken: 'only-rt' })
    assert.equal(onlyRT.balanceNumber, 10)
    assert.equal(onlyRT.credentialUpdate.refreshToken, 'rotated-rt')
    assert.equal(queries, 1)
    const nearExpiry = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 20 })).toString('base64url')}.signature`
    assert.equal((await probeOne({ ...base, apiKey: nearExpiry, refreshToken: 'soon-rt' })).ok, true)
    assert.equal(queries, 2)
    const before = calls
    const disabled = await probeOne({ ...base, apiKey: 'expired', refreshToken: 'disabled-rt', autoRefresh: false })
    assert.equal(disabled.ok, false)
    assert.equal(calls, before)
    const invalid = await probeOne({ ...base, apiKey: '', refreshToken: 'invalid-rt' })
    assert.equal(invalid.ok, false)
    assert.match(invalid.message, /RT 已失效/)
    assert.ok(!JSON.stringify(invalid).includes('invalid-rt'))
    assert.equal((await probeOne({ ...base, apiKey: '', refreshToken: 'malformed' })).ok, false)
    const cfg = testVault.open(JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8')))
    assert.equal(cfg.accounts.some((a) => a.id === base.id), false)
  } finally { await close(upstream) }
})


test('group, monitoring, history, import preview and config inspect endpoints', async () => {
  const upstream = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/status') return res.end(JSON.stringify({ data: { quota_per_unit: 500000, quota_display_type: 'USD' } }))
    return res.end(JSON.stringify({ success: true, data: { quota: 1500000 } }))
  })
  const upstreamUrl = await listen(upstream)
  const server = http.createServer(app)
  const local = await listen(server)
  const account = { id: 'grouped', name: 'Grouped Channel', baseUrl: upstreamUrl, apiKey: 'fixture-pat', preset: 'newapi_profile', group: '生图', monitorEnabled: false, rememberSecret: true }
  try {
    const save = await fetch(local + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accounts: [account], theme: 'light', density: 'compact', balancePrecision: 3 }) })
    assert.equal(save.status, 200)
    const loaded = await (await fetch(local + '/api/config')).json()
    assert.equal(loaded.accounts[0].group, '生图')
    assert.equal(loaded.accounts[0].monitorEnabled, false)
    assert.equal(loaded.theme, 'light')
    assert.equal(loaded.density, 'compact')
    assert.equal(loaded.balancePrecision, 3)
    const probed = await (await fetch(local + '/api/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accounts: [account] }) })).json()
    assert.equal(probed[0].ok, true)
    const history = await (await fetch(local + '/api/probe-history')).json()
    assert.ok(history.items.length >= 1)
    assert.equal(history.items[0].account.group, '生图')
    assert.equal(history.items[0].issue.type, '正常')
    const inspect = await (await fetch(local + '/api/config-inspect')).json()
    assert.match(inspect.configJson, /Grouped Channel/)
    assert.doesNotMatch(inspect.configJson, /fixture-pat/)
    const preview = await (await fetch(local + '/api/import-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Sub2API https://sub.example.com model gpt-image-2' }) })).json()
    assert.equal(preview.count, 1)
    assert.equal(preview.accounts[0].group, 'Sub2API')
    await fetch(local + '/api/probe-history/clear', { method: 'POST' })
    assert.equal((await (await fetch(local + '/api/probe-history')).json()).items.length, 0)
  } finally { await close(server); await close(upstream) }
})

test('session delete endpoint backs up before delete and can restore', async () => {
  const server = http.createServer(app)
  const local = await listen(server)
  const relativePath = path.join('2026', '09', '13', 'fixture-session.jsonl')
  const sessionFile = path.join(sessionRoot, relativePath)
  await fs.mkdir(path.dirname(sessionFile), { recursive: true })
  await fs.writeFile(sessionFile, [
    JSON.stringify({ timestamp: '2026-09-13T01:00:00.000Z', role: 'user', content: '测试会话删除' }),
    JSON.stringify({ timestamp: '2026-09-13T01:01:00.000Z', role: 'assistant', content: 'ok' }),
    '',
  ].join('\n'), 'utf8')
  try {
    const scan = await (await fetch(local + '/api/sessions')).json()
    assert.equal(scan.scannedFiles, 1)
    assert.equal(scan.sessions[0].relativePath, relativePath)
    const deleted = await (await fetch(local + '/api/sessions/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ relativePath }) })).json()
    assert.equal(deleted.ok, true)
    assert.equal(deleted.deleted, 1)
    await assert.rejects(fs.stat(sessionFile))
    assert.ok((await fs.stat(deleted.backupFile)).isFile())
    const restored = await (await fetch(local + '/api/sessions/restore-deleted', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backupDir: deleted.backupDir }) })).json()
    assert.equal(restored.ok, true)
    assert.equal(restored.restored, 1)
    assert.ok((await fs.stat(sessionFile)).isFile())
  } finally { await close(server) }
})

test('Codex enhancer export writes runnable bundle and apply reports CDP failures without HTTP failure', async () => {
  const server = http.createServer(app)
  const local = await listen(server)
  const tools = { enhanceEnabled: true, features: { modelWhitelist: false, sessionDelete: true, markdownExport: true, scriptMarket: true, recommendedContent: true } }
  try {
    const exported = await (await fetch(local + '/api/codex-tools/export-enhancer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tools }) })).json()
    assert.equal(exported.ok, true)
    assert.ok((await fs.stat(exported.payloadFile)).isFile())
    assert.ok((await fs.stat(exported.injectorFile)).isFile())
    const payload = await fs.readFile(exported.payloadFile, 'utf8')
    assert.match(payload, /会话工具/)
    assert.match(payload, /\/api\/sessions\/delete/)
    assert.match(payload, /__UBR_CODEX_ENHANCER__/)
    const status = await (await fetch(local + '/api/codex-tools/status')).json()
    assert.equal(status.enhancerReady, true)
    assert.equal(status.enhancerFeatureStatus.sessionDelete, '待连接')
    const appliedResponse = await fetch(local + '/api/codex-tools/apply-enhancer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tools, launch: false }) })
    assert.equal(appliedResponse.status, 200)
    const applied = await appliedResponse.json()
    assert.equal(applied.ok, false)
    assert.match(applied.message, /CDP|可注入/)
    assert.equal(applied.state.ok, false)
    assert.ok(applied.state.lastError)
  } finally { await close(server) }
})

test.after(async () => { await fs.rm(dataDir, { recursive: true, force: true }) })
