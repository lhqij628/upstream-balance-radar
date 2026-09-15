import fs from 'node:fs/promises'
import path from 'node:path'
import {createVault} from '../server/vault.mjs'
const [source,target]=process.argv.slice(2)
if(!source||!target)throw new Error('Usage: node scripts/migrate-data.mjs SOURCE_DATA_DIR TARGET_DATA_DIR')
const src=path.resolve(source),dst=path.resolve(target)
if(src===dst)throw new Error('Source and target must differ')
const own=path.join(dst,'config.json')
try{await fs.access(own);throw new Error('Target already contains data; use the application to import instead')}catch(e){if(e.code!=='ENOENT')throw e}
const raw=JSON.parse(await fs.readFile(path.join(src,'config.json'),'utf8'))
let cfg=raw
if(raw.radarEncrypted){const sourceKey=await fs.readFile(path.join(src,'vault-key'));const old=process.env.RADAR_VAULT_KEY;process.env.RADAR_VAULT_KEY=sourceKey.toString('base64');cfg=(await createVault(src)).open(raw);if(old===undefined)delete process.env.RADAR_VAULT_KEY;else process.env.RADAR_VAULT_KEY=old}
const vault=await createVault(dst)
await fs.writeFile(own,JSON.stringify(vault.seal({...cfg,revision:Number(cfg.revision||0)})),{flag:'wx',mode:0o600})
console.log(JSON.stringify({migrated:cfg.accounts?.length||0,target:dst,sourceUnchanged:true}))
