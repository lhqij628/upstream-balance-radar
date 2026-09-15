import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { bridgeBootstrap, isOfficialPage } from './cdp-bridge.mjs'
import { createEnhancer } from './enhancer.mjs'

test('only official app page is eligible; Codex-X/title lookalikes are excluded', () => {
  const p = { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9234/devtools/page/1' }
  assert.equal(isOfficialPage({ ...p, title: 'ChatGPT', url: 'app://-/index.html' }), true)
  for (const url of ['http://tauri.localhost/', 'https://example.com/Codex', 'file:///Codex/index.html', 'app://other/index.html']) assert.equal(isOfficialPage({ ...p, title: 'Codex', url }), false)
})

test('page binding routes concurrent replies by request and connection; errors and disposal reject', async () => {
  const messages = []
  const window = { __radarBridgeSession: 'test', __radarNativeBinding: s => messages.push(JSON.parse(s)) }
  vm.runInNewContext(bridgeBootstrap, { window, setTimeout, clearTimeout })
  const a = window.__codexSessionDeleteBridge('/a'), b = window.__codexSessionDeleteBridge('/b')
  window.__radarBridgeReply('old-connection', messages[0].id, 'wrong', null)
  window.__radarBridgeReply('test', messages[1].id, 'B', null)
  window.__radarBridgeReply('test', messages[0].id, 'A', null)
  assert.deepEqual(await Promise.all([a, b]), ['A', 'B'])
  const c = window.__codexSessionDeleteBridge('/error')
  window.__radarBridgeReply('test', messages[2].id, null, 'fixture error')
  await assert.rejects(c, /fixture error/)
  const d = window.__codexSessionDeleteBridge('/pending')
  window.__radarBridgeDispose()
  await assert.rejects(d, /连接已更新/)
})

test('settings master switch, per-feature switch and mode persist using renderer field names', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'radar-settings-contract-'))
  const cfg = { accounts: [], codexTools: { enhanceEnabled: true, mode: 'compatible', features: { sessionDelete: true } } }
  let writes = 0
  const e = createEnhancer({ dataDir: root, sessionRoot: path.join(root, 'sessions'), apiBase: 'http://127.0.0.1:1', loadConfig: async () => cfg, updateConfig: async fn => fn(cfg), writeConfig: async () => { writes++ }, listModels: async () => [] })
  try {
    const initial = await e.bridge('/settings/get')
    assert.equal(initial.enhancementsEnabled, true); assert.equal(initial.launchMode, 'relay'); assert.equal(initial.providerSyncEnabled, false)
    const disabled = await e.bridge('/settings/set', { enhancementsEnabled: false, codexAppSessionDelete: false, launchMode: 'patch' })
    assert.equal(disabled.enhancementsEnabled, false); assert.equal(disabled.codexAppSessionDelete, false); assert.equal(disabled.launchMode, 'patch')
    assert.equal(cfg.codexTools.mode, 'full'); assert.equal(cfg.codexTools.enhanceEnabled, false); assert.equal(writes, 1)
    const enabled = await e.bridge('/settings/set', { enhancementsEnabled: true, codexAppSessionDelete: true })
    assert.equal(enabled.enhancementsEnabled, true); assert.equal(enabled.codexAppSessionDelete, true)
    assert.equal((await e.bridge('/diagnostics/log')).status, 'ok')
    assert.equal((await e.bridge('/backend/status')).status, 'ok')
    const zed = await e.bridge('/zed-remote/status')
    assert.equal(zed.status, 'ok'); assert.equal(typeof zed.zedCliFound, 'boolean')
  } finally { e.close(); await fs.rm(root, { recursive: true, force: true }) }
})

test('catalog includes current Codex TOML model, normalizes IDs and survives enhancer recreation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'radar-model-contract-'))
  await fs.writeFile(path.join(root, 'config.toml'), 'model="fixture-current"\nmodel_provider="custom"\n[model_providers.custom]\nname="Fixture provider"\n')
  const cfg = { accounts: [{ name: 'Fixture', textTestModel: 'fixture-fallback', apiKey: 'fixture' }], codexTools: { features: {} } }
  const options = { dataDir: path.join(root, 'data'), sessionRoot: path.join(root, 'sessions'), apiBase: 'http://127.0.0.1:1', loadConfig: async () => cfg, updateConfig: async fn => fn(cfg), writeConfig: async () => {}, listModels: async () => ['fixture-new', { id: 'fixture-object' }, 'fixture-new'] }
  const e = createEnhancer(options)
  try {
    await e.models()
    const restored = createEnhancer(options)
    const catalog = await restored.bridge('/codex-model-catalog')
    assert.equal(catalog.model, 'fixture-current'); assert.equal(catalog.default_model, 'fixture-current'); assert.equal(catalog.provider_name, 'Fixture provider')
    assert.deepEqual(catalog.models, ['fixture-current', 'fixture-fallback', 'fixture-new', 'fixture-object'])
    assert.equal(catalog.responses_api.status, 'unknown'); assert.equal(catalog.sources.length, 1)
    assert.deepEqual(await restored.bridge('/codex-config-model'), catalog)
    restored.close()
  } finally { e.close(); await fs.rm(root, { recursive: true, force: true }) }
})
