import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { DatabaseSync } from 'node:sqlite'
import { deleteSession, restoreDeletedSession, scanSessions } from './sessions.mjs'
import { createEnhancer } from './enhancer.mjs'
import { createUserScripts } from './enhancer-scripts.mjs'
import { zedUrl, createNativeActions } from './enhancer-native.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'radar-repair-test-'))
  const sessions = path.join(root, 'sessions'), backups = path.join(root, 'backups'), file = path.join(sessions, 'a.jsonl')
  await fs.mkdir(sessions)
  await fs.writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: 'a', cwd: root, title: 'Original', model_provider: 'openai' } }) + '\n')
  await fs.utimes(file, new Date(0), new Date(0))
  const index = path.join(root, 'session_index.jsonl'), initial = '{"id":"a","thread_name":"Renamed"}\n{"id":"b","thread_name":"Unrelated"}\n'
  await fs.writeFile(index, initial)
  const db = new DatabaseSync(path.join(root, 'state_5.sqlite'))
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT); CREATE TABLE thread_items(thread_id TEXT,n INTEGER,b BLOB)')
  db.prepare('INSERT INTO threads VALUES(?,?)').run('a', 'Database title')
  db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run('parent', 'a')
  db.prepare('INSERT INTO thread_items VALUES(?,?,?)').run('a', 2n ** 60n, Buffer.from([0, 127, 255]))
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }) })
  const cfg = { accounts: [], codexTools: { enhanceEnabled: true, features: {} } }
  const enhancer = createEnhancer({ dataDir: root, sessionRoot: sessions, loadConfig: async () => cfg, updateConfig: async fn => fn(cfg), writeConfig: async () => {}, listModels: async () => [], apiBase: 'http://127.0.0.1:1' })
  t.after(() => enhancer.close())
  return { root, sessions, backups, file, index, initial, db, enhancer }
}

test('delete and undo preserve int64/blob, both relation directions and unrelated index updates', async t => {
  const f = await fixture(t)
  const deleted = await deleteSession(f.sessions, f.backups, 'a.jsonl')
  assert.equal(f.db.prepare('SELECT count(*) n FROM thread_spawn_edges').get().n, 0)
  assert.equal(await fs.readFile(f.index, 'utf8'), '{"id":"b","thread_name":"Unrelated"}\n')
  await fs.appendFile(f.index, '{"id":"c","thread_name":"Created after delete"}\n')
  await restoreDeletedSession(f.sessions, f.backups, deleted.backupDir)
  const stmt = f.db.prepare('SELECT n,b FROM thread_items'); stmt.setReadBigInts(true)
  const row = stmt.get(); assert.equal(row.n, 2n ** 60n); assert.deepEqual([...row.b], [0, 127, 255])
  assert.equal(f.db.prepare('SELECT child_thread_id FROM thread_spawn_edges').get().child_thread_id, 'a')
  const rows = (await fs.readFile(f.index, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(rows.map(r => r.id).sort(), ['a', 'b', 'c'])
  assert.equal(rows.find(r => r.id === 'a').thread_name, 'Renamed')
})

test('database delete failure rolls back children without touching rollout or index', async t => {
  const f = await fixture(t), before = await fs.readFile(f.file, 'utf8')
  f.db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON threads BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
  await assert.rejects(() => deleteSession(f.sessions, f.backups, 'a.jsonl'), /fixture failure/)
  assert.equal(await fs.readFile(f.file, 'utf8'), before)
  assert.equal(await fs.readFile(f.index, 'utf8'), f.initial)
  assert.equal(f.db.prepare('SELECT count(*) n FROM thread_items').get().n, 1)
  assert.equal(f.db.prepare('SELECT count(*) n FROM thread_spawn_edges').get().n, 1)
})

test('failed undo rolls back database and leaves deleted rollout and index unchanged', async t => {
  const f = await fixture(t), deletion = await deleteSession(f.sessions, f.backups, 'a.jsonl')
  const index = await fs.readFile(f.index, 'utf8')
  f.db.exec("CREATE TRIGGER reject_restore BEFORE INSERT ON thread_items BEGIN SELECT RAISE(ABORT,'fixture restore'); END")
  await assert.rejects(() => restoreDeletedSession(f.sessions, f.backups, deletion.backupDir), /fixture restore/)
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' })
  assert.equal(f.db.prepare('SELECT count(*) n FROM threads').get().n, 0)
  assert.equal(await fs.readFile(f.index, 'utf8'), index)
})

test('concurrent deletes serialize and renamed titles come from the index', async t => {
  const f = await fixture(t)
  assert.equal((await scanSessions(f.sessions)).sessions[0].title, 'Renamed')
  const results = await Promise.allSettled([deleteSession(f.sessions, f.backups, 'a.jsonl'), deleteSession(f.sessions, f.backups, 'a.jsonl')])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const success = results.find(r => r.status === 'fulfilled').value
  await restoreDeletedSession(f.sessions, f.backups, success.backupDir)
  assert.equal((await scanSessions(f.sessions)).sessions.length, 1)
})

test('archived title lookup rejects ambiguity and invalid moves preserve the original file', async t => {
  const f = await fixture(t), dir = path.join(f.root, 'archived_sessions')
  await fs.mkdir(dir)
  for (const id of ['archived-a', 'archived-b']) await fs.writeFile(path.join(dir, id + '.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id, title: 'Same' } }))
  const r = await f.enhancer.bridge('/archived-thread', { title: 'Same' })
  assert.equal(r.status, 'failed'); assert.match(r.message, /同名/)
  const before = await fs.readFile(f.file, 'utf8')
  for (const target_cwd of ['', '../other', path.join(f.root, 'missing')]) assert.equal((await f.enhancer.bridge('/move-thread-workspace', { session_id: 'a', target_cwd })).status, 'failed')
  assert.equal(await fs.readFile(f.file, 'utf8'), before)
})

test('user scripts install, execute, clean up, toggle and report execution failures', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'radar-script-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const window = {}, context = vm.createContext({ window, AbortController })
  let enabled = true
  const connection = { alive: true, evaluate: expression => vm.runInContext(expression, context, { timeout: 1000 }) }
  const scripts = createUserScripts({ root, getConnection: () => connection, isEnabled: async () => enabled })
  let r = await scripts.handle('/user-scripts/install', { name: 'a.js', code: 'window.active=true;window.count=(window.count||0)+1;radar.onCleanup(()=>{window.active=false})' })
  assert.equal(r.scripts[0].status, 'loaded'); assert.equal(window.active, true)
  await scripts.handle('/user-scripts/install', { name: 'b.js', code: 'window.b=true;return ()=>{window.b=false}' })
  assert.equal(window.count, 1, 'installing another script must not rerun unchanged scripts')
  await scripts.handle('/user-scripts/set-script-enabled', { key: 'a.js', enabled: false })
  assert.equal(window.active, false); assert.equal(window.b, true)
  await scripts.handle('/user-scripts/set-script-enabled', { key: 'a.js', enabled: true })
  assert.equal(window.active, true)
  enabled = false; await scripts.refresh(); assert.equal(window.active, false); assert.equal(window.b, false)
  enabled = true; await scripts.refresh(); assert.equal(window.active, true)
  r = await scripts.handle('/user-scripts/install', { name: 'bad.js', code: 'throw new Error("fixture-script-error")' })
  assert.equal(r.status, 'failed'); assert.match(r.scripts.find(s => s.key === 'bad.js').error, /fixture-script-error/)
  await scripts.handle('/user-scripts/delete', { key: 'a.js' }); assert.equal(window.active, false)
  await assert.rejects(() => scripts.handle('/user-scripts/install', { name: '../evil.js', code: '1' }), /文件名/)
  await assert.rejects(() => scripts.handle('/user-scripts/install', { name: 'b.js', code: '1' }), /同名/)
  await assert.rejects(() => scripts.handle('/user-scripts/set-script-enabled', { key: 'missing', enabled: true }), /不存在/)
})

test('modern dispatcher adapter transforms correlated requests/replies and leaves unrelated traffic alone', async () => {
  const source = await fs.readFile(new URL('./official-renderer-adapter.js', import.meta.url), 'utf8')
  const window = { addEventListener() {} }, sent = [], delivered = []
  vm.runInNewContext(source, { window, Map, Promise })
  const a = window.__radarOfficialAdapter
  a.dispatcher = { dispatchMessage: (type, payload) => sent.push({ type, payload }), deliverMessage: (type, payload) => delivered.push({ type, payload }) }
  await a.installRequestHooks({ request: (method, p) => ({ ...p, expanded: method }), response: (_m, r) => ({ ...r, patched: true }) })
  a.dispatcher.dispatchMessage('mcp-request', { hostId: 'local', request: { id: 'a', method: 'plugin/list', params: { cwds: [] } } })
  a.dispatcher.dispatchMessage('mcp-request', { request: { id: 'b', method: 'thread/read', params: { threadId: 'x' } } })
  assert.equal(sent[0].payload.request.params.expanded, 'plugin/list'); assert.equal(sent[1].payload.request.params.expanded, undefined)
  a.dispatcher.deliverMessage('mcp-response', { message: { id: 'a', result: { marketplaces: [] } } })
  assert.equal(delivered[0].payload.message.result.patched, true)
  a.dispatcher.deliverMessage('mcp-response', { message: { id: 'other', result: {} } })
  assert.equal(delivered[1].payload.message.result.patched, undefined)
  await a.installRequestHooks({ request: (_m, p) => p, response: (_m, r) => r })
  a.dispatcher.dispatchMessage('mcp-request', { request: { id: 'c', method: 'plugin/list', params: {} } })
  assert.equal(sent.length, 3); assert.equal(sent[2].payload.request.params.expanded, undefined)
})

test('Zed URL preserves SSH authority and encodes paths; rejects option/control injection', () => {
  assert.equal(zedUrl({ ssh: { user: 'test user', host: 'fixture', port: 2222 }, path: '/project/a b.js', line: 3, column: 2 }), 'ssh://test%20user@fixture:2222/project/a%20b.js:3:2')
  for (const host of ['-oProxyCommand=evil', 'fixture --flag', 'a\n']) assert.throws(() => zedUrl({ ssh: { host }, path: '/file' }))
  for (const port of [0, 65536, 'oops']) assert.throws(() => zedUrl({ ssh: { host: 'fixture', port }, path: '/file' }))
  assert.throws(() => zedUrl({ ssh: { host: 'fixture' }, path: 'relative' }))
})

test('Zed host and fallback resolve the official managed connection format without writes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'radar-zed-test-')); t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, '.codex-global-state.json'), value = JSON.stringify({ 'codex-managed-remote-connections': [{ hostId: 'remote-ssh-fixture', sshHost: 'user@fixture:2222' }] })
  await fs.writeFile(file, value)
  const native = createNativeActions({ codexHome: root })
  const r = await native.zedFallback({ hostId: 'remote-ssh-fixture', remoteWorkspaceRoot: '/repo' })
  assert.deepEqual(r.request.ssh, { user: 'user', host: 'fixture', port: 2222 }); assert.equal(r.request.path, '/repo')
  assert.equal(await fs.readFile(file, 'utf8'), value)
  await assert.rejects(() => native.resolveHost('remote-ssh-missing'), /未找到/)
})
