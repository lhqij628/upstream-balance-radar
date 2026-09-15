import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
const dir = 'server/test-artifacts/official-sessions-20260913'
const f = JSON.parse(await fs.readFile(path.join(dir, 'fixtures.json'), 'utf8'))
const [a, b] = f.created
const token = (await fs.readFile('E:/radar-temp/official-codex-release/radar-acceptance/access-token', 'utf8')).trim()
const checks = []
const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex')
const baseline = { a: a.sha256, b: b.sha256 }
const db = new DatabaseSync(path.join(f.root, 'state_5.sqlite'), { readOnly: true })
const record = id => db.prepare('SELECT * FROM threads WHERE id=?').get(id)
async function bridge(route, payload) {
  const r = await fetch('http://127.0.0.1:8796/api/enhancer/bridge', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ route, payload }) })
  const data = await r.json(); assert.equal(r.status, 200, data.error); return data
}
async function check(name, action) { try { await action(); checks.push({ name, status: 'PASS' }) } catch (e) { checks.push({ name, status: 'FAIL', error: e.message }); throw e } }
let undo
try {
  // Historical turn_context cwd must stay unchanged; only session ownership moves.
  await new Promise(resolve => setTimeout(resolve, 11000))
  await bridge('/move-thread-workspace', { session_id: a.id, target_cwd: a.cwd })
  await new Promise(resolve => setTimeout(resolve, 11000))
  assert.equal(await hash(a.file), baseline.a)
  await check('Markdown contains 12 ordered user/assistant turns', async () => {
    const r = await bridge('/export-markdown', { session_id: a.id })
    assert.equal(r.status, 'exported')
    for (let n = 1; n <= 12; n++) { const key = 'A-' + String(n).padStart(2, '0'); assert.ok(r.markdown.includes(key + '：')); assert.ok(r.markdown.includes('验收答复 ' + key)) }
    assert.ok(r.markdown.indexOf('A-01：') < r.markdown.indexOf('A-12：'))
    await fs.writeFile(path.join(dir, 'export-A.md'), r.markdown)
  })
  const originalRow = record(a.id)
  await check('Move changes rollout metadata and real official SQLite cwd only for fixture A', async () => {
    const r = await bridge('/move-thread-workspace', { session_id: a.id, target_cwd: b.cwd })
    assert.equal(r.status, 'moved')
    const rows = (await fs.readFile(a.file, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(rows.find(r => r.type === 'session_meta').payload.cwd.replaceAll('\\', '/'), b.cwd.replaceAll('\\', '/'))
    assert.ok(rows.filter(r => r.type === 'turn_context').every(r => r.payload.cwd === a.cwd))
    assert.equal(record(a.id).cwd.replaceAll('\\', '/'), b.cwd.replaceAll('\\', '/'))
    assert.equal(await hash(b.file), baseline.b)
  })
  await check('Move back preserves conversation content and original database timestamps', async () => {
    await new Promise(resolve => setTimeout(resolve, 11000))
    const r = await bridge('/move-thread-workspace', { session_id: a.id, target_cwd: a.cwd })
    assert.equal(r.status, 'moved'); assert.equal(await hash(a.file), baseline.a)
    assert.equal(record(a.id).updated_at, originalRow.updated_at)
    assert.equal(record(a.id).updated_at_ms, originalRow.updated_at_ms)
  })
  const rowBefore = record(a.id)
  await check('Delete removes actual rollout, index entry and SQLite row; B unchanged', async () => {
    const r = await bridge('/delete', { session_id: a.id }); undo = r.undo_token
    assert.equal(r.status, 'local_deleted'); assert.ok(undo)
    assert.equal(await fs.stat(a.file).catch(() => null), null); assert.equal(record(a.id), undefined)
    const lines = (await fs.readFile(path.join(f.root, 'session_index.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    assert.ok(!lines.some(r => r.id === a.id)); assert.ok(lines.some(r => r.id === b.id))
    assert.equal(await hash(b.file), baseline.b)
  })
  await check('Undo restores byte-identical rollout, index entry and complete official SQLite row', async () => {
    const r = await bridge('/undo', { undo_token: undo }); assert.equal(r.status, 'undone'); undo = null
    assert.equal(await hash(a.file), baseline.a); assert.deepEqual(record(a.id), rowBefore)
    const lines = (await fs.readFile(path.join(f.root, 'session_index.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    assert.equal(lines.filter(r => r.id === a.id).length, 1); assert.equal(lines.filter(r => r.id === b.id).length, 1)
    assert.equal(await hash(b.file), baseline.b)
  })
} finally {
  if (undo) { try { await bridge('/undo', { undo_token: undo }) } catch (e) { checks.push({ name: 'cleanup undo', status: 'FAIL', error: e.message }) } }
  db.close()
  await fs.writeFile(path.join(dir, 'roundtrip.json'), JSON.stringify({ at: new Date().toISOString(), mode: 'real Radar API and real isolated official SQLite/rollout; not UI clicks', checks }, null, 2))
  console.log(JSON.stringify(checks))
}
