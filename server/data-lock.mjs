import fs from 'node:fs/promises'
import path from 'node:path'
export async function lockDataDirectory(dataDir){
  const file=path.join(dataDir,'service.lock')
  await fs.mkdir(dataDir,{recursive:true})
  try{await fs.writeFile(file,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600})}
  catch(e){
    if(e.code!=='EEXIST')throw e
    const old=JSON.parse(await fs.readFile(file,'utf8'));let alive=true
    try{process.kill(old.pid,0)}catch(e){if(e.code==='ESRCH')alive=false;else throw e}
    if(alive)throw new Error('此数据目录已有服务运行，请连接已有实例')
    await fs.unlink(file)
    await fs.writeFile(file,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600})
  }
  return async()=>{try{const d=JSON.parse(await fs.readFile(file,'utf8'));if(d.pid===process.pid)await fs.unlink(file)}catch{}}
}
