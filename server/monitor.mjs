import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import { emailFailureMessage } from './email-errors.mjs'

const fingerprint=a=>createHash('sha256').update(JSON.stringify([a.baseUrl||'',a.preset||'auto',a.userId||'',a.endpoint||'',a.paths||'',a.rememberSecret===false?'':a.apiKey||'',a.usageScript||null])).digest('hex')

function rechargeUrl(account) {
  const base = String(account.baseUrl || '').trim()
  const configured = String(account.rechargePath || '/wallet').trim() || '/wallet'
  try {
    const origin = new URL(base)
    if (!['https:', 'http:'].includes(origin.protocol) || /^\/\//.test(configured) || configured.includes('\\')) throw new Error('Invalid recharge URL')
    const target = new URL(configured, origin.origin + '/')
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid recharge URL')
    return target.href
  } catch {
    return '充值链接配置有误，请在渠道编辑中检查充值地址。'
  }
}

export function createMonitor({ dataDir, loadConfig, updateConfig, writeConfig, probe, appendHistory, sendEmail, remoteResults, clock = Date.now }) {
  const file = path.join(dataDir, 'monitor-state.json'), inflight = new Map(); let state = { results: {}, signatures: {}, next: {}, intervals: {}, alerts: {}, lastError: '' }, ready, timer, busy = false
  const init = () => ready ||= fs.readFile(file, 'utf8').then(s => { state = { ...state, ...JSON.parse(s) } }).catch(() => {})
  let saveQueue = Promise.resolve()
  const save = () => { const json = JSON.stringify(state); const job = saveQueue.then(async () => { await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(file + '.tmp', json); await fs.rename(file + '.tmp', file) }); saveQueue = job.catch(() => {}); return job }
  let alertQueue = Promise.resolve()
  const alert = (account, result) => {
    const task = alertQueue.then(async () => {
      const cfg = await loadConfig(), current = cfg.accounts.find(a => a.id === account.id)
      if (!current || current.syncManaged || fingerprint(current)!==fingerprint({...account,...result.credentialUpdate}) || !result.ok || !Number.isFinite(result.balanceNumber) || current.preset === 'sub2api_billing' || result.unit === '倍率') return
      const levels = current.alertLevels || { ...cfg.alertLevels, ...(current.lowBalanceThreshold > 0 ? { level1: current.lowBalanceThreshold } : {}) }
      const balance = result.balanceNumber, level = balance <= levels.level3 ? 3 : balance <= levels.level2 ? 2 : balance <= levels.level1 ? 1 : 0
      const previous = state.alerts[current.id] || { level: current.lastAlertLevel || 0, at: 0 }
      if (!level) { state.alerts[current.id] = { level: 0, at: 0 }; if (current.lastAlertLevel) await updateConfig(async latest => { const a = latest.accounts.find(a => a.id === current.id); if (a) { a.lastAlertLevel = 0; await writeConfig(latest) } }); return }
      const email = cfg.email
      if (!email.enabled) return
      const now = clock()
      if (level <= previous.level) return
      try {
        const name = current.name || '未命名渠道'
        const url = String(current.baseUrl || '').trim()
        await sendEmail(email, `上游余额 ${level} 级预警：${name}`, `渠道名称：${name}\n渠道 URL：${url}\n当前余额：${balance}${result.unit ? ' ' + result.unit : ''}\n触发阈值：${level} 级，余额 ≤ ${levels['level' + level]}${result.unit ? ' ' + result.unit : ''}\n快速充值：${rechargeUrl(current)}\n预警线：${levels.level1} / ${levels.level2} / ${levels.level3}\n检查时间：${result.checkedAt || new Date(now).toISOString()}`)
        state.alerts[current.id] = { level, at: now }; state.lastError = ''
        await updateConfig(async latest => { const a = latest.accounts.find(a => a.id === current.id); if (a) { a.lastAlertLevel = level; await writeConfig(latest) } })
      } catch (error) { state.lastError = `预警邮件发送失败：${emailFailureMessage(error)}；下次探测将重试` }
    })
    alertQueue = task.catch(() => {}); return task
  }
  const run = async account => {
    await init()
    if (inflight.has(account.id)) return inflight.get(account.id)
    const job = (async () => {
      const result = await probe(account)
      const safe = { ...result }; delete safe.credentialUpdate
      state.results[account.id] = safe
      state.signatures[account.id] = fingerprint({...account,...result.credentialUpdate})
      await appendHistory([account], [result]); await alert(account, result); await save()
      return result
    })().finally(() => inflight.delete(account.id))
    inflight.set(account.id, job); return job
  }
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      await init(); const cfg = await loadConfig(), now = clock(), due = []
      const managed = cfg.accounts.filter(a=>a.syncManaged)
      if (managed.length && remoteResults) {
        try {
          const results = await remoteResults()
          for (const account of managed) {
            if (results[account.id]) { state.results[account.id]=results[account.id];state.signatures[account.id]=fingerprint(account) }
            else { delete state.results[account.id];delete state.signatures[account.id] }
          }
          state.lastSyncError=''
        } catch { state.lastSyncError='服务器状态同步失败，显示上次查询结果；可在设置中重新连接或切回独立运行' }
      } else state.lastSyncError=''
      const ids = new Set(cfg.accounts.map(a => a.id))
      for (const k of new Set([...Object.keys(state.next), ...Object.keys(state.results)])) if (!ids.has(k)) { delete state.next[k]; delete state.results[k]; delete state.signatures[k]; delete state.alerts[k]; delete state.intervals[k] }
      for (const account of cfg.accounts) {
        const minutes = Number(account.autoProbeIntervalMinutes || cfg.autoProbeIntervalMinutes || 0)
        if (account.syncManaged || account.monitorEnabled === false || !account.rememberSecret || minutes <= 0) { delete state.next[account.id]; continue }
        if (!state.next[account.id] || state.intervals[account.id] !== minutes) state.next[account.id] = now + minutes * 60000
        state.intervals[account.id] = minutes
        if (state.next[account.id] <= now) { state.next[account.id] = now + minutes * 60000; due.push(account) }
      }
      let index = 0
      await Promise.all(Array.from({ length: Math.min(3, due.length) }, async () => { while (index < due.length) { try { await run(due[index++]) } catch { state.lastError = '后台探测失败，请检查服务日志' } } }))
      await save()
    } finally { busy = false }
  }
  return { run, tick, async status() { await init();const cfg=await loadConfig();for(const id of Object.keys(state.results)){const current=cfg.accounts.find(a=>a.id===id);if(!current||state.signatures[id]!==fingerprint(current)){delete state.results[id];delete state.signatures[id]}} return { serverManaged: true, running: Boolean(timer), ...state } }, start() { if (timer) return; timer = setInterval(() => tick().catch(() => {}), 5000); timer.unref(); tick().catch(() => {}) }, stop() { clearInterval(timer); timer = null } }
}
