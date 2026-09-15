import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export function createUserScripts({ root, getConnection, isEnabled }) {
  const file = path.join(root, 'user-scripts.json'), userDir = path.join(root, 'user-scripts')
  let queue = Promise.resolve(), currentConnection
  const runtime = new Map()
  async function read() {
    let data = { enabled: true, scripts: [] }
    try { data = JSON.parse(await fs.readFile(file, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
    data.scripts ||= []
    // Only the dedicated directory is scanned; no arbitrary path from a request.
    for (const entry of await fs.readdir(userDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue
      const key = entry.name
      const sourceFile = path.join(userDir, key)
      if ((await fs.stat(sourceFile)).size > 128 * 1024) continue
      const existing = data.scripts.find(s => s.key === key)
      const code = await fs.readFile(sourceFile, 'utf8')
      if (existing) existing.code = code
      else data.scripts.push({ key, name: entry.name, source: 'user', enabled: true, code })
    }
    return data
  }
  async function save(data) {
    await fs.mkdir(root, { recursive: true })
    const temp = file + '.' + randomUUID() + '.tmp'
    try { await fs.writeFile(temp, JSON.stringify(data, null, 2)); await fs.rename(temp, file) }
    finally { await fs.rm(temp, { force: true }).catch(() => {}) }
  }
  function connection() {
    const next = getConnection()
    if (next !== currentConnection || !next?.alive) { runtime.clear(); currentConnection = next }
    return next?.alive ? next : null
  }
  async function dispose(key) {
    const c = connection()
    if (!c) return
    await c.evaluate(`(async()=>{const r=window.__radarUserScripts?.[${JSON.stringify(key)}];if(!r)return;r.controller.abort();try{for(const fn of r.cleanups)await fn()}finally{delete window.__radarUserScripts[${JSON.stringify(key)}]}})()`)
    runtime.delete(key)
  }
  async function execute(script) {
    const c = connection()
    if (!c) return { status: 'not_loaded', error: '请先连接官方 Codex' }
    if (typeof script.code !== 'string' || Buffer.byteLength(script.code) > 128 * 1024) return { status: 'failed', error: '脚本内容为空或超过 128 KiB' }
    const key = JSON.stringify(script.key)
    try {
      await dispose(script.key)
      await c.evaluate(`(async()=>{const all=window.__radarUserScripts||=(Object.create(null));const r={controller:new AbortController(),cleanups:[]};all[${key}]=r;const radar={signal:r.controller.signal,onCleanup(fn){if(typeof fn==='function')r.cleanups.push(fn)}};try{const result=await(async function(radar){\n${script.code}\n})(radar);if(typeof result==='function')r.cleanups.push(result);return true}catch(e){r.controller.abort();for(const fn of r.cleanups)try{await fn()}catch{}delete all[${key}];throw e}})()`)
      return { status: 'loaded', hash: createHash('sha256').update(script.code).digest('hex') }
    } catch (e) { return { status: 'failed', error: e.message } }
  }
  async function view(data) {
    connection()
    const enabled = data.enabled && await isEnabled()
    return { status: 'ok', enabled: Boolean(data.enabled), effective_enabled: Boolean(enabled), builtin_dir: '', user_dir: userDir, scripts: data.scripts.map(({ code, ...s }) => ({ ...s, ...(runtime.get(s.key) || { status: enabled && s.enabled ? 'not_loaded' : 'disabled' }) })) }
  }
  async function run(data, force = false) {
    const enabled = data.enabled && await isEnabled()
    for (const script of data.scripts) {
      if (!enabled || !script.enabled) { await dispose(script.key); runtime.set(script.key, { status: 'disabled' }); continue }
      connection()
      const previous = runtime.get(script.key)
      if (!force && previous?.status === 'loaded' && previous.hash === createHash('sha256').update(script.code || '').digest('hex')) continue
      runtime.set(script.key, await execute(script))
    }
    const result = await view(data)
    return { ...result, status: result.scripts.some(s => s.status === 'failed') ? 'failed' : 'ok', reloaded: true }
  }
  async function operation(route, payload = {}) {
    const data = await read()
    if (route === '/user-scripts/list') return view(data)
    if (route === '/user-scripts/install') {
      if (typeof payload.code !== 'string' || !payload.code.trim() || Buffer.byteLength(payload.code) > 128 * 1024) throw new Error('请选择 128 KiB 以内的 JavaScript 文件')
      const name = String(payload.name || 'user-script.js')
      if (!/^[\p{L}\p{N}_. -]+\.js$/u.test(name) || name === '..js') throw new Error('脚本文件名无效')
      if (data.scripts.some(s => s.key === name)) throw new Error('已存在同名脚本，请先删除或更换文件名')
      await fs.mkdir(userDir, { recursive: true })
      await fs.writeFile(path.join(userDir, name), payload.code, { flag: 'wx' })
      data.scripts.push({ key: name, name, source: 'user', enabled: true, code: payload.code })
    } else if (route === '/user-scripts/set-enabled') data.enabled = Boolean(payload.enabled)
    else if (route === '/user-scripts/set-script-enabled' || route === '/user-scripts/delete') {
      const script = data.scripts.find(s => s.key === payload.key)
      if (!script) throw new Error('脚本不存在')
      if (route.endsWith('/delete')) {
        await dispose(script.key)
        data.scripts = data.scripts.filter(s => s !== script)
        if (path.basename(script.key) === script.key && script.key.endsWith('.js')) await fs.rm(path.join(userDir, script.key), { force: true })
      } else script.enabled = Boolean(payload.enabled)
    } else if (route !== '/user-scripts/reload') throw new Error('未知脚本操作')
    await save(data)
    return run(data, route === '/user-scripts/reload')
  }
  return {
    handle(route, payload) { const result = queue.catch(() => {}).then(() => operation(route, payload)); queue = result; return result },
    refresh() { return this.handle('/user-scripts/reload') },
  }
}
