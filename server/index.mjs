import express from 'express'
import { createAccess } from './access.mjs'
import { createVault } from './vault.mjs'
import { lockDataDirectory } from './data-lock.mjs'
import { createEnhancer } from './enhancer.mjs'
import { createMonitor } from './monitor.mjs'
import { createSyncClient, syncSnapshot } from './sync.mjs'
import { validateEmail, emailFailureMessage } from './email-errors.mjs'
import { emailHtml } from './email-content.mjs'
import { scanSources, channelIdentity, importId } from './import-sources.mjs'
import { providerStatus, switchProvider } from './providers.mjs'
import { runUsageScript } from './usage-script.mjs'
import nodemailer from 'nodemailer'
import fs from 'node:fs/promises'
import fssync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { refreshSub2api, tokenNeedsRefresh } from './sub2api-refresh.mjs'
import { powershellRequest } from './powershell-http.mjs'
import { scanSessions, syncSessions, repairSessions, exportSessions, deleteSession, restoreDeletedSession, sessionMarkdown } from './sessions.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const serviceMode = process.env.RADAR_MODE === 'server' ? 'server' : 'local'
const defaultDataDir = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'BalanceRadar', 'data') : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'balance-radar')
const dataDir = path.resolve(process.env.DATA_DIR || defaultDataDir)
const configFile = path.join(dataDir, 'config.json')
const historyFile = path.join(dataDir, 'probe-history.json')
const port = Number(process.env.PORT || 8789)
const host = process.env.HOST || '127.0.0.1'
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
const unlockData = isMain ? await lockDataDirectory(dataDir) : async()=>{}
const access = await createAccess({ dataDir, host, mode: serviceMode })
const vault = await createVault(dataDir)
const USER_AGENT_VALUE = 'upstream-balance-radar-web/1.0'
const DEFAULT_QUOTA_PER_UNIT = 500000
const BODY_LIMIT = process.env.BODY_LIMIT || '4mb'
const sessionRoot = path.resolve(process.env.CODEX_SESSIONS_DIR || path.join(process.env.RADAR_CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'))
const sessionBackupDir = path.join(dataDir, 'session-backups')
const execFileAsync = promisify(execFile)

function defaultEmail() {
  return { enabled: false, smtpHost: '', smtpPort: 465, smtpSsl: true, username: '', password: '', sender: '', recipients: '', cooldownMinutes: 60, lastAlertAt: 0 }
}
function defaultAlertLevels() { return { level1: 10, level2: 6, level3: 1 } }
function defaultCodexTools() {
  return {
    enhanceEnabled: true,
    mode: 'compatible',
    features: { pluginMarket: true, forcePluginEntry: true, forcePluginInstall: true, modelWhitelist: true, fastButton: false, sessionDelete: true, markdownExport: true, sessionProjectMove: true, conversationTimeline: true, centeredWidth: false, rememberThreadPosition: true, zedRemoteOpen: true, scriptMarket: true, recommendedContent: true, installMaintenance: true },
  }
}
function normalizeCodexTools(input = {}) {
  const base = defaultCodexTools()
  const mode = input.mode === 'full' ? 'full' : 'compatible'
  return {
    ...base,
    ...input,
    enhanceEnabled: input.enhanceEnabled !== false,
    mode,
    features: { ...base.features, ...(input.features || {}) },
  }
}


const codexPlusManagerPath = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Codex++', 'codex-plus-plus-manager.exe') : ''

async function codexToolsStatus() { return enhancer.status() }
async function discoverCodexModels() { return enhancer.models() }
async function exportCodexEnhancerPackage(input) { return enhancer.generate(input) }
async function applyCodexEnhancements(input) { return enhancer.apply(input) }
function emptyConfig() { return { accounts: [], email: defaultEmail(), threshold: 5, alertLevels: defaultAlertLevels(), autoProbeIntervalMinutes: 0, theme: 'dark', density: 'comfortable', balancePrecision: 6, codexTools: defaultCodexTools() } }

function normalizeBaseUrl(value = '') {
  let raw = String(value || '').trim()
  const markdownOpen = raw.indexOf('](')
  if (markdownOpen >= 0) {
    const innerStart = markdownOpen + 2
    const close = raw.indexOf(')', innerStart)
    if (close >= 0) raw = raw.slice(innerStart, close)
  } else {
    const startHttp = raw.indexOf('https://') >= 0 ? raw.indexOf('https://') : raw.indexOf('http://')
    if (startHttp >= 0) raw = raw.slice(startHttp)
  }
  let cut = raw.length
  for (const sep of ['，', ',', ' ', '\t', '\r', '\n']) {
    const idx = raw.indexOf(sep)
    if (idx >= 0 && idx < cut) cut = idx
  }
  return raw.slice(0, cut).trim().replace(/[/，,、；;。)）\]】]+$/g, '')
}
function displayName(account) { return String(account?.name || '').trim() || String(account?.baseUrl || '').trim() || '未命名渠道' }
function trimFloat(s) { return String(s).replace(/0+$/, '').replace(/\.$/, '') }
function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return ''
  const n = Number(value)
  return Math.abs(n) >= 1000 ? trimFloat(n.toFixed(4)) : trimFloat(n.toFixed(6))
}
function isUnlimited(unit = '') { return ['unlimited', 'unlimited_quota', 'no_limit', 'no limit', '不限额', '无限额', '∞'].includes(String(unit).trim().toLowerCase()) }
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const cleaned = value.replaceAll(',', '')
    const m = cleaned.match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i)
    if (!m) return null
    const n = Number(m[0])
    return Number.isFinite(n) ? n : null
  }
  return null
}
function pathGet(value, dotted) {
  let current = value
  for (const rawPart of String(dotted).split('.')) {
    if (!rawPart) return undefined
    const match = rawPart.match(/^([^[]+)(?:\[(\d+)\])?$/)
    if (!match) return undefined
    current = current?.[match[1]]
    if (match[2] !== undefined) current = current?.[Number(match[2])]
    if (current === undefined) return undefined
  }
  return current
}
function firstPath(value, paths) {
  for (const p of paths) {
    const v = pathGet(value, p)
    if (v !== undefined && v !== null) return [p, v]
  }
  return null
}
function deepFindKey(value, keys, depth = 0) {
  if (depth > 7 || value === null || value === undefined) return null
  if (Array.isArray(value)) {
    for (const item of value) { const found = deepFindKey(item, keys, depth + 1); if (found) return found }
    return null
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (keys.some((wanted) => wanted.toLowerCase() === k.toLowerCase()) && v !== null && v !== undefined) return [k, v]
      const found = deepFindKey(v, keys, depth + 1)
      if (found) return found
    }
  }
  return null
}
function quotaUnitValue(data) {
  for (const p of ['quota_per_unit', 'data.quota_per_unit', '_newapi_status.quota_per_unit', '_newapi_status.data.quota_per_unit']) {
    const n = toNumber(pathGet(data, p)); if (n && n > 0) return n
  }
  return DEFAULT_QUOTA_PER_UNIT
}
function quotaDisplayType(data) {
  for (const p of ['quota_display_type', 'data.quota_display_type', '_newapi_status.quota_display_type', '_newapi_status.data.quota_display_type']) {
    const v = pathGet(data, p); if (typeof v === 'string') return v.trim().toUpperCase()
  }
  return 'USD'
}
function quotaDisplayValue(raw, data) {
  const divisor = quotaUnitValue(data)
  const dtype = quotaDisplayType(data)
  const rawNote = `原始额度 ${formatNumber(raw)} quota`
  if (dtype === 'TOKENS') return [raw, 'quota units', `${rawNote}；站点为 TOKENS 展示，未换算`]
  const usd = raw / divisor
  if (dtype === 'CNY') {
    const rate = ['usd_exchange_rate', 'data.usd_exchange_rate', '_newapi_status.usd_exchange_rate', '_newapi_status.data.usd_exchange_rate'].map((p) => toNumber(pathGet(data, p))).find((n) => n && n > 0) || 7.3
    return [usd * rate, 'CNY eq.', `${rawNote}；按 quota_per_unit=${formatNumber(divisor)}、USD汇率=${formatNumber(rate)} 换算`]
  }
  return [usd, 'USD eq.', `${rawNote}；按 quota_per_unit=${formatNumber(divisor)} 换算`]
}
function commonBalance(data) {
  const paths = ['balance','credit','credits','quota','available_balance','availableBalance','remain_quota','remaining_quota','remaining','total_balance','totalBalance','total_available','totalAvailable','data.balance','data.credit','data.credits','data.quota','data.available_balance','data.remaining','data.total_balance','data.total_available','result.balance','result.credit','result.remaining']
  const found = firstPath(data, paths) || deepFindKey(data, ['balance','credit','credits','quota','available_balance','availableBalance','remain_quota','remaining_quota','remaining','total_balance','totalBalance','total_available','totalAvailable'])
  const unit = ['unit','currency','billing_mode','data.unit','data.currency','result.unit','result.currency'].map((p) => pathGet(data, p)).find((v) => typeof v === 'string') || ''
  return found ? [toNumber(found[1]), unit, `字段 ${found[0]}`] : [null, unit, '未识别余额字段']
}
function endpointCandidates(baseUrl, pathOrUrl) {
  const p = String(pathOrUrl || '').trim()
  if (p.startsWith('http://') || p.startsWith('https://')) return [p]
  const base = normalizeBaseUrl(baseUrl)
  const low = base.toLowerCase()
  const withoutV1 = low.endsWith('/v1') ? base.slice(0, -3).replace(/\/+$/, '') : base
  const roots = []
  if (p.startsWith('/api/')) roots.push(withoutV1)
  else { if (low.endsWith('/v1')) roots.push(withoutV1); roots.push(base) }
  return [...new Set(roots.map((root) => `${root.replace(/\/+$/, '')}${p.startsWith('/') ? p : `/${p}`}`))]
}
function looksLikeHtml(text, contentType) {
  const ct = String(contentType || '').toLowerCase()
  const head = String(text || '').trimStart().slice(0, 160).toLowerCase()
  return ct.includes('text/html') || head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<head') || head.includes('<title')
}
function parseResponseJson(text, contentType, maxChars) {
  try { return JSON.parse(text) } catch {}
  return { error: looksLikeHtml(text, contentType) ? '端点返回 HTML，不是 JSON 余额接口' : '端点返回非 JSON 内容', content_type: contentType || '', raw: String(text || '').slice(0, maxChars) }
}
function networkErrorPayload(err) {
  const cause = err?.cause || {}
  const parts = []
  if (err?.name === 'AbortError') parts.push('请求超时')
  else parts.push(String(err?.message || err || '请求失败'))
  if (cause.code) parts.push('原因 ' + cause.code)
  if (cause.message) parts.push(cause.message)
  if (cause.hostname) parts.push('主机 ' + cause.hostname)
  return { error: parts.filter(Boolean).join('；'), network_error: { name: err?.name || '', code: cause.code || '', message: cause.message || '', hostname: cause.hostname || '', syscall: cause.syscall || '' } }
}
function authHeaders(apiKey, extraHeaders = [], contentType = false) {
  const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT_VALUE, 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' }
  if (contentType) headers['Content-Type'] = 'application/json'
  if (String(apiKey || '').trim()) headers.Authorization = 'Bearer ' + String(apiKey).trim()
  for (const [k, v] of extraHeaders) headers[k] = v
  return headers
}
function attachTransport(data, transport) {
  if (!transport) return data
  if (data && typeof data === 'object' && !Array.isArray(data)) return { ...data, _transport: transport }
  return { response: data, _transport: transport }
}
const powershellPreferredHosts = new Map()
const POWERSHELL_HOST_TTL_MS = 10 * 60 * 1000
function urlHost(url) {
  try { return new URL(url).host.toLowerCase() } catch { return '' }
}
function shouldPreferPowerShell(url) {
  const host = urlHost(url)
  if (!host) return false
  const expiresAt = powershellPreferredHosts.get(host) || 0
  if (expiresAt > Date.now()) return true
  if (expiresAt) powershellPreferredHosts.delete(host)
  return false
}
function rememberPowerShellHost(url, status) {
  if (!status) return
  const host = urlHost(url)
  if (host) powershellPreferredHosts.set(host, Date.now() + POWERSHELL_HOST_TTL_MS)
}
async function powershellJsonRequest(url, method, headers, timeoutSecs, body, primaryError, maxChars) {
  const fallback = await powershellRequest({ url, method, headers, body, timeoutSecs })
  if (!fallback) return null
  rememberPowerShellHost(url, fallback.status)
  const parsed = parseResponseJson(fallback.body || '', fallback.contentType || '', maxChars)
  return [fallback.status || 0, attachTransport(parsed, { fallback: 'powershell', primary_error: primaryError?.error || '已使用 Windows HTTP 通道' })]
}
async function fallbackJsonRequest(url, method, headers, timeoutSecs, body, primaryError, maxChars) {
  return (await powershellJsonRequest(url, method, headers, timeoutSecs, body, primaryError, maxChars)) || [0, primaryError]
}
async function requestJson(url, apiKey, timeoutSecs, extraHeaders = []) {
  const headers = authHeaders(apiKey, extraHeaders)
  if (shouldPreferPowerShell(url)) {
    const fast = await powershellJsonRequest(url, 'GET', headers, timeoutSecs, undefined, { error: '沿用上次成功的 Windows HTTP 通道' }, 2000)
    if (fast) return fast
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(3, Math.min(60, Number(timeoutSecs) || 12)) * 1000)
  try {
    const resp = await fetch(url, { method: 'GET', headers, cache: 'no-store', signal: controller.signal })
    const text = await resp.text()
    return [resp.status, parseResponseJson(text, resp.headers.get('content-type') || '', 2000)]
  } catch (err) { return fallbackJsonRequest(url, 'GET', headers, timeoutSecs, undefined, networkErrorPayload(err), 2000) }
  finally { clearTimeout(timer) }
}
async function requestPostJson(url, apiKey, timeoutSecs, body, extraHeaders = []) {
  const headers = authHeaders(apiKey, extraHeaders, true)
  if (shouldPreferPowerShell(url)) {
    const fast = await powershellJsonRequest(url, 'POST', headers, timeoutSecs, body, { error: '沿用上次成功的 Windows HTTP 通道' }, 4000)
    if (fast) return fast
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(10, Math.min(180, Number(timeoutSecs) || 90)) * 1000)
  try {
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store', signal: controller.signal })
    const text = await resp.text()
    return [resp.status, parseResponseJson(text, resp.headers.get('content-type') || '', 4000)]
  } catch (err) { return fallbackJsonRequest(url, 'POST', headers, timeoutSecs, body, networkErrorPayload(err), 4000) }
  finally { clearTimeout(timer) }
}
function accountExtraHeaders(account) { return String(account?.userId || '').trim() ? [['New-Api-User', String(account.userId).trim()]] : [] }
async function firstJsonEndpointWithHeaders(baseUrl, p, apiKey, timeout, headers = []) {
  let last = ['', 0, {}]
  let preferred = null
  for (const endpoint of endpointCandidates(baseUrl, p)) {
    const [code, data] = await requestJson(endpoint, apiKey, timeout, headers)
    last = [endpoint, code, data]
    if (code === 200) return last
    if ([400, 401, 403].includes(code) && !preferred) preferred = last
  }
  return preferred || last
}
async function fetchNewapiStatus(baseUrl, timeout) {
  const [endpoint, code, data] = await firstJsonEndpointWithHeaders(baseUrl, '/api/status', '', timeout, [])
  if (code === 200) return [endpoint, code, data?.data || data]
  return [endpoint, code, {}]
}
function withStatus(data, status) {
  if (!status || (typeof status === 'object' && Object.keys(status).length === 0)) return data
  if (data && typeof data === 'object' && !Array.isArray(data)) return { ...data, _newapi_status: status }
  return { response: data, _newapi_status: status }
}
function extractNewapiTokenBalance(data) {
  if (pathGet(data, 'data.unlimited_quota') === true || pathGet(data, 'unlimited_quota') === true) return [null, 'unlimited', '该 API Key 在 New API 中开启 unlimited_quota=true，所以没有有限余额上限']
  const found = firstPath(data, ['data.total_available','total_available','data.remain_quota','remain_quota','data.quota','quota'])
  if (found) {
    const raw = toNumber(found[1]); if (raw !== null) { const [v, unit, note] = quotaDisplayValue(raw, data); return [v, unit, `New API token 字段 ${found[0]}；${note}`] }
  }
  return commonBalance(data)
}
function extractNewapiProfileBalance(data) {
  const foundDirect = firstPath(data, ['data.balance_usd','data.available_usd','data.remaining_usd','balance_usd','available_usd','remaining_usd','data.balance','data.available_balance','balance','available_balance'])
  if (foundDirect) { const n = toNumber(foundDirect[1]); if (n !== null) return [n, pathGet(data, 'data.currency') || pathGet(data, 'currency') || 'USD/credits', `面板账户字段 ${foundDirect[0]}`] }
  const foundQuota = firstPath(data, ['data.user.quota','data.quota','quota','data.remaining_quota','remaining_quota','data.total_available','total_available'])
  if (foundQuota) { const raw = toNumber(foundQuota[1]); if (raw !== null) { const [v, unit, note] = quotaDisplayValue(raw, data); const used = toNumber(pathGet(data, 'data.user.used_quota')) ?? toNumber(pathGet(data, 'data.used_quota')); return [v, unit, `面板账户字段 ${foundQuota[0]}；${note}${used !== null ? `；已用额度 ${formatNumber(used)} quota` : ''}`] } }
  return commonBalance(data)
}
function extractSub2apiUsageBalance(data) {
  const found = firstPath(data, ['remaining_grant','remaining_balance','remaining_usd','remaining','balance','wallet_balance','usage.remaining_grant','usage.remaining_balance','usage.remaining_usd','usage.remaining','usage.balance','subscription.remaining_grant','subscription.remaining','subscription.balance','data.remaining_grant','data.remaining_balance','data.remaining_usd','data.remaining','data.balance','data.wallet_balance','data.usage.remaining_grant','data.usage.remaining','data.subscription.remaining_grant','data.subscription.remaining','quota.remaining','quota.available','data.quota.remaining','data.quota.available','rate_limits.remaining','data.rate_limits.remaining'])
  if (found) return [toNumber(found[1]), pathGet(data, 'currency') || pathGet(data, 'unit') || pathGet(data, 'usage.currency') || pathGet(data, 'usage.unit') || pathGet(data, 'data.currency') || pathGet(data, 'data.unit') || 'USD', `字段 ${found[0]}`]
  const usageFound = firstPath(data, ['total_cost','usage.total_cost','data.total_cost','data.usage.total_cost'])
  if (usageFound && toNumber(usageFound[1]) !== null) return [null, 'USD', `字段 ${usageFound[0]} 是已消耗金额，不是剩余额度；如需钱包余额请使用 Sub2API 面板 JWT 预设`]
  return commonBalance(data)
}
function extractSub2apiDashboardBalance(data) {
  const found = firstPath(data, ['balance','available_balance','wallet_balance','credit','credits','data.balance','data.available_balance','data.wallet_balance','data.credit','data.credits','data.user.balance','data.user.available_balance','data.user.wallet_balance','user.balance','user.available_balance','user.wallet_balance','wallet.balance','account.balance'])
  if (found) return [toNumber(found[1]), pathGet(data, 'currency') || pathGet(data, 'data.currency') || 'USD', `字段 ${found[0]}`]
  return commonBalance(data)
}
function extractSub2apiBillingValue(data) {
  const found = firstPath(data, ['effective_rate_multiplier','rate_multiplier','default_rate_multiplier','data.effective_rate_multiplier','data.rate_multiplier','data.default_rate_multiplier','billing.effective_rate_multiplier','billing.rate_multiplier','pricing.effective_rate_multiplier','pricing.rate_multiplier'])
  if (found) return [toNumber(found[1]), '倍率', `字段 ${found[0]}；此接口返回 Key 的 Sub2API 计费倍率/账单信息，不等同钱包余额`]
  return [null, '倍率', '未匹配 billing 倍率字段；该接口用于账单诊断，不等同钱包余额']
}
function frimodelPlatformBase(baseUrl) { const base = normalizeBaseUrl(baseUrl); const low = base.toLowerCase(); return low.includes('frimodel.com') && !low.includes('platform.frimodel.com') ? 'https://platform.frimodel.com' : base }
function compactText(input, maxChars) { const text = String(input || '').replace(/\s+/g, ' ').trim(); return text.slice(0, maxChars) + (text.length > maxChars ? '…' : '') }
function valueAsMessage(v) {
  if (typeof v === 'string') return compactText(v, 180) || null
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v && typeof v === 'object') return ['message','msg','detail','error.message','error.msg','data.message','data.msg'].map((p) => pathGet(v, p)).map(valueAsMessage).find(Boolean) || compactText(JSON.stringify(v), 180)
  return null
}
function upstreamErrorMessage(raw) {
  for (const p of ['error','message','msg','detail','error.message','error.msg','data.error','data.message','data.msg']) { const msg = valueAsMessage(pathGet(raw, p)); if (msg) return msg }
  if (pathGet(raw, 'success') === false) return 'success=false，但响应未提供具体 message'
  return null
}
function fallbackHttpHint(code) {
  return ({ 0: '请求未完成，请检查网络、域名、证书或超时', 400: '请求参数不被该端点接受', 401: '鉴权失败，Key / PAT / 用户上下文不匹配', 403: '权限不足或该 token 没有读取余额权限', 404: '接口不存在或该站点未开启此余额端点', 405: '请求方法不被该端点接受', 429: '触发频率限制，稍后再试' })[code] || (code >= 500 && code <= 599 ? '上游服务端返回错误' : null)
}
function finalProbeMessage(ok, code, message, raw) {
  const base = String(message || '').trim() || '未识别余额字段'
  if (ok) return base
  const up = upstreamErrorMessage(raw); if (up && !base.includes(up)) return `${base}；上游返回：${up}`
  const hint = fallbackHttpHint(code); if (hint && !base.includes(hint)) return `${base}；${hint}`
  return base
}
function redactedSummary(raw) {
  const redact = (v) => {
    if (Array.isArray(v)) return v.slice(0, 20).map(redact)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, val]) => [/token|secret|password|authorization|api_?key|cookie/i.test(k) ? k : k, /token|secret|password|authorization|api_?key|cookie/i.test(k) ? '••••' : redact(val)]))
    return v
  }
  try { return JSON.stringify(redact(raw), null, 2) } catch { return '{}' }
}
function buildResult(account, ok, balance, unit, httpStatus, endpoint, message, raw, elapsedMs) {
  const businessFailure = raw?.success === false || raw?.error || (typeof raw?.code === 'number' && ![0, 200].includes(raw.code))
  ok = Boolean(ok) && !businessFailure
  if (!ok) balance = null
  const unlimited = (balance === null || balance === undefined) && isUnlimited(unit)
  const unitDisplay = unlimited ? '不限额' : String(unit || '')
  return { id: account.id, name: displayName(account), preset: account.preset || 'auto', ok: Boolean(ok), status: !ok ? '失败' : (unlimited || balance !== null && balance !== undefined ? '正常' : '未知'), balanceNumber: balance === undefined ? null : balance, balanceDisplay: !ok ? '' : unlimited ? '不限额' : formatNumber(balance), unit: unitDisplay, httpStatus, endpoint, message: finalProbeMessage(Boolean(ok), httpStatus, message, raw), rawSummary: redactedSummary(raw), elapsedMs, checkedAt: new Date().toISOString() }
}
async function probeOne(account) {
  const start = Date.now(); const timeout = Math.max(3, Math.min(60, Number(account.timeout) || 12)); const preset = account.preset || 'auto'
  if (preset === 'ccswitch_script') {
    try {
      const r = await runUsageScript(account)
      const first = r.plans[0]; const single = r.plans.length === 1
      const result = buildResult(account, r.ok, single ? first?.remaining : null, single ? first?.unit : '', r.httpStatus, r.endpoint, r.message, {}, Date.now() - start)
      if (r.ok && !single) result.balanceDisplay = r.plans.map(p => `${p.planName || '额度'}: ${p.remaining ?? '未知'} ${p.unit}`).join(' / ')
      return { ...result, plans: r.plans }
    } catch { return buildResult(account, false, null, '', 0, '', '余额脚本执行失败，请检查脚本、请求地址及查询凭据', {}, Date.now() - start) }
  }
  if (preset === 'usage_token') {
    const base = frimodelPlatformBase(account.baseUrl); const [statusEndpoint, statusCode, status] = await fetchNewapiStatus(base, timeout); const headers = accountExtraHeaders(account); const [endpoint, code, data] = await firstJsonEndpointWithHeaders(base, '/api/usage/token/', account.apiKey, timeout, headers); const merged = withStatus(data, status); const [balance, unit, msg] = extractNewapiTokenBalance(merged); return buildResult(account, code === 200 && (balance !== null || isUnlimited(unit)), balance, unit, code, endpoint, `${msg}${statusCode === 200 ? `；已读取状态接口 ${statusEndpoint}` : ''}`, merged, Date.now() - start)
  }
  if (preset === 'newapi_profile') {
    if (String(account.apiKey || '').trim().toLowerCase().startsWith('sk-')) { const endpoint = endpointCandidates(account.baseUrl, '/api/user/self')[0] || ''; return buildResult(account, false, null, 'USD/credits', 0, endpoint, '面板余额接口需要 Profile Token / PAT / User.AccessToken；当前像是 sk-API-Key。', {}, Date.now() - start) }
    const base = frimodelPlatformBase(account.baseUrl); const [statusEndpoint, statusCode, status] = await fetchNewapiStatus(base, timeout); const headers = accountExtraHeaders(account); const [endpoint, code, data] = await firstJsonEndpointWithHeaders(base, '/api/user/self', account.apiKey, timeout, headers); const merged = withStatus(data, status); let [balance, unit, msg] = extractNewapiProfileBalance(merged); if ([401, 403].includes(code)) msg = '面板余额鉴权失败：请填 Profile Token / PAT / User.AccessToken；如果站点要求用户上下文，请同时填写 New-Api-User'; else if (statusCode === 200) msg += `；已读取状态接口 ${statusEndpoint}`; return buildResult(account, code === 200 && balance !== null, balance, unit, code, endpoint, msg, merged, Date.now() - start)
  }
  if (preset === 'sub2api_usage') {
    const headers = accountExtraHeaders(account); let response = await firstJsonEndpointWithHeaders(account.baseUrl, '/v1/usage', account.apiKey, timeout, headers); if (response[1] === 404 || response[1] === 0) response = await firstJsonEndpointWithHeaders(account.baseUrl, '/usage', account.apiKey, timeout, headers); const [endpoint, code, data] = response; const [balance, unit, msg] = extractSub2apiUsageBalance(data); return buildResult(account, code === 200 && balance !== null, balance, unit || 'USD', code, endpoint, `Sub2API /v1/usage；${msg}`, data, Date.now() - start)
  }
  if (preset === 'sub2api_dashboard') {
    return probeSub2apiDashboard(account, start, timeout)
  }
  if (preset === 'sub2api_billing') { const headers = accountExtraHeaders(account); const [endpoint, code, data] = await firstJsonEndpointWithHeaders(account.baseUrl, '/v1/sub2api/billing', account.apiKey, timeout, headers); const [balance, unit, msg] = extractSub2apiBillingValue(data); return buildResult(account, code === 200 && balance !== null, balance, unit, code, endpoint, `Sub2API billing 诊断；${msg}`, data, Date.now() - start) }
  if (preset === 'ccswitch_usage') { const headers = accountExtraHeaders(account); const [endpoint, code, data] = await firstJsonEndpointWithHeaders(account.baseUrl, '/v1/usage', account.apiKey, timeout, headers); const [balance, unit, msg] = commonBalance(data); return buildResult(account, code === 200 && balance !== null, balance, unit || 'USD', code, endpoint, `CC Switch /v1/usage；${msg}`, data, Date.now() - start) }
  if (preset === 'custom') { const headers = accountExtraHeaders(account); const p = String(account.endpoint || '').trim() || '/v1/balance'; const [endpoint, code, data] = await firstJsonEndpointWithHeaders(account.baseUrl, p, account.apiKey, timeout, headers); const pathList = String(account.paths || '').trim() ? String(account.paths).split(/[,;\s]+/).filter(Boolean) : ['balance','data.balance','total_available','data.total_available','credit','data.credit']; const found = firstPath(data, pathList); const balance = found ? toNumber(found[1]) : null; const unit = pathGet(data, 'unit') || pathGet(data, 'data.unit') || pathGet(data, 'currency') || ''; return buildResult(account, code === 200 && balance !== null, balance, unit, code, endpoint, found ? `字段 ${found[0]}` : '未匹配自定义路径', data, Date.now() - start) }
  let last = null
  for (const p of ['newapi_profile','sub2api_dashboard','sub2api_usage','ccswitch_usage','usage_token']) { const r = await probeOne({ ...account, preset: p }); if (r.ok) return { ...r, preset: `auto / ${r.preset}`, message: `自动识别成功：${r.preset}；${r.message}` }; last = r }
  return last || buildResult(account, false, null, '', 0, '', '自动识别未产生请求', {}, Date.now() - start)
}
function extractModels(data) { let out = []; const items = pathGet(data, 'data'); if (Array.isArray(items)) out = items.map((x) => typeof x === 'string' ? x : x?.id).filter(Boolean); if (!out.length && Array.isArray(data)) out = data.map((x) => typeof x === 'string' ? x : x?.id).filter(Boolean); return [...new Set(out)].sort() }
function firstImagePayload(data) { const items = Array.isArray(data?.data) ? data.data : [data]; const images = items.filter(Boolean).map(item => ({imageUrl: /^https?:\/\//i.test(item.url || '') ? item.url : null, imageB64: typeof item.b64_json === 'string' ? item.b64_json : null, revisedPrompt: item.revised_prompt || ''})).filter(i => i.imageUrl || i.imageB64); return { ...(images[0] || {imageUrl:null,imageB64:null,revisedPrompt:''}), images } }
function textFromChatCompletion(data) {
  return pathGet(data, 'choices[0].message.content') || pathGet(data, 'choices[0].text') || pathGet(data, 'data[0].content') || ''
}
async function runTextTest(account) {
  const start = Date.now(), model = String(account.textTestModel || 'gpt-4o-mini').trim()
  const protocols = account.wireApi === 'responses' ? ['responses'] : account.wireApi === 'chat' ? ['chat'] : ['responses', 'chat']
  let last = ['', 0, {}], content = '', wireApi = protocols[0]
  for (const protocol of protocols) {
    wireApi = protocol
    const body = protocol === 'responses' ? { model, input: 'ping，回复 pong', max_output_tokens: 32, stream: false } : { model, messages: [{ role: 'user', content: 'ping，回复 pong' }], max_tokens: 32, stream: false }
    last = await firstPostEndpointWithHeaders(account.baseUrl, protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions', account.textApiKey || account.apiKey, Math.max(5, Math.min(60, Number(account.timeout) || 20)), body, accountExtraHeaders(account))
    const data = last[2]
    content = protocol === 'responses' ? String(data.output_text || (data.output || []).flatMap(x => x.content || []).map(x => x.text || '').join('')) : String(textFromChatCompletion(data) || '')
    if (last[1] === 200 || ![404, 405, 501].includes(last[1])) break
  }
  const [endpoint, code, data] = last, ok = code === 200 && Boolean(content.trim()) && !data.error && data.success !== false
  return { id: account.id, ok, httpStatus: code, endpoint, model, wireApi, message: ok ? '文本连接成功：' + compactText(content, 120) : finalProbeMessage(false, code, '文本连接失败：检查协议、模型与调用 Key', data), rawSummary: redactedSummary(data), elapsedMs: Date.now() - start, checkedAt: new Date().toISOString() }
}
async function firstPostEndpointWithHeaders(baseUrl, p, apiKey, timeout, body, headers = []) {
  let last = ['', 0, {}]
  let preferred = null
  for (const endpoint of endpointCandidates(baseUrl, p)) {
    const [code, data] = await requestPostJson(endpoint, apiKey, timeout, body, headers)
    last = [endpoint, code, data]
    if (code === 200) return last
    if ([400, 401, 403].includes(code) && !preferred) preferred = last
  }
  return preferred || last
}
function balancePathForPreset(account) {
  if (account.preset === 'usage_token') return '/api/usage/token/'
  if (account.preset === 'newapi_profile') return '/api/user/self'
  if (account.preset === 'sub2api_dashboard') return '/api/v1/auth/me'
  if (account.preset === 'sub2api_usage' || account.preset === 'ccswitch_usage') return '/v1/usage'
  if (account.preset === 'sub2api_billing') return '/v1/sub2api/billing'
  return account.endpoint || '/api/status'
}
async function runConnectivity(account) {
  const start = Date.now()
  const timeout = Math.max(3, Math.min(60, Number(account.timeout) || 12))
  const steps = []
  for (const step of [
    ['Base URL', '', ''],
    ['状态接口', '/api/status', ''],
    ['余额接口', balancePathForPreset(account), account.apiKey],
    ['模型接口', '/v1/models', account.textApiKey || account.apiKey],
  ]) {
    const url = endpointCandidates(account.baseUrl, step[1] || '/')[0] || normalizeBaseUrl(account.baseUrl)
    const [code, data] = await requestJson(url, step[2], timeout, step[0] === '余额接口' ? accountExtraHeaders(account) : [])
    steps.push({ name: step[0], url, httpStatus: code, reachable: code > 0, ok: code >= 200 && code < 300 && !data?.error && data?.success !== false, message: code ? (upstreamErrorMessage(data) || fallbackHttpHint(code) || '可达') : (data?.error || '连接失败'), transport: data?._transport?.fallback || 'node' })
  }
  return { id: account.id, reachable: steps.some((s) => s.httpStatus > 0), ok: steps.filter(s => ['余额接口', '模型接口'].includes(s.name)).every(s => s.ok), steps, elapsedMs: Date.now() - start, checkedAt: new Date().toISOString() }
}
function sanitizeAccount(account = {}) { const preset = String(account.preset || 'auto'); const keepSecrets = account.rememberSecret !== false; return { syncManaged: serviceMode === 'local' && account.syncManaged === true, wireApi: ['chat', 'responses', 'auto'].includes(account.wireApi) ? account.wireApi : 'auto', providerConfig: keepSecrets ? String(account.providerConfig || '') : '', source: String(account.source || ''), sources: account.sources || [], sourceId: String(account.sourceId || ''), sourcePath: String(account.sourcePath || ''), usageScript: keepSecrets ? account.usageScript || null : null, id: String(account.id || ('acct_' + Date.now())), name: String(account.name || ''), baseUrl: normalizeBaseUrl(account.baseUrl || account.base_url || ''), apiKey: String(keepSecrets ? (account.apiKey || account.api_key || '') : ''), textApiKey: String(keepSecrets ? (account.textApiKey || account.text_api_key || '') : ''), refreshToken: keepSecrets ? String(account.refreshToken || '').trim() : '', autoRefresh: account.autoRefresh !== false, authVersion: Number(account.authVersion || 0), authUpdatedAt: String(account.authUpdatedAt || ''), rememberSecret: keepSecrets, preset, group: String(account.group || account.channelGroup || account.kind || accountKind({ ...account, preset }) || '文本'), monitorEnabled: account.monitorEnabled !== false, endpoint: String(account.endpoint || ''), paths: String(account.paths || ''), timeout: Number(account.timeout || 12), userId: String(account.userId || account.user_id || ''), textTestModel: String(account.textTestModel || account.text_test_model || 'gpt-4o-mini'), rechargePath: String(account.rechargePath || account.recharge_path || '/wallet'), autoProbeIntervalMinutes: Number(account.autoProbeIntervalMinutes || account.auto_probe_interval_minutes || 0), lowBalanceThreshold: Number(account.lowBalanceThreshold || account.low_balance_threshold || 0), alertLevels: account.alertLevels == null ? null : validateLevels(account.alertLevels), lastAlertLevel: Math.min(3, Math.max(0, Number(account.lastAlertLevel || account.last_alert_level || 0))) } }
function sameAuthBinding(a, b) { return a && b && a.id === b.id && a.baseUrl === b.baseUrl && a.preset === b.preset && String(a.userId || '') === String(b.userId || '') }
function credentialsOf(account) {
  return { apiKey: account.apiKey, refreshToken: account.refreshToken || '', authVersion: Number(account.authVersion || 0), authUpdatedAt: account.authUpdatedAt || '' }
}

async function probeSub2apiDashboard(input, start, timeout) {
  let account = { ...input }
  const saved = (await loadConfig()).accounts.find((a) => a.id === account.id)
  if (sameAuthBinding(account, saved) && saved.rememberSecret && saved.authVersion > Number(account.authVersion || 0)) {
    account = { ...account, ...credentialsOf(saved), autoRefresh: saved.autoRefresh }
  }
  let refreshed = false
  let credentialUpdate = account.apiKey !== input.apiKey || account.refreshToken !== input.refreshToken ? credentialsOf(account) : undefined
  const refresh = async () => {
    const result = await refreshSub2api(account.baseUrl, account.refreshToken, timeout)
    if (!result.ok) return buildResult(account, false, null, 'USD', result.httpStatus, result.endpoint, result.message, {}, Date.now() - start)
    const before = account
    account = { ...account, ...credentialsOf(result), authVersion: Number(before.authVersion || 0) + 1 }
    credentialUpdate = credentialsOf(account)
    refreshed = true
    if (before.rememberSecret !== false) {
      try {
        await updateConfig(async (cfg) => {
          const current = cfg.accounts.find((a) => a.id === before.id)
          // Never resurrect a deleted channel or replace credentials edited during refresh.
          if (sameAuthBinding(before, current) && current.rememberSecret && current.refreshToken === before.refreshToken && current.authVersion === Number(before.authVersion || 0)) {
            Object.assign(current, credentialUpdate)
            await writeConfig(cfg)
          }
        })
      } catch {
        return buildResult(account, false, null, 'USD', 0, '', '令牌已刷新，但保存失败；请检查配置目录写入权限后重新保存渠道', {}, Date.now() - start)
      }
    }
    return null
  }
  const canRefresh = account.autoRefresh !== false && Boolean(account.refreshToken)
  if (canRefresh && tokenNeedsRefresh(account.apiKey)) {
    const failure = await refresh()
    if (failure) return { ...failure, credentialUpdate }
  }
  const query = async () => {
    let response = await firstJsonEndpointWithHeaders(account.baseUrl, '/api/v1/auth/me', account.apiKey, timeout)
    if (response[1] === 404) response = await firstJsonEndpointWithHeaders(account.baseUrl, '/api/v1/user/profile', account.apiKey, timeout)
    return response
  }
  let response = await query()
  if (response[1] === 401 && canRefresh && !refreshed) {
    const failure = await refresh()
    if (failure) return { ...failure, credentialUpdate }
    response = await query()
  }
  const [endpoint, code, data] = response
  const [balance, unit, extracted] = extractSub2apiDashboardBalance(data)
  let message = `Sub2API 面板余额；${extracted}${refreshed ? '；JWT / RT 已自动续期' : ''}`
  if (code === 401) message = refreshed ? '续期后鉴权仍失败，请重新登录上游更新 JWT / RT' : !account.refreshToken ? '登录令牌已失效，请在渠道编辑中填写 Refresh Token (RT)' : '登录令牌已失效，自动续期已关闭'
  if (code === 403) message = '上游拒绝访问，请检查账号权限或状态'
  return { ...buildResult(account, code === 200 && balance !== null, balance, unit || 'USD', code, endpoint, message, data, Date.now() - start), credentialUpdate }
}

let configQueue = Promise.resolve()
function updateConfig(operation) {
  const task = configQueue.then(async () => operation(await loadConfig()))
  configQueue = task.catch(() => undefined)
  return task
}

function mergeSavedCredentials(incoming, existing, raw) {
  if (!sameAuthBinding(incoming, existing) || incoming.preset !== 'sub2api_dashboard') return incoming
  if (incoming.authVersion < existing.authVersion) {
    if (raw.authChanged) throw Object.assign(new Error('凭据已自动更新，请重新打开渠道编辑后再修改 JWT / RT'), { status: 409 })
    return { ...incoming, ...credentialsOf(existing), ...(incoming.rememberSecret ? {} : { apiKey: '', refreshToken: '' }) }
  }
  const changed = incoming.apiKey !== existing.apiKey || incoming.refreshToken !== existing.refreshToken
  return { ...incoming, authVersion: existing.authVersion + (changed ? 1 : 0), authUpdatedAt: changed ? '' : existing.authUpdatedAt }
}
function validateLevels(levels) {
  const values = ['level1', 'level2', 'level3'].map((key) => levels[key])
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0) || values[0] <= values[1] || values[1] <= values[2]) {
    throw Object.assign(new Error('阈值须满足：一级 > 二级 > 三级，且均为非负数'), { status: 400 })
  }
  return { level1: values[0], level2: values[1], level3: values[2] }
}
function mergeAccounts(incoming, existing, allowRemoval) { const ids = new Set(); incoming = incoming.map(a => { if (ids.has(a.id)) a = { ...a, id: importId(a) }; if (ids.has(a.id)) throw Object.assign(new Error('重复渠道标识'), {status: 409}); ids.add(a.id); return a }); if (allowRemoval) return incoming; const existingById = new Map((existing?.accounts || []).map(a => [a.id, a])); const seen = new Set(), out = []; for (const a of incoming) { if (seen.has(a.id)) continue; seen.add(a.id); const old = existingById.get(a.id); out.push(old ? { ...old, ...a, apiKey: a.apiKey || old.apiKey, textApiKey: a.textApiKey || old.textApiKey, refreshToken: a.refreshToken || old.refreshToken, providerConfig: a.providerConfig || old.providerConfig, usageScript: a.usageScript || old.usageScript } : a) } for (const a of existing?.accounts || []) if (!seen.has(a.id)) { seen.add(a.id); out.push(a) } return out }
function normalizeConfig(cfg = emptyConfig()) { return { ...emptyConfig(), ...cfg, revision: Number(cfg.revision || 0), accounts: Array.isArray(cfg.accounts) ? cfg.accounts.map(sanitizeAccount) : [], email: { ...defaultEmail(), ...(cfg.email || {}) }, alertLevels: { ...defaultAlertLevels(), ...(cfg.alertLevels || {}) }, threshold: Number(cfg.threshold ?? cfg.alertLevels?.level1 ?? 5), autoProbeIntervalMinutes: Number(cfg.autoProbeIntervalMinutes || 0), theme: String(cfg.theme || 'dark'), density: String(cfg.density || 'comfortable'), balancePrecision: Number(cfg.balancePrecision ?? 6), codexTools: normalizeCodexTools(cfg.codexTools || {}) } }
async function readJsonFile(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return null } }
async function scanImportSources() { return scanSources({ sanitize: sanitizeAccount }) }
function desktopCandidates() { const profile = process.env.USERPROFILE; const local = process.env.LOCALAPPDATA; return [profile && path.join(profile, 'AppData', 'Roaming', 'UpstreamBalanceRadar', 'config.json'), local && path.join(local, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Roaming', 'UpstreamBalanceRadar', 'config.json')].filter(Boolean) }
let configReadQueue=Promise.resolve()
function loadConfig() {
  const read=configReadQueue.then(readConfig)
  configReadQueue=read.catch(()=>undefined)
  return read
}
async function readConfig() {
  let own
  try { own = JSON.parse(await fs.readFile(configFile, 'utf8')) } catch (e) { if(e.code !== 'ENOENT') throw new Error('配置读取失败，请检查数据文件和密钥；已停止覆盖原数据') }
  if (own) { const cfg = normalizeConfig(vault.open(own)); if(!own.radarEncrypted) await writeConfig(cfg); return cfg }
  if (!process.env.DATA_DIR) {
    const legacy = await readJsonFile(path.join(__dirname, 'data-rt', 'config.json')) || await readJsonFile(path.join(__dirname, 'data', 'config.json'))
    if (legacy) {
      if(legacy.radarEncrypted)throw new Error('检测到旧目录的加密配置，请使用 scripts/migrate-data.mjs 迁移配置和密钥')
      const migrated = normalizeConfig(legacy)
      await writeConfig(migrated)
      return migrated
    }
  }
  let best = null
  for (const file of process.env.DATA_DIR ? [] : desktopCandidates()) { const cfg = await readJsonFile(file); if (cfg && (!best || (cfg.accounts?.length || 0) > (best.accounts?.length || 0))) best = cfg }
  const cfg = normalizeConfig(best || emptyConfig())
  await writeConfig(cfg)
  return cfg
}
async function writeConfig(cfg) { await fs.mkdir(dataDir, { recursive: true, mode:0o700 }); const tmp = `${configFile}.tmp`; await fs.writeFile(tmp, JSON.stringify(vault.seal(normalizeConfig(cfg))), {mode:0o600}); await fs.rename(tmp, configFile) }

function accountKind(account = {}) {
  const preset = String(account.preset || '').toLowerCase()
  const text = String((account.name || '') + ' ' + (account.baseUrl || '') + ' ' + (account.textTestModel || '')).toLowerCase()
  if (preset.includes('sub2api') || text.includes('sub2api')) return 'Sub2API'
  if (preset.includes('ccswitch') || text.includes('cc switch')) return 'CC Switch'
  if (preset.includes('newapi') || preset.includes('usage_token')) return 'New API'
  if (text.includes('image') || text.includes('生图') || text.includes('gpt-image') || text.includes('gemini')) return '生图'
  return '文本'
}
function classifyProbeIssue(result = {}) {
  const code = Number(result.httpStatus || 0)
  const message = String(result.message || '').toLowerCase()
  const raw = String(result.rawSummary || '').toLowerCase()
  const all = message + ' ' + raw
  if (result.ok) return { type: '正常', advice: '余额读取成功，继续按当前间隔监控。' }
  if (all.includes('refresh token') || all.includes('rt') || all.includes('token has expired') || all.includes('jwt') || all.includes('过期')) return { type: 'RT / Token 过期', advice: '在渠道编辑里补填最新 JWT / RT，Sub2API 建议启用自动续期。' }
  if (code === 401) return { type: '401 鉴权失败', advice: '检查 API Key / PAT / New-Api-User 是否对应同一上游账号。' }
  if (code === 403) return { type: '403 权限不足', advice: '确认该 token 是否有读取余额或使用模型权限。' }
  if (code === 404) return { type: '404 接口不存在', advice: '切换探测类型，或在自定义 JSON 里填写该站真实余额接口路径。' }
  if (code === 0 || all.includes('timeout') || all.includes('超时') || all.includes('failed to fetch') || all.includes('connect timeout')) return { type: '超时 / 网络失败', advice: '先点连接诊断，确认域名、端口、证书和本地后端服务状态。' }
  if (all.includes('未识别余额字段') || all.includes('未匹配') || all.includes('field')) return { type: '余额字段不匹配', advice: '在自定义 JSON 路径里补充真实余额字段，例如 data.balance 或 data.quota。' }
  return { type: '其他异常', advice: '查看 Raw 摘要和连接诊断，确认上游返回结构。' }
}
function historyAccountSummary(account = {}) {
  return { id: String(account.id || ''), name: displayName(account), baseUrl: normalizeBaseUrl(account.baseUrl || ''), preset: String(account.preset || 'auto'), group: String(account.group || accountKind(account)), monitorEnabled: account.monitorEnabled !== false }
}
function compactHistoryItem(account, result) {
  const issue = classifyProbeIssue(result)
  return { historyId: Date.now() + '_' + Math.random().toString(16).slice(2), checkedAt: result.checkedAt || new Date().toISOString(), account: historyAccountSummary(account), ok: Boolean(result.ok), status: result.status || (result.ok ? '正常' : '失败'), balanceNumber: result.balanceNumber ?? null, balanceDisplay: result.balanceDisplay || '', unit: result.unit || '', httpStatus: Number(result.httpStatus || 0), endpoint: result.endpoint || '', message: String(result.message || '').slice(0, 500), elapsedMs: Number(result.elapsedMs || 0), issue }
}
async function readHistory() {
  const items = await readJsonFile(historyFile)
  return Array.isArray(items) ? items : []
}
async function writeHistory(items) {
  await fs.mkdir(dataDir, { recursive: true })
  const tmp = historyFile + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(items.slice(0, 2000), null, 2))
  await fs.rename(tmp, historyFile)
}
let historyQueue = Promise.resolve()
function appendProbeHistory(accounts, results) { const job = historyQueue.then(() => appendProbeHistoryUnlocked(accounts, results)); historyQueue = job.catch(() => {}); return job }
async function appendProbeHistoryUnlocked(accounts, results) {
  const byId = new Map((accounts || []).map((a) => [a.id, a]))
  const nextItems = (results || []).map((result) => compactHistoryItem(byId.get(result.id) || result, result))
  if (!nextItems.length) return
  const existing = await readHistory()
  await writeHistory(nextItems.concat(existing))
}
function redactedAccount(account = {}) {
  return { ...account, apiKey: account.apiKey ? '••••' : '', textApiKey: account.textApiKey ? '••••' : '', refreshToken: account.refreshToken ? '••••' : '', providerConfig: account.providerConfig ? '[已保存配置]' : '', usageScript: account.usageScript ? { enabled: account.usageScript.enabled, code: '[已保存脚本]' } : null }
}
function inspectConfigSnapshot(cfg) {
  return {
    configFile,
    dataDir,
    historyFile,
    sessionRoot,
    accountCount: cfg.accounts.length,
    savedSecrets: cfg.accounts.filter((a) => a.apiKey || a.refreshToken || a.textApiKey).length,
    groups: Object.entries(cfg.accounts.reduce((acc, a) => { const key = String(a.group || accountKind(a)); acc[key] = (acc[key] || 0) + 1; return acc }, {})).map(([name, count]) => ({ name, count })),
    configJson: JSON.stringify({ ...cfg, accounts: cfg.accounts.map(redactedAccount), email: { ...cfg.email, password: cfg.email?.password ? '••••' : '' } }, null, 2)
  }
}
function detectPresetFromText(text = '') {
  const low = String(text).toLowerCase()
  if (low.includes('sub2api')) return 'sub2api_dashboard'
  if (low.includes('cc-switch') || low.includes('ccswitch')) return 'ccswitch_usage'
  if (low.includes('new api') || low.includes('new-api') || low.includes('newapi')) return 'newapi_profile'
  return 'auto'
}
function parseImportCandidates(input = '') {
  const text = String(input || '')
  const out = []
  const seen = new Set()
  const add = (candidate = {}) => {
    const baseUrl = normalizeBaseUrl(candidate.baseUrl || candidate.base_url || candidate.apiBase || candidate.api_base || candidate.url || candidate.endpoint || candidate.host || '')
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return
    const key = channelIdentity({ baseUrl, apiKey: candidate.apiKey || candidate.api_key || '', textApiKey: candidate.textApiKey })
    if (seen.has(key)) return
    seen.add(key)
    const models = Array.isArray(candidate.models) ? candidate.models.join(',') : String(candidate.models || candidate.model || '')
    const name = String(candidate.name || candidate.title || candidate.label || baseUrl).trim()
    const preset = String(candidate.preset || detectPresetFromText(name + ' ' + baseUrl + ' ' + models))
    out.push(sanitizeAccount({ id: 'import_' + Date.now() + '_' + out.length + '_' + Math.random().toString(16).slice(2), ...candidate, name, baseUrl, preset, group: accountKind({ name, baseUrl, preset, textTestModel: models }), textTestModel: models.split(',')[0]?.trim() || 'gpt-4o-mini', rechargePath: '/wallet', rememberSecret: true, monitorEnabled: true, timeout: 12 }))
  }
  const walk = (value) => {
    if (!value) return
    if (Array.isArray(value)) { value.forEach(walk); return }
    if (typeof value === 'object') {
      add(value)
      for (const child of Object.values(value)) walk(child)
    }
  }
  let structured = false
  try { walk(JSON.parse(text)); structured = true } catch {}
  if (structured) return out
  const urlMatches = text.match(/https?:\/\/[^\s,'"<>，、；;）)]+/g) || []
  for (const url of urlMatches) add({ baseUrl: url, name: url, preset: detectPresetFromText(text) })
  return out
}

function parseRecipients(v) { return String(v || '').split(/[;,\s]+/).map((s) => s.trim()).filter(Boolean) }
async function sendEmail(config, subject, body) {
  validateEmail(config)
  const recipients = parseRecipients(config?.recipients); if (!recipients.length) throw new Error('请填写收件邮箱')
  if (!String(config?.smtpHost || '').trim()) throw new Error('请填写 SMTP 服务器')
  const sender = String(config?.sender || '').trim() || String(config?.username || '').trim(); if (!sender) throw new Error('请填写发件邮箱')
  const transporter = nodemailer.createTransport({ host: String(config.smtpHost).trim(), port: Number(config.smtpPort || 465), secure: config.smtpSsl !== false, connectionTimeout:10000, greetingTimeout:10000, socketTimeout:20000, disableFileAccess:true, disableUrlAccess:true, auth: { user: String(config.username || ''), pass: String(config.password || '') } })
  try { await transporter.sendMail({ from: sender, to: recipients, subject, text: body, html: emailHtml(subject, body) }) }
  catch (error) { throw Object.assign(new Error(emailFailureMessage(error)), { code: 'RADAR_EMAIL_CONFIG', status: 502 }) }
  finally { transporter.close() }
}

const enhancer = createEnhancer({ dataDir, sessionRoot, loadConfig, updateConfig, writeConfig, apiBase: `http://127.0.0.1:${port}`, listModels: async a => { const [, code, data] = await firstJsonEndpointWithHeaders(a.baseUrl, '/v1/models', a.textApiKey || a.apiKey, 5); if (code !== 200) throw new Error('模型查询失败'); return extractModels(data) } })
async function applySyncSnapshot(snapshot, revision, options = {}) {
  if (!Array.isArray(snapshot?.accounts) || snapshot.accounts.length > 2000) throw Object.assign(new Error('同步渠道列表无效'), {status:400})
  return updateConfig(async cfg => {
    if (!Number.isInteger(revision) || cfg.revision !== revision) throw Object.assign(new Error('同步期间配置已变更，请重新同步；两端数据已保留'), {status:409})
    const clean = syncSnapshot(snapshot, Object.hasOwn(snapshot,'email'))
    const ids = new Set()
    cfg.accounts = clean.accounts.map(raw => {
      if (!raw.id || ids.has(raw.id)) throw Object.assign(new Error('同步渠道标识重复或缺失'), {status:400})
      ids.add(raw.id)
      const old=cfg.accounts.find(a=>a.id===raw.id)
      const incoming=mergeSavedCredentials(sanitizeAccount(raw),old,raw)
      return {...old,...pickSyncAccount(incoming),lastAlertLevel:old?.lastAlertLevel || 0,syncManaged:serviceMode==='local' && options.serverManaged===true}
    })
    cfg.alertLevels=validateLevels(clean.alertLevels)
    const interval=Number(clean.autoProbeIntervalMinutes)
    if(!Number.isFinite(interval)||interval<0)throw Object.assign(new Error('自动探测间隔无效'),{status:400})
    cfg.autoProbeIntervalMinutes=interval
    if(clean.email)cfg.email={...defaultEmail(),...clean.email}
    cfg.revision++
    await writeConfig(cfg)
    return {ok:true,revision:cfg.revision,snapshot:syncSnapshot(cfg,Object.hasOwn(clean,'email'))}
  })
}
function pickSyncAccount(account) { return syncSnapshot({accounts:[account]}).accounts[0] }
const syncClient = createSyncClient({dataDir,vault,loadConfig,applySnapshot:applySyncSnapshot})
const monitor = createMonitor({ dataDir, loadConfig, updateConfig, writeConfig, probe: async account => serviceMode==='local' && account.syncManaged ? syncClient.probe(account) : probeOne(account), appendHistory: appendProbeHistory, sendEmail, remoteResults:()=>syncClient.monitorResults() })
const app = express()
app.disable('x-powered-by')
app.use(access.middleware)
app.use(express.json({ limit: BODY_LIMIT }))
app.post('/api/auth/login', access.login)
app.get('/api/auth/setup', access.setup)
app.post('/api/auth/register', access.register)
app.post('/api/auth/change-password', access.changePassword)
app.post('/api/auth/logout', access.logout)
app.get('/api/auth/status', access.status)
app.get('/api/sync/snapshot', async(req,res,next)=>{try{const cfg=await loadConfig();res.json({revision:cfg.revision,snapshot:syncSnapshot(cfg,req.query.email==='1')})}catch(e){next(e)}})
app.post('/api/sync/apply', async(req,res,next)=>{try{res.json(await applySyncSnapshot(req.body?.snapshot,req.body?.revision))}catch(e){next(e)}})
app.post('/api/sync/probe', async(req,res,next)=>{try{const account=(await loadConfig()).accounts.find(a=>a.id===req.body?.id);if(!account)throw Object.assign(new Error('服务器渠道不存在，请先同步'),{status:404});res.json(await monitor.run(account))}catch(e){next(e)}})
app.get('/api/sync-client/status', async(_req,res,next)=>{try{res.json(await syncClient.status())}catch(e){next(e)}})
app.post('/api/sync-client/connect', async(req,res,next)=>{try{res.json(await syncClient.connect(req.body||{}))}catch(e){next(e)}})
app.post('/api/sync-client/run', async(req,res,next)=>{try{res.json(await syncClient.run(req.body||{}))}catch(e){next(e)}})
app.post('/api/sync-client/disconnect', async(_req,res,next)=>{try{res.json(await syncClient.disconnect())}catch(e){next(e)}})

app.post('/api/enhancer/bridge', async (req, res, next) => { try { res.json(await enhancer.bridge(req.body?.route, req.body?.payload)) } catch(e) { next(e) } })
app.get('/api/monitor/status', async (_req, res, next) => { try { res.json(await monitor.status()) } catch(e) { next(e) } })
app.get('/api/health', (_req, res) => res.json({ ok: true, version:'0.2.0', mode:serviceMode }))
app.get('/api/config-path', async (_req, res, next) => { try { const cfg = await loadConfig(); res.json(`${configFile}（${cfg.accounts.length} 个渠道）`) } catch (e) { next(e) } })
app.get('/api/config', async (_req, res, next) => { try { res.json(await loadConfig()) } catch (e) { next(e) } })
app.get('/api/config-version', async (_req,res,next)=>{try{res.json({revision:Number((await loadConfig()).revision||0)})}catch(e){next(e)}})
app.post('/api/codex-tools/config', async(req,res,next)=>{try{await updateConfig(async cfg=>{cfg.codexTools=normalizeCodexTools(req.body?.tools||{});await writeConfig(cfg)});res.json({ok:true})}catch(e){next(e)}})
app.post('/api/config', async (req, res, next) => {
  try {
    const result = await updateConfig(async (existing) => {
    if (!Number.isInteger(req.body?.revision)) throw Object.assign(new Error('请先重载配置后保存'), {status:428})
    if (req.body.revision !== Number(existing.revision || 0)) throw Object.assign(new Error('其他客户端已更新配置，请重载后再保存；本次更改尚未写入'), {status:409})
    const incoming = Array.isArray(req.body?.accounts) ? req.body.accounts.map((raw) => mergeSavedCredentials(sanitizeAccount(raw), existing.accounts.find((a) => a.id === raw.id), raw)) : []
    const incomingEmail = { ...defaultEmail(), ...(req.body?.email || {}) }
    if (!String(incomingEmail.password || '').trim() && String(existing.email?.password || '').trim()) {
      incomingEmail.password = existing.email.password
    }
    const cfg = normalizeConfig({
      revision: Number(existing.revision || 0) + 1,
      accounts: mergeAccounts(incoming, existing, Boolean(req.body?.allowAccountRemoval)),
      email: incomingEmail,
      threshold: Number(req.body?.threshold ?? req.body?.alertLevels?.level1 ?? 5),
      alertLevels: validateLevels({ ...defaultAlertLevels(), ...(req.body?.alertLevels || {}) }),
      autoProbeIntervalMinutes: Number(req.body?.autoProbeIntervalMinutes || 0),
      theme: String(req.body?.theme || existing.theme || 'dark'),
      density: String(req.body?.density || existing.density || 'comfortable'),
      balancePrecision: Number(req.body?.balancePrecision ?? existing.balancePrecision ?? 6),
      codexTools: normalizeCodexTools(existing.codexTools || {}),
    })
    await writeConfig(cfg)
    return { ok: true, revision:cfg.revision, accounts: cfg.accounts.length, credentialUpdates: cfg.accounts.filter((a) => a.preset === 'sub2api_dashboard' && a.rememberSecret).map((a) => ({ id: a.id, baseUrl: a.baseUrl, ...credentialsOf(a) })) }
    })
    res.json(result)
  } catch (e) { next(e) }
})
app.post('/api/probe', async (req, res, next) => { try { const accounts = Array.isArray(req.body?.accounts) ? req.body.accounts.map((a) => ({ ...sanitizeAccount(a), apiKey: String(a.apiKey || a.api_key || ''), textApiKey: String(a.textApiKey || a.text_api_key || ''), refreshToken: String(a.refreshToken || '').trim() })) : []; const out = []; for (const account of accounts) out.push(await monitor.run(account)); res.json(out) } catch (e) { next(e) } })
app.post('/api/connectivity', async (req, res, next) => { try { const account = { ...sanitizeAccount(req.body?.account || {}), apiKey: String(req.body?.account?.apiKey || req.body?.account?.api_key || ''), textApiKey: String(req.body?.account?.textApiKey || req.body?.account?.text_api_key || ''), refreshToken: String(req.body?.account?.refreshToken || '').trim() }; res.json(await runConnectivity(account)) } catch (e) { next(e) } })
app.post('/api/text-test', async (req, res, next) => { try { const account = { ...sanitizeAccount(req.body?.account || {}), apiKey: String(req.body?.account?.apiKey || req.body?.account?.api_key || ''), textApiKey: String(req.body?.account?.textApiKey || req.body?.account?.text_api_key || ''), refreshToken: String(req.body?.account?.refreshToken || '').trim() }; res.json(await runTextTest(account)) } catch (e) { next(e) } })
app.get('/api/probe-history', async (_req, res, next) => { try { res.json({ items: await readHistory(), historyFile }) } catch (e) { next(e) } })
app.post('/api/probe-history/clear', async (_req, res, next) => { try { await writeHistory([]); res.json({ ok: true, message: '探测历史已清空' }) } catch (e) { next(e) } })
app.get('/api/config-inspect', async (_req, res, next) => { try { res.json(inspectConfigSnapshot(await loadConfig())) } catch (e) { next(e) } })
app.get('/api/import-sources', async (_req, res, next) => { try { res.json(await scanImportSources()) } catch (e) { next(e) } })
app.post('/api/import-preview', async (req, res, next) => { try { const candidates = parseImportCandidates(req.body?.text || req.body?.json || ''); res.json({ count: candidates.length, accounts: candidates }) } catch (e) { next(e) } })
app.get('/api/codex-tools/status', async (_req, res, next) => { try { res.json(await codexToolsStatus()) } catch (e) { next(e) } })
app.post('/api/codex-tools/models', async (_req, res, next) => { try { res.json(await discoverCodexModels()) } catch (e) { next(e) } })
app.post('/api/codex-tools/export-enhancer', async (req, res, next) => { try { res.json(await exportCodexEnhancerPackage(req.body || {})) } catch (e) { next(e) } })
app.post('/api/codex-tools/apply-enhancer', async (req, res, next) => { try { res.json(await applyCodexEnhancements(req.body || {})) } catch (e) { next(e) } })
app.post('/api/email/send', async (req, res, next) => { try { await sendEmail(req.body?.config || {}, String(req.body?.subject || ''), String(req.body?.body || '')); res.json({ ok: true }) } catch (e) { next(e) } })
app.post('/api/models', async (req, res, next) => { try { const start = Date.now(); const account = { ...sanitizeAccount(req.body?.account || {}), apiKey: String(req.body?.account?.apiKey || req.body?.account?.api_key || ''), textApiKey:String(req.body?.account?.textApiKey || req.body?.account?.text_api_key || '') }; const headers = accountExtraHeaders(account); let last = ['', 0, {}]; for (const endpoint of endpointCandidates(account.baseUrl, '/v1/models')) { const [code, data] = await requestJson(endpoint, account.textApiKey || account.apiKey, Math.max(3, Math.min(60, Number(account.timeout) || 12)), headers); last = [endpoint, code, data]; if (code === 200) { const models = extractModels(data); return res.json({ ok: models.length > 0, httpStatus: code, endpoint, models, message: models.length ? `已获取 ${models.length} 个模型` : '接口成功，但响应里没有识别到模型 id', rawSummary: redactedSummary(data), elapsedMs: Date.now() - start }) } } const models = extractModels(last[2]); res.json({ ok: false, httpStatus: last[1], endpoint: last[0], models, message: '获取模型失败：请检查 Base URL 与 API Key / PAT', rawSummary: redactedSummary(last[2]), elapsedMs: Date.now() - start }) } catch (e) { next(e) } })
app.post('/api/image-test', async (req, res, next) => { try { const start = Date.now(); const request = req.body?.request || {}; if (!String(request.model || '').trim()) throw new Error('请选择或填写生图模型'); if (!String(request.prompt || '').trim()) throw new Error('请填写生图提示词'); const account = { ...sanitizeAccount(request.account || {}), apiKey: String(request.account?.apiKey || request.account?.api_key || ''), textApiKey:String(request.account?.textApiKey || request.account?.text_api_key || '') }; const body = { model: String(request.model).trim(), prompt: String(request.prompt).trim(), n: Math.max(1, Math.min(4, Number(request.n || 1))) }; for (const [from, to] of [['size','size'],['quality','quality'],['outputFormat','output_format'],['background','background'],['responseFormat','response_format']]) { const v = String(request[from] || '').trim(); if (v && v !== 'auto') body[to] = v } const headers = accountExtraHeaders(account); let last = ['', 0, {}]; for (const endpoint of endpointCandidates(account.baseUrl, '/v1/images/generations')) { const [code, data] = await requestPostJson(endpoint, account.textApiKey || account.apiKey, Math.max(10, Math.min(180, Number(request.timeout) || 90)), body, headers); last = [endpoint, code, data]; if (code === 200) { const image = firstImagePayload(data); const ok = Boolean(image.imageUrl || image.imageB64); return res.json({ ok, httpStatus: code, endpoint, model: request.model, ...image, message: ok ? '生图接口调用成功' : '接口返回成功，但没有识别到 url 或 b64_json 图片字段', rawSummary: redactedSummary(data), elapsedMs: Date.now() - start }) } } const image = firstImagePayload(last[2]); res.json({ ok: false, httpStatus: last[1], endpoint: last[0], model: request.model, ...image, message: '生图测试失败：请检查模型、Key、额度和渠道转发规则', rawSummary: redactedSummary(last[2]), elapsedMs: Date.now() - start }) } catch (e) { next(e) } })
app.get('/api/providers/status', async (_req, res, next) => { try { res.json(await providerStatus()) } catch (e) { next(e) } })
app.post('/api/providers/switch', async (req, res, next) => { try { const cfg = await loadConfig(); const raw = req.body?.account; const account = raw ? { ...sanitizeAccount(raw), apiKey:String(raw.apiKey||''), textApiKey:String(raw.textApiKey||''), providerConfig:String(raw.providerConfig||'') } : cfg.accounts.find(a => a.id === req.body?.id); if (!account && req.body?.mode !== 'official') throw new Error('渠道不存在'); res.json(await switchProvider(account || {}, dataDir, req.body?.mode)) } catch (e) { next(e) } })
app.post('/api/sessions/markdown', async (req, res, next) => { try { res.json({ markdown: await sessionMarkdown(sessionRoot, req.body?.relativePath) }) } catch (e) { next(e) } })
app.get('/api/sessions', async (_req, res, next) => { try { res.json(await scanSessions(sessionRoot)) } catch (e) { next(e) } })
app.post('/api/sessions/sync', async (req, res, next) => { try { res.json(await syncSessions(sessionRoot, sessionBackupDir, req.body || {})) } catch (e) { next(e) } })
app.post('/api/sessions/repair', async (_req, res, next) => { try { res.json(await repairSessions(sessionRoot, sessionBackupDir)) } catch (e) { next(e) } })
app.post('/api/sessions/export', async (_req, res, next) => { try { res.json(await exportSessions(sessionRoot, path.join(dataDir, 'session-exports'))) } catch (e) { next(e) } })
app.post('/api/sessions/delete', async (req, res, next) => { try { res.json(await deleteSession(sessionRoot, sessionBackupDir, req.body?.relativePath || '')) } catch (e) { next(e) } })
app.post('/api/sessions/restore-deleted', async (req, res, next) => { try { res.json(await restoreDeletedSession(sessionRoot, sessionBackupDir, req.body?.backupDir || '')) } catch (e) { next(e) } })

const distDir = path.join(rootDir, 'dist')
if (fssync.existsSync(distDir)) {
  app.use(express.static(distDir, { index: false, maxAge: '1h' }))
  app.get('*', (req, res, next) => { if (req.path.startsWith('/api/')) return next(); res.sendFile(path.join(distDir, 'index.html')) })
}
app.use((err, _req, res, _next) => { console.error(`[${new Date().toISOString()}]`, err?.message || err); res.status(err.status || 500).json({ error: String(err?.message || err) }) })

export { app, monitor, probeOne, quotaDisplayValue, buildResult, sanitizeAccount }
if (isMain) {
  await fs.mkdir(dataDir, { recursive: true })
  monitor.start()
  const server=app.listen(port, host, () => console.log(`上游余额雷达 Web 服务已启动：http://${host}:${port}，配置：${configFile}`))
  let stopping=false
  const shutdown=async()=>{if(stopping)return;stopping=true;monitor.stop();enhancer.close();server.close(async()=>{await unlockData();process.exit(0)});setTimeout(()=>process.exit(1),5000).unref()}
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown)
  const parentPid=Number(process.env.RADAR_PARENT_PID)
  if(Number.isInteger(parentPid)&&parentPid>0){setInterval(()=>{try{process.kill(parentPid,0)}catch{void shutdown()}},3000).unref()}
}

