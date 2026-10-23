/** Finish only unstarted cases using the original bundles, image and budget. */
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {parseArgs,parseEnv} from 'node:util';
import {RuntimeConfig} from '../../apps/server/src/runtime.ts';
import {sha,verifyBundles,collectCases,writeSummary} from './artifacts.mjs';

const {values}=parseArgs({options:{id:{type:'string'},run:{type:'boolean',default:false}}});
if(!values.id||!/^[a-zA-Z0-9_.-]+$/.test(values.id))throw Error('Usage: pnpm m6:resume --id EXISTING_ID [--run]');
const root=resolve(import.meta.dirname,'../..'),directory=join(root,'test-results','m6',values.id);
const privateRoot=join(root,'.tessera','m6',values.id),bundle=join(privateRoot,'bundles');
const protocol=JSON.parse(readFileSync(join(directory,'protocol.json'),'utf8'));
if(protocol.id!==values.id)throw Error('Protocol ID mismatch');
verifyBundles(protocol,bundle);
const cases=collectCases(protocol,directory),pending=cases.filter(c=>c.pending);
const image=JSON.parse(execFileSync('docker',['image','inspect',protocol.worker_image_id],{encoding:'utf8'}))[0];
if(image.Id!==protocol.worker_image_id)throw Error('Frozen Worker image is unavailable');
console.log(JSON.stringify({id:protocol.id,completed:cases.length-pending.length,pending:pending.map(c=>c.spec),budget:protocol.budget,run:values.run}));
if(!values.run)process.exit(0);
const lock=join(privateRoot,'resume.lock'),modelFile=join(privateRoot,'private-model.json');
writeFileSync(lock,JSON.stringify({pid:process.pid,at:new Date().toISOString()}),{flag:'wx'});
try{
  const results=cases.filter(c=>!c.pending).map(c=>c.result);
  if(pending.length){
    const environment={...process.env,...parseEnv(readFileSync(join(root,'.env'),'utf8'))};
    const model=new RuntimeConfig(join(root,'datas','tessera','runtime.json'),environment).value.model;
    const actual={id:model.id,provider:model.provider,api:model.api,context_window:model.context_window,max_output_tokens:protocol.budget.request_output,
      endpoint_sha256:sha(model.base_url??''),credential_material:'omitted'};
    if(!model.api_key||JSON.stringify(actual)!==JSON.stringify(protocol.model))throw Error('Current model configuration differs from frozen protocol');
    const containers=execFileSync('docker',['ps','-a','--format','{{.Names}}'],{encoding:'utf8'}).trim().split(/\r?\n/);
    const prefix=`tessera-m6-${sha(protocol.id).slice(0,8)}-`;
    if(containers.some(name=>name.startsWith(prefix)))throw Error('An original case container still exists; reconcile it first');
    const execution=join(directory,`resume-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
    writeFileSync(execution,JSON.stringify({at:new Date().toISOString(),driver_sha256:sha(readFileSync(import.meta.filename)),
      artifacts_sha256:sha(readFileSync(join(import.meta.dirname,'artifacts.mjs'))),pending:pending.map(c=>c.spec),budget:protocol.budget,worker_image_id:image.Id},null,2),{flag:'wx'});
    writeFileSync(modelFile,JSON.stringify(model),{mode:0o600});
    for(const c of pending){
      mkdirSync(c.path,{recursive:true});
      const name=prefix+(c.index+1);
      console.log(JSON.stringify({event:'case_start',...c.spec,index:c.index+1,total:cases.length,at:new Date().toISOString()}));
      const child=spawnSync('docker',['run','--rm','--init','--name',name,'--cpus','2','--memory','2g',
        '--mount',`type=bind,source=${bundle},target=/opt/tessera/m6,readonly`,
        '--mount',`type=bind,source=${c.path},target=/results`,
        '--mount',`type=bind,source=${modelFile},target=/run/secrets/m6-model.json,readonly`,
        '-e',`M6_CASE_CONFIG=${JSON.stringify({...c.spec,budget:protocol.budget,protocol_id:protocol.id})}`,
        image.Id,'node','/opt/tessera/m6/case.mjs'],{encoding:'utf8',timeout:(protocol.budget.seconds+90)*1000,maxBuffer:4*1024*1024});
      if(child.error){spawnSync('docker',['stop','-t','15',name],{timeout:20000});spawnSync('docker',['rm','-f',name],{timeout:15000});}
      writeFileSync(join(c.path,'controller.log'),`${child.stdout??''}\n${child.stderr??''}`.replaceAll(model.api_key,'[redacted]'));
      const file=join(c.path,'result.json');
      if(!existsSync(file))throw Error(`Case did not finalize; reconcile ${name} before continuing`);
      const result=JSON.parse(readFileSync(file,'utf8'));results.push(result);
      writeSummary(protocol,directory,results);
      console.log(JSON.stringify({event:'case_end',...c.spec,completed:result.completed,input:result.input,output:result.output,budget_stop:result.budget_stop,error:result.error}));
    }
  }
  console.log(JSON.stringify(writeSummary(protocol,directory,results)));
  const audit=spawnSync(process.execPath,[join(import.meta.dirname,'analyze.mjs'),'--directory',directory],{stdio:'inherit'});
  if(audit.status!==0)process.exitCode=1;
}finally{rmSync(modelFile,{force:true});rmSync(lock,{force:true});}
