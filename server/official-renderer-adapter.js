// Runtime adapter for the official Electron host. No installation-file patching.
(() => {
  if (window.__radarOfficialAdapter?.revision === 1) return;
  const host = window.electronBridge;
  const pending = new Map();
  const adapter = {
    revision: 1,
    version: host?.getDesktopUserAgent?.().match(/Codex Desktop\/([\d.]+)/)?.[1] || '',
    capabilities: { nativeHost: typeof host?.sendMessageFromView === 'function', dispatcher: false, hostSettings: false },
  };
  const onMessage = event => {
    if (event.source && event.source !== window) return;
    const data = event.data;
    if (data?.type !== 'fetch-response') return;
    const p = pending.get(data.requestId);
    if (!p) return;
    pending.delete(data.requestId); clearTimeout(p.timer);
    if (data.responseType !== 'success' || data.status < 200 || data.status >= 300) { p.reject(new Error(data.error || `官方接口返回 ${data.status}`)); return; }
    try { p.resolve('body' in data ? data.body : JSON.parse(data.bodyJsonString)); } catch (e) { p.reject(e); }
  };
  window.addEventListener('message', onMessage);
  adapter.hostCall = (method, options = {}) => new Promise((resolve, reject) => {
    if (!adapter.capabilities.nativeHost) { reject(new Error('当前页面未暴露官方桌面通信接口')); return; }
    const requestId = 'radar-' + crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('官方桌面接口响应超时')); }, 5000);
    pending.set(requestId, { resolve, reject, timer });
    Promise.resolve(host.sendMessageFromView({ type: 'fetch', requestId, method: 'POST', url: 'vscode://codex/' + method, body: JSON.stringify(options.params || {}) })).catch(e => { clearTimeout(timer); pending.delete(requestId); reject(e); });
  });
  adapter.settings = {
    n: async setting => { const r = await adapter.hostCall('get-setting', { params: { key: setting.key } }); return r?.value ?? setting.default; },
    s: async (setting, value) => { const r = await adapter.hostCall('set-setting', { params: { key: setting.key, value } }); if (r?.success === false) throw new Error('官方设置保存失败'); return r; },
  };
  // Recent builds bundle their state and RPC code. Discover the actual message bus
  // through the loaded entry's dependency manifest, rather than pinning a hash.
  adapter.ready = (async () => {
    if (!adapter.capabilities.nativeHost) return adapter.capabilities;
    try {
      const urls = [...document.scripts].map(s => s.src).concat([...document.querySelectorAll('link[href]')].map(l => l.href), performance.getEntriesByType('resource').map(e => e.name));
      let busUrl = urls.find(u => /\/message-bus-[^/]+\.js$/.test(u));
      if (!busUrl) {
        const entry = urls.find(u => /\/assets\/index-[^/]+\.js$/.test(u));
        if (entry) {
          const response = await fetch(entry);
          if (!response.ok) throw new Error('官方入口资源读取失败');
          const source = await response.text(), dependency = source.match(/["'`]((?:\.\/)?message-bus-[\w.-]+\.js)["'`]/)?.[1];
          if (dependency) busUrl = new URL(dependency, entry).href;
        }
      }
      if (!busUrl) throw new Error('当前构建的消息调度模块尚未识别');
      const module = await import(busUrl);
      const Dispatcher = Object.values(module).find(v => typeof v === 'function' && typeof v.getInstance === 'function' && typeof v.prototype?.dispatchMessage === 'function' && typeof v.prototype?.subscribe === 'function');
      if (!Dispatcher) throw new Error('官方消息调度器导出格式已变化');
      adapter.dispatcher = Dispatcher.getInstance();
      adapter.settings.v = Dispatcher;
      adapter.capabilities.dispatcher = true;
      adapter.capabilities.moduleUrl = busUrl;
      const result = await adapter.hostCall('get-setting', { params: { key: 'default-service-tier' } });
      adapter.capabilities.hostSettings = !!result && typeof result === 'object';
    } catch (e) { adapter.capabilities.error = e.message; }
    return adapter.capabilities;
  })();
  adapter.installRequestHooks = async hooks => {
    await adapter.ready;
    const bus = adapter.dispatcher;
    if (!bus) throw new Error(adapter.capabilities.error || '官方消息调度器未就绪');
    // One wrapper per dispatcher, with current callbacks replaced on reinjection.
    bus.__radarHooks = hooks;
    if (bus.__radarOriginalDispatch) return true;
    const tracked = new Map();
    const original = bus.dispatchMessage.bind(bus), deliver = bus.deliverMessage.bind(bus);
    bus.__radarOriginalDispatch = original;
    bus.dispatchMessage = (type, payload) => {
      if (type === 'mcp-request' && payload?.request) {
        const request = payload.request, method = request.method;
        if (['plugin/list', 'plugin/install', 'plugin/read', 'model/list'].includes(method)) {
          tracked.set(String(request.id), { method, at: Date.now() });
          for (const [id, item] of tracked) if (Date.now() - item.at > 60000 || tracked.size > 512) tracked.delete(id);
          const params = bus.__radarHooks?.request?.(method, request.params) ?? request.params;
          payload = { ...payload, request: { ...request, params } };
        }
      }
      return original(type, payload);
    };
    bus.deliverMessage = (type, payload) => {
      if (type === 'mcp-response') {
        const message = payload?.message || payload?.response, ref = message && tracked.get(String(message.id));
        if (ref) {
          tracked.delete(String(message.id));
          if (message.result !== undefined) {
            const result = bus.__radarHooks?.response?.(ref.method, message.result) ?? message.result;
            payload = { ...payload, [payload.message ? 'message' : 'response']: { ...message, result } };
          }
        }
      }
      return deliver(type, payload);
    };
    return true;
  };
  window.__radarOfficialAdapter = adapter;
})();
