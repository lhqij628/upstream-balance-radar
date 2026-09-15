import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const fields = ['id','name','baseUrl','apiKey','textApiKey','refreshToken','autoRefresh','authVersion','authUpdatedAt','rememberSecret','preset','endpoint','paths','timeout','userId','textTestModel','rechargePath','autoProbeIntervalMinutes','lowBalanceThreshold','alertLevels','wireApi','usageScript']
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const pick = account => Object.fromEntries(fields.filter(key => account[key] !== undefined).map(key => [key, account[key]]))
export function syncSnapshot(config, includeEmail = false) {
  const snapshot = { accounts: (config.accounts || []).map(pick), alertLevels: config.alertLevels, autoProbeIntervalMinutes: config.autoProbeIntervalMinutes || 0 }
  if (includeEmail) snapshot.email = config.email
  return snapshot
}

// Three-way merge preserves changes made on either device and detects delete/edit conflicts.
export function mergeSync(base, local, remote, resolution = 'abort') {
  if (!['abort','local','server'].includes(resolution)) throw fail('同步冲突策略无效')
  const conflicts = []
  const value = (before, left, right, label) => {
    if (isDeepStrictEqual(left, right)) return left
    if (base && isDeepStrictEqual(before, left)) return right
    if (base && isDeepStrictEqual(before, right)) return left
    conflicts.push(label)
    return resolution === 'server' ? right : left
  }
  const map = input => new Map((input?.accounts || []).map(a => [a.id, a]))
  const b = map(base), l = map(local), r = map(remote), accounts = []
  for (const id of new Set([...l.keys(), ...r.keys(), ...b.keys()])) {
    const before=b.get(id), left=l.get(id), right=r.get(id)
    let merged
    if (!before && (!left || !right)) merged = left || right
    else if (!left || !right) merged = value(before,left,right,`渠道 ${left?.name || right?.name || id}：删除与编辑`)
    else {
      merged = {}
      for (const key of new Set([...Object.keys(left),...Object.keys(right),...Object.keys(before || {})])) {
        const result = value(before?.[key],left[key],right[key],`渠道 ${left.name || left.baseUrl || id}：${key}`)
        if (result !== undefined) merged[key] = result
      }
    }
    if (merged) accounts.push(merged)
  }
  const snapshot = { accounts }
  for (const key of ['alertLevels','autoProbeIntervalMinutes','email']) {
    if (key in local || key in remote) snapshot[key] = value(base?.[key],local[key],remote[key],key === 'email' ? '邮箱配置' : key === 'alertLevels' ? '全局预警阈值' : '自动探测间隔')
  }
  return { snapshot, conflicts }
}

export function validateServerUrl(input) {
  let url
  try { url = new URL(String(input).trim()) } catch { throw fail('请输入有效服务器地址') }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('服务器地址请填写根地址')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) throw fail('远程同步需要 HTTPS 地址')
  return url.origin
}

export function createSyncClient({ dataDir, vault, loadConfig, applySnapshot, request = fetch }) {
  const file = path.join(dataDir,'server-sync.json')
  let state, queue = Promise.resolve()
  const load = async () => {
    if (state) return state
    try { state=vault.open(JSON.parse(await fs.readFile(file,'utf8'))) }
    catch(error){ if(error.code!=='ENOENT') throw fail('服务器同步配置读取失败',500);state={} }
    return state
  }
  const save = async next => {
    await fs.writeFile(file+'.tmp',JSON.stringify(vault.seal(next)),{mode:0o600})
    await fs.rename(file+'.tmp',file);state=next
  }
  const serial = fn => { const task=queue.then(fn);queue=task.catch(()=>{});return task }
  const remote = async (connection, route, body) => {
    let response
    try {
      response = await request(connection.url+route,{ method:body===undefined?'GET':'POST',redirect:'error',headers:{Authorization:`Bearer ${connection.token || ''}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(route.endsWith('/probe')?150000:20000) })
    } catch { throw fail('服务器连接失败，本机数据已保留',502) }
    let result
    try { result=await response.json() } catch { throw fail('服务器响应格式错误',502) }
    if (!response.ok) throw fail(response.status===401?'服务器登录已过期，请重新连接':result.error || '服务器请求失败',response.status===401?409:response.status)
    return result
  }
  return {
    status: async () => { const s=await load();return {connected:!!s.token,url:s.url||'',username:s.username||'',expiresAt:s.expiresAt||0,lastSyncAt:s.lastSyncAt||'',serverMonitoring:s.serverMonitoring!==false} },
    connect: input => serial(async () => {
      const url=validateServerUrl(input.url)
      const logged=await remote({url},'/api/auth/login',{username:input.username,password:input.password,client:'desktop-sync'})
      if (!logged.token || logged.mode !== 'server' || !logged.username) throw fail('请连接已注册管理员的服务器 Web 版',502)
      const old=await load()
      await save({ ...(old.url===url&&old.username===logged.username?old:{}),url,username:logged.username||input.username||'',token:logged.token,expiresAt:logged.expiresAt,serverMonitoring:input.serverMonitoring!==false })
      return {ok:true}
    }),
    disconnect: () => serial(async () => {
      const s=await load()
      if(s.token)try{await remote(s,'/api/auth/logout',{})}catch{}
      const config=await loadConfig()
      await applySnapshot(syncSnapshot(config),config.revision,{serverManaged:false})
      await save({url:s.url,username:s.username})
      return {ok:true}
    }),
    run: input => serial(async () => {
      const s=await load()
      if(!s.token)throw fail('请先连接服务器')
      const includeEmail=input.includeEmail===true
      const localConfig=await loadConfig(), local=syncSnapshot(localConfig,includeEmail)
      const other=await remote(s,`/api/sync/snapshot?email=${includeEmail?'1':'0'}`)
      if(!Array.isArray(other.snapshot?.accounts)||!Number.isInteger(other.revision))throw fail('服务器同步接口版本不匹配',502)
      const base=s.baseline ? {...s.baseline} : null
      if(base&&!includeEmail)delete base.email
      const merged=mergeSync(base,local,other.snapshot,input.resolution || 'abort')
      if(merged.conflicts.length&&input.resolution!=='local'&&input.resolution!=='server')return {ok:false,conflicts:merged.conflicts,message:'两端存在冲突，请选择保留本机或服务器的冲突项；其余改动会合并。'}
      const saved=await remote(s,'/api/sync/apply',{revision:other.revision,snapshot:merged.snapshot})
      // Persist the merge base only after both commits, so a failed local commit is retryable.
      await applySnapshot(saved.snapshot,localConfig.revision,{serverManaged:s.serverMonitoring!==false})
      await save({...s,baseline:saved.snapshot,lastSyncAt:new Date().toISOString()})
      return {ok:true,count:saved.snapshot.accounts.length,message:`已同步 ${saved.snapshot.accounts.length} 个渠道`,conflicts:[]}
    }),
    probe: async account => {
      const s=await load()
      if(!s.token)throw fail('服务器同步会话已断开，请重新连接或切回独立模式',409)
      return remote(s,'/api/sync/probe',{id:account.id})
    },
    monitorResults: async () => {
      const s=await load()
      if(!s.token)throw fail('服务器同步会话已断开',409)
      return (await remote(s,'/api/monitor/status')).results || {}
    },
  }
}
