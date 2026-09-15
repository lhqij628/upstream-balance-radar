import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createMonitor } from './monitor.mjs'
import { validateEmail, emailFailureMessage } from './email-errors.mjs'
import { radarFetch } from './test-client.mjs'

const email = { enabled: true, smtpHost: 'smtp.example.com', username: 'sender@example.com', sender: 'sender@example.com', recipients: 'receiver@example.com', password: '', cooldownMinutes: 60 }

test('missing SMTP secret remains retryable; successful alert stays deduplicated across restart', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'radar-email-monitor-'))
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }))
  const account = { id: 'channel', name: 'Fixture', baseUrl: 'https://fixture.example', rechargePath: '/console/topup', rememberSecret: true }
  const cfg = { accounts: [account], alertLevels: { level1: 10, level2: 6, level3: 1 }, email: { ...email } }
  const sent = []
  let balance = 8.79
  const args = { dataDir, loadConfig: async () => cfg, updateConfig: async f => f(cfg), writeConfig: async () => {}, appendHistory: async () => {}, clock: () => 10000000,
    probe: async () => ({ id: account.id, ok: true, balanceNumber: balance, unit: 'credits' }),
    sendEmail: async (config, subject, body) => { validateEmail(config); sent.push({ subject, body }) } }
  let monitor = createMonitor(args)
  await monitor.run(account)
  assert.match((await monitor.status()).lastError, /缺少 SMTP 授权码/)
  assert.equal((await monitor.status()).alerts.channel, undefined)
  assert.equal(sent.length, 0)
  cfg.email.password = 'fixture-secret'
  await monitor.run(account)
  assert.equal(sent.length, 1)
  assert.equal((await monitor.status()).lastError, '')
  assert.equal(account.lastAlertLevel, 1)
  assert.match(sent[0].body, /渠道名称：Fixture/)
  assert.match(sent[0].body, /渠道 URL：https:\/\/fixture.example/)
  assert.match(sent[0].body, /当前余额：8.79 credits/)
  assert.match(sent[0].body, /触发阈值：1 级，余额 ≤ 10 credits/)
  assert.match(sent[0].body, /快速充值：https:\/\/fixture.example\/console\/topup/)
  monitor = createMonitor(args)
  await monitor.run(account)
  assert.equal(sent.length, 1)
  balance = 5
  await monitor.run(account)
  assert.equal(sent.length, 2)
  assert.equal(account.lastAlertLevel, 2)
})

test('each tier sends once regardless of elapsed time; recharge above level one rearms', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'radar-alert-tiers-'))
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }))
  const account = { id: 'channel', baseUrl: 'https://fixture.example', rememberSecret: true }
  const cfg = { accounts: [account], alertLevels: { level1: 10, level2: 6, level3: 1 }, email: { enabled: true, cooldownMinutes: 60 } }
  let now = 10000000, balance = 11, ok = true
  const sent = []
  const args = { dataDir, loadConfig: async () => cfg, updateConfig: async f => f(cfg), writeConfig: async () => {}, appendHistory: async () => {}, clock: () => now,
    probe: async () => ({ id: account.id, ok, balanceNumber: balance, unit: 'credits' }),
    sendEmail: async (_config, subject, body) => sent.push({ subject, body }) }
  let monitor = createMonitor(args)
  const check = async (value, count) => { balance = value; await monitor.run(account); assert.equal(sent.length, count) }
  await check(11, 0)
  await check(10, 1)
  now += 61 * 60000
  await check(8.8, 1)
  now += 24 * 60 * 60000
  monitor = createMonitor(args)
  await check(8.8, 1)
  cfg.email.cooldownMinutes = 0
  await check(7, 1)
  await check(6, 2)
  await check(1, 3)
  await check(8.8, 3)
  ok = false
  await check(20, 3)
  ok = true
  await check(1, 3)
  await check(10, 3)
  await check(10.01, 3)
  assert.equal(account.lastAlertLevel, 0)
  monitor = createMonitor(args)
  await check(8.8, 4)
  await check(0.5, 5)
  assert.match(sent[4].body, /触发阈值：3 级，余额 ≤ 1 credits/)
  await check(0, 5)
})

test('channel-specific tiers override global tiers and remain independent', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'radar-alert-channels-'))
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }))
  const first = { id: 'a', baseUrl: 'https://a.example', alertLevels: { level1: 5, level2: 3, level3: 1 } }
  const second = { id: 'b', baseUrl: 'https://b.example' }
  const cfg = { accounts: [first, second], alertLevels: { level1: 10, level2: 6, level3: 1 }, email: { enabled: true } }
  let balance = 8.8
  const sent = []
  const monitor = createMonitor({ dataDir, loadConfig: async () => cfg, updateConfig: async f => f(cfg), writeConfig: async () => {}, appendHistory: async () => {},
    probe: async a => ({ id: a.id, ok: true, balanceNumber: balance }),
    sendEmail: async (_config, _subject, body) => sent.push(body) })
  await monitor.run(first)
  assert.equal(sent.length, 0)
  await monitor.run(second)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /余额 ≤ 10/)
  balance = 5
  await monitor.run(first)
  await monitor.run(second)
  assert.equal(sent.length, 3)
  assert.match(sent[1], /1 级，余额 ≤ 5/)
  assert.match(sent[2], /2 级，余额 ≤ 6/)
})

test('SMTP diagnostics never echo upstream credentials or response text', () => {
  for (const code of ['EAUTH', 'ETIMEDOUT', 'ESOCKET', 'EENVELOPE', 'UNKNOWN']) {
    const message = emailFailureMessage({ code, message: 'fixture-private-secret', response: 'fixture-private-secret' })
    assert(!message.includes('fixture-private-secret'))
    assert(message.length > 0)
  }
})

test('email API rejects missing secret; saved secret survives blank-password config updates and encrypted storage', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'radar-email-api-'))
  Object.assign(process.env, { DATA_DIR: root, RADAR_USER_HOME: root, RADAR_CODEX_HOME: path.join(root, 'codex'), HOST: '127.0.0.1', RADAR_MODE: 'local' })
  const { app } = await import('./index.mjs')
  const server = http.createServer(app)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  t.after(async () => { await new Promise(r => server.close(r)); await fs.rm(root, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (route, body) => radarFetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const invalid = await post('/api/email/send', { config: email })
  assert.equal(invalid.status, 400)
  assert.match((await invalid.json()).error, /缺少 SMTP 授权码/)
  const cfg = await (await radarFetch(base + '/api/config')).json()
  assert.equal((await post('/api/config', { ...cfg, email: { ...email, enabled: false, password: 'fixture-smtp-secret' } })).status, 200)
  const saved = await (await radarFetch(base + '/api/config')).json()
  assert.equal(saved.email.password, 'fixture-smtp-secret')
  assert.equal((await post('/api/config', { ...saved, email: { ...saved.email, password: '' } })).status, 200)
  assert.equal((await (await radarFetch(base + '/api/config')).json()).email.password, 'fixture-smtp-secret')
  const disk = await fs.readFile(path.join(root, 'config.json'), 'utf8')
  assert.equal(JSON.parse(disk).radarEncrypted, 1)
  assert(!disk.includes('fixture-smtp-secret'))
})
