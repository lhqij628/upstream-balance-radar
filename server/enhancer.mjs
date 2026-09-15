import fs from 'node:fs/promises'
import fssync from 'node:fs'
import path from 'node:path'
import { parse } from 'smol-toml'
import { createHash } from 'node:crypto'
import { createUserScripts } from './enhancer-scripts.mjs'
import { createNativeActions, openUrl } from './enhancer-native.mjs'
import { connectRenderer, discoverOfficialPage, bridgeBootstrap } from './cdp-bridge.mjs'
import { scanSessions, deleteSession, restoreDeletedSession, sessionMarkdown, syncSessions } from './sessions.mjs'

const featureMap = { pluginMarket: 'codexAppPluginMarketplaceUnlock', forcePluginEntry: 'codexAppPluginEntryUnlock', forcePluginInstall: 'codexAppForcePluginInstall', modelWhitelist: 'codexAppModelWhitelistUnlock', fastButton: 'codexAppServiceTierControls', sessionDelete: 'codexAppSessionDelete', markdownExport: 'codexAppMarkdownExport', sessionProjectMove: 'codexAppProjectMove', conversationTimeline: 'codexAppConversationTimeline', centeredWidth: 'codexAppConversationView', rememberThreadPosition: 'codexAppThreadScrollRestore', zedRemoteOpen: 'codexAppZedRemoteOpen', scriptMarket: 'codexAppUserScripts', recommendedContent: 'codexAppRecommendedContent', installMaintenance: 'codexAppInstallMaintenance' }
export function createEnhancer({ dataDir, sessionRoot, loadConfig, updateConfig, writeConfig, listModels, apiBase, openExternal = openUrl, nativeActions }) {
  const root = path.join(dataDir, 'codex-enhancer'), payloadFile = path.join(root, 'payload.js'), stateFile = path.join(root, 'state.json'), injectorFile = path.join(root, 'injector.mjs')
  let state = {}, connection, targetPage, reconnecting = false, watchTimer, lastPort, disposed = false
  const native = nativeActions || createNativeActions({ codexHome: path.dirname(sessionRoot) })
  const scripts = createUserScripts({ root, getConnection: () => connection, isEnabled: async () => { const tools = (await loadConfig()).codexTools; return tools.enhanceEnabled !== false && tools.features?.scriptMarket === true } })
  const rendererSettings = tools => ({
    launchMode: tools.mode === 'full' ? 'patch' : 'relay',
    enhancementsEnabled: tools.enhanceEnabled !== false,
    providerSyncEnabled: false,
    codexAppNativeMenuPlacement: false,
    codexAppUpstreamWorktreeCreate: false,
    codexAppVersion: state.appVersion || '',
    radarCapabilities: state.capabilities || {},
    ...Object.fromEntries(Object.entries(featureMap).map(([k, v]) => [v, tools.enhanceEnabled !== false && Boolean(tools.features?.[k])])),
  })
  const read = async () => { try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')) } catch {} }
  const status = async () => { await read(); const tools = (await loadConfig()).codexTools; const ready = fssync.existsSync(payloadFile), alive = Boolean(connection?.alive); return { tools, dataDir, enhancerRoot: root, enhancerBundleDir: root, enhancerPayloadFile: payloadFile, enhancerInjectorFile: injectorFile, enhancerStateFile: stateFile, enhancerReady: ready, enhancerInjected: alive && Boolean(state.ok), enhancerTargets: alive ? state.targets || 0 : 0, enhancerModelCount: state.models?.length || 0, enhancerFeatureStatus: Object.fromEntries(Object.keys(tools.features || {}).map(k => [k, tools.enhanceEnabled === false || !tools.features[k] ? '已禁用' : !ready ? '未安装' : !alive ? '待连接' : ['pluginMarket', 'modelWhitelist'].includes(k) && !state.capabilities?.dispatcher ? '当前构建未适配' : '已连接，待操作验证'])), capabilities: state.capabilities || {}, codexAppVersion: state.appVersion || '', codexPlusPlusManagerPath: '', codexPlusPlusFound: fssync.existsSync(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Codex++', 'codex-plus-plus-manager.exe')), injectorAlive: alive, cdp: { ...state.cdp, ok: alive && Boolean(state.ok) } } }
  const configuredModel = async () => {
    try { const c = parse(await fs.readFile(path.join(path.dirname(sessionRoot), 'config.toml'), 'utf8')); const provider = c.model_provider || 'openai'; return { model: c.model || '', default_model: c.model || '', model_provider: provider, provider_name: c.model_providers?.[provider]?.name || provider } }
    catch { return { model: '', default_model: '', model_provider: '', provider_name: '' } }
  }
  const models = async () => {
    const cfg = await loadConfig(), found = new Set(), sources = [], current = await configuredModel()
    if (current.model) found.add(current.model)
    for (const a of cfg.accounts) if (a.textTestModel) found.add(a.textTestModel)
    for (const a of cfg.accounts.filter(a => a.textApiKey || a.apiKey).slice(0, 4)) { try { for (const m of await listModels(a)) { const id = typeof m === 'string' ? m : m?.id; if (id) found.add(id) }; sources.push({ name: a.name, ok: true }) } catch { sources.push({ name: a.name, ok: false }) } }
    const catalog = { ok: true, status: 'ok', ...current, models: [...found].filter(m => typeof m === 'string' && m.trim()), sources, responses_api: { status: 'unknown', message: '模型列表不代表 Responses 接口已通过测试' } }
    state.models = catalog.models; state.catalog = catalog
    await fs.mkdir(root, { recursive: true }); await fs.writeFile(stateFile, JSON.stringify(state))
    return catalog
  }
  const generate = async (input = {}) => {
    await fs.mkdir(root, { recursive: true }); const cfg = await loadConfig(), tools = input.tools || cfg.codexTools
    const settings = rendererSettings(tools)
    const source = await fs.readFile(new URL('./vendor/codex-plus-plus/renderer-inject.js', import.meta.url), 'utf8')
    const adapter = await fs.readFile(new URL('./official-renderer-adapter.js', import.meta.url), 'utf8')
    const prefix = `window.__UBR_CODEX_ENHANCER__=true; window.__CODEX_SESSION_DELETE_HELPER__=${JSON.stringify(apiBase + '/api/enhancer')}; window.__CODEX_PLUS_VERSION__='radar-1.2.4';\n` + bridgeBootstrap + '\n' + adapter
    const revision = createHash('sha256').update(source + adapter).digest('hex').slice(0, 16)
    await fs.writeFile(payloadFile, prefix + `\nif(window.__radarRendererRevision!==${JSON.stringify(revision)}){\n` + source + `\nwindow.__radarRendererRevision=${JSON.stringify(revision)}; }\nwindow.dispatchEvent(new Event('radar-enhancer-refresh'));\n// 会话工具 /api/sessions/delete\n`)
    await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify(settings, null, 2))
    await fs.writeFile(injectorFile, `import fs from 'node:fs/promises';\nconst token=process.env.RADAR_ACCESS_TOKEN||(await fs.readFile(new URL('../access-token',import.meta.url),'utf8')).trim();\nconst r=await fetch(${JSON.stringify(apiBase + '/api/codex-tools/apply-enhancer')},{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:'{"launch":false}'});console.log(await r.text());if(!r.ok)process.exitCode=1;`)
    const catalog = tools.features?.modelWhitelist ? await models() : { models: [] }
    state.models = catalog.models
    await fs.writeFile(stateFile, JSON.stringify(state))
    return { ok: true, message: '增强脚本已生成', enhancerRoot: root, bundleDir: root, payloadFile, injectorFile, configFile: path.join(root, 'settings.json'), modelCount: state.models.length }
  }
  const inject = async port => {
    const { page, origin } = await discoverOfficialPage(port)
    const code = await fs.readFile(payloadFile, 'utf8')
    const next = await connectRenderer(page, bridge)
    try {
      await next.evaluate(code, undefined, false)
      const runtime = await next.evaluate('(async()=>{const a=window.__radarOfficialAdapter;await a?.ready;return {version:a?.version||"",capabilities:a?.capabilities||{}}})()')
      state.appVersion = runtime.version; state.capabilities = runtime.capabilities
      const settings = await next.evaluate("window.__codexSessionDeleteBridge('/settings/get', {})")
      if (typeof settings?.enhancementsEnabled !== 'boolean') throw new Error('增强桥接设置握手失败')
    } catch (e) { next.close(); throw e }
    if (disposed) { next.close(); throw new Error('增强服务已关闭') }
    connection?.close(); connection = next; targetPage = page; lastPort = port
    await scripts.refresh()
    if (!watchTimer) {
      watchTimer = setInterval(async () => {
        if (disposed || !connection || connection.alive || reconnecting) return
        reconnecting = true
        try { const cdp = await inject(lastPort); state = { ...state, ok: true, cdp, targets: 1, lastError: '' }; await fs.writeFile(stateFile, JSON.stringify(state)) }
        catch (e) { state.lastError = e.message }
        finally { reconnecting = false }
      }, 5000)
      watchTimer.unref?.()
    }
    return { ok: true, port, origin, targets: 1, transport: 'cdp-binding', targetUrl: page.url, targetId: page.id }
  }
  const apply = async (input = {}) => {
    if (disposed) throw new Error('增强服务已关闭')
    const result = await generate(input)
    const ports = [Number(process.env.RADAR_CODEX_DEBUG_PORT || 9222)]
    let cdp = { ok: false, port: ports[0] }, lastError = 'CDP 未连接，请用调试端口启动 Codex 后重试'
    for (const port of ports) { try { cdp = await inject(port); lastError = ''; break } catch (e) { lastError = e.message } }
    state = { ...state, ok: cdp.ok, targets: cdp.targets || 0, cdp, lastError, lastAppliedAt: new Date().toISOString() }; await fs.writeFile(stateFile, JSON.stringify(state))
    return { ...result, ok: cdp.ok, cdp, state, message: cdp.ok ? '页面增强已注入' : '增强包已生成，CDP 未连接：' + lastError }
  }
  const bridge = async (route, payload = {}) => {
    const cfg = await loadConfig(), settings = rendererSettings(cfg.codexTools)
    if (route === '/settings/get') return settings
    if (route === '/settings/set') {
      if (payload.providerSyncEnabled === true) return { status: 'failed', message: '请在余额雷达会话管理中执行对话同步', ...settings }
      await updateConfig(async c => {
        c.codexTools.features ||= {}
        if (typeof payload.enhancementsEnabled === 'boolean') c.codexTools.enhanceEnabled = payload.enhancementsEnabled
        if (['patch', 'relay'].includes(payload.launchMode)) c.codexTools.mode = payload.launchMode === 'patch' ? 'full' : 'compatible'
        for (const [k, v] of Object.entries(featureMap)) if (typeof payload[v] === 'boolean') c.codexTools.features[k] = payload[v]
        await writeConfig(c)
      });
      if (Object.hasOwn(payload, 'enhancementsEnabled') || Object.hasOwn(payload, 'codexAppUserScripts')) await scripts.refresh()
      return bridge('/settings/get')
    }
    if (route === '/backend/status') return { status: 'ok', ...(await status()) }
    if (route === '/backend/repair') {
      if (!connection?.alive) { const r = await apply(); return { ...r, status: r.ok ? 'ok' : 'failed' } }
      await connection.evaluate("window.dispatchEvent(new Event('radar-enhancer-refresh'));true")
      const r = await scripts.refresh()
      return { status: r.status, message: r.status === 'ok' ? '增强连接与脚本状态已刷新' : '连接正常，部分脚本执行失败', scripts: r.scripts }
    }
    if (route === '/manager/open') return { status: 'ok', url: apiBase, ...(await openExternal(apiBase)) }
    if (route === '/devtools/open') {
      if (!connection?.alive || !targetPage?.devtoolsFrontendUrl) return { status: 'failed', message: '请先连接带调试端口的官方 Codex' }
      const url = new URL(targetPage.devtoolsFrontendUrl, state.cdp?.origin || `http://127.0.0.1:${state.cdp?.port || 9222}`)
      const ws = new URL(targetPage.webSocketDebuggerUrl)
      const advertisedWs = url.searchParams.get('ws')
      if (advertisedWs) {
        const advertised = new URL('ws://' + advertisedWs)
        if (['127.0.0.1', 'localhost', '[::1]'].includes(advertised.hostname) && advertised.port === ws.port && advertised.pathname === ws.pathname) url.searchParams.set('ws', ws.host + ws.pathname)
      }
      if (url.searchParams.get('ws') !== ws.host + ws.pathname) throw new Error('开发者工具目标与当前 Codex 不一致')
      return { status: 'ok', url: url.href, ...(await openExternal(url.href)) }
    }
    if (route.startsWith('/zed-remote/')) {
      try {
        if (route === '/zed-remote/status') return native.zedStatus()
        if (route === '/zed-remote/resolve-host') return { status: 'ok', ssh: await native.resolveHost(payload.hostId) }
        if (route === '/zed-remote/fallback-request') return await native.zedFallback(payload)
        if (route === '/zed-remote/open') return await native.openZed(payload)
      } catch (e) { return { status: 'failed', message: e.message } }
    }
    if (route === '/diagnostics/log') return { status: 'ok' }
    if (route === '/codex-model-catalog' || route === '/codex-config-model') {
      await read()
      return { status: 'ok', ...(await configuredModel()), models: [...new Set((state.models || []).map(m => typeof m === 'string' ? m : m?.id).filter(m => typeof m === 'string' && m.trim()))], sources: state.catalog?.sources || [], responses_api: state.catalog?.responses_api || { status: 'unknown', message: '尚未测试 Responses 接口' } }
    }
    if (route === '/ads' || route === '/recommended-content') {
      const enabled = settings.enhancementsEnabled && settings.codexAppRecommendedContent
      const ads = enabled ? [{ id: 'radar-help', type: 'normal', title: '余额雷达', description: '打开渠道、会话与增强管理。', url: apiBase }] : []
      return { status: 'ok', ads, items: ads }
    }
    if (route.startsWith('/user-scripts/')) return scripts.handle(route, payload)
    if (!['/thread-sort-keys', '/undo', '/delete', '/export-markdown', '/move-thread-workspace', '/thread-sort-key', '/archived-thread'].includes(route)) return { status: 'failed', message: '此增强操作尚未接入：' + route }
    if (route === '/undo') { const r = await restoreDeletedSession(sessionRoot, path.join(dataDir, 'session-backups'), payload.undo_token); return { ...r, status: r.ok ? 'undone' : 'failed' } }
    const scan = await scanSessions(sessionRoot)
    let id = payload.session_id || payload.session?.session_id
    if (route === '/archived-thread' && !id && typeof payload.title === 'string') {
      const matches = scan.sessions.filter(s => s.relativePath.replaceAll('\\', '/').startsWith('../archived_sessions/') && s.title.trim() === payload.title.trim())
      if (matches.length !== 1) return { status: 'failed', message: matches.length ? '存在同名归档会话，请按会话 ID 操作' : '未找到所选归档会话' }
      id = matches[0].id
    }
    if (route === '/thread-sort-keys') return { status: 'ok', sort_keys: (payload.sessions || []).map(ref => { const found = scan.sessions.find(s => s.id === (ref.session_id || ref.id)); return { session_id: ref.session_id || ref.id, updated_at: found ? Date.parse(found.updatedAt) / 1000 : 0 } }) }
    const item = scan.sessions.find(s => s.id === id)
    if (!item) return { status: 'failed', message: '未找到所选会话' }
    if (route === '/delete') { const r = await deleteSession(sessionRoot, path.join(dataDir, 'session-backups'), item.relativePath); return { ...r, status: 'local_deleted', session_id: id, undo_token: r.backupDir, backup_path: r.backupDir } }
    if (route === '/export-markdown') return { status: 'exported', session_id: id, filename: id + '.md', markdown: await sessionMarkdown(sessionRoot, item.relativePath) }
    if (route === '/move-thread-workspace') {
      if (typeof payload.target_cwd !== 'string' || !path.isAbsolute(payload.target_cwd) || !(await fs.stat(payload.target_cwd).catch(() => null))?.isDirectory()) return { status: 'failed', message: '请选择存在的目标项目目录' }
      const r = await syncSessions(sessionRoot, path.join(dataDir, 'session-backups'), { ids: [id], provider: item.provider || 'openai', cwd: payload.target_cwd })
      return { ...r, status: r.ok ? 'moved' : 'failed', session_id: id, cwd: payload.target_cwd, updated_at: Date.parse(item.updatedAt) / 1000 }
    }
    if (route === '/thread-sort-key') return { status: 'ok', session_id: id, updated_at: Date.parse(item.updatedAt) / 1000 }
    if (route === '/archived-thread') return { status: 'ok', session_id: id, archived: Boolean(payload.archived ?? true) }
    return { status: 'failed', message: '此增强操作尚未接入：' + route }
  }
  return { status, models, generate, apply, bridge, close() { disposed = true; clearInterval(watchTimer); watchTimer = null; connection?.close(); connection = null } }
}
