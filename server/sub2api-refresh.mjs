import { createHash } from 'node:crypto'

const rotations = new Map()

export function tokenNeedsRefresh(token, now = Date.now()) {
  if (!token) return true
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    return Number.isFinite(payload.exp) && payload.exp * 1000 <= now + 60000
  } catch { return false }
}

export function refreshSub2api(baseUrl, refreshToken, timeout = 12) {
  // Rotating RTs are single-use. Concurrent probes share one exchange.
  const key = createHash('sha256').update(`${baseUrl}\n${refreshToken}`).digest('hex')
  const now = Date.now()
  for (const [id, item] of rotations) if (item.expiresAt < now) rotations.delete(id)
  if (rotations.has(key)) return rotations.get(key).promise
  const promise = exchange(baseUrl, refreshToken, timeout)
  rotations.set(key, { promise, expiresAt: now + 60000 })
  if (rotations.size > 200) rotations.delete(rotations.keys().next().value)
  return promise
}

async function exchange(baseUrl, refreshToken, timeout) {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/api/v1/auth/refresh`
  try {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(Math.max(3, Math.min(60, Number(timeout) || 12)) * 1000),
    })
    const body = await response.json().catch(() => null)
    const data = body?.data || body
    if (!response.ok || body?.success === false || (body?.code != null && ![0, 200].includes(body.code))) {
      const message = [400, 401, 403].includes(response.status)
        ? 'RT 已失效或被撤销，请重新登录上游并更新 JWT / RT'
        : response.status === 404 ? '上游未开放 RT 刷新接口' : response.status === 429 ? '上游刷新频率受限，请稍后再试' : '上游 RT 刷新失败，请稍后重试'
      return { ok: false, httpStatus: response.status, endpoint, message }
    }
    if (typeof data?.access_token !== 'string' || !data.access_token.trim() || typeof data.refresh_token !== 'string' || !data.refresh_token.trim()) {
      return { ok: false, httpStatus: response.status, endpoint, message: '刷新响应缺少 access_token 或 refresh_token，原凭据已保留' }
    }
    return { ok: true, apiKey: data.access_token.trim(), refreshToken: data.refresh_token.trim(), authUpdatedAt: new Date().toISOString() }
  } catch {
    return { ok: false, httpStatus: 0, endpoint, message: 'RT 刷新请求超时或网络异常，请稍后重试' }
  }
}
