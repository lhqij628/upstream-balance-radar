import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { createAdminAccount } from './admin-account.mjs'

const equal = (a, b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest())
export async function createAccess({ dataDir, host, mode = 'local', token = process.env.RADAR_ACCESS_TOKEN }) {
  const local = ['127.0.0.1', 'localhost', '::1'].includes(host)
  if ((!local || mode === 'server') && (!token || token.length < 24 || token.startsWith('REPLACE_WITH_'))) throw new Error('服务器启动需要至少 24 字符的随机 RADAR_ACCESS_TOKEN，请替换示例值')
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  if (!token) {
    const file = path.join(dataDir, 'access-token')
    try { token = (await fs.readFile(file, 'utf8')).trim() } catch (e) { if (e.code !== 'ENOENT') throw e }
    if (!token) { token = randomBytes(32).toString('base64url'); await fs.writeFile(file, token, { mode: 0o600, flag: 'wx' }) }
  }
  const sessions = new Map(), attempts = new Map()
  const admin = await createAdminAccount(dataDir)
  const origins = new Set(String(process.env.RADAR_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean))
  if (mode === 'local') { origins.add('http://tauri.localhost'); origins.add('tauri://localhost') }
  const authenticated = req => {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /i, '')
    if (bearer && (mode === 'local' || !admin.exists()) && equal(bearer, token)) return true
    const cookie = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('radar_session='))?.slice(14)
    if (admin.authenticated(bearer || cookie)) return true
    const session = !admin.exists() && (sessions.get(bearer) || sessions.get(cookie))
    return !!session && session > Date.now()
  }
  const middleware = (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    if (!req.path.startsWith('/api/')) return next()
    res.setHeader('Cache-Control', 'no-store')
    if (mode === 'local' && !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(req.headers.host || '')) return res.status(403).json({error:'本机服务仅接受本机地址'})
    const origin = req.headers.origin
    let same = false
    try { same = new URL(origin).host === req.headers.host && ['http:', 'https:'].includes(new URL(origin).protocol) } catch {}
    if (origin && !same && !origins.has(origin)) return res.status(403).json({ error: '此来源未获允许' })
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Credentials', 'true') }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    if (['/api/health','/api/auth/login','/api/auth/setup','/api/auth/register'].includes(req.path)) return next()
    if (!authenticated(req)) return res.status(401).json({ error: '请先连接并登录余额雷达' })
    if (mode === 'server' && /^\/api\/(sessions|providers|codex-tools|enhancer|import-sources|sync-client)(\/|$)/.test(req.path)) return res.status(409).json({error:'此操作需要桌面版的本机服务，请在桌面版打开'})
    next()
  }
  const limit = (req, res) => {
    const now = Date.now(), key = req.socket.remoteAddress, recent = (attempts.get(key) || []).filter(t => now-t < 60000)
    if (recent.length >= 10) { res.status(429).json({ error: '尝试过于频繁，请一分钟后重试' }); return false }
    for (const [ip, times] of attempts) if (times.at(-1) < now-60000) attempts.delete(ip)
    if (!attempts.has(key) && attempts.size >= 4096) { res.status(429).json({error:'登录请求繁忙，请稍后重试'}); return false }
    attempts.set(key, [...recent, now])
    return true
  }
  const issue = (req, res, value) => {
    const secure = req.secure || String(process.env.RADAR_PUBLIC_URL || '').startsWith('https://')
    res.cookie('radar_session', value.token, { httpOnly:true, sameSite:'strict', secure, maxAge:value.expiresAt-Date.now(), path:'/api' })
    res.json({ ok:true, ...value, mode, username:admin.username() })
  }
  const login = async (req, res, next) => {
    if (!limit(req, res)) return
    if (admin.exists()) {
      try { return issue(req, res, await admin.login(req.body?.username, req.body?.password, req.body?.client === 'desktop-sync')) }
      catch (error) { return next(error) }
    }
    if (!equal(req.body?.password || '', token)) return res.status(401).json({ error: '访问密码错误' })
    const now = Date.now()
    for (const [id, expiry] of sessions) if (expiry <= now) sessions.delete(id)
    if (sessions.size >= 256) sessions.delete(sessions.keys().next().value)
    const id = randomBytes(32).toString('base64url'), expiresAt = now + 12*60*60*1000
    sessions.set(id, expiresAt)
    issue(req, res, { token:id, expiresAt })
  }
  const credential = req => String(req.headers.authorization||'').replace(/^Bearer /i,'') || String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('radar_session='))?.slice(14)
  const logout = async (req,res,next) => { try { const id=credential(req);sessions.delete(id);if(admin.exists()) await admin.logout(id);res.clearCookie('radar_session',{path:'/api'});res.json({ok:true}) } catch(error){next(error)} }
  const setup = (_req,res) => res.json({ registrationOpen:!admin.exists(), mode, requiresSetupCode:true })
  const register = async (req,res,next) => {
    if (!limit(req,res)) return
    try {
      if (admin.exists()) return res.status(409).json({error:'管理员已注册，注册入口已关闭'})
      if (!equal(req.body?.setupCode || '', token)) return res.status(403).json({error:'部署初始化码错误'})
      await admin.register(req.body?.username, req.body?.password)
      sessions.clear()
      res.status(201).json({ok:true})
    } catch(error){next(error)}
  }
  const changePassword = async (req,res,next) => {
    if (!limit(req,res)) return
    try { await admin.changePassword(req.body?.currentPassword, req.body?.password); sessions.clear();res.clearCookie('radar_session',{path:'/api'});res.json({ok:true}) } catch(error){next(error)}
  }
  const status = (_req,res) => res.json({ok:true,mode,version:'0.2.0',syncProtocol:1,username:admin.username(),registered:admin.exists()})
  return { middleware, login, logout, setup, register, changePassword, status, mode }
}
