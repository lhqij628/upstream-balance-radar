import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'

const quote = s => '"' + s.replaceAll('"', '""') + '"'
export async function databaseFiles(codexHome) {
  const out = []
  for (const dir of [codexHome, path.join(codexHome, 'sqlite')]) {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.isFile() && (/^state_.*\.sqlite$/.test(e.name) || (dir.endsWith('sqlite') && /\.(db|sqlite)$/.test(e.name)))) out.push(path.join(dir, e.name))
    }
  }
  return out
}
export async function readThreadMetadata(codexHome) {
  const result = new Map()
  for (const file of (await databaseFiles(codexHome)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const columns = db.prepare('PRAGMA table_info(threads)').all().map(c => c.name)
      if (!columns.includes('id') || !columns.includes('title')) continue
      for (const row of db.prepare('SELECT id,title FROM threads').all()) if (!result.has(row.id)) result.set(row.id, row)
    } finally { db.close() }
  }
  return result
}
export async function withSessionDatabases(codexHome, backupDir, action) {
  const opened = [], snapshots = []
  try {
    for (const file of await databaseFiles(codexHome)) {
      const db = new DatabaseSync(file); db.exec('PRAGMA busy_timeout=3000')
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='threads'").get()) { db.close(); continue }
      opened.push({ db, file })
      const target = path.join(backupDir, 'databases', String(opened.length) + '-' + path.basename(file))
      await fs.mkdir(path.dirname(target), { recursive: true }); await backup(db, target)
      snapshots.push({ file, snapshot: target })
    }
    await fs.mkdir(backupDir, { recursive: true })
    await fs.writeFile(path.join(backupDir, 'database-backups.json'), JSON.stringify(snapshots))
    for (const { db } of opened) db.exec('BEGIN IMMEDIATE')
    const result = await action(opened)
    for (const { db } of opened) db.exec('COMMIT')
    return result
  } catch (err) { for (const { db } of opened) { try { db.exec('ROLLBACK') } catch {} } throw err }
  finally { for (const { db } of opened) db.close() }
}
export function updateThread(db, id, patch) {
  const cols = db.prepare('PRAGMA table_info(threads)').all().map(c => c.name)
  const fields = Object.keys(patch).filter(k => cols.includes(k))
  if (!fields.length || !cols.includes('id')) return 0
  return db.prepare(`UPDATE threads SET ${fields.map(k => quote(k) + '=?').join(',')} WHERE id=?`).run(...fields.map(k => patch[k]), id).changes
}
export function removeThread(db, id) {
  const records = []
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(x => x.name)
  for (const table of tables.filter(t => t !== 'threads').concat('threads')) {
    const cols = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(c => c.name)
    const keys = table === 'threads' ? ['id'] : ['thread_id', 'parent_thread_id', 'child_thread_id'].filter(k => cols.includes(k))
    if (!keys.length || !keys.every(k => cols.includes(k))) continue
    const where = keys.map(k => `${quote(k)}=?`).join(' OR '), values = keys.map(() => id)
    const select = db.prepare(`SELECT * FROM ${quote(table)} WHERE ${where}`)
    select.setReadBigInts(true)
    const rows = select.all(...values)
    if (rows.length) {
      records.push({ table, rows: rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? { __radarSqlType: 'int64', value: String(v) } : v instanceof Uint8Array ? { __radarSqlType: 'blob', value: Buffer.from(v).toString('base64') } : v]))) })
      db.prepare(`DELETE FROM ${quote(table)} WHERE ${where}`).run(...values)
    }
  }
  return records
}
export function restoreThread(db, records) {
  for (const record of [...records].sort((a, b) => a.table === 'threads' ? -1 : b.table === 'threads' ? 1 : 0)) {
    for (const row of record.rows) {
      const keys = Object.keys(row)
      db.prepare(`INSERT INTO ${quote(record.table)} (${keys.map(quote).join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => row[k]?.__radarSqlType === 'int64' ? BigInt(row[k].value) : row[k]?.__radarSqlType === 'blob' ? Buffer.from(row[k].value, 'base64') : row[k]))
    }
  }
}
