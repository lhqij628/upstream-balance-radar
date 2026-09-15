import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

export function launchProcess(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve({ pid: child.pid }) })
  })
}
export async function openUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 HTTP/HTTPS 页面地址')
  if (process.platform === 'win32') return launchProcess('rundll32.exe', ['url.dll,FileProtocolHandler', url.href])
  return launchProcess(process.platform === 'darwin' ? 'open' : 'xdg-open', [url.href])
}
export function zedUrl({ ssh, path: remotePath, line, column }) {
  if (!ssh || typeof ssh.host !== 'string' || !/^(?:[a-zA-Z0-9][\w.-]*|\[[a-fA-F0-9:]+\])$/.test(ssh.host)) throw new Error('SSH 主机名无效')
  if (ssh.port != null && (!Number.isInteger(Number(ssh.port)) || Number(ssh.port) < 1 || Number(ssh.port) > 65535)) throw new Error('SSH 端口无效')
  if (typeof remotePath !== 'string' || !remotePath.startsWith('/') || /[\x00-\x1f]/.test(remotePath)) throw new Error('需要远程文件的绝对路径')
  const user = ssh.user ? encodeURIComponent(String(ssh.user)) + '@' : ''
  const suffix = line == null ? '' : ':' + positive(line) + (column == null ? '' : ':' + positive(column))
  return `ssh://${user}${ssh.host}${ssh.port ? ':' + ssh.port : ''}${remotePath.split('/').map(encodeURIComponent).join('/')}${suffix}`
}
function positive(value) { const n = Number(value); if (!Number.isInteger(n) || n < 1) throw new Error('行号或列号无效'); return n }
export function createNativeActions({ codexHome, launch = launchProcess } = {}) {
  async function findZed() {
    const dirs = (process.env.PATH || '').split(path.delimiter)
    if (process.platform === 'win32') dirs.unshift(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Zed'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Zed', 'bin'))
    for (const dir of dirs.filter(Boolean)) {
      const file = path.join(dir, process.platform === 'win32' ? 'zed.exe' : 'zed')
      if ((await fs.stat(file).catch(() => null))?.isFile()) return file
    }
    return ''
  }
  async function resolveHost(hostId) {
    if (typeof hostId !== 'string' || !hostId.startsWith('remote-ssh-')) throw new Error('需要远程 SSH 主机 ID')
    let state = {}
    try { state = JSON.parse(await fs.readFile(path.join(codexHome, '.codex-global-state.json'), 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
    const connection = (state['codex-managed-remote-connections'] || []).find(c => c.hostId === hostId)
    if (!connection) throw new Error('未找到该主机的 SSH 连接信息')
    const authority = connection.sshHost || connection.host || connection.sshAlias || connection.alias
    const parsed = new URL('ssh://' + authority)
    const ssh = { host: parsed.hostname, user: connection.sshUser || connection.user || decodeURIComponent(parsed.username), port: Number(connection.sshPort || parsed.port) || null }
    zedUrl({ ssh, path: '/' })
    return ssh
  }
  return {
    async zedStatus() { const file = await findZed(); return { status: 'ok', platformSupported: ['win32', 'darwin', 'linux'].includes(process.platform), zedCliFound: !!file, zedAppFound: !!file, zedCliPath: file, zedAppPath: file, message: file ? '已找到 Zed' : '请安装 Zed 并将命令加入 PATH' } },
    resolveHost,
    async zedFallback(payload) { return { status: 'ok', request: { hostId: payload.hostId, ssh: await resolveHost(payload.hostId), path: payload.remoteWorkspaceRoot || '/' } } },
    async openZed(payload) {
      const ssh = payload.ssh || await resolveHost(payload.hostId), url = zedUrl({ ...payload, ssh }), file = await findZed()
      if (!file) return { status: 'failed', message: '未找到 Zed，请安装并将命令加入 PATH' }
      const flag = { addToFocusedWorkspace: '-a', reuseWindow: '-r', newWindow: '-n', default: '' }[payload.strategy || 'addToFocusedWorkspace']
      if (flag === undefined) throw new Error('Zed 窗口策略无效')
      const result = await launch(file, [...(flag ? [flag] : []), url])
      return { status: 'ok', url, ...result }
    },
  }
}
