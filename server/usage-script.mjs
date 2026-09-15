import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten'

async function evaluate(code) {
  const engine = await getQuickJS()
  return engine.evalCode(code, { shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + 1000), memoryLimitBytes: 16 * 1024 * 1024, maxStackSizeBytes: 256 * 1024 })
}
export async function runUsageScript(account, request = fetch) {
  const script = account.usageScript
  if (!script?.code || !script.enabled) throw new Error('余额查询脚本未启用')
  if (script.code.length > 128 * 1024) throw new Error('余额查询脚本过大')
  // Substitute data after evaluating the script, so credentials never become JavaScript source.
  const vars = { apiKey: script.apiKey || script.api_key || account.textApiKey || account.apiKey || '', baseUrl: script.baseUrl || script.base_url || account.baseUrl, accessToken: script.accessToken || script.access_token || account.apiKey || '', userId: script.userId || script.user_id || account.userId || '' }
  const replace = v => typeof v === 'string' ? v.replace(/\{\{(apiKey|baseUrl|accessToken|userId)\}\}/g, (_, k) => vars[k]) : Array.isArray(v) ? v.map(replace) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replace(x)])) : v
  const config = replace(await evaluate(`JSON.parse(JSON.stringify((${script.code}).request))`))
  const url = new URL(config.url), base = new URL(vars.baseUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('查询脚本请求地址无效')
  if (script.template_type !== 'custom' && url.origin !== base.origin) throw new Error('查询脚本请求地址与渠道不一致')
  const response = await request(url.href, { method: config.method || 'GET', headers: config.headers || {}, body: config.body || undefined, redirect: 'error', signal: AbortSignal.timeout(Math.min(60, Math.max(3, account.timeout || 12)) * 1000) })
  if (!response.ok) return { ok: false, httpStatus: response.status, endpoint: url.href, plans: [], message: `查询脚本 HTTP ${response.status}` }
  const text = await response.text()
  if (text.length > 4 * 1024 * 1024) throw new Error('余额响应过大')
  const data = JSON.parse(text)
  const value = await evaluate(`(${script.code}).extractor(${JSON.stringify(data)})`)
  const plans = (Array.isArray(value) ? value : [value]).map(p => {
    const remaining = p.remaining ?? (Number.isFinite(p.total) && Number.isFinite(p.used) ? p.total - p.used : null)
    if (remaining !== null && !Number.isFinite(remaining)) throw new Error('脚本余额字段须为有限数值')
    return { planName: String(p.planName || ''), remaining, unit: String(p.unit || ''), isValid: p.isValid !== false, invalidMessage: String(p.invalidMessage || '') }
  })
  return { ok: plans.length > 0 && plans.every(p => p.isValid), httpStatus: response.status, endpoint: url.href, plans, message: '已按原渠道脚本查询' }
}
