import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { parse as parseToml } from 'smol-toml'

export const channelIdentity = (a) => `${String(a.baseUrl || '').replace(/\/$/, '').toLowerCase()}\0${a.textApiKey || a.apiKey || ''}`
export const importId = (a) => 'import_' + createHash('sha256').update(channelIdentity(a)).digest('hex').slice(0, 32)
function toml(text) { try { return parseToml(text || '') } catch { return {} } }
function json(text) { try { return typeof text === 'string' ? JSON.parse(text) : (text || {}) } catch { return {} } }
function provider(config) { const d = toml(config); return { d, p: d.model_providers?.[d.model_provider] || Object.values(d.model_providers || {})[0] || {} } }
function fromConfig(config, auth = {}) {
  const { d, p } = provider(config)
  return { baseUrl: p.base_url, apiKey: p.experimental_bearer_token || p.bearer_token || auth.OPENAI_API_KEY || '', wireApi: p.wire_api || 'responses', textTestModel: d.model || '', providerConfig: config || '' }
}
export async function scanSources({ home = process.env.RADAR_USER_HOME || os.homedir(), codexHome = process.env.RADAR_CODEX_HOME || path.join(home, '.codex'), sanitize = (a) => a } = {}) {
  const sources = [], byIdentity = new Map()
  const add = (raw) => {
    if (!raw.baseUrl || !/^https?:\/\//.test(raw.baseUrl)) return
    const a = { ...raw, baseUrl: raw.baseUrl.replace(/\/$/, ''), textApiKey: raw.textApiKey || raw.apiKey || '', preset: raw.usageScript?.enabled ? 'ccswitch_script' : (raw.preset || 'auto'), rememberSecret: true }
    a.id = importId(a)
    const key = channelIdentity(a), old = byIdentity.get(key)
    if (old) {
      if (a.usageScript?.code) Object.assign(old, { usageScript: a.usageScript, preset: a.preset })
      old.sources = [...new Set([...(old.sources || [old.source]), a.source])]
      if (!old.providerConfig && a.providerConfig) old.providerConfig = a.providerConfig
      if (!old.userId && a.userId) old.userId = a.userId
      return
    }
    byIdentity.set(key, a)
  }
  const dbSource = async (source, file, query, convert) => {
    let db
    try {
      await fs.access(file); db = new DatabaseSync(file, { readOnly: true }); db.exec('PRAGMA busy_timeout=3000')
      const rows = db.prepare(query).all(); let rejected = 0
      for (const row of rows) { try { const item = convert(row); if (item?.baseUrl) add({ ...item, source, sourcePath: file }); else rejected++ } catch { rejected++ } }
      sources.push({ source, path: file, found: true, count: rows.length, skipped: rejected })
    } catch (error) { sources.push({ source, path: file, found: false, count: 0, error: error.code === 'ENOENT' ? '配置文件不存在' : '数据库读取失败，请检查文件格式或占用状态' }) }
    finally { db?.close() }
  }
  await dbSource('Codex-X', path.join(home, '.codexx', 'codexx.db'), 'SELECT * FROM providers', r => ({ ...fromConfig(r.toml_config, {}), name: r.provider_name, baseUrl: r.base_url, apiKey: r.api_key || fromConfig(r.toml_config).apiKey, wireApi: r.wire_api || fromConfig(r.toml_config).wireApi, textTestModel: r.model, sourceId: String(r.id) }))
  await dbSource('CC Switch', path.join(home, '.cc-switch', 'cc-switch.db'), "SELECT * FROM providers WHERE app_type='codex'", r => {
    const settings = json(r.settings_config), meta = json(r.meta), usage = meta.usage_script || meta.usageScript
    return { ...fromConfig(settings.config, settings.auth), name: r.name, sourceId: String(r.id), usageScript: usage || null, rechargePath: r.website_url || '/wallet' }
  })
  const ppPath = path.join(home, '.codex-session-delete', 'settings.json')
  try {
    const settings = json(await fs.readFile(ppPath, 'utf8')); const rows = settings.relayProfiles || []
    for (const r of rows) { const p = fromConfig(r.configContents, json(r.authContents)); add({ ...p, name: r.name || 'Codex++', baseUrl: r.upstreamBaseUrl || r.baseUrl || p.baseUrl, apiKey: r.officialMixApiKey || r.apiKey || p.apiKey, wireApi: /chat/i.test(r.protocol || '') ? 'chat' : p.wireApi, textTestModel: r.testModel || p.textTestModel, source: 'Codex++', sourceId: r.id, sourcePath: ppPath }) }
    if (!rows.length && settings.relayBaseUrl) add({ baseUrl: settings.relayBaseUrl, apiKey: settings.relayApiKey, textTestModel: settings.relayTestModel, source: 'Codex++', sourcePath: ppPath })
    sources.push({ source: 'Codex++', path: ppPath, found: true, count: rows.length })
  } catch { sources.push({ source: 'Codex++', path: ppPath, found: false, count: 0 }) }
  const configPath = path.join(codexHome, 'config.toml')
  try {
    const config = await fs.readFile(configPath, 'utf8'), d = toml(config)
    const auth = json(await fs.readFile(path.join(codexHome, 'auth.json'), 'utf8').catch(() => '{}'))
    for (const [id, p] of Object.entries(d.model_providers || {})) add({ baseUrl: p.base_url, apiKey: p.experimental_bearer_token || p.bearer_token || (id === d.model_provider ? auth.OPENAI_API_KEY : '') || '', wireApi: p.wire_api || 'responses', textTestModel: d.model, name: p.name || id, providerConfig: config, source: 'Codex', sourceId: id, sourcePath: configPath })
    sources.push({ source: 'Codex', path: configPath, found: true })
  } catch { sources.push({ source: 'Codex', path: configPath, found: false }) }
  const accounts = [...byIdentity.values()].map(sanitize)
  return { count: accounts.length, accounts, sources }
}
