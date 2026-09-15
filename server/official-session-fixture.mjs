// Disposable rollout fixtures for the already isolated official desktop profile.
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const root = 'E:/radar-temp/official-codex-release/codex-home'
const out = path.resolve('server/test-artifacts/official-sessions-20260913')
await fs.mkdir(out, { recursive: true })
const manifestFile = path.join(out, 'fixtures.json')
if (await fs.stat(manifestFile).catch(() => null)) throw Error('Fixture manifest exists; inspect it before reusing')
const db = new DatabaseSync(path.join(root, 'state_5.sqlite'))
db.exec('PRAGMA busy_timeout=3000')
const created = []
try {
  for (const label of ['A', 'B']) {
    const id = randomUUID(), title = `余额雷达验收 ${label} — 仅测试`, cwd = `E:/radar-temp/official-codex-release/project-${label.toLowerCase()}`
    await fs.mkdir(cwd, { recursive: true })
    const time = Date.now() - (label === 'A' ? 240000 : 120000), stamp = n => new Date(time + n * 1000).toISOString()
    const file = path.join(root, 'sessions', '2026', '09', '13', `rollout-2026-09-13-${id}.jsonl`)
    const rows = [{ timestamp: stamp(0), type: 'session_meta', payload: { id, timestamp: stamp(0), cwd, originator: 'codex_cli_rs', cli_version: '0.114.0', source: 'cli', model_provider: 'openai' } }]
    for (let n = 1; n <= (label === 'A' ? 12 : 3); n++) {
      const turnId = randomUUID(), question = `${label}-${String(n).padStart(2, '0')}：余额雷达功能验收问题。这是离线测试记录，请勿执行。`
      const answer = `验收答复 ${label}-${String(n).padStart(2, '0')}\n\n` + Array.from({ length: 8 }, (_, k) => `第 ${k + 1} 段：用于检验 Timeline、滚动位置和 Markdown 的固定样本文本。`).join('\n\n')
      rows.push(
        { timestamp: stamp(n * 5), type: 'event_msg', payload: { type: 'task_started', turn_id: turnId, model_context_window: 272000, collaboration_mode_kind: 'default' } },
        { timestamp: stamp(n * 5), type: 'turn_context', payload: { turn_id: turnId, cwd, approval_policy: 'never', sandbox_policy: { type: 'read-only' }, model: 'gpt-5.4', effort: 'medium', summary: 'auto' } },
        { timestamp: stamp(n * 5), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: question }] } },
        { timestamp: stamp(n * 5), type: 'event_msg', payload: { type: 'user_message', message: question, images: [], local_images: [], text_elements: [] } },
        { timestamp: stamp(n * 5 + 1), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }], phase: 'final_answer' } },
        { timestamp: stamp(n * 5 + 1), type: 'event_msg', payload: { type: 'agent_message', message: answer, phase: 'final_answer' } },
        { timestamp: stamp(n * 5 + 2), type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: answer } },
      )
    }
    const text = rows.map(r => JSON.stringify(r)).join('\n') + '\n'
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text, { flag: 'wx' })
    await fs.utimes(file, new Date(time), new Date(time))
    const rec = { id, rollout_path: file, created_at: Math.floor(time / 1000), updated_at: Math.floor(time / 1000), source: 'cli', model_provider: 'openai', cwd, title, sandbox_policy: JSON.stringify({ type: 'read-only' }), approval_mode: 'never', has_user_event: 1, cli_version: '0.114.0', first_user_message: title, model: 'gpt-5.4', reasoning_effort: 'medium', created_at_ms: time, updated_at_ms: time, preview: title, recency_at: Math.floor(time / 1000), recency_at_ms: time, originator: 'codex_cli_rs' }
    const keys = Object.keys(rec)
    db.prepare(`INSERT INTO threads (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(rec))
    await fs.appendFile(path.join(root, 'session_index.jsonl'), JSON.stringify({ id, thread_name: title, updated_at: stamp(0) }) + '\n')
    created.push({ id, title, cwd, file, sha256: createHash('sha256').update(text).digest('hex') })
  }
  await fs.writeFile(manifestFile, JSON.stringify({ root, created }, null, 2), { flag: 'wx' })
  console.log(JSON.stringify({ manifestFile, created: created.map(({ id, title }) => ({ id, title })) }))
} finally { db.close() }
