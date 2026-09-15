import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const digest = value => createHash('sha256').update(String(value)).digest('hex')
const fail = (message, status = 400) => Object.assign(new Error(message), { status })

export async function createAdminAccount(dataDir) {
  const file = path.join(dataDir, 'admin-account.json')
  let state = { admin: null, sessions: {} }
  try {
    state = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!state.admin?.username || !/^[a-f0-9]{128}$/.test(state.admin.hash) || !/^[a-f0-9]{32}$/.test(state.admin.salt) || !state.sessions) throw new Error('Invalid account data')
  } catch (error) { if (error.code !== 'ENOENT') throw fail('管理员账户文件读取失败，请检查备份', 500) }
  let queue = Promise.resolve()
  const update = operation => {
    const job = queue.then(async () => {
      const next = structuredClone(state)
      const result = await operation(next)
      await fs.writeFile(file + '.tmp', JSON.stringify(next), { mode: 0o600 })
      await fs.rename(file + '.tmp', file)
      state = next
      return result
    })
    queue = job.catch(() => {})
    return job
  }
  const checkPassword = async (password, admin = state.admin) => {
    if (typeof password !== 'string' || password.length > 256) return false
    const salt = admin?.salt || '00000000000000000000000000000000'
    const key = await scrypt(password, salt, 64)
    return !!admin && timingSafeEqual(key, Buffer.from(admin.hash, 'hex'))
  }
  const passwordFields = async password => {
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw fail('密码长度须为 12 至 256 个字符')
    const salt = randomBytes(16).toString('hex')
    return { salt, hash: (await scrypt(password, salt, 64)).toString('hex') }
  }
  return {
    exists: () => !!state.admin,
    username: () => state.admin?.username || '',
    async register(username, password) {
      return update(async next => {
        if (next.admin) throw fail('管理员已注册，注册入口已关闭', 409)
        if (typeof username !== 'string' || !/^[\p{L}\p{N}_.@-]{3,64}$/u.test(username)) throw fail('用户名须为 3 至 64 个字母、数字或 _.@-')
        next.admin = { username: username.trim(), ...(await passwordFields(password)), createdAt: new Date().toISOString() }
      })
    },
    async login(username, password, device = false) {
      // Serialize password verification with password changes and session creation.
      return update(async next => {
        const valid = await checkPassword(password, next.admin)
        if (!valid || username !== next.admin.username) throw fail('用户名或密码错误', 401)
        const now = Date.now()
        for (const [key, value] of Object.entries(next.sessions)) if (value.expiresAt <= now) delete next.sessions[key]
        if (Object.keys(next.sessions).length >= 128) delete next.sessions[Object.keys(next.sessions)[0]]
        const token = randomBytes(32).toString('base64url')
        const expiresAt = now + (device ? 30 * 24 : 12) * 60 * 60 * 1000
        next.sessions[digest(token)] = { expiresAt, device }
        return { token, expiresAt }
      })
    },
    authenticated: token => !!token && (state.sessions[digest(token)]?.expiresAt || 0) > Date.now(),
    logout: token => update(async next => { delete next.sessions[digest(token)] }),
    changePassword: (oldPassword, password) => update(async next => {
      if (!await checkPassword(oldPassword, next.admin)) throw fail('当前密码错误', 401)
      next.admin = { ...next.admin, ...(await passwordFields(password)) }
      next.sessions = {}
    }),
  }
}
