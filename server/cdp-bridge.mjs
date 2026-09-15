import { randomBytes } from 'node:crypto'

// Only the official app origin is supported. A title containing "Codex" also
// matches Codex-X and is not evidence that the renderer belongs to this app.
export function isOfficialPage(page) {
  try { const u = new URL(page.url); return page.type === 'page' && u.protocol === 'app:' && u.hostname === '-' && u.pathname === '/index.html' && Boolean(page.webSocketDebuggerUrl) } catch { return false }
}

export async function discoverOfficialPage(port, { fetchImpl = fetch } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Codex debug port')
  const failures = []
  for (const host of ['127.0.0.1', '[::1]']) {
    const origin = `http://${host}:${port}`
    try {
      const response = await fetchImpl(origin + '/json/list', { signal: AbortSignal.timeout(2500), redirect: 'error' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const pages = await response.json()
      const page = Array.isArray(pages) && pages.find(isOfficialPage)
      if (!page) throw new Error('Official Codex app://-/index.html target absent')
      const ws = new URL(page.webSocketDebuggerUrl)
      if (ws.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(ws.hostname) || Number(ws.port) !== port) throw new Error('Unexpected debug WebSocket address')
      // Use the interface that answered discovery, including IPv6-only hosts.
      ws.hostname = host
      return { page: { ...page, webSocketDebuggerUrl: ws.href }, origin }
    } catch (error) { failures.push(`${host}: ${error.cause?.code || error.message}`) }
  }
  throw new Error('Codex CDP discovery failed (' + failures.join('; ') + ')')
}

export const bridgeBootstrap = `(() => {
  window.__radarBridgeDispose?.();
  window.__radarBridgeTransport = 'cdp-binding';
  const pending = new Map(); let sequence = 0;
  window.__radarBridgeDispose = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('增强连接已更新')); } pending.clear(); };
  window.__radarBridgeReply = (session, id, result, error) => {
    if (session !== window.__radarBridgeSession) return;
    const p = pending.get(id); if (!p) return;
    clearTimeout(p.timer); pending.delete(id);
    error ? p.reject(new Error(error)) : p.resolve(result);
  };
  window.__codexSessionDeleteBridge = (route, payload = {}) => new Promise((resolve, reject) => {
    if (typeof window.__radarNativeBinding !== 'function') { reject(new Error('请先连接官方 Codex 调试端口')); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('增强后端响应超时')); }, route === '/backend/status' ? 1500 : 30000);
    pending.set(id, { resolve, reject, timer });
    try { window.__radarNativeBinding(JSON.stringify({ session: window.__radarBridgeSession, id, route, payload })); }
    catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
  });
})();`

export async function connectRenderer(page, handle, { timeoutMs = 5000 } = {}) {
  if (!isOfficialPage(page)) throw new Error('调试目标不是受支持的官方 Codex 页面')
  const address = new URL(page.webSocketDebuggerUrl)
  if (address.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)) throw new Error('调试地址必须位于本机')
  const socket = new WebSocket(address.href), pending = new Map(), contexts = new Set(), nonce = randomBytes(24).toString('hex')
  let sequence = 0, closed = false, inflight = 0, contextInvalidated = false
  const failPending = () => { closed = true; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex 调试连接已断开')); } pending.clear() }
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) { reject(new Error('Codex 调试连接未就绪')); return }
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' 超时')); }, timeoutMs)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression, contextId, awaitPromise = true) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, ...(contextId ? { contextId } : {}) })
    if (r.exceptionDetails) throw new Error('Codex 页面执行失败：' + r.exceptionDetails.text)
    return r.result?.value
  }
  async function dispatch(event) {
    if (event.name !== '__radarNativeBinding' || !contexts.has(event.executionContextId) || event.payload.length > 262144) return
    let request; try { request = JSON.parse(event.payload) } catch { return }
    if (request.session !== nonce || !Number.isSafeInteger(request.id) || typeof request.route !== 'string' || !request.route.startsWith('/')) return
    const reply = (value, error) => evaluate(`window.__radarBridgeReply?.(${JSON.stringify(nonce)},${request.id},${JSON.stringify(value ?? null)},${JSON.stringify(error || null)})`, event.executionContextId)
    if (inflight >= 32) { await reply(null, '增强请求过多，请稍后重试'); return }
    inflight++
    try { const value = await handle(request.route, request.payload || {}); if (!closed && contexts.has(event.executionContextId)) await reply(value) }
    catch (error) { if (!closed && contexts.has(event.executionContextId)) await reply(null, error.message).catch(() => {}) }
    finally { inflight-- }
  }
  socket.addEventListener('message', event => {
    let message; try { message = JSON.parse(event.data) } catch { return }
    const p = pending.get(message.id)
    if (p) { clearTimeout(p.timer); pending.delete(message.id); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); return }
    if (message.method === 'Runtime.executionContextCreated') {
      const c = message.params.context
      if (c.auxData?.isDefault && c.origin === 'app://-') contexts.add(c.id)
    }
    if (message.method === 'Runtime.executionContextDestroyed') { if (contexts.has(message.params.executionContextId)) contextInvalidated = true; contexts.delete(message.params.executionContextId) }
    if (message.method === 'Runtime.executionContextsCleared') { contexts.clear(); contextInvalidated = true }
    if (message.method === 'Runtime.bindingCalled') dispatch(message.params).catch(() => {})
  })
  socket.addEventListener('close', failPending)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('CDP 连接超时')); }, timeoutMs)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); }, { once: true })
  })
  try {
    await call('Runtime.enable')
    await call('Runtime.addBinding', { name: '__radarNativeBinding' })
    await evaluate(`window.__radarBridgeSession=${JSON.stringify(nonce)};` + bridgeBootstrap)
    contextInvalidated = false
    return { evaluate, get alive() { return !closed && !contextInvalidated && socket.readyState === WebSocket.OPEN }, close() { socket.close(); failPending() } }
  } catch (error) { socket.close(); failPending(); throw error }
}
