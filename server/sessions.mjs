import fs from 'node:fs/promises'
import fssync from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { randomUUID } from 'node:crypto'
import { withSessionDatabases, updateThread, removeThread, restoreThread, readThreadMetadata } from './session-db.mjs'

const MAX_SCAN_FILES = Number(process.env.SESSION_MAX_SCAN_FILES || Infinity)
const mutations = new Map()
function serialMutation(root, action) {
  const key = path.resolve(root), previous = mutations.get(key) || Promise.resolve()
  const result = previous.catch(() => {}).then(action)
  mutations.set(key, result)
  return result.finally(() => { if (mutations.get(key) === result) mutations.delete(key) })
}
const optionalText = async file => { try { return await fs.readFile(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
const indexId = line => { try { const r = JSON.parse(line); return r.id || r.session_id } catch { return null } }
const indexLines = text => text?.match(/[^\n]*\n|[^\n]+$/g) || []
async function replaceText(file, before, after) {
  const temp = file + '.' + randomUUID() + '.radar-tmp'
  try {
    await fs.writeFile(temp, after, { flag: 'wx' })
    if (await optionalText(file) !== before) throw new Error('文件已由其它进程更新，请重新操作')
    await fs.rename(temp, file)
  } finally { await fs.rm(temp, { force: true }).catch(() => {}) }
}
async function rollbackText(file, written, original) {
  if (await optionalText(file) !== written) return
  if (original === null) await fs.unlink(file)
  else await replaceText(file, written, original)
}

export async function scanSessions(rootDir) {
  const started = Date.now()
  const files = await listJsonl(rootDir)
  const summaries = []
  for (const file of files.slice(0, MAX_SCAN_FILES)) summaries.push(await summarizeFile(rootDir, file))
  const metadata = await readThreadMetadata(path.dirname(rootDir))
  for (const line of indexLines(await optionalText(path.join(path.dirname(rootDir), 'session_index.jsonl')))) {
    try { const row = JSON.parse(line); if (row.id && row.thread_name) metadata.set(row.id, { title: row.thread_name }) } catch {}
  }
  for (const item of summaries) if (metadata.get(item.id)?.title) item.title = metadata.get(item.id).title
  summaries.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  const invalidFiles = summaries.filter((item) => item.invalidLines > 0).length
  return {
    rootDir,
    exists: fssync.existsSync(rootDir),
    totalFiles: files.length,
    scannedFiles: summaries.length,
    invalidFiles,
    totalLines: summaries.reduce((sum, item) => sum + item.lines, 0),
    totalMessages: summaries.reduce((sum, item) => sum + item.messages, 0),
    elapsedMs: Date.now() - started,
    truncated: summaries.length < files.length, sessions: summaries,
  }
}

export async function backupSessions(rootDir, backupDir) {
  const scan = await scanSessions(rootDir)
  const stamp = timestamp()
  const targetRoot = path.join(backupDir, 'sync-' + stamp)
  let copied = 0
  await fs.mkdir(targetRoot, { recursive: true })
  for (const item of scan.sessions) {
    const source = path.join(rootDir, item.relativePath)
    const target = path.join(targetRoot, 'files', item.relativePath.replaceAll('..', '_parent_'))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(source, target)
    copied++
  }
  const manifest = { createdAt: new Date().toISOString(), source: rootDir, copied, scan: { ...scan, sessions: scan.sessions.slice(0, 50) } }
  await fs.writeFile(path.join(targetRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return { ok: true, copied, backupDir: targetRoot, invalidFiles: scan.invalidFiles, message: '已同步备份 ' + copied + ' 个会话文件' }
}

export async function repairSessions(rootDir, backupDir) {
  return serialMutation(rootDir, () => repairSessionsUnlocked(rootDir, backupDir))
}
async function repairSessionsUnlocked(rootDir, backupDir) {
  const scan = await scanSessions(rootDir)
  const bad = scan.sessions.filter((item) => item.invalidLines > 0)
  if (!bad.length) return { ok: true, repaired: 0, backupDir: '', message: '未发现需要修复的会话文件' }
  const stamp = timestamp()
  const targetRoot = path.join(backupDir, 'repair-' + stamp)
  await fs.mkdir(targetRoot, { recursive: true })
  let repaired = 0
  let removedLines = 0
  const skipped = []
  for (const item of bad) {
    const source = path.join(rootDir, item.relativePath)
    const initialStat = await fs.stat(source)
    if (Date.now() - initialStat.mtimeMs < 10000) { skipped.push(item.id || item.relativePath); continue }
    const target = path.join(targetRoot, 'files', item.relativePath.replaceAll('..', '_parent_'))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(source, target)
    const text = await fs.readFile(source, 'utf8')
    const kept = []
    let removed = 0
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        JSON.parse(trimmed)
        kept.push(trimmed)
      } catch {
        removed++
      }
    }
    if ((await fs.stat(source)).mtimeMs !== initialStat.mtimeMs) { skipped.push(item.id || item.relativePath); continue }
    await replaceText(source, text, kept.join('\n') + (kept.length ? '\n' : ''))
    repaired++
    removedLines += removed
  }
  await fs.writeFile(path.join(targetRoot, 'repair-manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), source: rootDir, repaired, removedLines, skipped, files: bad }, null, 2), 'utf8')
  return { ok: skipped.length === 0, repaired, removedLines, skipped, backupDir: targetRoot, message: `已修复 ${repaired} 个文件，移除 ${removedLines} 行异常 JSONL，跳过 ${skipped.length} 个正在使用的会话` }
}

export async function exportSessions(rootDir, exportDir) {
  const scan = await scanSessions(rootDir)
  const stamp = timestamp()
  const targetRoot = path.join(exportDir, 'markdown-' + stamp)
  await fs.mkdir(targetRoot, { recursive: true })
  let exported = 0
  for (const item of scan.sessions) {
    const source = path.join(rootDir, item.relativePath)
    const md = await jsonlToMarkdown(source, item)
    if (!md.trim()) continue
    const safeName = item.relativePath.replace(/[\\/:*?"<>|]+/g, '_').replace(/\.jsonl$/i, '.md')
    await fs.writeFile(path.join(targetRoot, safeName), md, 'utf8')
    exported++
  }
  return { ok: true, exported, exportDir: targetRoot, message: '已导出 ' + exported + ' 个 Markdown 会话' }
}

export async function deleteSession(rootDir, backupDir, relativePath) {
  return serialMutation(rootDir, () => deleteSessionUnlocked(rootDir, backupDir, relativePath))
}
async function deleteSessionUnlocked(rootDir, backupDir, relativePath) {
  const target = resolveSessionFile(rootDir, relativePath)
  const stat = await fs.stat(target.fullPath).catch(() => null)
  if (!stat || !stat.isFile()) throw new Error('会话文件不存在或不可删除')
  const stamp = timestamp()
  const targetRoot = path.join(backupDir, 'deleted-' + stamp + '-' + randomUUID().slice(0, 8))
  const backupFile = path.join(targetRoot, 'session.jsonl')
  await fs.mkdir(path.dirname(backupFile), { recursive: true })
  await fs.copyFile(target.fullPath, backupFile)
  const summary = await summarizeFile(rootDir, target.fullPath)
  const original = await fs.readFile(backupFile, 'utf8')
  const indexFile = path.join(path.dirname(rootDir), 'session_index.jsonl')
  const indexBefore = await optionalText(indexFile), lines = indexLines(indexBefore)
  const indexEntries = lines.filter(line => summary.id && indexId(line) === summary.id)
  const indexAfter = lines.filter(line => !summary.id || indexId(line) !== summary.id).join('')
  let fileDeleted = false, indexChanged = false
  let dbRecords = []
  await withSessionDatabases(path.dirname(rootDir), targetRoot, async opened => {
    dbRecords = opened.map(({ db, file }) => ({ file, records: summary.id ? removeThread(db, summary.id) : [] }))
    const manifest = { createdAt: new Date().toISOString(), source: rootDir, relativePath: target.relativePath, dbRecords, backupFile, originalFile: target.fullPath, bytes: stat.size, indexEntries }
    // Persist the undo journal before removing any filesystem data.
    await fs.writeFile(path.join(targetRoot, 'delete-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    if (await fs.readFile(target.fullPath, 'utf8') !== original) throw new Error('会话正在更新，请稍后重新删除')
    if (indexEntries.length) { await replaceText(indexFile, indexBefore, indexAfter); indexChanged = true }
    await fs.unlink(target.fullPath)
    fileDeleted = true
  }).catch(async err => {
    if (fileDeleted) await fs.copyFile(backupFile, target.fullPath, fssync.constants.COPYFILE_EXCL)
    if (indexChanged) await rollbackText(indexFile, indexAfter, indexBefore)
    throw err
  })
  return { ok: true, deleted: 1, relativePath: target.relativePath, backupDir: targetRoot, backupFile, message: '已删除 1 个会话文件，并先写入可恢复备份' }
}

export async function restoreDeletedSession(rootDir, backupDir, backupRoot = '') {
  return serialMutation(rootDir, () => restoreDeletedSessionUnlocked(rootDir, backupDir, backupRoot))
}
async function restoreDeletedSessionUnlocked(rootDir, backupDir, backupRoot = '') {
  const restoreRoot = backupRoot ? resolveBackupRoot(backupDir, backupRoot) : await latestDeletedBackupRoot(backupDir)
  if (!restoreRoot) return { ok: false, restored: 0, message: '未找到可恢复的删除备份' }
  const manifest = await readJson(path.join(restoreRoot, 'delete-manifest.json'))
  if (!manifest?.relativePath) throw new Error('删除备份缺少恢复清单')
  const target = resolveSessionFile(rootDir, manifest.relativePath)
  const backupFile = path.resolve(restoreRoot, manifest.backupFile ? path.basename(manifest.backupFile) : manifest.relativePath)
  if (!isInside(restoreRoot, backupFile)) throw new Error('备份路径越界')
  if (!fssync.existsSync(backupFile)) throw new Error('备份文件不存在')
  if (fssync.existsSync(target.fullPath)) throw new Error('原位置已有同名会话文件，未覆盖')
  await fs.mkdir(path.dirname(target.fullPath), { recursive: true })
  const indexFile = path.join(path.dirname(rootDir), 'session_index.jsonl'), indexBefore = await optionalText(indexFile)
  const existingIds = new Set(indexLines(indexBefore).map(indexId).filter(Boolean))
  const entries = (manifest.indexEntries || []).filter(line => !existingIds.has(indexId(line)))
  const indexAfter = (indexBefore || '') + (entries.length && indexBefore && !indexBefore.endsWith('\n') ? '\n' : '') + entries.join('')
  let fileRestored = false, indexChanged = false
  await withSessionDatabases(path.dirname(rootDir), path.join(restoreRoot, 'restore'), async opened => {
    for (const { db, file } of opened) { const record = (manifest.dbRecords || []).find(r => r.file === file); if (record) restoreThread(db, record.records) }
    await fs.copyFile(backupFile, target.fullPath, fssync.constants.COPYFILE_EXCL)
    fileRestored = true
    if (entries.length) { await replaceText(indexFile, indexBefore, indexAfter); indexChanged = true }
  }).catch(async err => {
    if (fileRestored) await fs.unlink(target.fullPath)
    if (indexChanged) await rollbackText(indexFile, indexAfter, indexBefore)
    throw err
  })
  await fs.writeFile(path.join(restoreRoot, 'restored.json'), JSON.stringify({ at: new Date().toISOString() }))
  return { ok: true, restored: 1, relativePath: target.relativePath, backupDir: restoreRoot, message: '已从删除备份恢复 1 个会话文件' }
}

async function listJsonl(rootDir) {
  const out = []
  async function walk(dir) {
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) out.push(full)
    }
  }
  await walk(rootDir)
  if (path.basename(rootDir) === 'sessions') await walk(path.join(rootDir, '..', 'archived_sessions'))
  return out
}

async function summarizeFile(rootDir, file) {
  const relativePath = path.relative(rootDir, file)
  const stat = await fs.stat(file)
  const text = await fs.readFile(file, 'utf8').catch(() => '')
  let lines = 0, invalidLines = 0, messages = 0, userMessages = 0, assistantMessages = 0
  let firstAt = '', lastAt = '', title = '', preview = '', model = '', cwd = '', provider = '', id = ''
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    lines++
    let obj
    try { obj = JSON.parse(trimmed) } catch { invalidLines++; continue }
    if (obj.type === 'session_meta') { cwd = obj.payload?.cwd || cwd; provider = obj.payload?.model_provider || provider; id = obj.payload?.id || id }
    const ts = findTimestamp(obj)
    if (ts && !firstAt) firstAt = ts
    if (ts) lastAt = ts
    const role = findRole(obj)
    if (role) {
      messages++
      if (role === 'user') userMessages++
      if (role === 'assistant') assistantMessages++
    }
    const textValue = role ? findText(obj) : ''
    if (!preview && role && textValue && !isNoiseText(textValue)) preview = textValue
    if (!title) title = findTitle(obj) || ''
    if (!model) model = findModel(obj) || ''
  }
  return { cwd, provider, id, relativePath, fileName: path.basename(file), size: stat.size, updatedAt: stat.mtime.toISOString(), firstAt, lastAt, title: title || preview.slice(0, 46) || path.basename(file, '.jsonl'), preview: preview.slice(0, 120), model, lines, invalidLines, messages, userMessages, assistantMessages }
}

async function jsonlToMarkdown(file, summary) {
  const text = await fs.readFile(file, 'utf8')
  const rows = ['# ' + summary.title, '', '- 文件：' + summary.relativePath, '- 更新时间：' + summary.updatedAt, '']
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj
    try { obj = JSON.parse(trimmed) } catch { continue }
    const role = findRole(obj)
    const content = findText(obj)
    if (!role || !content) continue
    rows.push('## ' + (role === 'user' ? 'User' : role === 'assistant' ? 'Assistant' : role), '', ...(findTimestamp(obj) ? ['时间：' + findTimestamp(obj), ''] : []), content, '')
  }
  return rows.join('\n')
}

function findTimestamp(obj) {
  const value = pick(obj, ['timestamp', 'created_at', 'createdAt', 'time', 'item.created_at', 'item.timestamp'])
  if (!value) return ''
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? String(value).slice(0, 40) : d.toISOString()
}
function findTitle(obj) { return String(pick(obj, ['title', 'conversation.title', 'session.title', 'metadata.title', 'payload.title']) || '').trim() }
function findModel(obj) { return String(pick(obj, ['model', 'model_slug', 'item.model', 'metadata.model', 'payload.model']) || '').trim() }
function findRole(obj) {
  const value = String(pick(obj, ['role', 'message.role', 'item.role', 'item.message.role', 'data.role', 'payload.role']) || '').toLowerCase()
  return ['user', 'assistant', 'system', 'tool'].includes(value) ? value : ''
}
function findText(obj) {
  const direct = pick(obj, ['content', 'message.content', 'item.content', 'item.message.content', 'data.content', 'payload.content', 'text'])
  const text = textFrom(direct)
  if (text) return text
  return deepText(obj, 0) || ''
}
function textFrom(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join('\n')
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.value === 'string') return value.value
    if (Array.isArray(value.parts)) return textFrom(value.parts)
  }
  return ''
}
function deepText(value, depth) {
  if (depth > 6 || value == null) return ''
  if (typeof value === 'string' && value.length > 12) return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepText(item, depth + 1)
      if (found) return found
    }
  } else if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/token|secret|password|authorization|api_?key|cookie/i.test(key)) continue
      const found = deepText(item, depth + 1)
      if (found) return found
    }
  }
  return ''
}
function pick(value, paths) {
  for (const dotted of paths) {
    let current = value
    for (const part of dotted.split('.')) current = current?.[part]
    if (current !== undefined && current !== null) return current
  }
  return undefined
}
function compact(value) { return String(value || '').replace(/\s+/g, ' ').trim() }
function isNoiseText(value) { return /^(<environment_context>|<skills_instructions>|# instructions|you are codex|distinguish instructions)/i.test(String(value || '').trim()) }
function timestamp() { return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '') }

function resolveSessionFile(rootDir, relativePath) {
  const root = path.resolve(rootDir)
  const raw = String(relativePath || '').trim()
  if (!raw) throw new Error('缺少会话文件路径')
  const fullPath = path.resolve(root, raw)
  const archived = path.resolve(root, '..', 'archived_sessions')
  if (!isInside(root, fullPath) && !(path.basename(root) === 'sessions' && isInside(archived, fullPath))) throw new Error('会话文件路径越界')
  if (path.extname(fullPath).toLowerCase() !== '.jsonl') throw new Error('仅允许操作 .jsonl 会话文件')
  return { root, fullPath, relativePath: path.relative(root, fullPath) }
}

function resolveBackupRoot(backupDir, requestedRoot) {
  const root = path.resolve(backupDir)
  const fullPath = path.resolve(String(requestedRoot || ''))
  if (!isInside(root, fullPath)) throw new Error('备份目录路径越界')
  return fullPath
}

function isInside(root, fullPath) {
  const relative = path.relative(path.resolve(root), path.resolve(fullPath))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function latestDeletedBackupRoot(backupDir) {
  const entries = await fs.readdir(backupDir, { withFileTypes: true }).catch(() => [])
  const dirs = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('deleted-')).map((entry) => path.join(backupDir, entry.name)).sort().reverse()
  for (const dir of dirs) if (!fssync.existsSync(path.join(dir, 'restored.json'))) return dir
  return ''
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return null }
}

export async function syncSessions(rootDir, backupDir, options = {}) {
  return serialMutation(rootDir, () => syncSessionsUnlocked(rootDir, backupDir, options))
}
async function syncSessionsUnlocked(rootDir, backupDir, options = {}) {
  let targetProvider = options.provider
  if (!targetProvider) {
    const config = parseToml(await fs.readFile(path.join(path.dirname(rootDir), 'config.toml'), 'utf8'))
    targetProvider = config.model_provider || 'openai'
  }
  if (!/^[\w.-]+$/.test(targetProvider)) throw new Error('供应商标识无效')
  const scan = await scanSessions(rootDir)
  if (scan.truncated) throw new Error('会话扫描达到配置上限，请提高 SESSION_MAX_SCAN_FILES 后重试')
  const targetRoot = path.join(backupDir, 'provider-sync-' + timestamp())
  let changed = 0, sqliteRows = 0; const skipped = [], undo = []
  await withSessionDatabases(path.dirname(rootDir), targetRoot, async opened => {
    try {
      for (const item of scan.sessions) {
        if (options.ids?.length && !options.ids.includes(item.id)) continue
        const file = resolveSessionFile(rootDir, item.relativePath).fullPath
        const stat = await fs.stat(file)
        if (!options.allowRecent && Date.now() - stat.mtimeMs < 10000) { skipped.push(item.id || item.relativePath); continue }
        const text = await fs.readFile(file, 'utf8'); let modified = false
        const next = text.split('\n').map(line => {
          try {
            const row = JSON.parse(line)
            if (row.type === 'session_meta' && row.payload) {
              if (row.payload.model_provider !== targetProvider) { row.payload.model_provider = targetProvider; modified = true }
              if (options.cwd !== undefined && row.payload.cwd !== options.cwd) { row.payload.cwd = options.cwd; modified = true }
              return JSON.stringify(row)
            }
          } catch {}
          return line
        }).join('\n')
        if (modified) {
          const saved = path.join(targetRoot, 'files', item.relativePath.replaceAll('..', '_parent_'))
          await fs.mkdir(path.dirname(saved), { recursive: true }); await fs.writeFile(saved, text)
          if ((await fs.stat(file)).mtimeMs !== stat.mtimeMs) { skipped.push(item.id); continue }
          undo.push({ file, text }); await fs.writeFile(file + '.radar-tmp', next); await fs.rename(file + '.radar-tmp', file); changed++
        }
        for (const { db } of opened) sqliteRows += updateThread(db, item.id, { model_provider: targetProvider, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) })
      }
      await fs.writeFile(path.join(targetRoot, 'manifest.json'), JSON.stringify({ targetProvider, changed, sqliteRows, skipped, files: undo.map(x => x.file) }, null, 2))
    } catch (err) { for (const { file, text } of undo) await fs.writeFile(file, text); throw err }
  })
  return { ok: skipped.length === 0, repaired: changed, sqliteRows, skipped, backupDir: targetRoot, message: `供应商同步：更新 ${changed} 个文件、${sqliteRows} 条数据库记录，跳过 ${skipped.length} 个正在使用的会话` }
}

export async function sessionMarkdown(rootDir, relativePath) {
  const file = resolveSessionFile(rootDir, relativePath).fullPath
  return jsonlToMarkdown(file, await summarizeFile(rootDir, file))
}
