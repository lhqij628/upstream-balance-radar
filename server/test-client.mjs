// Test-only client: exercises production auth and revision checks, never bypasses them.
export const testToken = 'radar-test-only-credential-32-characters'
process.env.RADAR_ACCESS_TOKEN = testToken
export async function radarFetch(url, options = {}) {
  const headers=new Headers(options.headers);headers.set('Authorization',`Bearer ${testToken}`)
  if(String(url).endsWith('/api/config') && options.method==='POST') {
    const body=JSON.parse(options.body||'{}')
    if(body.revision===undefined){const r=await fetch(url,{headers});body.revision=(await r.json()).revision||0}
    options={...options,body:JSON.stringify(body)}
  }
  return fetch(url,{...options,headers})
}
