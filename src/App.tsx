import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { ConnectionPanel, endpoint, headersFor, configRevision, setConfigRevision, resumeConnection, logoutConnection, desktop, isRemote } from './connection'
import { openUrl } from '@tauri-apps/plugin-opener'
import { ChannelAction } from './ChannelAction'
import { SessionId } from './SessionId'
import { SyncPanel, PasswordPanel } from './SyncPanel'
import { resolveRechargeUrl } from './recharge-url'
import { normalizedThresholds, validAlertLevels, alertLevelForBalance } from './alert-levels'
import type { AlertLevels } from './alert-levels'

type Page = 'channels' | 'image' | 'exceptions' | 'sessions' | 'import' | 'codex' | 'email' | 'settings'
type Preset = 'auto' | 'sub2api_dashboard' | 'sub2api_usage' | 'sub2api_billing' | 'ccswitch_usage' | 'usage_token' | 'newapi_profile' | 'custom'
type ChannelModalMode = 'add' | 'edit'
type ChannelGroup = '生图' | '文本' | 'Sub2API' | 'New API' | 'CC Switch'
type Theme = 'dark' | 'light'
type Density = 'comfortable' | 'compact'

type Account = {
  syncManaged?: boolean
  wireApi?: 'auto' | 'responses' | 'chat'
  usageScript?: { enabled: boolean; code: string; [key: string]: unknown } | null
  providerConfig?: string
  source?: string

  id: string
  name: string
  baseUrl: string
  apiKey: string
  textApiKey?: string
  refreshToken?: string
  autoRefresh?: boolean
  authVersion?: number
  authUpdatedAt?: string
  authChanged?: boolean
  textTestModel: string
  rechargePath: string
  group: ChannelGroup | string
  monitorEnabled: boolean
  rememberSecret: boolean
  preset: Preset | string
  endpoint: string
  paths: string
  timeout: number
  userId: string
  autoProbeIntervalMinutes: number
  lowBalanceThreshold: number
  alertLevels?: AlertLevels | null
  lastAlertLevel: number
}
type CredentialUpdate = { apiKey: string; refreshToken: string; authVersion: number; authUpdatedAt: string }
type ProbeResult = { id: string; name: string; preset: string; ok: boolean; status: string; balanceNumber: number | null; balanceDisplay: string; unit: string; httpStatus: number; endpoint: string; message: string; rawSummary: string; elapsedMs: number; checkedAt?: string; credentialUpdate?: CredentialUpdate }
type EmailConfig = { enabled: boolean; smtpHost: string; smtpPort: number; smtpSsl: boolean; username: string; password: string; sender: string; recipients: string; cooldownMinutes: number; lastAlertAt: number }
type AppConfig = { revision?:number; accounts: Array<Omit<Account, 'apiKey'> & { apiKey?: string; autoProbeIntervalMinutes?: number; lowBalanceThreshold?: number; lastAlertLevel?: number; group?: string; monitorEnabled?: boolean }>; email: EmailConfig; threshold?: number; alertLevels?: Partial<AlertLevels>; autoProbeIntervalMinutes?: number; theme?: Theme | string; density?: Density | string; balancePrecision?: number; codexTools?: Partial<CodexToolsConfig> }
type ModelListResult = { ok: boolean; httpStatus: number; endpoint: string; models: string[]; message: string; rawSummary: string; elapsedMs: number }
type ImageTestResult = { images?: Array<{imageUrl:string|null;imageB64:string|null;revisedPrompt:string}>; ok: boolean; httpStatus: number; endpoint: string; model: string; imageUrl: string | null; imageB64: string | null; revisedPrompt: string; message: string; rawSummary: string; elapsedMs: number }
type ImageParams = { model: string; prompt: string; aspectRatio: string; imageSize: string; customSize: string; quality: string; n: number; responseFormat: string; outputFormat: string; background: string; timeout: number }
type TextTestResult = { id: string; ok: boolean; httpStatus: number; endpoint: string; model: string; message: string; rawSummary: string; elapsedMs: number; checkedAt: string }
type ConnectivityStep = { name: string; url: string; httpStatus: number; ok: boolean; message: string; transport: string }
type ConnectivityResult = { id: string; ok: boolean; steps: ConnectivityStep[]; elapsedMs: number; checkedAt: string }
type SessionItem = { cwd?: string; provider?: string; id?: string; relativePath: string; fileName: string; size: number; updatedAt: string; title: string; preview: string; model: string; lines: number; invalidLines: number; messages: number; userMessages: number; assistantMessages: number }
type SessionScan = { rootDir: string; exists: boolean; totalFiles: number; scannedFiles: number; invalidFiles: number; totalLines: number; totalMessages: number; elapsedMs: number; sessions: SessionItem[] }
type SessionActionResult = { ok: boolean; message: string; backupDir?: string; exportDir?: string; copied?: number; repaired?: number; removedLines?: number; exported?: number; deleted?: number; restored?: number; relativePath?: string; backupFile?: string }
type ProbeIssue = { type: string; advice: string }
type ProbeHistoryItem = { historyId: string; checkedAt: string; account: Pick<Account, 'id' | 'name' | 'baseUrl' | 'preset' | 'group' | 'monitorEnabled'>; ok: boolean; status: string; balanceNumber: number | null; balanceDisplay: string; unit: string; httpStatus: number; endpoint: string; message: string; elapsedMs: number; issue: ProbeIssue }
type ProbeHistoryResponse = { items: ProbeHistoryItem[]; historyFile: string }
type ConfigInspectResult = { configFile: string; dataDir: string; historyFile: string; sessionRoot: string; accountCount: number; savedSecrets: number; groups: Array<{ name: string; count: number }>; configJson: string }
type CodexToolsConfig = { enhanceEnabled: boolean; mode: 'compatible' | 'full'; features: Record<string, boolean> }
type CodexToolStatus = { tools?:CodexToolsConfig; dataDir: string; enhancerRoot?: string; enhancerBundleDir?: string; enhancerPayloadFile?: string; enhancerInjectorFile?: string; enhancerConfigFile?: string; enhancerStateFile?: string; enhancerReady?: boolean; enhancerInjected?: boolean; enhancerTargets?: number; enhancerLastAppliedAt?: string; enhancerModelCount?: number; enhancerRevision?: string; enhancerFeatureStatus?: Record<string, string>; codexPlusPlusManagerPath: string; codexPlusPlusFound: boolean; paused?: boolean; stateFile?: string; stateExists?: boolean; injectorPid?: number; injectorAlive?: boolean; cdp?: { port?: number; available?: boolean; ok?: boolean; browser?: string; protocol?: string; error?: string } }
type CodexEnhancerResult = { ok: boolean; message: string; enhancerRoot: string; bundleDir: string; payloadFile: string; injectorFile: string; configFile: string; modelCount: number; models?: string[]; sources?: Array<Record<string, unknown>>; launch?: { ok?: boolean; startScript?: string; stdout?: string; stderr?: string } | null; cdp?: CodexToolStatus['cdp']; inject?: { ok?: boolean; result?: Record<string, unknown>; stdout?: string; stderr?: string }; state?: Record<string, unknown> }
type ImportPreviewResult = { count: number; accounts: Account[] }
type ImportSourceResult = { count: number; accounts: Account[]; sources: Array<{ source: string; path: string; found: boolean; count?: number }> }

const channelIdentity = (a: Account) => normalizeBaseUrlInput(a.baseUrl).toLowerCase() + '\u0000' + (a.textApiKey || a.apiKey || '')
const SERVICE_OFFLINE = '余额雷达服务连接失败，请检查服务器地址和网络；使用本机服务时，请重新打开余额雷达。'

class ServiceConnectionError extends Error {}

async function apiCall<T>(name: string, payload?: unknown): Promise<T> {
  const routeMap: Record<string, { method: 'GET' | 'POST'; path: string }> = {
    save_codex_tools: {method:'POST',path:'/api/codex-tools/config'},
    config_version: {method:'GET',path:'/api/config-version'},
    monitor_status: { method: 'GET', path: '/api/monitor/status' },
    switch_provider: { method: 'POST', path: '/api/providers/switch' },
    load_config: { method: 'GET', path: '/api/config' },
    save_config: { method: 'POST', path: '/api/config' },
    probe_accounts: { method: 'POST', path: '/api/probe' },
    probe_history: { method: 'GET', path: '/api/probe-history' },
    clear_probe_history: { method: 'POST', path: '/api/probe-history/clear' },
    config_inspect: { method: 'GET', path: '/api/config-inspect' },
    import_preview: { method: 'POST', path: '/api/import-preview' },
    import_sources: { method: 'GET', path: '/api/import-sources' },
    test_connectivity: { method: 'POST', path: '/api/connectivity' },
    test_text: { method: 'POST', path: '/api/text-test' },
    send_email: { method: 'POST', path: '/api/email/send' },
    list_models: { method: 'POST', path: '/api/models' },
    generate_image_test: { method: 'POST', path: '/api/image-test' },
    config_path: { method: 'GET', path: '/api/config-path' },
    scan_sessions: { method: 'GET', path: '/api/sessions' },
    sync_sessions: { method: 'POST', path: '/api/sessions/sync' },
    repair_sessions: { method: 'POST', path: '/api/sessions/repair' },
    export_sessions: { method: 'POST', path: '/api/sessions/export' },
    delete_session: { method: 'POST', path: '/api/sessions/delete' },
    restore_deleted_session: { method: 'POST', path: '/api/sessions/restore-deleted' },
    codex_tools_status: { method: 'GET', path: '/api/codex-tools/status' },
    codex_models: { method: 'POST', path: '/api/codex-tools/models' },
    export_codex_enhancer: { method: 'POST', path: '/api/codex-tools/export-enhancer' },
    apply_codex_enhancer: { method: 'POST', path: '/api/codex-tools/apply-enhancer' },
  }
  const route = routeMap[name]
  if (!route) throw new Error(`未知 API：${name}`)
  let resp: Response
  let text: string
  try {
    resp = await fetch(`${endpoint(name)}${route.path}`, {
    method: route.method,
    credentials:'include',
    cache: 'no-store',
    signal: AbortSignal.timeout(name === 'probe_accounts' ? 660000 : 200000),
    headers: { ...headersFor(name), ...(route.method === 'POST' ? {'Content-Type':'application/json'} : {}) },
    body: route.method === 'POST' ? JSON.stringify(name === 'save_config' ? {...(payload as object || {}),revision:configRevision} : payload || {}) : undefined,
  })
    text = await resp.text()
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error('本次请求等待超时，请稍后重试')
    window.dispatchEvent(new Event('radar-service-offline'))
    throw new ServiceConnectionError(SERVICE_OFFLINE)
  }
  let data: unknown = text
  try { data = text ? JSON.parse(text) : null } catch {}
  if (resp.status === 401) void logoutConnection().catch(()=>undefined)
  if (!resp.ok) {
    const message = data && typeof data === 'object' && 'error' in data ? String((data as { error?: unknown }).error) : text
    throw new Error(message || `HTTP ${resp.status}`)
  }
  if ((name==='load_config'||name==='save_config') && data && typeof data==='object' && 'revision' in data) setConfigRevision(Number((data as {revision:number}).revision))
  return data as T
}
const presets = [
  ['auto', '自动识别'],
  ['ccswitch_script', 'CC Switch 原查询脚本'],
  ['sub2api_dashboard', 'Sub2API 面板 /api/v1/auth/me 或 /user/profile (JWT)'],
  ['sub2api_usage', 'Sub2API API Key /v1/usage'],
  ['sub2api_billing', 'Sub2API API Key /v1/sub2api/billing'],
  ['ccswitch_usage', 'CC Switch /v1/usage'],
  ['usage_token', 'New API 官方 /api/usage/token'],
  ['newapi_profile', 'New API 面板 /api/user/self (PAT)'],
  ['custom', '自定义 JSON'],
] as const
const presetLabel: Record<string, string> = Object.fromEntries(presets)
const navItems = [
  { page: 'image', title: '渠道生图测试', subtitle: '模型获取和生图验证', glyph: '图' },
  { page: 'channels', title: '渠道管理', subtitle: '余额探测和自动轮询', glyph: '渠' },
  { page: 'exceptions', title: '异常中心', subtitle: '历史、失败分类和建议', glyph: '异' },
  { page: 'sessions', title: '会话管理', subtitle: '同步、导出和修复', glyph: '会' },
  { page: 'codex', title: 'Codex增强', subtitle: '页面增强和工具', glyph: '++' },
  { page: 'email', title: '邮箱管理', subtitle: '低余额邮件提醒', glyph: '邮' },
  { page: 'settings', title: '设置', subtitle: '阈值、路径和说明', glyph: '设' },
] as const

const channelGroupOptions: ChannelGroup[] = ['生图', '文本', 'Sub2API', 'New API', 'CC Switch']

const codexFeatureCatalog = [
  { id: 'pluginMarket', title: '插件市场解锁', description: '显示完整插件列表和入口，适合纯 API Key 或混合模式。', status: '正常' },
  { id: 'forcePluginEntry', title: '强制解锁入口', description: '强制显示插件入口、工具与插件页相关菜单。', status: '正常' },
  { id: 'forcePluginInstall', title: '特殊插件强制安装', description: '解除 App unavailable / 应用不可用导致的前端安装禁用。', status: '正常' },
  { id: 'modelWhitelist', title: '模型白名单解锁', description: '从环境变量和 config.toml 的 /v1/models 拉取模型并补进模型列表。', status: '正常' },
  { id: 'fastButton', title: 'Fast 按钮', description: '显示服务模式切换按钮；Fast 仅支持指定模型，其它模型按 Standard 发送。', status: '已禁用' },
  { id: 'sessionDelete', title: '会话删除', description: '在会话列表暴露删除按钮，并支持撤销。', status: '正常' },
  { id: 'markdownExport', title: 'Markdown 导出', description: '在会话列表提供导出按钮，导出带时间戳的 Markdown。', status: '正常' },
  { id: 'sessionProjectMove', title: '会话项目移动', description: '把会话移动到普通对话或其它本地项目。', status: '正常' },
  { id: 'conversationTimeline', title: '对话 Timeline', description: '在对话右侧显示用户提问时间线，支持摘要和跳转。', status: '正常' },
  { id: 'centeredWidth', title: '对话居中宽度', description: '把正文对话和输入框限制到固定最大宽度，适合大屏阅读。', status: '已禁用' },
  { id: 'rememberThreadPosition', title: '切换对话保留位置', description: '切换 thread 时恢复上一次浏览位置。', status: '正常' },
  { id: 'zedRemoteOpen', title: 'Zed Remote open', description: '远程 SSH 文件引用可直接用 Zed Remote Development 打开。', status: '正常' },
  { id: 'scriptMarket', title: '脚本市场', description: '集中管理常用用户脚本、安装状态和入口。', status: '正常' },
  { id: 'recommendedContent', title: '推荐内容', description: '管理推荐卡片与入口展示，避免页面分散。', status: '正常' },
  { id: 'installMaintenance', title: '安装维护', description: '集中展示安装状态、恢复入口、脚本状态和重启提示。', status: '正常' },
] as const
function defaultCodexTools(): CodexToolsConfig {
  return {
    enhanceEnabled: true,
    mode: 'compatible',
    features: Object.fromEntries(codexFeatureCatalog.map((item) => [item.id, item.status !== '已禁用'])),
  }
}
function normalizeCodexTools(value?: Partial<CodexToolsConfig>): CodexToolsConfig {
  const base = defaultCodexTools()
  return {
    ...base,
    ...value,
    enhanceEnabled: value?.enhanceEnabled !== false,
    mode: value?.mode === 'full' ? 'full' : 'compatible',
    features: { ...base.features, ...(value?.features || {}) },
  }
}
function normalizeTheme(value?: string): Theme { return value === 'light' ? 'light' : 'dark' }
function normalizeDensity(value?: string): Density { return value === 'compact' ? 'compact' : 'comfortable' }
function normalizePrecision(value?: number) { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(8, Math.round(n))) : 6 }
function channelGroupForAccount(account: Partial<Account>): ChannelGroup {
  const explicit = String(account.group || '').trim()
  if ((channelGroupOptions as string[]).includes(explicit)) return explicit as ChannelGroup
  const preset = String(account.preset || '').toLowerCase()
  const text = String((account.name || '') + ' ' + (account.baseUrl || '') + ' ' + (account.textTestModel || '')).toLowerCase()
  if (preset.includes('sub2api') || text.includes('sub2api')) return 'Sub2API'
  if (preset.includes('ccswitch') || text.includes('cc switch')) return 'CC Switch'
  if (preset.includes('newapi') || preset.includes('usage_token')) return 'New API'
  if (text.includes('image') || text.includes('生图') || text.includes('gpt-image') || text.includes('gemini')) return '生图'
  return '文本'
}
function latestHistoryByAccount(items: ProbeHistoryItem[]) {
  const out = new Map<string, ProbeHistoryItem>()
  for (const item of [...items].sort((a, b) => new Date(b.checkedAt).getTime() - new Date(a.checkedAt).getTime())) {
    const key = item.account?.id || item.account?.baseUrl || item.historyId
    if (!out.has(key)) out.set(key, item)
  }
  return out
}
function groupFailures(items: ProbeHistoryItem[]): Array<[string, ProbeHistoryItem[]]> {
  const map = new Map<string, ProbeHistoryItem[]>()
  for (const item of items) {
    const key = item.issue?.type || (item.httpStatus ? 'HTTP ' + item.httpStatus : '其他异常')
    map.set(key, [...(map.get(key) || []), item])
  }
  return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length)
}
function sessionProjectName(item: SessionItem) { return item.cwd || '无项目' }
function sessionMatches(item: SessionItem, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [item.title, item.preview, item.model, item.relativePath, item.fileName].join(' ').toLowerCase().includes(q)
}

const builtinImageModels = ['gpt-image-2', 'gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview']
const commonRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
const extendedGeminiRatios = ['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9']
const openAiSizeMap: Record<string, Record<string, string>> = {
  '512px': { '1:1': '512x512', '2:3': '512x768', '3:2': '768x512', '3:4': '480x640', '4:3': '640x480', '4:5': '512x640', '5:4': '640x512', '9:16': '576x1024', '16:9': '1024x576', '21:9': '1024x448', '1:3': '384x1152', '3:1': '1152x384' },
  '1K': { '1:1': '1024x1024', '2:3': '1024x1536', '3:2': '1536x1024', '3:4': '960x1280', '4:3': '1280x960', '4:5': '1024x1280', '5:4': '1280x1024', '9:16': '1024x1792', '16:9': '1792x1024', '21:9': '1792x768', '1:3': '768x2304', '3:1': '2304x768' },
  '2K': { '1:1': '2048x2048', '2:3': '1344x2016', '3:2': '2016x1344', '3:4': '1536x2048', '4:3': '2048x1536', '4:5': '1600x2000', '5:4': '2000x1600', '9:16': '1152x2048', '16:9': '2048x1152', '21:9': '2048x896', '1:3': '768x2304', '3:1': '2304x768' },
  '4K': { '1:1': '4096x4096', '2:3': '2730x4096', '3:2': '4096x2730', '3:4': '3072x4096', '4:3': '4096x3072', '4:5': '3276x4096', '5:4': '4096x3276', '9:16': '2304x4096', '16:9': '4096x2304', '21:9': '4096x1755', '1:3': '1365x4096', '3:1': '4096x1365' },
}
const geminiFlashSizeMap: Record<string, Record<string, string>> = {
  '512px': { '1:1': '512x512', '1:4': '256x1024', '1:8': '192x1536', '2:3': '424x632', '3:2': '632x424', '3:4': '448x600', '4:1': '1024x256', '4:3': '600x448', '4:5': '464x576', '5:4': '576x464', '8:1': '1536x192', '9:16': '384x688', '16:9': '688x384', '21:9': '792x336' },
  '1K': { '1:1': '1024x1024', '1:4': '512x2048', '1:8': '384x3072', '2:3': '848x1264', '3:2': '1264x848', '3:4': '896x1200', '4:1': '2048x512', '4:3': '1200x896', '4:5': '928x1152', '5:4': '1152x928', '8:1': '3072x384', '9:16': '768x1376', '16:9': '1376x768', '21:9': '1584x672' },
  '2K': { '1:1': '2048x2048', '1:4': '1024x4096', '1:8': '768x6144', '2:3': '1696x2528', '3:2': '2528x1696', '3:4': '1792x2400', '4:1': '4096x1024', '4:3': '2400x1792', '4:5': '1856x2304', '5:4': '2304x1856', '8:1': '6144x768', '9:16': '1536x2752', '16:9': '2752x1536', '21:9': '3168x1344' },
  '4K': { '1:1': '4096x4096', '1:4': '2048x8192', '1:8': '1536x12288', '2:3': '3392x5056', '3:2': '5056x3392', '3:4': '3584x4800', '4:1': '8192x2048', '4:3': '4800x3584', '4:5': '3712x4608', '5:4': '4608x3712', '8:1': '12288x1536', '9:16': '3072x5504', '16:9': '5504x3072', '21:9': '6336x2688' },
}
const geminiProSizeMap: Record<string, Record<string, string>> = {
  '1K': { '1:1': '1024x1024', '2:3': '848x1264', '3:2': '1264x848', '3:4': '896x1200', '4:3': '1200x896', '4:5': '928x1152', '5:4': '1152x928', '9:16': '768x1376', '16:9': '1376x768', '21:9': '1584x672' },
  '2K': { '1:1': '2048x2048', '2:3': '1696x2528', '3:2': '2528x1696', '3:4': '1792x2400', '4:3': '2400x1792', '4:5': '1856x2304', '5:4': '2304x1856', '9:16': '1536x2752', '16:9': '2752x1536', '21:9': '3168x1344' },
  '4K': { '1:1': '4096x4096', '2:3': '3392x5056', '3:2': '5056x3392', '3:4': '3584x4800', '4:3': '4800x3584', '4:5': '3712x4608', '5:4': '4608x3712', '9:16': '3072x5504', '16:9': '5504x3072', '21:9': '6336x2688' },
}
const defaultAlertLevels: AlertLevels = { level1: 10, level2: 6, level3: 1 }
const emptyEmail: EmailConfig = { enabled: false, smtpHost: '', smtpPort: 465, smtpSsl: true, username: '', password: '', sender: '', recipients: '', cooldownMinutes: 60, lastAlertAt: 0 }
const emptyImageParams: ImageParams = { model: 'gpt-image-2', prompt: '一只橘猫坐在未来城市窗边，电影感光影，细节丰富', aspectRatio: '1:1', imageSize: '1K', customSize: '', quality: 'auto', n: 1, responseFormat: 'b64_json', outputFormat: 'png', background: 'auto', timeout: 90 }
const emptyAccount = (): Account => ({ id: 'acct_' + Date.now() + '_' + Math.random().toString(16).slice(2), name: '', baseUrl: 'https://api.duolapi.cn', apiKey: '', textApiKey: '', rememberSecret: true, preset: 'usage_token', endpoint: '/api/usage/token/', paths: 'data.total_available,data.quota,balance', timeout: 12, userId: '', textTestModel: 'gpt-4o-mini', rechargePath: '/wallet', group: 'New API', monitorEnabled: true, autoProbeIntervalMinutes: 0, lowBalanceThreshold: 0, lastAlertLevel: 0 })

function App() {
  const [batchEditor,setBatchEditor]=useState<{type:'levels'|'interval';ids:string[];value:string}|null>(null)
  const [batchError,setBatchError]=useState('')
  const [page, setPage] = useState<Page>('channels')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [draft, setDraft] = useState<Account>(emptyAccount)
  const [selectedId, setSelectedId] = useState<string>('')
  const [results, setResults] = useState<Record<string, ProbeResult>>({})
  const [textResults, setTextResults] = useState<Record<string, TextTestResult>>({})
  const [connectivityResults, setConnectivityResults] = useState<Record<string, ConnectivityResult>>({})
  const [runningAll, setRunningAll] = useState(false)
  const [runningIds, setRunningIds] = useState<Record<string, boolean>>({})
  const [runningTextIds, setRunningTextIds] = useState<Record<string, boolean>>({})
  const [runningDiagIds, setRunningDiagIds] = useState<Record<string, boolean>>({})
  const [alertLevels, setAlertLevels] = useState<AlertLevels>(defaultAlertLevels)
  const [autoProbeInterval, setAutoProbeInterval] = useState(0)
  const [email, setEmail] = useState<EmailConfig>(emptyEmail)
  const [toast, setToast] = useState('就绪')
  const [serviceOffline, setServiceOffline] = useState(false)
  const [configFile, setConfigFile] = useState('')
  const [imageAccountId, setImageAccountId] = useState('')
  const [imageParams, setImageParams] = useState<ImageParams>(emptyImageParams)
  const [models, setModels] = useState<string[]>([])
  const [modelResult, setModelResult] = useState<ModelListResult | null>(null)
  const [imageResult, setImageResult] = useState<ImageTestResult | null>(null)
  const [imageHistory, setImageHistory] = useState<ImageTestResult[]>([])
  const [modelLoading, setModelLoading] = useState(false)
  const [imageLoading, setImageLoading] = useState(false)
  const [channelModalOpen, setChannelModalOpen] = useState(false)
  const [channelModalMode, setChannelModalMode] = useState<ChannelModalMode>('add')
  const [sessions, setSessions] = useState<SessionScan | null>(null)
  const [sessionStatus, setSessionStatus] = useState<SessionActionResult | null>(null)
  const [sessionBusy, setSessionBusy] = useState(false)
  const [history, setHistory] = useState<ProbeHistoryItem[]>([])
  const [historyFile, setHistoryFile] = useState('')
  const [historyBusy, setHistoryBusy] = useState(false)
  const [configInspect, setConfigInspect] = useState<ConfigInspectResult | null>(null)
  const [configInspectBusy, setConfigInspectBusy] = useState(false)
  const [importText, setImportText] = useState('')
  const [importPreview, setImportPreview] = useState<ImportPreviewResult | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importSources, setImportSources] = useState<ImportSourceResult | null>(null)
  const [theme, setTheme] = useState<Theme>('dark')
  const [density, setDensity] = useState<Density>('comfortable')
  const [balancePrecision, setBalancePrecision] = useState(6)
  const [codexTools, setCodexTools] = useState<CodexToolsConfig>(() => defaultCodexTools())
  const [codexStatus, setCodexStatus] = useState<CodexToolStatus | null>(null)
  const [codexEnhancerResult, setCodexEnhancerResult] = useState<CodexEnhancerResult | null>(null)
  const [codexBusy, setCodexBusy] = useState(false)
  const accountsRef = useRef<Account[]>([])
  const emailRef = useRef<EmailConfig>(emptyEmail)
  const alertLevelsRef = useRef<AlertLevels>(defaultAlertLevels)
  const persistQueueRef = useRef<Promise<void>>(Promise.resolve())
  const savingRef = useRef(0)
  const saveEpochRef = useRef(0)
  const probingRef = useRef(new Set<string>())
  const runningAllRef = useRef(false)

  useEffect(() => {
    const onOffline = () => setServiceOffline(true)
    window.addEventListener('radar-service-offline', onOffline)
    return () => window.removeEventListener('radar-service-offline', onOffline)
  }, [])

  async function reconnectService() {
    try {
      const response = await fetch(`${endpoint()}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
      if (!response.ok || !(await response.json()).ok) throw new Error('服务尚未就绪')
      setServiceOffline(false)
      setToast('服务已恢复，请重新探测余额')
    } catch { setToast(SERVICE_OFFLINE) }
  }

  useEffect(() => { accountsRef.current = accounts }, [accounts])
  useEffect(() => { emailRef.current = email }, [email])
  useEffect(() => { alertLevelsRef.current = alertLevels }, [alertLevels])

  const selectedAccount = accounts.find((item) => item.id === selectedId)
  const imageAccount = accounts.find((item) => item.id === imageAccountId) || selectedAccount || accounts[0]
  const summary = useMemo(() => {
    const list = Object.values(results)
    return {
      total: accounts.length,
      ready: accounts.filter(hasProbeCredential).length,
      ok: list.filter((r) => r.ok).length,
      low: list.filter((r) => {
        const account = accounts.find((item) => item.id === r.id)
        return account ? alertLevelOf(r, account, alertLevels) > 0 : false
      }).length,
      fail: list.filter((r) => !r.ok).length,
    }
  }, [accounts, results, alertLevels])

  function syncCredentials(id: string, baseUrl: string, update: CredentialUpdate, expected?: Account) {
    const merge = (item: Account) => {
      if (item.id !== id || item.baseUrl !== baseUrl || Number(item.authVersion || 0) > update.authVersion) return item
      if (expected && (item.apiKey !== expected.apiKey || item.refreshToken !== expected.refreshToken)) return item
      return { ...item, ...update, authChanged: false }
    }
    accountsRef.current = accountsRef.current.map(merge)
    setAccounts(accountsRef.current)
    setDraft((old) => old.authChanged ? old : merge(old))
  }

  async function persist(nextAccounts = accounts, nextEmail = email, nextAlertLevels = alertLevels, nextAutoProbeInterval = autoProbeInterval, allowAccountRemoval = false, nextTheme = theme, nextDensity = density, nextBalancePrecision = balancePrecision, nextCodexTools = codexTools) {
    savingRef.current++
    const epoch = saveEpochRef.current
    const write = persistQueueRef.current.then(() => {
      if(epoch!==saveEpochRef.current)throw new Error('前一次保存发生冲突，已取消排队的旧修改，请核对最新配置后重试')
      return apiCall<{ credentialUpdates?: Array<CredentialUpdate & { id: string; baseUrl: string }> }>('save_config', { accounts: nextAccounts, email: nextEmail, threshold: nextAlertLevels.level1, alertLevels: nextAlertLevels, autoProbeIntervalMinutes: nextAutoProbeInterval, allowAccountRemoval, theme: nextTheme, density: nextDensity, balancePrecision: nextBalancePrecision, codexTools: nextCodexTools })
    }).then((response) => {
      for (const update of response.credentialUpdates || []) syncCredentials(update.id, update.baseUrl, update, nextAccounts.find((a) => a.id === update.id))
    }).catch(async error => {
      if(epoch===saveEpochRef.current){saveEpochRef.current++;await reloadConfig()}
      throw error
    })
    persistQueueRef.current = write.catch(() => undefined)
    try { await write } catch(error) { setToast(String(error));throw error } finally {savingRef.current--}
  }

  function selectAccount(account: Account) {
    setSelectedId(account.id)
    setImageAccountId(account.id)
  }

  function openAddChannel() {
    setDraft(applyPreset(emptyAccount()))
    setChannelModalMode('add')
    setChannelModalOpen(true)
    setToast('填写渠道参数后保存')
  }

  function openEditChannel(account: Account) {
    selectAccount(account)
    setDraft({ ...account, alertLevels: account.alertLevels || (account.lowBalanceThreshold > 0 ? normalizedThresholds(account, alertLevels) : null) })
    setChannelModalMode('edit')
    setChannelModalOpen(true)
    setToast('正在编辑渠道设置')
  }

  async function saveDraft() {
    const fixed = normalizeDraft(draft)
    if (fixed.alertLevels && !validAlertLevels(fixed.alertLevels)) {
      setToast('阈值须满足：一级 > 二级 > 三级，且均为非负数')
      return
    }
    if (!fixed.baseUrl.trim()) {
      setToast('请填写渠道 URL')
      return
    }
    try { resolveRechargeUrl(fixed.baseUrl, fixed.rechargePath) }
    catch (error) { setToast(String(error)); return }
    const exists = accounts.some((item) => item.id === fixed.id)
    const next = exists ? accounts.map((item) => item.id === fixed.id ? fixed : item) : [...accounts, fixed]
    setAccounts(next)
    setSelectedId(fixed.id)
    setImageAccountId(fixed.id)
    setDraft(fixed)
    setResults((old) => { const copy = { ...old }; delete copy[fixed.id]; return copy })
    try { await persist(next) } catch (err) { setToast(`保存失败：${String(err)}`); return }
    setChannelModalOpen(false)
    setToast(exists ? `渠道已更新，${fixed.rememberSecret ? 'PAT 会随配置保存' : 'PAT 仅本次运行保留'}` : `渠道已添加，${fixed.rememberSecret ? 'PAT 会随配置保存' : 'PAT 仅本次运行保留'}`)
  }

  async function deleteDraftAccount() {
    const targetId = draft.id || selectedId
    if (!targetId) return
    const next = accounts.filter((item) => item.id !== targetId)
    setAccounts(next)
    setSelectedId(next[0]?.id || '')
    setImageAccountId(next[0]?.id || '')
    setDraft(next[0] || emptyAccount())
    setResults((old) => { const copy = { ...old }; delete copy[targetId]; return copy })
    await persist(next, email, alertLevels, autoProbeInterval, true)
    setChannelModalOpen(false)
    setToast('渠道已删除')
  }

  async function runProbe(silent = false) {
    const source = accountsRef.current.filter((item) => silent ? item.monitorEnabled !== false : true)
    await runProbeTargets(source, silent ? '自动探测' : '探测', silent)
  }

  async function runProbeTargets(targets: Account[], label: string, silent = false) {
    if (runningAllRef.current) return
    const runnable = targets.filter((item) => hasProbeCredential(item) && !probingRef.current.has(item.id))
    if (!runnable.length) {
      setToast('请先在编辑里给至少一个渠道粘贴 API Key / PAT')
      return
    }
    setRunningAll(true)
    runningAllRef.current = true
    if (!silent) setToast('正在执行' + label + '：' + runnable.length + ' 个渠道')
    try {
      const list: ProbeResult[] = []
      let cursor = 0
      let serviceError: unknown
      await Promise.all(Array.from({ length: Math.min(3, runnable.length) }, async () => {
        while (cursor < runnable.length) {
          if (serviceError) break
          try {
            const result = await fetchAccountBalance(runnable[cursor++])
            if (result) list.push(result)
          } catch (error) { serviceError = error; break }
        }
      }))
      if (serviceError) throw serviceError
      const current = accountsRef.current
      const low = list.filter((r) => {
        const account = current.find((item) => item.id === r.id)
        return account ? alertLevelOf(r, account, alertLevelsRef.current) > 0 : false
      })
      const alertNote = '预警由后台服务处理'
      const skipped = targets.length - runnable.length
      if (page === 'exceptions') loadProbeHistory()
      setToast((silent ? '自动探测完成' : label + '完成') + '：成功 ' + list.filter((r) => r.ok).length + '，失败 ' + list.filter((r) => !r.ok).length + '，预警 ' + low.length + (skipped ? '，跳过 ' + skipped + ' 个未填 Key/停用渠道' : '') + (alertNote ? '，' + alertNote : ''))
    } catch (err) {
      setToast(label + '失败：' + String(err))
    } finally {
      setRunningAll(false)
      runningAllRef.current = false
    }
  }

  async function fetchAccountBalance(target: Account): Promise<ProbeResult | undefined> {
    if (probingRef.current.has(target.id)) return
    probingRef.current.add(target.id)
    setRunningIds((old) => ({ ...old, [target.id]: true }))
    let result: ProbeResult
    try {
      const list = await apiCall<ProbeResult[]>('probe_accounts', { accounts: [target] })
      if (!list[0]) throw new Error('余额接口返回空结果')
      result = list[0]
    } catch (err) {
      if (err instanceof ServiceConnectionError) {
        setResults((old) => { const next = { ...old }; delete next[target.id]; return next })
        throw err
      }
      result = { id: target.id, name: target.name, preset: target.preset, ok: false, status: '失败', balanceNumber: null, balanceDisplay: '', unit: '', httpStatus: 0, endpoint: '', message: String(err), rawSummary: '', elapsedMs: 0, checkedAt: new Date().toISOString() }
    } finally {
      probingRef.current.delete(target.id)
      setRunningIds((old) => ({ ...old, [target.id]: false }))
    }
    const current = accountsRef.current.find((item) => item.id === target.id)
    if (!current || ['baseUrl', 'apiKey', 'refreshToken', 'userId', 'preset', 'endpoint', 'paths'].some((key) => current[key as keyof Account] !== target[key as keyof Account])) return
    if (result.credentialUpdate) syncCredentials(target.id, target.baseUrl, result.credentialUpdate, target)
    delete result.credentialUpdate
    setResults((old) => ({ ...old, [result.id]: result }))
    return result
  }

  async function runProbeForAccount(account: Account, silent = false) {
    const target = accountsRef.current.find((item) => item.id === account.id) || account
    if (!hasProbeCredential(target)) {
      setToast('请先在编辑里粘贴该渠道的 API Key / PAT')
      return
    }
    if (!silent) setToast(`正在探测：${target.baseUrl}`)
    try {
      const result = await fetchAccountBalance(target)
      if (result) {
        const alertNote = '预警由后台服务处理'
        if (!silent) setToast(`${target.baseUrl} 探测完成：${statusOf(result, target, alertLevels)}${alertNote ? `，${alertNote}` : ''}`)
      }
    } catch (err) {
      setToast(`渠道探测失败：${String(err)}`)
    }
  }

  async function runTextTestForAccount(account: Account) {
    const target = accountsRef.current.find((item) => item.id === account.id) || account
    if (!(target.textApiKey || target.apiKey).trim()) { setToast('文本测试需要文本 API Key 或余额 Key'); return }
    setRunningTextIds((old) => ({ ...old, [target.id]: true }))
    setToast(`正在测试文本连接：${target.baseUrl}`)
    try {
      const result = await apiCall<TextTestResult>('test_text', { account: target })
      setTextResults((old) => ({ ...old, [target.id]: result }))
      setToast(`${target.baseUrl} 文本测试：${result.message}`)
    } catch (err) {
      setToast(`文本测试失败：${String(err)}`)
    } finally {
      setRunningTextIds((old) => ({ ...old, [target.id]: false }))
    }
  }

  async function runConnectivityForAccount(account: Account) {
    const target = accountsRef.current.find((item) => item.id === account.id) || account
    setRunningDiagIds((old) => ({ ...old, [target.id]: true }))
    setToast(`正在诊断连接：${target.baseUrl}`)
    try {
      const result = await apiCall<ConnectivityResult>('test_connectivity', { account: target })
      setConnectivityResults((old) => ({ ...old, [target.id]: result }))
      const failed = result.steps.filter((step) => !step.ok).length
      setToast(`${target.baseUrl} 连接诊断完成：${result.steps.length - failed}/${result.steps.length} 可达`)
    } catch (err) {
      setToast(`连接诊断失败：${String(err)}`)
    } finally {
      setRunningDiagIds((old) => ({ ...old, [target.id]: false }))
    }
  }

  function openRecharge(account: Account) {
    try {
      const url = resolveRechargeUrl(normalizeBaseUrlInput(account.baseUrl), account.rechargePath)
      if (desktop) void openUrl(url).catch(e=>setToast(String(e))); else window.open(url, '_blank', 'noopener,noreferrer')
      setToast('已打开充值页：' + url)
    } catch (error) { setToast(String(error)) }
  }


  function targetsFromIds(ids: string[]) {
    const idSet = new Set(ids)
    return accountsRef.current.filter((account) => idSet.has(account.id))
  }

  async function persistAccounts(next: Account[], message: string, allowAccountRemoval = false) {
    setAccounts(next)
    await persist(next, emailRef.current, alertLevelsRef.current, autoProbeInterval, allowAccountRemoval)
    setToast(message)
  }

  async function runBatchProbe(ids: string[]) {
    const targets = targetsFromIds(ids).filter((account) => account.monitorEnabled !== false)
    if (!targets.length) { setToast('请选择要批量探测的渠道'); return }
    await runProbeTargets(targets, '批量探测')
  }

  async function runBatchDiagnostics(ids: string[]) {
    const targets = targetsFromIds(ids)
    if (!targets.length) { setToast('请选择要批量诊断的渠道'); return }
    setToast('正在批量诊断：' + targets.length + ' 个渠道')
    let cursor = 0
    let success = 0
    let fail = 0
    try {
      await Promise.all(Array.from({ length: Math.min(3, targets.length) }, async () => {
        while (cursor < targets.length) {
          const target = targets[cursor++]
          setRunningDiagIds((old) => ({ ...old, [target.id]: true }))
          try {
            const result = await apiCall<ConnectivityResult>('test_connectivity', { account: target })
            setConnectivityResults((old) => ({ ...old, [target.id]: result }))
            if (result.ok) success++; else fail++
          } catch {
            fail++
          } finally {
            setRunningDiagIds((old) => ({ ...old, [target.id]: false }))
          }
        }
      }))
      setToast('批量诊断完成：成功 ' + success + '，异常 ' + fail)
    } catch (err) {
      setToast('批量诊断失败：' + String(err))
    }
  }

  function batchSetThresholds(ids:string[]){setBatchError('');setBatchEditor({type:'levels',ids,value:Object.values(alertLevels).join(',')})}
  function batchSetInterval(ids:string[]){setBatchError('');setBatchEditor({type:'interval',ids,value:'30'})}
  async function commitBatchEditor(){
    if(!batchEditor)return
    const ids=new Set(batchEditor.ids)
    const values=batchEditor.value.split(/[,，/\s]+/).map(Number)
    let next:Account[]
    if(batchEditor.type==='levels'){
      const levels={level1:values[0],level2:values[1],level3:values[2]}
      if(values.length!==3||!validAlertLevels(levels)){setBatchError('请输入一级 > 二级 > 三级的三个非负数');return}
      next=accountsRef.current.map(a=>ids.has(a.id)?{...a,alertLevels:levels,lowBalanceThreshold:0,lastAlertLevel:0}:a)
    }else{
      const minutes=Number(batchEditor.value)
      if(!Number.isFinite(minutes)||minutes<0||minutes>10080){setBatchError('间隔须为 0 至 10080 分钟');return}
      next=accountsRef.current.map(a=>ids.has(a.id)?{...a,autoProbeIntervalMinutes:minutes}:a)
    }
    try{await persistAccounts(next,'批量设置已保存');setBatchEditor(null)}catch(e){setBatchError(String(e))}
  }

  async function loadProbeHistory() {
    setHistoryBusy(true)
    try {
      const data = await apiCall<ProbeHistoryResponse>('probe_history')
      setHistory(data.items || [])
      setHistoryFile(data.historyFile || '')
    } catch (err) {
      setToast('探测历史读取失败：' + String(err))
    } finally {
      setHistoryBusy(false)
    }
  }

  async function clearProbeHistory() {
    setHistoryBusy(true)
    try {
      await apiCall('clear_probe_history', {})
      setHistory([])
      setToast('探测历史已清空')
    } catch (err) {
      setToast('清空历史失败：' + String(err))
    } finally {
      setHistoryBusy(false)
    }
  }

  async function loadConfigInspect() {
    setConfigInspectBusy(true)
    try {
      setConfigInspect(await apiCall<ConfigInspectResult>('config_inspect'))
    } catch (err) {
      setToast('配置查看失败：' + String(err))
    } finally {
      setConfigInspectBusy(false)
    }
  }

  async function previewImportConfig() {
    if (!importText.trim()) { setToast('请先粘贴 Codex-X / CC Switch / JSON 配置内容'); return }
    setImportBusy(true)
    try {
      const data = await apiCall<ImportPreviewResult>('import_preview', { text: importText })
      setImportPreview({ ...data, accounts: (data.accounts || []).map((account) => normalizeLoadedAccount(account)) })
      setToast('已识别 ' + (data.count || 0) + ' 个候选渠道')
    } catch (err) {
      setToast('导入预览失败：' + String(err))
    } finally {
      setImportBusy(false)
    }
  }

  async function scanImportConfig() {
    setImportBusy(true)
    try { const data = await apiCall<ImportSourceResult>('import_sources'); setImportSources(data); setImportPreview({ count: data.count, accounts: data.accounts.map((account) => normalizeLoadedAccount(account)) }); setToast(`已扫描 ${data.count} 个候选渠道`) }
    catch (err) { setToast('一键扫描失败：' + String(err)) } finally { setImportBusy(false) }
  }

  async function commitImportConfig() {
    const candidates = (importPreview?.accounts || []).map((account) => normalizeLoadedAccount(account))
    if (!candidates.length) { setToast('没有可导入渠道'); return }
    const seen = new Set(accountsRef.current.map((account) => channelIdentity(account)))
    const incoming = candidates.filter((account) => {
      const key = channelIdentity(account)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (!incoming.length) { setToast('候选渠道均已存在'); return }
    const next = [...accountsRef.current, ...incoming]
    setAccounts(next)
    setSelectedId(incoming[0].id)
    setImageAccountId(incoming[0].id)
    await persist(next)
    setToast('已导入 ' + incoming.length + ' 个渠道，相同地址与凭据已合并')
  }

  async function oneClickImportConfig() {
    setImportBusy(true)
    try {
      const data = await apiCall<ImportSourceResult>('import_sources')
      const candidates = (data.accounts || []).map((account) => normalizeLoadedAccount(account))
      setImportSources({ ...data, accounts: candidates })
      setImportPreview({ count: data.count || candidates.length, accounts: candidates })
      if (!candidates.length) { setToast('未扫描到可导入渠道'); return }
      const seen = new Set(accountsRef.current.map((account) => channelIdentity(account)))
      const incoming = candidates.filter((account) => {
        const key = channelIdentity(account)
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (!incoming.length) { setToast('已扫描 ' + candidates.length + ' 个候选渠道，均已在列表中'); return }
      const next = [...accountsRef.current, ...incoming]
      setAccounts(next)
      setSelectedId(incoming[0].id)
      setImageAccountId(incoming[0].id)
      await persist(next)
      setToast('一键导入完成：新增 ' + incoming.length + ' 个渠道，相同地址与凭据已合并')
    } catch (err) {
      setToast('一键导入失败：' + String(err))
    } finally {
      setImportBusy(false)
    }
  }

  async function saveEmail() {
    const next = { ...email, smtpPort: Number(email.smtpPort || 465), cooldownMinutes: Math.max(0, Number(email.cooldownMinutes || 0)) }
    setEmail(next)
    try {
      await persist(accounts, next)
      setToast(next.enabled && !next.password.trim() ? '邮箱设置已保存；请补填 SMTP 授权码，预警邮件才可发送' : '邮箱提醒设置已保存')
    } catch (error) { setToast(`邮箱设置保存失败：${String(error)}`) }
  }

  async function testEmail() {
    try {
      setToast('正在发送测试邮件')
      await apiCall('send_email', { config: email, subject: '上游余额雷达测试邮件', body: '这是一封测试邮件。收到它表示 SMTP 配置可用。' })
      setToast('测试邮件已发送')
    } catch (err) {
      setToast(`测试邮件失败：${String(err)}`)
    }
  }

  function updateAccountKey(id: string, apiKey: string) {
    setAccounts((old) => old.map((item) => item.id === id ? { ...item, apiKey } : item))
    if (draft.id === id) setDraft((old) => ({ ...old, apiKey }))
  }

  function goImageTest(account?: Account) {
    if (account) {
      setImageAccountId(account.id)
      setSelectedId(account.id)
      setDraft({ ...account })
    }
    setChannelModalOpen(false)
    setPage('image')
  }

  async function fetchModels() {
    if (!imageAccount) {
      setToast('请先添加并选择一个渠道')
      return
    }
    if (!(imageAccount.textApiKey || imageAccount.apiKey).trim()) {
      setToast('请先给该渠道粘贴 API Key / PAT')
      return
    }
    setModelLoading(true)
    setToast('正在获取模型列表')
    try {
      const result = await apiCall<ModelListResult>('list_models', { account: imageAccount })
      const modelList = result.models || []
      setModelResult(result)
      setModels(modelList)
      const preferred = pickImageModel([...builtinImageModels, ...modelList])
      if (preferred) setImageParams((old) => ({ ...old, model: !old.model || old.model === emptyImageParams.model ? preferred : old.model }))
      setToast(result.message || '模型列表已更新')
    } catch (err) {
      setToast(`获取模型失败：${String(err)}`)
    } finally {
      setModelLoading(false)
    }
  }

  async function runImageTest() {
    if (!imageAccount) {
      setToast('请先添加并选择一个渠道')
      return
    }
    if (!(imageAccount.textApiKey || imageAccount.apiKey).trim()) {
      setToast('请先给该渠道粘贴 API Key / PAT')
      return
    }
    const size = resolveImageSize(imageParams)
    setImageLoading(true)
    setToast('正在调用生图接口')
    try {
      const result = await apiCall<ImageTestResult>('generate_image_test', { request: { account: imageAccount, model: imageParams.model, prompt: imageParams.prompt, size, quality: imageParams.quality, n: Number(imageParams.n || 1), responseFormat: imageParams.responseFormat, outputFormat: imageParams.outputFormat, background: imageParams.background, timeout: Number(imageParams.timeout || 90) } })
      setImageResult(result)
      setImageHistory((old) => [...(result.images?.length ? result.images.map(image=>({...result,...image,images:undefined})) : [result]), ...old].slice(0,36))
      setToast(result.message || '生图测试完成')
    } catch (err) {
      setToast(`生图测试失败：${String(err)}`)
    } finally {
      setImageLoading(false)
    }
  }

  async function saveSettings() {
    if (!validAlertLevels(alertLevels)) { setToast('阈值须满足：一级 > 二级 > 三级，且均为非负数'); return }
    await persist(accounts, email, alertLevels, autoProbeInterval, false, theme, density, balancePrecision, codexTools)
    loadConfigInspect()
    setToast('设置已保存')
  }

  async function saveCodexTools(next = codexTools) {
    const fixed = normalizeCodexTools(next)
    setCodexTools(fixed)
    await apiCall('save_codex_tools',{tools:fixed})
    setToast('Codex 增强配置已保存；点击安装并注入后在 Codex 生效')
  }

  async function loadCodexToolStatus() {
    try {
      const status=await apiCall<CodexToolStatus>('codex_tools_status');setCodexStatus(status);if(status.tools)setCodexTools(status.tools)
    } catch (err) { setToast('Codex 增强状态读取失败：' + String(err)) }
  }

  async function reloadConfig() {
    try {
      setToast('正在重新加载渠道配置')
      const cfg = await apiCall<AppConfig>('load_config')
      const loaded = (cfg.accounts || []).map((item) => normalizeLoadedAccount(item))
      accountsRef.current = loaded
      setAccounts(loaded)
      if (loaded.length && !loaded.some((item) => item.id === selectedId)) {
        setSelectedId(loaded[0].id)
        setImageAccountId(loaded[0].id)
        setDraft(loaded[0])
      }
      setEmail({ ...emptyEmail, ...(cfg.email || {}) })
      setAlertLevels(normalizeAlertLevels(cfg.alertLevels, cfg.threshold))
      if (typeof cfg.autoProbeIntervalMinutes === 'number') setAutoProbeInterval(cfg.autoProbeIntervalMinutes)
      setTheme(normalizeTheme(cfg.theme))
      setDensity(normalizeDensity(cfg.density))
      setBalancePrecision(normalizePrecision(cfg.balancePrecision))
      if(!isRemote()) setCodexTools(normalizeCodexTools(cfg.codexTools))
      setToast(`已重新加载 ${loaded.length} 个渠道`)
    } catch (err) {
      setToast(`重新加载配置失败：${String(err)}`)
    }
  }

  async function loadSessions() {
    try {
      setSessionBusy(true)
      const scan = await apiCall<SessionScan>('scan_sessions')
      setSessions(scan)
      setToast(`已扫描 ${scan.scannedFiles} 个会话文件`)
    } catch (err) {
      setToast(`会话扫描失败：${String(err)}`)
    } finally {
      setSessionBusy(false)
    }
  }

  async function runSessionAction(action: 'sync_sessions' | 'repair_sessions' | 'export_sessions') {
    try {
      setSessionBusy(true)
      const result = await apiCall<SessionActionResult>(action)
      setSessionStatus(result)
      setToast(result.message)
      if (action !== 'export_sessions') {
        const scan = await apiCall<SessionScan>('scan_sessions')
        setSessions(scan)
      }
    } catch (err) {
      setToast(`会话操作失败：${String(err)}`)
    } finally {
      setSessionBusy(false)
    }
  }

  async function deleteSessionItem(relativePath: string) {
    try {
      setSessionBusy(true)
      const result = await apiCall<SessionActionResult>('delete_session', { relativePath })
      setSessionStatus(result)
      setToast(result.message)
      await loadSessions()
    } catch (err) {
      setToast(`删除会话失败：${String(err)}`)
      setSessionBusy(false)
    }
  }

  async function restoreDeletedSessionItem() {
    try {
      setSessionBusy(true)
      const result = await apiCall<SessionActionResult>('restore_deleted_session', {})
      setSessionStatus(result)
      setToast(result.message)
      await loadSessions()
    } catch (err) {
      setToast(`恢复会话失败：${String(err)}`)
      setSessionBusy(false)
    }
  }

  async function exportCodexEnhancerPackage() {
    const fixed = normalizeCodexTools(codexTools)
    try {
      setCodexBusy(true)
      await apiCall('save_codex_tools',{tools:fixed})
      const result = await apiCall<CodexEnhancerResult>('export_codex_enhancer', { tools: fixed })
      setCodexEnhancerResult(result)
      setToast(`${result.message}，模型 ${result.modelCount} 个`)
      loadCodexToolStatus()
    } catch (err) { setToast('页面增强脚本生成失败：' + String(err)) }
    finally { setCodexBusy(false) }
  }

  async function applyCodexEnhancerPackage() {
    const fixed = normalizeCodexTools(codexTools)
    try {
      setCodexBusy(true)
      await apiCall('save_codex_tools',{tools:fixed})
      const result = await apiCall<CodexEnhancerResult>('apply_codex_enhancer', { tools: fixed, launch: true, restartExisting: true })
      setCodexEnhancerResult(result)
      setToast(result.message)
      loadCodexToolStatus()
    } catch (err) { setToast('页面增强安装 / 注入失败：' + String(err)) }
    finally { setCodexBusy(false) }
  }



  useEffect(() => {
    apiCall<AppConfig>('load_config').then((cfg) => {
      const loaded = (cfg.accounts || []).map((item) => normalizeLoadedAccount(item))
      setAccounts(loaded)
      if (loaded[0]) {
        setSelectedId(loaded[0].id)
        setImageAccountId(loaded[0].id)
        setDraft(loaded[0])
      }
      setEmail({ ...emptyEmail, ...(cfg.email || {}) })
      setAlertLevels(normalizeAlertLevels(cfg.alertLevels, cfg.threshold))
      if (typeof cfg.autoProbeIntervalMinutes === 'number') setAutoProbeInterval(cfg.autoProbeIntervalMinutes)
      setTheme(normalizeTheme(cfg.theme))
      setDensity(normalizeDensity(cfg.density))
      setBalancePrecision(normalizePrecision(cfg.balancePrecision))
      if(!isRemote()) setCodexTools(normalizeCodexTools(cfg.codexTools))
      setToast('已加载保存的渠道配置')
    }).catch((err) => setToast(`配置加载失败：${String(err)}`))
    apiCall<string>('config_path').then(setConfigFile).catch(() => setConfigFile(''))
  }, [])

  useEffect(() => {
    if (page === 'sessions' && !sessions && !sessionBusy) loadSessions()
    if (page === 'exceptions' && !historyBusy) loadProbeHistory()
    if (page === 'settings' && !configInspect && !configInspectBusy) loadConfigInspect()
    if (page === 'codex' && !codexStatus && !codexBusy) loadCodexToolStatus()
  }, [page])

  useEffect(() => {
    if(page!=='channels'||channelModalOpen||batchEditor)return
    const timer=setInterval(async()=>{if(savingRef.current||runningAllRef.current)return;try{const v=await apiCall<{revision:number}>('config_version');if(v.revision!==configRevision)await reloadConfig()}catch{}},5000)
    return()=>clearInterval(timer)
  },[page,channelModalOpen,batchEditor])

  useEffect(() => {
    let active = true
    let previousError = ''
    const poll = async () => {
      try {
        const state = await apiCall<{ results: Record<string, ProbeResult>; lastError?: string; lastSyncError?: string }>('monitor_status')
        if (active) {
          setResults(Object.fromEntries(accountsRef.current.map(a=>[a.id,state.results[a.id]]).filter(([,r])=>r)))
          const error = state.lastError || state.lastSyncError || ''
          if (error !== previousError) {
            const clearedError = previousError
            previousError = error
            if (error) setToast(error)
            else setToast(current => current === clearedError ? '后台异常已解除' : current)
          }
        }
      } catch {}
    }
    poll()
    const timer = window.setInterval(poll, 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  return (
    <main className={"app-shell theme-" + theme + " density-" + density}>
      <aside className="nav-panel">
        <div className="brand-block"><span className="brand-mark">UB</span><div><strong>上游余额雷达</strong><small>Web 控制台</small></div></div>
        <nav className="nav-list" aria-label="主导航">
          {navItems.filter(item=>!isRemote()||!['sessions','codex'].includes(item.page)).map((item) => <NavItem key={item.page} item={item} current={page} onClick={setPage} />)}
        </nav>
        <div className="nav-footer"><StatusLine label="渠道" value={`${summary.total}`} /><StatusLine label="已填 Key" value={`${summary.ready}`} /><StatusLine label="自动探测" value={autoProbeInterval > 0 ? `${autoProbeInterval} 分钟` : '按渠道设置'} /></div>
      </aside>
      <section className={`content-shell page-${page}`}>
        <label className="mobile-navigation">功能页<select aria-label="功能页" value={page} onChange={e=>setPage(e.target.value as Page)}>{navItems.filter(item=>!isRemote()||!['sessions','codex'].includes(item.page)).map(item=><option key={item.page} value={item.page}>{item.title}</option>)}</select></label>
        {serviceOffline && <div role="alert" className="service-offline"><div><strong>余额雷达服务离线</strong><p>{SERVICE_OFFLINE}</p><small>当前页面未连接到后端，余额状态待重新查询。</small></div><button className="ghost" onClick={reconnectService}>重新连接服务</button></div>}
        {page === 'channels' && <div className="channel-feedback" role="status">{toast}</div>}
        <div className="connection-toolbar"><span>{isRemote()?'服务器工作区':'本机工作区'}</span>{desktop?<button className="ghost" onClick={()=>setPage('settings')}>服务器同步</button>:<button className="ghost" onClick={()=>void logoutConnection().catch(e=>setToast(String(e)))}>退出登录</button>}</div>
        {page !== 'channels' && <header className="topbar"><div><p className="eyebrow">Web Balance Operations</p><h1>{pageTitle(page)}</h1></div><div className="toast-pill" title={toast}>{toast}</div></header>}
        {page === 'channels' && <ChannelPage accounts={accounts} selectedId={selectedId} results={results} textResults={textResults} connectivityResults={connectivityResults} alertLevels={alertLevels} balancePrecision={balancePrecision} runningAll={runningAll} runningIds={runningIds} runningTextIds={runningTextIds} runningDiagIds={runningDiagIds} selectAccount={selectAccount} openAddChannel={openAddChannel} openEditChannel={openEditChannel} runProbe={runProbe} runProbeForAccount={runProbeForAccount} runTextTestForAccount={runTextTestForAccount} runConnectivityForAccount={runConnectivityForAccount} openRecharge={openRecharge} goImageTest={goImageTest} reloadConfig={reloadConfig} runBatchProbe={runBatchProbe} runBatchDiagnostics={runBatchDiagnostics} batchSetThresholds={batchSetThresholds} batchSetInterval={batchSetInterval} importBusy={importBusy} oneClickImport={oneClickImportConfig} />}
        {page === 'image' && <ImagePage accounts={accounts} selectedId={imageAccountId} selectedAccount={imageAccount} params={imageParams} models={models} modelResult={modelResult} imageResult={imageResult} imageHistory={imageHistory} modelLoading={modelLoading} imageLoading={imageLoading} setSelectedId={setImageAccountId} setParams={setImageParams} updateAccountKey={updateAccountKey} fetchModels={fetchModels} runImageTest={runImageTest} goChannels={() => setPage('channels')} />}
        {page === 'exceptions' && <ExceptionPage history={history} accounts={accounts} busy={historyBusy} file={historyFile} refresh={loadProbeHistory} clear={clearProbeHistory} />}
        {page === 'sessions' && <SessionPage sessions={sessions} status={sessionStatus} busy={sessionBusy} scan={loadSessions} sync={() => runSessionAction('sync_sessions')} repair={() => runSessionAction('repair_sessions')} exportMd={() => runSessionAction('export_sessions')} deleteSession={deleteSessionItem} restoreDeleted={restoreDeletedSessionItem} />}
        {page === 'import' && <ImportPage text={importText} setText={setImportText} preview={importPreview} sources={importSources} busy={importBusy} runPreview={previewImportConfig} scan={scanImportConfig} commit={commitImportConfig} />}
        {page === 'codex' && <CodexToolsPage tools={codexTools} status={codexStatus} enhancerResult={codexEnhancerResult} busy={codexBusy} setTools={setCodexTools} saveTools={saveCodexTools} refreshStatus={loadCodexToolStatus} exportEnhancer={exportCodexEnhancerPackage} applyEnhancer={applyCodexEnhancerPackage} />}
        {page === 'email' && <EmailPage email={email} setEmail={setEmail} saveEmail={saveEmail} testEmail={testEmail} />}
        {page === 'settings' && <SettingsPage alertLevels={alertLevels} autoProbeInterval={autoProbeInterval} configFile={configFile} theme={theme} density={density} balancePrecision={balancePrecision} configInspect={configInspect} configInspectBusy={configInspectBusy} setAlertLevels={setAlertLevels} setAutoProbeInterval={setAutoProbeInterval} setTheme={setTheme} setDensity={setDensity} setBalancePrecision={setBalancePrecision} saveSettings={saveSettings} refreshConfigInspect={loadConfigInspect} />}
        {page === 'settings' && !isRemote() && <SyncPanel onSynced={()=>void reloadConfig()} />}
        {page === 'settings' && !desktop && <PasswordPanel />}
      </section>
      {batchEditor&&<div className="modal-backdrop"><section role="dialog" aria-label="批量设置" className="modal-card"><h2>{batchEditor.type==='levels'?'批量设置三级阈值':'批量设置自动探测间隔'}</h2><p>作用于所选 {batchEditor.ids.length} 个渠道。</p><Field label={batchEditor.type==='levels'?'三级阈值（逗号分隔）':'间隔分钟'} value={batchEditor.value} onChange={value=>setBatchEditor({...batchEditor,value})}/>{batchError&&<p role="alert">{batchError}</p>}<div className="button-row"><button onClick={()=>setBatchEditor(null)}>取消</button><button onClick={commitBatchEditor}>保存批量设置</button></div></section></div>}
      <ChannelModal open={channelModalOpen} mode={channelModalMode} draft={draft} levels={alertLevels} setDraft={setDraft} onClose={() => setChannelModalOpen(false)} onSave={saveDraft} onDelete={deleteDraftAccount} />
    </main>
  )
}

function ChannelPage(props: { accounts: Account[]; selectedId: string; results: Record<string, ProbeResult>; textResults: Record<string, TextTestResult>; connectivityResults: Record<string, ConnectivityResult>; alertLevels: AlertLevels; balancePrecision: number; runningAll: boolean; importBusy: boolean; runningIds: Record<string, boolean>; runningTextIds: Record<string, boolean>; runningDiagIds: Record<string, boolean>; selectAccount: (account: Account) => void; openAddChannel: () => void; openEditChannel: (account: Account) => void; runProbe: (silent?: boolean) => void; runProbeForAccount: (account: Account) => void; runTextTestForAccount: (account: Account) => void; runConnectivityForAccount: (account: Account) => void; openRecharge: (account: Account) => void; goImageTest: (account?: Account) => void; reloadConfig: () => void; oneClickImport: () => void; runBatchProbe: (ids: string[]) => void; runBatchDiagnostics: (ids: string[]) => void; batchSetThresholds: (ids: string[]) => void; batchSetInterval: (ids: string[]) => void }) {
  const { accounts, selectedId, results, textResults, connectivityResults, alertLevels, balancePrecision, runningAll, importBusy, runningIds, runningTextIds, runningDiagIds, selectAccount, openAddChannel, openEditChannel, runProbe, runProbeForAccount, runTextTestForAccount, runConnectivityForAccount, openRecharge, goImageTest, reloadConfig, oneClickImport, runBatchProbe, runBatchDiagnostics, batchSetThresholds, batchSetInterval } = props
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const rows = useMemo(() => accounts.map((account, index) => ({ account, index })), [accounts])
  const visibleIds = rows.map(({ account }) => account.id)
  const selectedVisible = selectedIds.filter((id) => visibleIds.includes(id))
  const targetIds = selectedVisible.length ? selectedVisible : visibleIds
  const selectedAccount = selectedId ? accounts.find((account) => account.id === selectedId) : undefined
  const toggleOne = (id: string) => setSelectedIds((old) => old.includes(id) ? old.filter((x) => x !== id) : [...old, id])
  const toggleVisible = () => setSelectedIds((old) => selectedVisible.length === visibleIds.length ? old.filter((id) => !visibleIds.includes(id)) : Array.from(new Set([...old, ...visibleIds])))
  return <section className="channel-layout">
    <section className="card channel-table-card">
      <div className="card-head horizontal channel-list-head">
        <div className="channel-list-title"><h2>渠道列表</h2><p>已选 {selectedVisible.length} 个；未选择时作用于全部 {visibleIds.length} 个渠道。</p></div>
        <div className="list-toolbar" role="toolbar" aria-label="渠道管理操作">
          <button className="primary" onClick={openAddChannel}>新增渠道</button>
          {!isRemote()&&<button className="ghost" disabled={importBusy} onClick={oneClickImport}>{importBusy ? '导入中' : '一键导入'}</button>}
          <button className="ghost" onClick={reloadConfig}>重载配置</button>
          <button className="ghost" disabled={runningAll} onClick={() => runProbe(false)}>{runningAll ? '探测中' : '开始探测'}</button>
          <button className="ghost" onClick={() => goImageTest(selectedAccount)}>生图测试</button>
          <button className="ghost" disabled={!targetIds.length || runningAll} onClick={() => runBatchProbe(targetIds)}>批量探测</button>
          <button className="ghost" disabled={!targetIds.length} onClick={() => runBatchDiagnostics(targetIds)}>批量诊断</button>
          <button className="ghost" disabled={!targetIds.length} onClick={() => batchSetThresholds(targetIds)}>设置阈值</button>
          <button className="ghost" disabled={!targetIds.length} onClick={() => batchSetInterval(targetIds)}>设置间隔</button>
        </div>
        <span className="table-count">共 {accounts.length} 个渠道</span>
      </div>
      <table className="channel-table"><thead><tr><th><input aria-label="选择全部渠道" type="checkbox" checked={visibleIds.length > 0 && selectedVisible.length === visibleIds.length} onChange={toggleVisible} /></th><th>序号</th><th>渠道网址</th><th>渠道余额</th><th>操作</th></tr></thead><tbody>
        {accounts.length === 0 && <tr><td colSpan={5} className="empty"><strong>还没有渠道</strong><span>点击上方“新增渠道”或“一键导入”开始配置。</span></td></tr>}
        {rows.map(({ account, index }) => {
          const result = results[account.id]
          const textResult = textResults[account.id]
          const diagResult = connectivityResults[account.id]
          const status = result ? statusOf(result, account, alertLevels) : '待探测'
          return <tr key={account.id} className={(selectedId === account.id ? 'selected ' : '') + rowClassForStatus(status)} onClick={() => selectAccount(account)}>
            <td><input aria-label={'选择渠道 ' + (account.name || account.baseUrl)} type="checkbox" checked={selectedIds.includes(account.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggleOne(account.id)} /></td>
            <td className="row-index">{index + 1}</td>
            <td><div className="channel-url-cell" title={[account.baseUrl, account.name].filter(Boolean).join('\n')}><strong>{account.baseUrl}</strong><small><span className="type-badge">{channelGroupForAccount(account)}</span>{account.name && normalizeBaseUrlInput(account.name) !== normalizeBaseUrlInput(account.baseUrl) ? ' ' + account.name : ''} · 预警线 {Object.values(normalizedThresholds(account, alertLevels)).map((v) => formatNumber(v, balancePrecision)).join(' / ')}{textResult ? ' · 文本' + (textResult.ok ? 'OK' : '失败' + (textResult.httpStatus ? ' ' + textResult.httpStatus : '')) : ''}{diagResult ? ' · 诊断' + diagResult.steps.filter((s) => s.ok).length + '/' + diagResult.steps.length : ''}</small></div></td>
            <td><BalanceCell account={account} result={result} alertLevels={alertLevels} running={!!runningIds[account.id]} precision={balancePrecision} /></td>
            <td><div className="channel-actions" role="group" aria-label="渠道操作">
              <ChannelAction icon="text" label="文本测试" busyLabel="测试中" busy={!!runningTextIds[account.id]} onClick={() => runTextTestForAccount(account)} />
              <ChannelAction icon="diagnose" label="诊断" busyLabel="诊断中" busy={!!runningDiagIds[account.id]} onClick={() => runConnectivityForAccount(account)} />
              <ChannelAction icon="image" label="生图测试" onClick={() => goImageTest(account)} />
              <ChannelAction icon="recharge" label="充值" onClick={() => openRecharge(account)} />
              <ChannelAction icon="probe" label="余额探测" busyLabel="探测中" busy={!!runningIds[account.id]} onClick={() => runProbeForAccount(account)} />
              {!isRemote()&&<ChannelAction icon="switch" label="设为 Codex 供应商" onClick={async () => { try { const r = await apiCall<{message: string}>('switch_provider', { account, id: account.id }); window.alert(r.message) } catch(e) { window.alert(String(e)) } }} />}
              <ChannelAction icon="edit" label="编辑" onClick={() => openEditChannel(account)} />
            </div></td>
          </tr>
        })}
      </tbody></table>
    </section>
  </section>
}

function SessionPage(props: { sessions: SessionScan | null; status: SessionActionResult | null; busy: boolean; scan: () => void; sync: () => void; repair: () => void; exportMd: () => void; deleteSession: (relativePath: string) => void; restoreDeleted: () => void }) {
  const { sessions, status, busy, scan, sync, repair, exportMd, deleteSession, restoreDeleted } = props
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('全部')
  const projects = useMemo(() => ['全部', ...Array.from(new Set((sessions?.sessions || []).map(sessionProjectName).filter(Boolean)))], [sessions])
  const items = useMemo(() => (sessions?.sessions || []).filter((item) => (project === '全部' || sessionProjectName(item) === project) && sessionMatches(item, query)), [sessions, project, query])
  return <section className="session-layout">
    <div className="metric-row"><Metric title="会话文件" value={sessions?.scannedFiles || 0} tone="blue" /><Metric title="消息数" value={sessions?.totalMessages || 0} tone="green" /><Metric title="异常文件" value={sessions?.invalidFiles || 0} tone="red" /><Metric title="JSONL 行" value={sessions?.totalLines || 0} tone="violet" /></div>
    <section className="card operations-card">
      <div><h2>会话控制台</h2><p>{sessions ? '路径：' + sessions.rootDir : '扫描本地 Codex 会话目录，支持搜索、项目筛选、同步、导出和异常修复。'}</p></div>
      <div className="toolbar-actions"><button className="primary" disabled={busy} onClick={scan}>{busy ? '处理中' : '扫描会话'}</button><button className="ghost" disabled={busy} onClick={sync}>对话同步</button><button className="ghost" disabled={busy} onClick={exportMd}>导出 Markdown</button><button className="ghost" disabled={busy} onClick={restoreDeleted}>恢复最近删除</button><button className="danger" disabled={busy} onClick={repair}>对话修复</button></div>
    </section>
    <section className="card filter-card"><div className="filter-row"><label><span>搜索会话</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="标题 / 摘要 / 模型 / 文件" /></label><label><span>项目筛选</span><select value={project} onChange={(e) => setProject(e.target.value)}>{projects.map((name) => <option key={name} value={name}>{name}</option>)}</select></label></div></section>
    {status && <section className={'card session-status ' + (status.ok ? 'ok' : 'fail')}><strong>{status.message}</strong>{status.backupDir && <span>备份目录：{status.backupDir}</span>}{status.exportDir && <span>导出目录：{status.exportDir}</span>}</section>}
    <section className="card channel-table-card">
      <div className="card-head horizontal"><div><h2>最近会话</h2><p>最多显示最近 300 个 JSONL 会话，修复前会自动备份。</p></div><span className="table-count">显示 {items.length}</span></div>
      <table className="session-table"><thead><tr><th>更新时间</th><th>标题 / 摘要</th><th>项目</th><th>消息</th><th>异常行</th><th>大小</th><th>文件</th><th>操作</th></tr></thead><tbody>
        {!items.length && <tr><td colSpan={8} className="empty"><strong>暂无会话数据</strong><span>点击扫描会话读取本地 Codex sessions。</span></td></tr>}
        {items.map((item) => <tr key={item.relativePath} className={item.invalidLines > 0 ? 'fail' : ''}>
          <td>{formatDateTime(item.updatedAt)}</td>
          <td><div className="channel-url-cell"><strong>{item.title}</strong><small>{item.preview || item.model || '无摘要'}</small></div><SessionId key={item.id || item.relativePath} id={item.id} /></td>
          <td>{sessionProjectName(item)}</td>
          <td>{item.messages}</td>
          <td>{item.invalidLines}</td>
          <td>{formatFileSize(item.size)}</td>
          <td><span className="mono breakable">{item.relativePath}</span></td>
          <td><button className="danger small-action" disabled={busy} onClick={() => deleteSession(item.relativePath)}>删除</button></td>
        </tr>)}
      </tbody></table>
    </section>
  </section>
}

function ExceptionPage({ history, accounts, busy, file, refresh, clear }: { history: ProbeHistoryItem[]; accounts: Account[]; busy: boolean; file: string; refresh: () => void; clear: () => void }) {
  const latest = latestHistoryByAccount(history)
  const failures = Array.from(latest.values()).filter((item) => !item.ok)
  const groups = groupFailures(failures)
  return <section className="session-layout">
    <div className="metric-row"><Metric title="历史记录" value={history.length} tone="blue" /><Metric title="最新异常" value={failures.length} tone="red" /><Metric title="已覆盖渠道" value={latest.size} tone="green" /><Metric title="配置渠道" value={accounts.length} tone="violet" /></div>
    <section className="card operations-card"><div><h2>异常中心</h2><p>按 401 / 403 / 404 / 超时 / 余额字段不匹配 / RT 过期分类，方便判断是否接口变更或凭据过期。</p></div><div className="toolbar-actions"><button className="primary" disabled={busy} onClick={refresh}>{busy ? '读取中' : '刷新历史'}</button><button className="danger" disabled={busy || !history.length} onClick={clear}>清空历史</button></div></section>
    <section className="card issue-grid">
      {groups.length === 0 && <div className="issue-empty"><strong>暂无异常</strong><span>探测失败后会自动进入这里。</span></div>}
      {groups.map(([type, items]) => <article key={type} className="issue-card"><strong>{type}</strong><span>{items.length} 个渠道</span><p>{items[0]?.issue?.advice || '查看最近探测返回。'}</p></article>)}
    </section>
    <section className="card channel-table-card">
      <div className="card-head horizontal"><div><h2>探测历史</h2><p className="mono breakable">{file || '历史文件路径读取中'}</p></div></div>
      <table className="history-table"><thead><tr><th>时间</th><th>渠道</th><th>分组</th><th>状态</th><th>余额</th><th>HTTP</th><th>异常 / 建议</th></tr></thead><tbody>
        {!history.length && <tr><td colSpan={7} className="empty"><strong>暂无历史</strong><span>执行余额探测后自动保存每次结果。</span></td></tr>}
        {history.slice(0, 300).map((item) => <tr key={item.historyId} className={item.ok ? '' : 'fail'}><td>{formatDateTime(item.checkedAt)}</td><td><div className="channel-url-cell"><strong>{item.account.baseUrl}</strong><small>{item.account.name || item.account.preset}</small></div></td><td>{item.account.group}</td><td>{item.status}</td><td>{item.balanceDisplay || '-'}</td><td>{item.httpStatus || '-'}</td><td><div className="channel-url-cell"><strong>{item.issue?.type || '-'}</strong><small>{item.issue?.advice || item.message}</small></div></td></tr>)}
      </tbody></table>
    </section>
  </section>
}

function ImportPage({ text, setText, preview, sources, busy, runPreview, scan, commit }: { text: string; setText: (value: string) => void; preview: ImportPreviewResult | null; sources: ImportSourceResult | null; busy: boolean; runPreview: () => void; scan: () => void; commit: () => void }) {
  const accounts = preview?.accounts || []
  return <section className="page-grid narrow-page"><section className="card form-card full-span"><div className="card-head horizontal"><div><h2>一键导入渠道</h2><p>只读扫描 Codex-X、CC Switch、Codex++ 和当前 Codex 配置，不修改原软件文件；重复地址会自动跳过。</p></div><div className="toolbar-actions"><button className="primary" disabled={busy} onClick={scan}>{busy ? '扫描中' : '一键扫描全部'}</button><button className="ghost" disabled={busy} onClick={runPreview}>{busy ? '解析中' : '预览粘贴内容'}</button><button className="primary" disabled={!accounts.length || busy} onClick={commit}>导入到渠道列表</button></div></div>
     {sources && <div className="source-grid">{sources.sources.map((item) => <div className="source-chip" key={item.source}><strong>{item.source}</strong><span>{item.found ? `已找到${item.count ? ` · ${item.count} 条` : ''}` : '未找到配置'}</span></div>)}</div>}
    <textarea className="import-textarea" value={text} onChange={(e) => setText(e.target.value)} placeholder="粘贴 JSON、TOML 或包含 https://api.example.com 的文本。" />
    <div className="note-box compact-note"><strong>支持来源</strong><p>Codex-X、CC Switch、New API 导出的 JSON / 文本配置；能识别 baseUrl、apiBase、url、endpoint、host、model/models 等常见字段。</p></div>
  </section>
  <section className="card channel-table-card full-span"><div className="card-head horizontal"><div><h2>导入预览</h2><p>{preview ? '识别到 ' + accounts.length + ' 个候选渠道' : '先粘贴配置并点击预览导入。'}</p></div></div><table className="import-table"><thead><tr><th>序号</th><th>渠道 URL</th><th>类型</th><th>文本/模型</th><th>探测类型</th></tr></thead><tbody>{!accounts.length && <tr><td colSpan={5} className="empty"><strong>暂无候选</strong><span>预览后会显示待导入渠道。</span></td></tr>}{accounts.map((account, index) => <tr key={account.id}><td className="row-index">{index + 1}</td><td><span className="mono breakable">{account.baseUrl}</span></td><td>{channelGroupForAccount(account)}</td><td>{account.textTestModel}</td><td>{presetLabel[account.preset] || account.preset}</td></tr>)}</tbody></table></section></section>
}


function ChannelModal(props: { open: boolean; mode: ChannelModalMode; draft: Account; levels: AlertLevels; setDraft: (account: Account | ((old: Account) => Account)) => void; onClose: () => void; onSave: () => void; onDelete: () => void }) {
  const { open, mode, draft, levels, setDraft, onClose, onSave, onDelete } = props
  if (!open) return null
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="modal-card" role="dialog" aria-modal="true" aria-label={mode === 'add' ? '添加渠道' : '编辑渠道'} onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal-head"><div><span className="modal-kicker">{mode === 'add' ? '添加渠道' : '编辑渠道'}</span><h2>{mode === 'add' ? '添加探测渠道' : '渠道参数设置'}</h2><p>渠道地址和探测配置会保存；勾选“记住凭据”后，API Key / PAT 下次启动会自动带回。</p></div><button className="ghost close-button" onClick={onClose}>关闭</button></div>
      <div className="modal-form">
        <Field label="渠道名称" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} placeholder="例如 duolapi" />
        <Field label="渠道 URL" value={draft.baseUrl} onChange={(v) => setDraft({ ...draft, baseUrl: v })} placeholder="https://api.example.com" />
        <label className="switch inline remember-secret monitor-row"><input type="checkbox" checked={draft.monitorEnabled !== false} onChange={(e) => setDraft({ ...draft, monitorEnabled: e.target.checked })} /><span>启用自动监控</span></label>
        <Field label="API Key / Profile Token" type="password" value={draft.apiKey} onChange={(v) => setDraft({ ...draft, apiKey: v, authChanged: true })} placeholder="余额探测用：API Key / PAT / JWT" />
        <Field label="文本测试 Key（可选）" type="password" value={draft.textApiKey || ''} onChange={(v) => setDraft({ ...draft, textApiKey: v })} placeholder="模型获取、文本与生图共用；不填则沿用余额 Key" />
        <label className="switch inline remember-secret"><input type="checkbox" checked={draft.rememberSecret !== false} onChange={(e) => setDraft({ ...draft, rememberSecret: e.target.checked })} /><span>{draft.preset === 'sub2api_dashboard' ? '记住 JWT / RT' : '记住 API Key / PAT，下次打开自动使用'}</span></label>
        <label>探测类型</label><select value={draft.preset} onChange={(e) => setDraft(applyPreset({ ...draft, preset: e.target.value }))}>{presets.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        {draft.preset === 'sub2api_dashboard' && <>
          <Field label="Refresh Token (RT)" type="password" value={draft.refreshToken || ''} onChange={(v) => setDraft({ ...draft, refreshToken: v.trim(), authChanged: true })} placeholder="粘贴上游登录返回的 refresh_token" />
          <label className="switch inline"><input type="checkbox" checked={draft.autoRefresh !== false} onChange={(e) => setDraft({ ...draft, autoRefresh: e.target.checked })} /><span>自动续期 JWT / RT</span></label>
          {draft.authUpdatedAt && <p>上次续期：{new Date(draft.authUpdatedAt).toLocaleString('zh-CN')}</p>}
        </>}
        <div className="two-col"><Field label="超时秒" type="number" value={String(draft.timeout)} onChange={(v) => setDraft({ ...draft, timeout: Number(v || 12) })} /><Field label="New-Api-User" value={draft.userId} onChange={(v) => setDraft({ ...draft, userId: v })} placeholder="需要用户上下文时填写" /></div>
        <div className="two-col"><Field label="文本测试模型" value={draft.textTestModel || 'gpt-4o-mini'} onChange={(v) => setDraft({ ...draft, textTestModel: v })} placeholder="gpt-4o-mini" /><Field label="充值链接" value={draft.rechargePath || '/wallet'} onChange={(v) => setDraft({ ...draft, rechargePath: v })} placeholder="/wallet 或完整充值页 URL" /></div>
        <RechargePreview baseUrl={draft.baseUrl} rechargePath={draft.rechargePath} />
        <label>文本接口协议<select value={draft.wireApi || 'auto'} onChange={e => setDraft({ ...draft, wireApi: e.target.value as Account['wireApi'] })}><option value="auto">自动（Responses → Chat）</option><option value="responses">Responses</option><option value="chat">Chat Completions</option></select></label>
        {draft.usageScript && <label>余额查询脚本<textarea value={draft.usageScript.code} onChange={e => setDraft({ ...draft, usageScript: { ...draft.usageScript!, code: e.target.value } })} /></label>}
        <Field label="自动探测间隔（分钟）" type="number" value={String(draft.autoProbeIntervalMinutes || 0)} onChange={(v) => setDraft({ ...draft, autoProbeIntervalMinutes: Number(v || 0) })} />
        <label className="switch inline"><input type="checkbox" checked={!!draft.alertLevels} onChange={(e) => setDraft({ ...draft, alertLevels: e.target.checked ? normalizedThresholds(draft, levels) : null, lowBalanceThreshold: 0, lastAlertLevel: 0 })} /><span>本渠道独立三级低余额阈值</span></label>
        <div className="alert-grid">{(['level1', 'level2', 'level3'] as const).map((key, index) => <Field key={key} label={`${['一级', '二级', '三级'][index]}低余额阈值`} type="number" disabled={!draft.alertLevels} value={String((draft.alertLevels || levels)[key])} onChange={(v) => setDraft({ ...draft, alertLevels: { ...(draft.alertLevels || levels), [key]: Number(v) }, lowBalanceThreshold: 0, lastAlertLevel: 0 })} />)}</div>
        {draft.alertLevels && !validAlertLevels(draft.alertLevels) && <p role="alert">阈值须满足：一级 &gt; 二级 &gt; 三级，且均为非负数</p>}
        {draft.preset === 'custom' && <><Field label="自定义接口" value={draft.endpoint} onChange={(v) => setDraft({ ...draft, endpoint: v })} placeholder="/v1/balance" /><Field label="JSON 路径" value={draft.paths} onChange={(v) => setDraft({ ...draft, paths: v })} placeholder="data.balance,balance" /></>}
      </div>
      <div className="modal-actions"><div>{mode === 'edit' && <button className="danger" onClick={onDelete}>删除渠道</button>}</div><div className="button-row no-margin"><button className="ghost" onClick={onClose}>取消</button><button className="primary" onClick={onSave}>{mode === 'add' ? '保存渠道' : '保存设置'}</button></div></div>
    </section>
  </div>
}

function ImagePage(props: { accounts: Account[]; selectedId: string; selectedAccount?: Account; params: ImageParams; models: string[]; modelResult: ModelListResult | null; imageResult: ImageTestResult | null; imageHistory: ImageTestResult[]; modelLoading: boolean; imageLoading: boolean; setSelectedId: (id: string) => void; setParams: (value: ImageParams | ((old: ImageParams) => ImageParams)) => void; updateAccountKey: (id: string, key: string) => void; fetchModels: () => void; runImageTest: () => void; goChannels: () => void }) {
  const { accounts, selectedId, selectedAccount, params, models, modelResult, imageResult, imageHistory, modelLoading, imageLoading, setSelectedId, setParams, updateAccountKey, fetchModels, runImageTest, goChannels } = props
  const [customModelOpen, setCustomModelOpen] = useState(false)
  const availableModels = uniqueModels([...builtinImageModels, ...models, customModelOpen ? '' : params.model])
  const modelSelectValue = customModelOpen || !availableModels.includes(params.model) ? '__custom__' : params.model
  const ratioOptions = ratioOptionsFor(params.model)
  const finalRatios = ratioOptions.includes(params.aspectRatio) ? ratioOptions : [...ratioOptions, params.aspectRatio]
  const resolvedSize = resolveImageSize(params)
  const galleryItems = imageHistory.length ? imageHistory : (imageResult ? [imageResult] : [])
  const patchParams = (patch: Partial<ImageParams>) => setParams((old: ImageParams) => ({ ...old, ...patch }))
  return <>
    <section className="image-workspace">
      <section className="card workspace-hero">
      <div><h2>多模型图片工作台</h2><p>结果区在上，底部参数栏统一承载渠道、模型、比例和提示词。</p></div>
      <div className="workspace-actions"><span className="workspace-chip">{modelResult ? `已载入 ${models.length} 个模型` : '内置 3 个模型'}</span><button className="ghost" disabled={modelLoading || !selectedAccount} onClick={fetchModels}>{modelLoading ? '获取中' : '获取模型'}</button><button className="ghost" onClick={goChannels}>返回渠道管理</button></div>
      </section>
      <section className="card gallery-panel">
      <div className="gallery-head"><div><strong>当前生成结果</strong><span>{imageResult?.message || '等待生图测试。成功后图片会进入结果墙。'}</span></div><div className="result-meta"><span>HTTP {imageResult ? imageResult.httpStatus : '-'}</span><strong>{resolvedSize}</strong></div></div>
      <div className="gallery-grid">
        {galleryItems.length === 0 && <div className="gallery-empty"><strong>等待第一张图片</strong><span>在底部参数栏选择渠道、模型和比例，然后开始生图测试。</span></div>}
        {galleryItems.map((item, index) => {
          const src = imageSrcFromResult(item, params.outputFormat)
          return <article key={`${item.elapsedMs}_${index}`} className={`gallery-item ${src ? '' : 'failed'}`}>{src ? <img src={src} alt="渠道生图测试结果" /> : <div><strong>调用未返回图片</strong><span>{item.message}</span></div>}<footer><strong>{item.model}</strong><span>HTTP {item.httpStatus} / {item.elapsedMs}ms</span></footer></article>
        })}
      </div>
      </section>
    </section>
    <section className="card prompt-dock" aria-label="生图参数设置">
      <div className="dock-topline">
        <label className="dock-field channel-field"><span>渠道</span><select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}><option value="">请选择渠道</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name || account.baseUrl}</option>)}</select></label>
        <label className="dock-field model-field"><span>模型</span><select value={modelSelectValue} onChange={(e) => { const value = e.target.value; if (value === '__custom__') { setCustomModelOpen(true); return } setCustomModelOpen(false); patchParams({ model: value }) }}>{availableModels.map((model) => <option key={model} value={model}>{model}</option>)}<option value="__custom__">自定义模型名</option></select></label>
        <button className="ghost dock-fetch" disabled={modelLoading || !selectedAccount} onClick={fetchModels}>{modelLoading ? '获取中' : '刷新模型'}</button>
      </div>
      {modelSelectValue === '__custom__' && <label className="dock-field custom-model-row"><span>自定义模型</span><input value={params.model} onChange={(e) => patchParams({ model: e.target.value })} placeholder="输入模型名，例如 gpt-image-2" /></label>}
      <div className="dock-param-grid">
        <label className="dock-field"><span>数量</span><input type="number" min="1" max="4" value={params.n} onChange={(e) => patchParams({ n: Number(e.target.value || 1) })} /></label>
        <label className="dock-field"><span>比例</span><select value={params.aspectRatio} onChange={(e) => patchParams({ aspectRatio: e.target.value })}>{finalRatios.map((option) => <option key={option} value={option}>{option === 'auto' ? '自动' : option}</option>)}</select></label>
        <label className="dock-field"><span>清晰度</span><select value={params.imageSize} onChange={(e) => patchParams({ imageSize: e.target.value })}>{imageSizeOptionsFor(params.model).map((option) => <option key={option} value={option}>{option === 'auto' ? '自动' : option === 'custom' ? '自定义' : option}</option>)}</select></label>
        <label className="dock-field"><span>尺寸</span><input value={params.imageSize === 'custom' ? params.customSize : resolvedSize} onChange={(e) => patchParams({ customSize: e.target.value, imageSize: 'custom' })} placeholder="例如 1024x1024" /></label>
        <label className="dock-field"><span>返回</span><select value={params.responseFormat} onChange={(e) => patchParams({ responseFormat: e.target.value })}>{['auto', 'b64_json', 'url'].map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
        <label className="dock-field"><span>质量</span><select value={params.quality} onChange={(e) => patchParams({ quality: e.target.value })}>{['auto', 'low', 'medium', 'high', 'standard', 'hd'].map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
        <label className="dock-field"><span>格式</span><select value={params.outputFormat} onChange={(e) => patchParams({ outputFormat: e.target.value })}>{['png', 'webp', 'jpeg', 'auto'].map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
        <label className="dock-field"><span>背景</span><select value={params.background} onChange={(e) => patchParams({ background: e.target.value })}>{['auto', 'transparent', 'opaque'].map((option) => <option key={option} value={option}>{option === 'auto' ? '自动' : option}</option>)}</select></label>
      </div>
      <div className="prompt-row"><textarea value={params.prompt} onChange={(e) => patchParams({ prompt: e.target.value })} rows={3} placeholder="描述要生成的图片" /><button className="primary send-button" disabled={imageLoading || !selectedAccount} onClick={runImageTest}>{imageLoading ? '生成中' : '开始生图'}</button></div>
      {selectedAccount && <div className="secret-row"><span>{selectedAccount.baseUrl}</span><input type="password" value={selectedAccount.apiKey} onChange={(e) => updateAccountKey(selectedAccount.id, e.target.value)} placeholder="粘贴 API Key / PAT；编辑渠道保存后可记住" /></div>}
    </section>
  </>
}

function CodexToolsPage({ tools, status, enhancerResult, busy, setTools, saveTools, refreshStatus, exportEnhancer, applyEnhancer }: { tools: CodexToolsConfig; status: CodexToolStatus | null; enhancerResult: CodexEnhancerResult | null; busy: boolean; setTools: (value: CodexToolsConfig) => void; saveTools: (value?: CodexToolsConfig) => void; refreshStatus: () => void; exportEnhancer: () => void; applyEnhancer: () => void }) {
  const patch = (patchValue: Partial<CodexToolsConfig>) => setTools(normalizeCodexTools({ ...tools, ...patchValue }))
  const patchFeature = (id: string, enabled: boolean) => patch({ features: { ...tools.features, [id]: enabled } })
  const enabledCount = codexFeatureCatalog.filter((item) => tools.features[item.id]).length
  const featureState = (id: string) => tools.enhanceEnabled && tools.features[id] ? (status?.enhancerFeatureStatus?.[id] || (status?.enhancerReady ? '待连接' : '未安装')) : '已禁用'
  const injectedLabel = status?.enhancerInjected ? `已注入 ${status.enhancerTargets || 0} 页` : status?.enhancerReady ? '已安装，待注入' : '未安装'
  return <section className="codex-tools-layout">
    <section className="card codex-hero-card">
      <div><span className="section-kicker">Codex++ Control</span><h2>页面增强</h2><p>开关会生成本机增强脚本，并通过本地调试会话注入当前 Codex 页面；受官方权限控制的能力会标为前端已注入。</p></div>
      <div className="codex-hero-actions"><StatusLine label="已启用" value={`${enabledCount}/${codexFeatureCatalog.length}`} /><StatusLine label="实际状态" value={injectedLabel} /><button className="ghost" onClick={refreshStatus}>刷新状态</button><button className="primary" disabled={busy} onClick={applyEnhancer}>{busy ? '处理中...' : '安装并注入页面增强'}</button></div>
    </section>
    <section className="card codex-mode-card">
      <div className="card-head horizontal"><div><h2>增强模式</h2><p>保存配置只记录开关；安装并注入会写入本机增强包并尝试连接 Codex 本地调试会话。</p></div><label className="switch"><input type="checkbox" checked={tools.enhanceEnabled} onChange={(e) => patch({ enhanceEnabled: e.target.checked })} /><span>启用页面增强</span></label></div>
      <div className="mode-choice-grid">
        <button className={'mode-choice ' + (tools.mode === 'compatible' ? 'active' : '')} onClick={() => patch({ mode: 'compatible' })}><strong>兼容增强</strong><span>保留基础入口，适合官方登录或混合 API Key。</span></button>
        <button className={'mode-choice ' + (tools.mode === 'full' ? 'active' : '')} onClick={() => patch({ mode: 'full' })}><strong>完整增强</strong><span>启用插件入口、会话导出移动、Timeline 和用户脚本等全部页面能力。</span></button>
      </div>
      <div className="button-row end"><button className="ghost" disabled={busy} onClick={exportEnhancer}>{busy ? '处理中...' : '仅生成增强脚本'}</button><button className="primary" disabled={busy} onClick={applyEnhancer}>{busy ? '注入中...' : '安装并注入 Codex'}</button><button className="ghost" onClick={() => saveTools(tools)}>只保存配置</button></div>
      {enhancerResult && <div className="codex-export-result"><strong>{enhancerResult.message}</strong><span className="mono breakable">{enhancerResult.bundleDir}</span><small>模型白名单来源 {enhancerResult.modelCount} 个；调试会话 {enhancerResult.cdp?.ok ? `已连接 127.0.0.1:${enhancerResult.cdp.port}` : '未连接或待启动'}。</small></div>}
    </section>
    <section className="codex-feature-grid">
      {codexFeatureCatalog.map((item) => <article key={item.id} className={'card feature-toggle-card ' + (tools.features[item.id] ? 'enabled' : '')}>
        <label className="feature-check"><input type="checkbox" checked={!!tools.features[item.id]} onChange={(e) => patchFeature(item.id, e.target.checked)} /><span><strong>{item.title}</strong><small>{item.description}</small></span></label>
        <em>{featureState(item.id)}</em>
      </article>)}
    </section>
  </section>
}
function EmailPage({ email, setEmail, saveEmail, testEmail }: { email: EmailConfig; setEmail: (email: EmailConfig) => void; saveEmail: () => void; testEmail: () => void }) {
  return <section className="page-grid narrow-page"><section className="card form-card full-span"><div className="card-head horizontal"><div><h2>提醒邮箱配置</h2></div><label className="switch"><input type="checkbox" checked={email.enabled} onChange={(e) => setEmail({ ...email, enabled: e.target.checked })} /><span>启用提醒</span></label></div>
    <div className="two-col"><Field label="SMTP 服务器" value={email.smtpHost} onChange={(v) => setEmail({ ...email, smtpHost: v })} placeholder="smtp.example.com" /><Field label="端口" type="number" value={String(email.smtpPort)} onChange={(v) => setEmail({ ...email, smtpPort: Number(v || 465) })} /><Field label="用户名" value={email.username} onChange={(v) => setEmail({ ...email, username: v })} /><Field label="发件邮箱" value={email.sender} onChange={(v) => setEmail({ ...email, sender: v })} /><Field label="密码 / 授权码" type="password" value={email.password} onChange={(v) => setEmail({ ...email, password: v })} placeholder="保存后在服务端加密存储" /></div>
    {email.enabled && !email.password.trim() && <div className="note-box compact-note" role="alert"><strong>缺少 SMTP 授权码，预警邮件尚未就绪</strong><p>请填写上方“密码 / 授权码”并保存。QQ 邮箱：设置 → 账户 → POP3/IMAP/SMTP 服务，开启 SMTP 后获取授权码。这里填写授权码，不是 QQ 登录密码。</p></div>}
    <Field label="收件邮箱（多个用逗号分隔）" value={email.recipients} onChange={(v) => setEmail({ ...email, recipients: v })} placeholder="admin@example.com" />
    <label className="switch inline"><input type="checkbox" checked={email.smtpSsl} onChange={(e) => setEmail({ ...email, smtpSsl: e.target.checked })} /><span>SMTP SSL</span></label>
    <div className="note-box compact-note"><strong>预警策略</strong><p>各级阈值触发一次，同级不重复；余额恢复到一级阈值以上后重新布防。</p></div>
    <div className="button-row end"><button className="ghost" onClick={testEmail}>发送测试邮件</button><button className="primary" onClick={saveEmail}>保存邮箱设置</button></div>
  </section></section>
}

function SettingsPage({ alertLevels, autoProbeInterval, configFile, theme, density, balancePrecision, configInspect, configInspectBusy, setAlertLevels, setAutoProbeInterval, setTheme, setDensity, setBalancePrecision, saveSettings, refreshConfigInspect }: { alertLevels: AlertLevels; autoProbeInterval: number; configFile: string; theme: Theme; density: Density; balancePrecision: number; configInspect: ConfigInspectResult | null; configInspectBusy: boolean; setAlertLevels: (value: AlertLevels | ((old: AlertLevels) => AlertLevels)) => void; setAutoProbeInterval: (value: number) => void; setTheme: (value: Theme) => void; setDensity: (value: Density) => void; setBalancePrecision: (value: number) => void; saveSettings: () => void; refreshConfigInspect: () => void }) {
  const patchLevels = (patch: Partial<AlertLevels>) => setAlertLevels((old) => normalizeAlertLevels({ ...old, ...patch }))
  return <section className="page-grid narrow-page">
    <section className="card form-card full-span"><div className="card-head"><div><h2>应用设置</h2><p>管理三级余额预警、全局自动探测、主题密度、余额精度和本机配置路径。</p></div></div>
      <div className="alert-grid"><Field label="一级预警余额" type="number" value={String(alertLevels.level1)} onChange={(v) => patchLevels({ level1: Number(v || 0) })} /><Field label="二级预警余额" type="number" value={String(alertLevels.level2)} onChange={(v) => patchLevels({ level2: Number(v || 0) })} /><Field label="三级预警余额" type="number" value={String(alertLevels.level3)} onChange={(v) => patchLevels({ level3: Number(v || 0) })} /></div>
      <Field label="全局自动探测间隔（分钟）" type="number" value={String(autoProbeInterval)} onChange={(v) => setAutoProbeInterval(Number(v || 0))} />
      <div className="two-col"><div><label>主题</label><select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}><option value="dark">深色</option><option value="light">浅色</option></select></div><div><label>界面密度</label><select value={density} onChange={(e) => setDensity(e.target.value as Density)}><option value="comfortable">标准</option><option value="compact">紧凑</option></select></div></div>
      <Field label="余额数字精度" type="number" value={String(balancePrecision)} onChange={(v) => setBalancePrecision(normalizePrecision(Number(v || 0)))} />
      <div className="note-box compact-note"><strong>单渠道阈值</strong><p>渠道编辑弹窗里的“本渠道独立三级低余额阈值”会覆盖全局三级阈值；批量设置可一次写入多个渠道。</p></div>
      <div className="note-box"><strong>配置文件</strong><p className="mono breakable">{configFile || '读取中...'}</p></div>
      <div className="note-box"><strong>接口参考</strong><p>Sub2API：面板 JWT 读取 `/api/v1/auth/me`，兼容回退 `/api/v1/user/profile`；API Key 读取 `/v1/usage` 的 `remaining`、`quota.remaining` 或 `balance`；`/v1/sub2api/billing` 只用于倍率/账单诊断。</p></div>
      <div className="note-box"><strong>密钥保存策略</strong><p>渠道地址、分组、监控开关、类型、自动探测、单渠道阈值和邮箱基础设置会保存；每个渠道可在编辑弹窗里勾选“记住 API Key / PAT”。已保存的凭据与 SMTP 授权码在服务端加密存储。</p></div>
      <div className="button-row end"><button className="ghost" disabled={configInspectBusy} onClick={refreshConfigInspect}>{configInspectBusy ? '刷新中' : '刷新配置查看器'}</button><button className="primary" onClick={saveSettings}>保存设置</button></div>
    </section>
    <section className="card form-card full-span"><div className="card-head horizontal"><div><h2>TOML / 配置查看器</h2><p>只读查看配置文件路径、当前保存渠道数、敏感字段打码和历史文件路径。</p></div></div>
      <div className="metric-row"><Metric title="保存渠道" value={configInspect?.accountCount || 0} tone="blue" /><Metric title="保存密钥" value={configInspect?.savedSecrets || 0} tone="violet" /><Metric title="分组数" value={configInspect?.groups.length || 0} tone="green" /></div>
      <div className="config-meta"><StatusLine label="Data Dir" value={configInspect?.dataDir || '-'} /><StatusLine label="History" value={configInspect?.historyFile || '-'} /><StatusLine label="Sessions" value={configInspect?.sessionRoot || '-'} /></div>
      <pre className="config-viewer">{configInspect?.configJson || '点击刷新配置查看器读取打码配置。'}</pre>
    </section>
  </section>
}


function NavItem({ item, current, onClick }: { item: (typeof navItems)[number]; current: Page; onClick: (page: Page) => void }) { return <button className={`nav-item ${item.page === current ? 'active' : ''}`} onClick={() => onClick(item.page)}><span className="nav-glyph">{item.glyph}</span><span>{item.title}</span><small>{item.subtitle}</small></button> }
function Metric({ title, value, tone }: { title: string; value: number; tone: string }) { return <div className={`metric card ${tone}`}><span>{title}</span><strong>{value}</strong></div> }
function Field({ label, value, onChange, type = 'text', placeholder = '', disabled = false }: { label: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string; disabled?: boolean }) { return <div className="field"><label>{label}</label><input aria-label={label} disabled={disabled} type={type} step={type === 'number' ? 'any' : undefined} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} /></div> }
function StatusLine({ label, value }: { label: string; value: string }) { return <div className="status-line"><span>{label}</span><strong>{value}</strong></div> }
function StatusBadge({ status }: { status: string }) { return <span className={`status-badge ${statusClass(status)}`}>{status}</span> }
function BalanceCell({ account, result, alertLevels, running, precision = 6 }: { account: Account; result?: ProbeResult; alertLevels: AlertLevels; running: boolean; precision?: number }) {
  const status = running ? '更新中' : result ? statusOf(result, account, alertLevels) : hasProbeCredential(account) ? '待探测' : '未填 Key'
  const failed = !!result && !result.ok
  const title = result ? [`预设：${presetLabel[result.preset] || result.preset}`, `端点：${result.endpoint || '-'}`, `HTTP：${result.httpStatus || '-'}`, result.message, result.rawSummary].filter(Boolean).join('\n') : ''
  const mainText = failed ? (result.httpStatus ? 'HTTP ' + result.httpStatus : '请求失败') : (result?.balanceNumber !== null && result?.balanceNumber !== undefined ? formatNumber(result.balanceNumber, precision) : (result?.balanceDisplay || (hasProbeCredential(account) ? '未探测' : '未填 Key')))
  const level = result && account.preset !== 'sub2api_billing' ? alertLevelOf(result, account, alertLevels) : 0
  const detailText = failed ? failureReason(result) : [result?.unit, level > 0 ? '线 ' + formatNumber(thresholdForAlertLevel(account, alertLevels, level), precision) : ''].filter(Boolean).join(' · ')
  return <div className={`balance-cell ${failed ? 'failed' : ''}`} title={title}><StatusBadge status={status} /><strong>{mainText}</strong>{detailText && <span>{detailText}</span>}{result?.checkedAt && <small className="balance-time">{running ? '上次查询' : '查询于'} {new Date(result.checkedAt).toLocaleString('zh-CN', { hour12: false })}</small>}</div>
}
function pageTitle(page: Page) { if (page === 'image') return '渠道生图测试'; if (page === 'channels') return '渠道管理'; if (page === 'exceptions') return '异常中心'; if (page === 'sessions') return '会话管理'; if (page === 'import') return '导入配置'; if (page === 'codex') return 'Codex增强'; if (page === 'email') return '邮箱管理'; return '设置' }
function hasProbeCredential(account: Account) { return Boolean(account.apiKey.trim() || (account.preset === 'sub2api_dashboard' && account.autoRefresh !== false && account.refreshToken?.trim())) }
function normalizeLoadedAccount(account: Omit<Account, 'apiKey'> & { apiKey?: string; autoProbeIntervalMinutes?: number; rememberSecret?: boolean; lowBalanceThreshold?: number; lastAlertLevel?: number; group?: string; monitorEnabled?: boolean }): Account { const merged = { ...emptyAccount(), ...account }; return { ...merged, apiKey: account.apiKey || '', textApiKey: account.textApiKey || '', rememberSecret: account.rememberSecret !== false, baseUrl: normalizeBaseUrlInput(account.baseUrl || ''), timeout: Number(account.timeout || 12), textTestModel: account.textTestModel || 'gpt-4o-mini', rechargePath: account.rechargePath || '/wallet', group: channelGroupForAccount(merged), monitorEnabled: account.monitorEnabled !== false, autoProbeIntervalMinutes: Number(account.autoProbeIntervalMinutes || 0), lowBalanceThreshold: Math.max(0, Number(account.lowBalanceThreshold || 0)), lastAlertLevel: clampAlertLevel(account.lastAlertLevel || 0) } }
function normalizeDraft(account: Account): Account { let apiKey = account.apiKey.trim(); let userId = account.userId.trim(); if (account.preset === 'newapi_profile' && !apiKey && looksLikeProfileToken(userId)) { apiKey = userId; userId = '' } return { ...account, name: account.name.trim(), baseUrl: normalizeBaseUrlInput(account.baseUrl), apiKey, textApiKey: (account.textApiKey || '').trim(), userId, rememberSecret: account.rememberSecret !== false, timeout: Number(account.timeout || 12), textTestModel: (account.textTestModel || 'gpt-4o-mini').trim(), rechargePath: (account.rechargePath || '/wallet').trim(), group: channelGroupForAccount(account), monitorEnabled: account.monitorEnabled !== false, autoProbeIntervalMinutes: Math.max(0, Number(account.autoProbeIntervalMinutes || 0)), lowBalanceThreshold: Math.max(0, Number(account.lowBalanceThreshold || 0)), lastAlertLevel: clampAlertLevel(account.lastAlertLevel || 0) } }
function applyPreset(account: Account): Account {
  if (account.preset === 'usage_token') return { ...account, group: 'New API', name: account.name || 'New API Key 余额', endpoint: '/api/usage/token/', paths: 'data.total_available,data.quota,balance' }
  if (account.preset === 'newapi_profile') return { ...account, group: 'New API', name: account.name || 'New API 面板余额', endpoint: '/api/user/self', paths: 'data.user.quota,data.quota,quota' }
  if (account.preset === 'sub2api_dashboard') return { ...account, group: 'Sub2API', name: account.name || 'Sub2API 面板余额', endpoint: '/api/v1/auth/me', paths: 'data.balance,user.balance,balance,wallet.balance,account.balance' }
  if (account.preset === 'sub2api_usage') return { ...account, group: 'Sub2API', name: account.name || 'Sub2API API Key 用量', endpoint: '/v1/usage', paths: 'usage.remaining_grant,remaining_grant,remaining,quota.remaining,balance,data.balance' }
  if (account.preset === 'sub2api_billing') return { ...account, group: 'Sub2API', name: account.name || 'Sub2API billing 诊断', endpoint: '/v1/sub2api/billing', paths: 'effective_rate_multiplier,rate_multiplier,data.effective_rate_multiplier,data.rate_multiplier' }
  if (account.preset === 'ccswitch_usage') return { ...account, group: 'CC Switch', endpoint: '/v1/usage', paths: 'remaining,quota.remaining,balance,data.balance' }
  return account
}
function looksLikeProfileToken(value: string) { return value.length >= 12 && !/^sk-/i.test(value) && /[A-Za-z]/.test(value) && /[+/=_-]/.test(value) }
function normalizeAlertLevels(value?: Partial<AlertLevels>, fallback?: number): AlertLevels {
  const level1 = Number(value?.level1 ?? fallback ?? defaultAlertLevels.level1)
  const level2 = Number(value?.level2 ?? defaultAlertLevels.level2)
  const level3 = Number(value?.level3 ?? defaultAlertLevels.level3)
  return { level1: Math.max(0, level1 || 0), level2: Math.max(0, level2 || 0), level3: Math.max(0, level3 || 0) }
}
function alertLevelOf(result: ProbeResult, account: Account, levels: AlertLevels) {
  if(account.preset==='sub2api_billing'||result.unit==='倍率')return 0
  return alertLevelForBalance(result.balanceNumber, result.ok, normalizedThresholds(account, levels))
}
function thresholdForAlertLevel(account: Account, levels: AlertLevels, level: number) { const t = normalizedThresholds(account, levels); return level >= 3 ? t.level3 : level === 2 ? t.level2 : t.level1 }
function alertLevelName(level: number) { return level >= 3 ? '三级预警' : level === 2 ? '二级预警' : level === 1 ? '一级预警' : '正常' }
function statusOf(result: ProbeResult, account: Account, levels: AlertLevels) { if (!result.ok) return '失败'; return alertLevelName(alertLevelOf(result, account, levels)) }
function statusClass(status: string) { if (status === '正常') return 'ok'; if (status === '一级预警') return 'low warn1'; if (status === '二级预警') return 'low warn2'; if (status === '三级预警') return 'low warn3'; if (status === '失败') return 'fail'; return '' }
function rowClassForStatus(status: string) { if (status === '失败') return 'fail'; if (status.includes('预警')) return status === '三级预警' ? 'low warn3' : status === '二级预警' ? 'low warn2' : 'low warn1'; return '' }
function clampAlertLevel(value: number) { return Math.max(0, Math.min(3, Number(value || 0))) }
function formatDateTime(value: string) { const d = new Date(value); return Number.isNaN(d.getTime()) ? value : d.toLocaleString('zh-CN', { hour12: false }) }
function formatFileSize(value: number) { if (!Number.isFinite(value)) return '0 B'; if (value > 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB'; if (value > 1024) return (value / 1024).toFixed(1) + ' KB'; return value + ' B' }
function formatNumber(value: number, precision = 6) { const p = normalizePrecision(precision); return Number.isFinite(value) ? Number(value.toFixed(p)).toString() : '0' }
function failureReason(result: ProbeResult) { const marker = '上游返回：'; const message = result.message || ''; const core = message.includes(marker) ? message.slice(message.lastIndexOf(marker) + marker.length) : message; return core.replace(/\s+/g, ' ').trim().slice(0, 72) || '未返回详情' }
function normalizeBaseUrlInput(value: string) { const text = value.trim(); const markdown = text.match(/\]\((https?:\/\/[^)\s，,]+)[^)]*\)/i); const direct = text.match(/https?:\/\/[^\s，,]+/i); const picked = markdown?.[1] || direct?.[0] || text.split(/[，,\s]/)[0] || text; return picked.replace(/[，,、；;。)\]】]+$/g, '').replace(/\/+$/g, '') }
function isLikelyImageModel(model: string) { const text = model.toLowerCase(); return text.includes('image') || text.includes('gemini') || text.includes('dall') || text.includes('flux') || text.includes('sd') || text.includes('midjourney') }
function pickImageModel(modelList: string[]) { const lower = new Map(modelList.map((model) => [model.toLowerCase(), model])); return lower.get('gpt-image-2') || lower.get('gemini-3.1-flash-image-preview') || lower.get('gemini-3-pro-image-preview') || lower.get('gpt-image-1.5') || lower.get('gpt-image-1') || lower.get('gpt-image-1-mini') || lower.get('dall-e-3') || modelList.find(isLikelyImageModel) || '' }
function uniqueModels(values: string[]) { return Array.from(new Set(values.filter(Boolean))) }
function ratioOptionsFor(model: string) { const text = model.toLowerCase(); if (text.startsWith('gpt-image')) return ['auto', '1:1', '2:3', '3:2']; if (text.includes('gemini-3.1-flash')) return ['auto', ...extendedGeminiRatios]; if (text.includes('gemini-3-pro')) return ['auto', ...commonRatios]; return ['auto', ...commonRatios, '1:3', '3:1'] }
function imageSizeOptionsFor(model: string) { const text = model.toLowerCase(); if (text.startsWith('gpt-image')) return ['auto', '1K', 'custom']; if (text.includes('gemini-3-pro')) return ['auto', '1K', '2K', '4K', 'custom']; return ['auto', '512px', '1K', '2K', '4K', 'custom'] }
function sizeMapFor(model: string) { const text = model.toLowerCase(); if (text.includes('gemini-3.1-flash')) return geminiFlashSizeMap; if (text.includes('gemini-3-pro')) return geminiProSizeMap; return openAiSizeMap }
function resolveImageSize(params: ImageParams) { if (params.imageSize === 'custom') return params.customSize.trim() || 'auto'; if (params.imageSize === 'auto' || params.aspectRatio === 'auto') return 'auto'; return sizeMapFor(params.model)[params.imageSize]?.[params.aspectRatio] || params.customSize.trim() || 'auto' }
function imageSrcFromResult(result?: ImageTestResult | null, outputFormat = 'png') { if (!result) return ''; const mime = outputFormat === 'jpeg' ? 'jpeg' : outputFormat === 'webp' ? 'webp' : 'png'; return result.imageB64 ? `data:image/${mime};base64,${result.imageB64}` : result.imageUrl || '' }
function ConnectedApp(){const [ready,setReady]=useState(false);const [starting,setStarting]=useState(true);useEffect(()=>{resumeConnection().then(setReady).catch(()=>setReady(false)).finally(()=>setStarting(false));const off=()=>setReady(false);window.addEventListener('radar-login-required',off);return()=>window.removeEventListener('radar-login-required',off)},[]);return starting?<div className="connection-screen">正在连接余额雷达…</div>:ready?<App/>:<ConnectionPanel onConnected={()=>setReady(true)}/> }
export default ConnectedApp





function RechargePreview({ baseUrl, rechargePath }: { baseUrl: string; rechargePath: string }) {
  let url = ''
  try { url = resolveRechargeUrl(normalizeBaseUrlInput(baseUrl), rechargePath) } catch {}
  return <div className="recharge-help"><p>每个渠道独立保存。支持 /console/topup、/#/recharge 等站内路径，或完整充值网址（含查询参数）。示例仅说明格式，请填写该站实际地址。</p><small>跳转预览：{url || '请检查渠道地址和充值链接'}</small></div>
}
