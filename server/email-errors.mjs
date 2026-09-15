export function validateEmail(config = {}) {
  const fail = message => { throw Object.assign(new Error(message), { code: 'RADAR_EMAIL_CONFIG', status: 400 }) }
  if (!String(config.recipients || '').trim()) fail('请填写收件邮箱')
  if (!String(config.smtpHost || '').trim()) fail('请填写 SMTP 服务器')
  if (!String(config.sender || config.username || '').trim()) fail('请填写发件邮箱')
  if (!String(config.username || '').trim()) fail('请填写 SMTP 用户名')
  if (!String(config.password || '').trim()) fail('缺少 SMTP 授权码，请在邮箱管理中填写并保存；QQ 邮箱请使用 SMTP 授权码')
}

// Only expose our own validation messages or allowlisted SMTP error categories.
export function emailFailureMessage(error) {
  if (error?.code === 'RADAR_EMAIL_CONFIG') return error.message
  if (error?.code === 'EAUTH') return 'SMTP 认证失败，请检查邮箱账号和授权码，以及邮箱是否已开启 SMTP 服务'
  if (error?.code === 'ETIMEDOUT') return 'SMTP 连接超时，请检查网络和 SMTP 端口'
  if (['ECONNECTION', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ENOTFOUND'].includes(error?.code)) return 'SMTP 连接失败，请检查服务器地址、端口、SSL 和网络'
  if (error?.code === 'EENVELOPE') return '邮件地址被 SMTP 服务器拒绝，请检查发件邮箱和收件邮箱'
  return '邮件发送失败，请检查 SMTP 设置或稍后重试'
}
