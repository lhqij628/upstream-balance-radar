const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

export function emailHtml(subject, body) {
  const lines = String(body).split(/\r?\n/).map(line => {
    const match = /^(快速充值|渠道 URL)：(https?:\/\/\S+)$/.exec(line)
    if (match) {
      try {
        const url = new URL(match[2])
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
          const href = escapeHtml(url.href)
          if (match[1] === '快速充值') return `<p style="margin:20px 0"><a href="${href}" target="_blank" style="display:inline-block;padding:14px 24px;background:#0f766e;color:#ffffff;text-decoration:underline;border-radius:8px;font-weight:bold">点击前往渠道充值</a></p><p style="font-size:13px;overflow-wrap:anywhere">充值地址：<a href="${href}" style="color:#0f766e;text-decoration:underline">${href}</a></p>`
          return `<p style="overflow-wrap:anywhere">渠道 URL：<a href="${href}" style="color:#0f766e;text-decoration:underline">${href}</a></p>`
        }
      } catch {}
    }
    return `<p style="margin:10px 0;overflow-wrap:anywhere">${escapeHtml(line)}</p>`
  }).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:20px;background:#f3f6fa;color:#172033;font:16px/1.6 Arial,sans-serif"><div style="max-width:600px;margin:auto;padding:24px;background:#ffffff;border:1px solid #dce3ea;border-radius:12px"><h2 style="font-size:20px">${escapeHtml(subject)}</h2>${lines}</div></body></html>`
}
