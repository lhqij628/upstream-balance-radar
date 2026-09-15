import { useState } from 'react'

export function SessionId({ id }: { id?: string }) {
  const [message, setMessage] = useState('')
  const [manual, setManual] = useState(false)
  async function copy() {
    if (!id) return
    setMessage('')
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(id)
      } else {
        // Older WebViews and HTTP deployments may lack the Clipboard API.
        const field = document.createElement('textarea')
        const previousFocus = document.activeElement
        field.value = id
        field.style.cssText = 'position:fixed;left:0;top:0;opacity:0;pointer-events:none'
        document.body.appendChild(field)
        try {
          field.select()
          if (!document.execCommand('copy')) throw new Error('clipboard unavailable')
        } finally {
          field.remove()
          if (previousFocus instanceof HTMLElement) previousFocus.focus()
        }
      }
      setManual(false)
      setMessage('会话 ID 已复制')
    } catch {
      setManual(true)
      setMessage('剪贴板未获准访问，请选中下方 ID 后按 Ctrl+C 复制。')
    }
  }
  return <div className="session-id">
    <div className="session-id-row"><code title={id}>{id || '会话 ID 缺失'}</code><button type="button" className="ghost session-copy" aria-label={id ? `复制会话 ID ${id}` : '会话 ID 缺失'} title={id ? '复制会话 ID' : '该文件没有记录会话 ID'} disabled={!id} onClick={() => void copy()}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg></button></div>
    <span className="session-copy-feedback" role="status">{message}</span>
    {manual && <input aria-label="手动复制会话 ID" readOnly value={id} onFocus={e => e.currentTarget.select()} />}
  </div>
}
