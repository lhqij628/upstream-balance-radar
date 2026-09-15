/** Relative recharge paths belong to the website, not its /v1 API prefix. */
export function resolveRechargeUrl(baseUrl: string, input: string): string {
  const value = input.trim() || '/wallet'
  const base = new URL(baseUrl)
  if (!['https:', 'http:'].includes(base.protocol)) throw new Error('渠道地址须为 HTTP 或 HTTPS')
  if (/^\/\//.test(value) || value.includes('\\')) throw new Error('请填写站内路径或完整 HTTP / HTTPS 充值网址')
  const url = new URL(value, base.origin + '/')
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('充值链接须为 HTTP 或 HTTPS，且不含登录凭据')
  return url.href
}
