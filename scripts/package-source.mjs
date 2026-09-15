import fs from 'node:fs/promises'
import path from 'node:path'
const root=process.cwd(),out=path.join(root,'artifacts','source-'+new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14))
await fs.mkdir(out,{recursive:true})
for(const entry of ['src','server','scripts','src-tauri','public','package.json','pnpm-lock.yaml','index.html','tsconfig.json','tsconfig.app.json','tsconfig.node.json','vite.config.ts','.gitignore','.dockerignore','.env.example','Dockerfile','compose.yaml','README.md','WEB_DEPLOY.md','start-desktop.cmd','start-local.ps1','start-local.bat']){
 const source=path.join(root,entry)
 try{await fs.access(source)}catch{continue}
 await fs.cp(source,path.join(out,entry),{recursive:true,filter:async p=>{const r=path.relative(root,p),stat=await fs.lstat(p);if(stat.isSymbolicLink())return false;return !(stat.isDirectory()&&/^data($|-)/.test(path.basename(p)))&&!r.split(path.sep).some(s=>['target','resources','data','data-rt','test-artifacts','node_modules'].includes(s))&&!/acceptance-audit|release-acceptance/.test(path.basename(p))}})
}
console.log('Source staging prepared without runtime data: '+out)
