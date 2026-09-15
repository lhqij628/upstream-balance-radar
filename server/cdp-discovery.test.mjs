import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverOfficialPage } from './cdp-bridge.mjs'

const page = { type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://localhost:9234/devtools/page/fixture' }
const response = body => ({ ok: true, json: async () => body })

test('CDP discovery uses IPv4 when available', async () => {
  const calls = []
  const result = await discoverOfficialPage(9234, { fetchImpl: async url => { calls.push(url); return response([page]) } })
  assert.equal(calls.length, 1)
  assert.equal(result.origin, 'http://127.0.0.1:9234')
  assert.equal(new URL(result.page.webSocketDebuggerUrl).hostname, '127.0.0.1')
})

test('CDP discovery falls back to IPv6 and normalizes WebSocket to responding interface', async () => {
  const calls = []
  const result = await discoverOfficialPage(9234, { fetchImpl: async url => {
    calls.push(url)
    if (calls.length === 1) throw new Error('ECONNREFUSED')
    return response([page])
  } })
  assert.deepEqual(calls, ['http://127.0.0.1:9234/json/list', 'http://[::1]:9234/json/list'])
  assert.equal(result.origin, 'http://[::1]:9234')
  assert.equal(new URL(result.page.webSocketDebuggerUrl).hostname, '[::1]')
})

test('CDP discovery rejects other apps, remote sockets, wrong ports and invalid responses', async () => {
  for (const body of [{}, [{ ...page, url: 'http://tauri.localhost/' }], [{ ...page, webSocketDebuggerUrl: 'ws://example.com:9234/devtools/page/fixture' }], [{ ...page, webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/fixture' }]]) {
    await assert.rejects(discoverOfficialPage(9234, { fetchImpl: async () => response(body) }), /discovery failed/)
  }
  await assert.rejects(discoverOfficialPage(0), /Invalid/)
})
