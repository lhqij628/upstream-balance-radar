import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

// The key is outside source/public assets; back it up separately from encrypted data.
export async function createVault(dataDir) {
  await fs.mkdir(dataDir,{recursive:true,mode:0o700})
  const file=path.join(dataDir,'vault-key')
  let key
  if(process.env.RADAR_VAULT_KEY) key=Buffer.from(process.env.RADAR_VAULT_KEY,'base64')
  else {
    try{key=await fs.readFile(file)}catch(e){if(e.code!=='ENOENT')throw e}
    if(!key){key=randomBytes(32);await fs.writeFile(file,key,{flag:'wx',mode:0o600})}
  }
  if(key.length!==32)throw new Error('RADAR_VAULT_KEY 必须是 Base64 编码的 32 字节密钥')
  return {
    seal(value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);return {radarEncrypted:1,iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:bytes.toString('base64')}},
    open(value){if(value?.radarEncrypted!==1)return value;const d=createDecipheriv('aes-256-gcm',key,Buffer.from(value.iv,'base64'));d.setAuthTag(Buffer.from(value.tag,'base64'));return JSON.parse(Buffer.concat([d.update(Buffer.from(value.data,'base64')),d.final()]).toString('utf8'))}
  }
}
