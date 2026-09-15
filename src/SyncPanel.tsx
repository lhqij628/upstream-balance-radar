import { useEffect, useState } from 'react'
import { endpoint, headersFor } from './connection'

async function request<T>(route:string,body?:unknown):Promise<T>{
  const r=await fetch(endpoint()+route,{method:body===undefined?'GET':'POST',credentials:'include',headers:{...headersFor(),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(180000)})
  const d=await r.json();if(!r.ok)throw new Error(d.error||'请求失败');return d
}
type Status={connected:boolean;url:string;username:string;lastSyncAt:string;expiresAt:number;serverMonitoring:boolean}
export function SyncPanel({onSynced}:{onSynced:()=>void}){
  const [status,setStatus]=useState<Status|null>(null),[url,setUrl]=useState(''),[username,setUsername]=useState(''),[password,setPassword]=useState('')
  const [serverMonitoring,setServerMonitoring]=useState(true),[includeEmail,setIncludeEmail]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[conflicts,setConflicts]=useState<string[]>([])
  const refresh=async()=>{const d=await request<Status>('/api/sync-client/status');setStatus(d);setUrl(d.url);setUsername(d.username);setServerMonitoring(d.serverMonitoring)}
  useEffect(()=>{void request<Status>('/api/sync-client/status').then(d=>{setStatus(d);setUrl(d.url);setUsername(d.username);setServerMonitoring(d.serverMonitoring)}).catch(e=>setMessage(String(e)))},[])
  const action=async(fn:()=>Promise<void>)=>{setBusy(true);setMessage('');try{await fn()}catch(e){setMessage(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
  const sync=async(resolution='abort')=>{
    const d=await request<{ok:boolean;message:string;conflicts:string[]}>('/api/sync-client/run',{includeEmail,resolution})
    setConflicts(d.conflicts);setMessage(d.message);await refresh();if(d.ok)onSynced()
  }
  return <section className="sync-panel"><div className="card-head"><h2>服务器同步</h2><span>{status?.connected?'已连接':'独立运行'}</span></div>
    <form onSubmit={e=>{e.preventDefault();void action(async()=>{await request('/api/sync-client/connect',{url,username,password,serverMonitoring});setPassword('');setConflicts([]);await refresh();setMessage('服务器已连接，可以同步渠道')})}}>
      <div className="two-col"><label>服务器地址<input required type="url" placeholder="https://radar.example.com" value={url} onChange={e=>setUrl(e.target.value)}/></label><label>用户名<input required autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)}/></label><label>密码<input required type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/></label></div>
      <label className="sync-option"><input type="checkbox" checked={serverMonitoring} onChange={e=>setServerMonitoring(e.target.checked)}/>已同步渠道由服务器自动探测和报警</label>
      <div className="button-row"><button disabled={busy} type="submit">{status?.connected?'更新服务器连接':'连接服务器'}</button><button disabled={busy||!status?.connected} type="button" onClick={()=>void action(async()=>{await request('/api/sync-client/disconnect',{});await refresh();setConflicts([]);setMessage('已切回独立运行，本机渠道已保留');onSynced()})}>断开并独立运行</button></div>
    </form>
    <label className="sync-option"><input type="checkbox" checked={includeEmail} onChange={e=>{setIncludeEmail(e.target.checked);setConflicts([])}}/>同步邮箱配置和 SMTP 授权码</label>
    <div className="button-row"><button disabled={busy||!status?.connected} onClick={()=>void action(()=>sync())}>{busy?'处理中…':'同步渠道与预警设置'}</button>{status?.lastSyncAt&&<small>上次同步：{new Date(status.lastSyncAt).toLocaleString()}</small>}</div>
    {conflicts.length>0&&<div role="alert"><p>冲突项：{conflicts.join('；')}</p><div className="button-row"><button disabled={busy} onClick={()=>void action(()=>sync('local'))}>冲突项保留本机值</button><button disabled={busy} onClick={()=>void action(()=>sync('server'))}>冲突项保留服务器值</button></div></div>}
    {message&&<p role="status">{message}</p>}
  </section>
}

export function PasswordPanel(){
  const [registered,setRegistered]=useState(false),[currentPassword,setCurrent]=useState(''),[password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  useEffect(()=>{void request<{registered:boolean}>('/api/auth/status').then(d=>setRegistered(d.registered)).catch(()=>{})},[])
  if(!registered)return null
  return <section className="sync-panel"><h2>账户密码</h2><form onSubmit={async e=>{e.preventDefault();setBusy(true);setMessage('');try{if(password!==confirm)throw new Error('两次输入的密码不一致');await request('/api/auth/change-password',{currentPassword,password});setCurrent('');setPassword('');setConfirm('');setMessage('密码已更新，请重新登录；已撤销其他设备的登录会话');window.dispatchEvent(new Event('radar-login-required'))}catch(e){setMessage(String(e))}finally{setBusy(false)}}}><div className="two-col"><label>当前密码<input required type="password" autoComplete="current-password" value={currentPassword} onChange={e=>setCurrent(e.target.value)}/></label><label>新密码<input required type="password" minLength={12} maxLength={256} autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)}/></label><label>确认新密码<input required type="password" autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)}/></label></div><button disabled={busy}>修改密码</button>{message&&<p role="status">{message}</p>}</form></section>
}
