import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

export const desktop = Boolean((window as unknown as {__TAURI_INTERNALS__?:unknown}).__TAURI_INTERNALS__)
let localBase = '', localToken = '', webToken = ''
export let serviceMode = 'local'
export let configRevision = 0
export function setConfigRevision(value:number) { configRevision=value }
export const isRemote = () => !desktop && serviceMode === 'server'
export function endpoint(_name='') { return desktop ? localBase : '' }
export function headersFor(_name=''):Record<string,string> { const token=desktop?localToken:webToken;return token?{Authorization:`Bearer ${token}`} : {} }
export async function logoutConnection(){
  if (desktop) return
  try { await fetch('/api/auth/logout',{method:'POST',credentials:'include',headers:headersFor(),signal:AbortSignal.timeout(5000)}) }
  finally { webToken='';window.dispatchEvent(new Event('radar-login-required')) }
}
export async function connectLocal() {
  if(!desktop)return
  const data=await invoke<{url:string;token:string}>('radar_connection')
  localBase=data.url;localToken=data.token;serviceMode='local'
}
export async function connect(_url:string,password:string,username='') {
  if(desktop) { await connectLocal();configRevision=0;return }
  const r=await fetch('/api/auth/login',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password}),signal:AbortSignal.timeout(10000)})
  const d=await r.json();if(!r.ok)throw new Error(d.error||'登录失败')
  webToken=d.token;serviceMode=d.mode;configRevision=0
}
export async function resumeConnection(){
  await connectLocal()
  const r=await fetch(endpoint()+'/api/auth/status',{credentials:'include',headers:headersFor(),signal:AbortSignal.timeout(5000)})
  if(r.ok) { const status=await r.json();serviceMode=status.mode }
  return r.ok
}
export function ConnectionPanel({onConnected}:{onConnected:()=>void}) {
  const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[setupCode,setSetupCode]=useState('')
  const [register,setRegister]=useState(false),[registrationOpen,setRegistrationOpen]=useState(false),[legacy,setLegacy]=useState(false)
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(!desktop)
  useEffect(()=>{if(desktop)return;fetch('/api/auth/setup',{signal:AbortSignal.timeout(8000)}).then(async r=>{if(!r.ok)throw new Error('服务状态读取失败');const d=await r.json();setRegistrationOpen(d.registrationOpen);setRegister(d.registrationOpen);serviceMode=d.mode}).catch(e=>setError(String(e))).finally(()=>setLoading(false))},[])
  const submit=async()=>{
    setBusy(true);setError('')
    try {
      if(register&&!desktop){
        if(password!==confirm)throw new Error('两次输入的密码不一致')
        const r=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password,setupCode}),signal:AbortSignal.timeout(15000)})
        const d=await r.json();if(!r.ok)throw new Error(d.error||'注册失败')
        setRegistrationOpen(false);setRegister(false);setSetupCode('')
      }
      await connect('',password,legacy?'':username);setPassword('');setConfirm('');onConnected()
    }catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
  }
  return <main className="connection-screen"><form className="connection-card" onSubmit={e=>{e.preventDefault();void submit()}}>
    <h1>余额雷达</h1><h2>{desktop?'本机工作区':register?'注册管理员':'登录'}</h2>
    {!desktop&&!legacy&&<label>用户名<input required autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)}/></label>}
    {!desktop&&<label>{legacy?'访问密码':'密码'}<input required minLength={register?12:undefined} maxLength={256} type="password" autoComplete={register?'new-password':'current-password'} value={password} onChange={e=>setPassword(e.target.value)}/></label>}
    {register&&!desktop&&<><label>确认密码<input required type="password" autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)}/></label><label>部署初始化码<input required type="password" autoComplete="off" value={setupCode} onChange={e=>setSetupCode(e.target.value)}/></label><small>使用部署时的 RADAR_ACCESS_TOKEN；本机 Web 使用数据目录中的 access-token。管理员注册后关闭注册。</small></>}
    {error&&<p role="alert">{error}</p>}
    <button type="submit" disabled={busy||loading}>{busy?'处理中…':desktop?'打开本机工作区':register?'注册并登录':'登录'}</button>
    {registrationOpen&&!desktop&&<button type="button" className="ghost" onClick={()=>{setRegister(!register);setLegacy(register);setError('')}}>{register?'使用原访问密码登录':'注册管理员'}</button>}
  </form></main>
}
