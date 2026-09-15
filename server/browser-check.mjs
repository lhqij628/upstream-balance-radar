import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
let cfg = { accounts: ['a', 'b'].map((id) => ({ id, name: `Channel ${id}`, baseUrl: `https://${id}.example`, apiKey: 'fixture-pat', preset: 'newapi_profile', userId: '66', timeout: 3, lowBalanceThreshold: 0, autoProbeIntervalMinutes: 0, lastAlertLevel: 0 })), alertLevels: { level1: 10, level2: 6, level3: 1 }, email: { enabled: false, password: 'fixture-smtp-password' }, autoProbeIntervalMinutes: 0 }
let delayedResolve
let delayB = false
let failA = false
let failTransport = false
let requests = 0
let rotateRT = false
await page.route('**/api/**', async (route) => {
  const req = route.request()
  const endpoint = new URL(req.url()).pathname
  let result
  if (endpoint === '/api/health') result = { ok: true }
  else if (endpoint === '/api/config') {
    if (req.method() === 'POST') cfg = req.postDataJSON()
    result = req.method() === 'GET' ? cfg : { ok: true }
  } else if (endpoint === '/api/config-path') result = 'fixture/config.json'
  else if (endpoint === '/api/probe') {
    const account = req.postDataJSON().accounts[0]
    requests++
    if (account.id === 'b' && delayB) await new Promise((resolve) => { delayedResolve = resolve })
    if (account.id === 'a' && failTransport) return route.abort()
    const ok = !(account.id === 'a' && failA)
    result = [{ id: account.id, name: account.name, preset: account.preset, ok, status: ok ? '正常' : '失败', balanceNumber: ok ? 8 : null, balanceDisplay: ok ? '8' : '', unit: 'CNY', httpStatus: ok ? 200 : 401, endpoint: account.baseUrl + '/api/user/self', message: ok ? 'data.quota / 500000' : 'Token has expired', rawSummary: '', elapsedMs: 100, checkedAt: new Date().toISOString() }]
    if (rotateRT) result[0].credentialUpdate = { apiKey: 'next-jwt', refreshToken: 'next-rt', authVersion: 1, authUpdatedAt: new Date().toISOString() }
  } else if (endpoint === '/api/text-test') {
    const account = req.postDataJSON().account
    result = { id: account.id, ok: true, httpStatus: 200, endpoint: account.baseUrl + '/v1/chat/completions', model: account.textTestModel || 'gpt-4o-mini', message: '文本连接成功：pong', rawSummary: '{}', elapsedMs: 50, checkedAt: new Date().toISOString() }
  } else if (endpoint === '/api/connectivity') {
    const account = req.postDataJSON().account
    result = { id: account.id, ok: true, elapsedMs: 60, checkedAt: new Date().toISOString(), steps: ['Base URL', '状态接口', '余额接口', '模型接口'].map((name, index) => ({ name, url: account.baseUrl, httpStatus: index === 3 ? 401 : 200, ok: true, message: index === 3 ? '认证返回 401' : '可达', transport: index ? 'powershell' : 'node' })) }
  } else if (endpoint === '/api/sessions') {
    result = { rootDir: 'C:/Users/ZhuanZ/.codex/sessions', exists: true, totalFiles: 2, scannedFiles: 2, invalidFiles: 1, totalLines: 12, totalMessages: 8, elapsedMs: 12, sessions: [{ relativePath: '2026/09/test.jsonl', fileName: 'test.jsonl', size: 2048, updatedAt: new Date().toISOString(), title: '探测上游余额', preview: '修复余额雷达', model: 'gpt-6', lines: 10, invalidLines: 1, messages: 7, userMessages: 3, assistantMessages: 4 }] }
  } else if (endpoint === '/api/sessions/sync') {
    result = { ok: true, message: '已同步备份 2 个会话文件', backupDir: 'fixture/sync' }
  } else if (endpoint === '/api/sessions/repair') {
    result = { ok: true, message: '已修复 1 个文件，移除 1 行异常 JSONL', backupDir: 'fixture/repair' }
  } else if (endpoint === '/api/sessions/export') {
    result = { ok: true, message: '已导出 2 个 Markdown 会话', exportDir: 'fixture/export' }
  } else throw new Error(`Unexpected API call: ${endpoint}`)
  await route.fulfill({ json: result })
})
try {
  await page.goto(process.env.RADAR_URL || 'http://127.0.0.1:8787')
  const rowA = page.locator('tbody tr').filter({ hasText: 'https://a.example' })
  const rowB = page.locator('tbody tr').filter({ hasText: 'https://b.example' })
  await rowA.getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByRole('checkbox', { name: '本渠道独立三级低余额阈值' }).check()
  for (const [label, value] of [['一级', '30'], ['二级', '15'], ['三级', '9']]) await page.getByLabel(`${label}低余额阈值`, { exact: true }).fill(value)
  await page.screenshot({ path: 'server/test-artifacts/channel-thresholds-desktop.png' })
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.deepEqual(cfg.accounts[0].alertLevels, { level1: 30, level2: 15, level3: 9 })
  assert.equal(cfg.email.password, 'fixture-smtp-password')
  await page.reload()
  await rowA.getByText('预警线 30 / 15 / 9', { exact: false }).waitFor()
  delayB = true
  await page.getByRole('button', { name: '开始探测', exact: true }).click()
  await rowA.locator('.balance-cell strong').filter({ hasText: /^8$/ }).waitFor()
  assert.equal(await rowB.getByRole('button', { name: '探测中', exact: true }).count(), 1)
  await rowA.getByText('三级预警', { exact: true }).waitFor()
  delayedResolve()
  await rowB.getByText('一级预警', { exact: true }).waitFor()
  await page.getByRole('button', { name: '开始探测', exact: true }).waitFor()
  assert.equal(requests, 2)
  failA = true
  await rowA.getByRole('button', { name: '余额探测', exact: true }).click()
  await rowA.getByText('HTTP 401', { exact: true }).waitFor()
  assert.equal(await rowA.locator('.balance-cell strong').innerText(), 'HTTP 401')
  await page.screenshot({ path: 'server/test-artifacts/channel-results-desktop.png' })
  failTransport = true
  await rowA.getByRole('button', { name: '余额探测', exact: true }).click()
  await page.getByText('余额雷达服务离线', { exact: true }).waitFor()
  assert.equal(await rowA.getByText('HTTP 401', { exact: true }).count(), 0)
  await page.getByRole('button', { name: '重新连接服务', exact: true }).click()
  await page.getByText('余额雷达服务离线', { exact: true }).waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 390, height: 844 })
  await rowA.getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByLabel('三级低余额阈值', { exact: true }).scrollIntoViewIfNeeded()
  const boxes = await page.getByRole('dialog').locator('.alert-grid input').evaluateAll((inputs) => inputs.map((input) => ({ width: input.getBoundingClientRect().width, scroll: input.scrollWidth, client: input.clientWidth })))
  assert.ok(boxes.every((box) => box.width > 100 && box.scroll <= box.client))
  await page.screenshot({ path: 'server/test-artifacts/channel-thresholds-mobile.png' })
  cfg.accounts[0] = { ...cfg.accounts[0], apiKey: '', refreshToken: 'first-rt', preset: 'sub2api_dashboard', autoRefresh: true }
  failTransport = false
  failA = false
  rotateRT = true
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.reload()
  await rowA.getByRole('button', { name: '编辑', exact: true }).click()
  assert.equal(await page.getByLabel('Refresh Token (RT)', { exact: true }).inputValue(), 'first-rt')
  assert.equal(await page.getByLabel('Refresh Token (RT)', { exact: true }).getAttribute('type'), 'password')
  assert.equal(await page.getByRole('checkbox', { name: '自动续期 JWT / RT' }).isChecked(), true)
  await page.screenshot({ path: 'server/test-artifacts/refresh-token-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel('Refresh Token (RT)', { exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'server/test-artifacts/refresh-token-mobile.png' })
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await rowA.getByRole('button', { name: '余额探测', exact: true }).click()
  await rowA.getByText('三级预警', { exact: true }).waitFor()
  await rowA.getByRole('button', { name: '编辑', exact: true }).click()
  assert.equal(await page.getByLabel('Refresh Token (RT)', { exact: true }).inputValue(), 'next-rt')
  assert.equal(await page.getByLabel('API Key / Profile Token', { exact: true }).inputValue(), 'next-jwt')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(cfg.accounts[0].refreshToken, 'next-rt')
  assert.equal(cfg.accounts[0].authVersion, 1)
  await page.reload()
  await rowA.getByRole('button', { name: '编辑', exact: true }).click()
  assert.equal(await page.getByLabel('Refresh Token (RT)', { exact: true }).inputValue(), 'next-rt')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await rowA.getByRole('button', { name: '文本测试', exact: true }).click()
  await rowA.getByText('文本OK', { exact: false }).waitFor()
  await rowA.getByRole('button', { name: '诊断', exact: true }).click()
  await rowA.getByText('诊断4/4', { exact: false }).waitFor()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: /会话管理/ }).click()
  await page.getByText('最近会话', { exact: true }).waitFor()
  await page.getByText('探测上游余额', { exact: true }).waitFor()
  await page.getByRole('button', { name: '对话同步', exact: true }).click()
  await page.getByText('已同步备份 2 个会话文件', { exact: true }).waitFor()
  await page.getByRole('button', { name: '导出 Markdown', exact: true }).click()
  await page.getByText('已导出 2 个 Markdown 会话', { exact: true }).waitFor()
  await page.getByRole('button', { name: '对话修复', exact: true }).click()
  await page.getByText('已修复 1 个文件，移除 1 行异常 JSONL', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
  console.log('PASS: channel thresholds, reload, SMTP credential retention, independent refresh, text test, connectivity diagnostics, recharge fields, session management, per-channel alert levels, authentication failure, transport failure, desktop/mobile layout')
} finally { await browser.close() }

