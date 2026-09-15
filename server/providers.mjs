import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { parse, stringify } from 'smol-toml'
import { createHash } from 'node:crypto'

export const codexHome = () => process.env.RADAR_CODEX_HOME || path.join(process.env.RADAR_USER_HOME || os.homedir(), '.codex')
let queue = Promise.resolve()
export async function providerStatus() {
  let config = {}; try { config = parse(await fs.readFile(path.join(codexHome(), 'config.toml'), 'utf8')) } catch {}
  return { home: codexHome(), provider: config.model_provider || 'openai', model: config.model || '', configured: Boolean(config.model_provider), protocol: config.model_providers?.[config.model_provider]?.wire_api || 'responses' }
}
export function switchProvider(account, dataDir, mode = 'api') {
  const task = queue.then(async () => {
    const root = codexHome(), configPath = path.join(root, 'config.toml'), authPath = path.join(root, 'auth.json')
    await fs.mkdir(root, { recursive: true })
    const before = await fs.readFile(configPath, 'utf8').catch(() => ''), authBefore = await fs.readFile(authPath, 'utf8').catch(() => null)
    const config = before ? parse(before) : {}, id = 'radar_' + createHash('sha256').update(account.id || 'official').digest('hex').slice(0, 12)
    const backupDir = path.join(dataDir, 'provider-backups', new Date().toISOString().replace(/[:.]/g, '-'))
    await fs.mkdir(backupDir, { recursive: true }); await fs.writeFile(path.join(backupDir, 'config.toml'), before)
    if (authBefore !== null) await fs.writeFile(path.join(backupDir, 'auth.json'), authBefore)
    await fs.writeFile(path.join(backupDir, 'manifest.json'), JSON.stringify({ root, configExisted: Boolean(before), authExisted: authBefore !== null }))
    if (mode === 'official') { config.model_provider = 'openai' }
    else {
      const key = account.textApiKey || account.apiKey
      if (!key || !account.baseUrl) throw new Error('请填写渠道地址和模型调用 Key')
      const url = new URL(account.baseUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('渠道 URL 无效')
      const source = account.providerConfig ? parse(account.providerConfig) : {}
      const original = source.model_providers?.[source.model_provider] || {}
      config.model_providers ||= {}
      config.model_providers[id] = { ...original, name: account.name || '余额雷达', base_url: account.baseUrl.replace(/\/$/, ''), wire_api: account.wireApi === 'chat' ? 'chat' : 'responses', requires_openai_auth: false, experimental_bearer_token: key }
      delete config.model_providers[id].env_key
      config.model_provider = id; config.model = account.textTestModel || source.model || config.model || 'gpt-5.5'
    }
    try { await fs.writeFile(configPath + '.radar-tmp', stringify(config)); await fs.rename(configPath + '.radar-tmp', configPath) }
    catch (e) { await fs.writeFile(configPath, before); throw e }
    return { ok: true, backupDir, ...(await providerStatus()), message: '供应商配置已保存，新任务将使用所选供应商；当前任务保留原配置' }
  })
  queue = task.catch(() => {})
  return task
}
