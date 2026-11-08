import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const source=fileURLToPath(new URL('../',import.meta.url));
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'story-standalone-'));
const excluded=new Set(['node_modules','dist','test-results','.releases','asset-archive','apk-out']);
try{
 await fs.cp(source,temporary,{recursive:true,filter:file=>!excluded.has(path.basename(file))&&!path.basename(file).startsWith('.build-')});
 for(const args of [['ci','--offline'],['run','typecheck'],['run','build']]){
  const result=spawnSync('npm',args,{cwd:temporary,stdio:'inherit'});
  if(result.status!==0)throw new Error(`独立工程检查失败 npm ${args.join(' ')}`);
 }
 console.log('Standalone installation, typecheck, content validation and production build passed');
}finally{await fs.rm(temporary,{recursive:true,force:true});}
