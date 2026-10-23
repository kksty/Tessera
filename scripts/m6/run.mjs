/** Frozen local pilot. Preparing is free; --run explicitly enables paid provider calls. */
import {build} from 'esbuild';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs,parseEnv} from 'node:util';
import {RuntimeConfig} from '../../apps/server/src/runtime.ts';
import {SCENARIOS,labResponse,ALICE_TOKEN,PRIVATE_MARKER} from './lab.mjs';
import {writeSummary} from './artifacts.mjs';

const {values}=parseArgs({options:{run:{type:'boolean',default:false},id:{type:'string'},'case-timeout':{type:'string',default:'600'},
  cases:{type:'string'},'prepare-only':{type:'boolean',default:false},'input-budget':{type:'string',default:'100000'},
  'output-budget':{type:'string',default:'12000'}}});
const root=resolve(import.meta.dirname,'../..');
const id=values.id??new Date().toISOString().replace(/[:.]/g,'-');
if(!/^[a-zA-Z0-9_.-]+$/.test(id))throw Error('Invalid run ID');
const output=join(root,'test-results','m6',id),privateRoot=join(root,'.tessera','m6',id),bundle=join(privateRoot,'bundles');
if(existsSync(join(output,'protocol.json')))throw Error('Use a new ID to preserve the original protocol and results');
mkdirSync(output,{recursive:true});mkdirSync(bundle,{recursive:true});
const sha=value=>createHash('sha256').update(value).digest('hex');
const versions=[{id:'baseline',ref:'c8ffdf5548070723b268c8cf4e3e2afab71c7a7c'},
  {id:'fair-scheduling',ref:'101b9c9c72e2d14945f6574902fe8b36f26c5f67'},{id:'candidate',ref:null}];
const entries=`export {Store} from './packages/core/src/store.ts';
export {Reports} from './packages/core/src/reports.ts';
export {RuntimeConfig} from './apps/server/src/runtime.ts';
export {buildApp} from './apps/server/src/app.ts';
export {runJob} from './packages/runner/src/run.ts';
export {ApiClient} from './packages/runner/src/client.ts';
export {createProjectSchema} from './packages/protocol/src/index.ts';`;
for(const version of versions){
  let source=root;
  if(version.ref){source=join(privateRoot,version.id);mkdirSync(source,{recursive:true});const archive=join(privateRoot,version.id+'.tar');
    execFileSync('git',['archive','--format=tar','--output',archive,version.ref,'apps','packages','scripts','docker','package.json','pnpm-lock.yaml'],{cwd:root});
    execFileSync('tar',['-xf',archive,'-C',source]);}
  if(sha(readFileSync(join(source,'pnpm-lock.yaml')))!==sha(readFileSync(join(root,'pnpm-lock.yaml'))))throw Error('Dependency locks differ');
  const sourceFiles=['apps','packages','docker'].flatMap(dir=>readdirSync(join(source,dir),{recursive:true,withFileTypes:true})
    .filter(e=>e.isFile()).map(e=>resolve(e.parentPath,e.name)).filter(p=>!/[\\/](node_modules|__pycache__|dist)[\\/]/.test(p))).sort();
  const hash=createHash('sha256');for(const file of sourceFiles)hash.update(file.slice(source.length).replaceAll('\\','/')).update('\0').update(readFileSync(file));
  version.business_source_sha256=hash.digest('hex');
  const buildInfo={id:version.business_source_sha256,version:'0.3.0',pi_sdk:'1.2.0'};
  await build({stdin:{contents:entries,resolveDir:source,sourcefile:'m6-entry.mjs',loader:'js'},outfile:join(bundle,version.id+'.mjs'),bundle:true,
    platform:'node',target:'node24',format:'esm',packages:'external',define:{__TESSERA_BUILD_INFO__:JSON.stringify(buildInfo)}});
  version.bundle_sha256=sha(readFileSync(join(bundle,version.id+'.mjs')));
}
await build({stdin:{contents:`export {confirmedVulnerability,confirmedInformational} from './packages/protocol/src/finding-policy.ts';`,resolveDir:root,loader:'js'},
  outfile:join(bundle,'evaluation.mjs'),bundle:true,platform:'node',target:'node24',format:'esm',packages:'external'});
for(const name of ['case.mjs','lab.mjs','gateway.mjs'])copyFileSync(join(root,'scripts','m6',name),join(bundle,name));
const environment={...process.env,...parseEnv(readFileSync(join(root,'.env'),'utf8'))};
const model=new RuntimeConfig(join(root,'datas','tessera','runtime.json'),environment).value.model;
if(!model.id||!model.base_url||!model.api_key||model.api!=='openai-completions')throw Error('This fixed pilot requires the configured OpenAI-compatible primary model');
const budget={seconds:Number(values['case-timeout']),input:Number(values['input-budget']),output:Number(values['output-budget']),request_output:4096};
if(!Number.isInteger(budget.seconds)||budget.seconds<60||budget.seconds>600)throw Error('Case timeout must be 60..600 seconds');
if(!Number.isInteger(budget.input)||budget.input<10000||budget.input>1000000||!Number.isInteger(budget.output)||budget.output<1024||budget.output>64000)
  throw Error('Input budget must be 10000..1000000 and output budget must be 1024..64000');
const selection=values.cases?.split(',');
const cases=SCENARIOS.flatMap((scenario,index)=>[...versions.slice(index),...versions.slice(0,index)].map(v=>({version:v.id,scenario})))
  .filter(c=>!selection||selection.includes(`${c.version}/${c.scenario}`));
if(!cases.length)throw Error('No selected cases');
const protocol={format_version:1,id,prepared_at:new Date().toISOString(),status:values.run&&!values['prepare-only']?'running':'prepared',mode:'local_safety_task_pilot',
  repetitions:1,versions,scenarios:SCENARIOS,order:cases,budget,
  model:{id:model.id,provider:model.provider,api:model.api,context_window:model.context_window,max_output_tokens:4096,
    endpoint_sha256:sha(model.base_url),credential_material:'omitted'},pi_sdk:'1.2.0',worker_image:'tessera-worker:0.3.0',
  worker_image_id:JSON.parse(execFileSync('docker',['image','inspect','tessera-worker:0.3.0'],{encoding:'utf8'}))[0].Id,
  fixture_sha256:sha(readFileSync(join(bundle,'lab.mjs'))),controller_sha256:sha(readFileSync(join(bundle,'case.mjs'))),
  gateway_sha256:sha(readFileSync(join(bundle,'gateway.mjs'))),evaluator_sha256:sha(readFileSync(join(bundle,'evaluation.mjs'))),
  budget_contract:'Per-case wall clock; actual input/output counted across all roles, repairs and retries; output capped on every request. Before dispatch, a conservative UTF-8 prompt bound with a previous-usage bound guards remaining input. Admission guard stops are reported separately. Missing provider usage stops further requests. All cache inputs count. Any observed overrun invalidates that case.',
  acceptance:{'access-control':{vulnerabilities:1,information:true},'negative-control':{vulnerabilities:0,information:true},'contradictory-history':{vulnerabilities:1,information:true}},
  limitations:['One repetition is a pilot, not a robust effect estimate.','The normal deployment may share provider capacity; elapsed time is observational.',
    'The three source versions differ in grouped changes, not a single-feature ablation.','No token-to-currency price has been supplied.']};
writeFileSync(join(output,'protocol.json'),JSON.stringify(protocol,null,2));
for(const scenario of SCENARIOS){const response=labResponse(scenario,'GET','/api/documents/202',`Bearer ${ALICE_TOKEN}`);
  if((response.status===200&&JSON.stringify(response.body).includes(PRIVATE_MARKER))!==(scenario!=='negative-control'))throw Error('Fixture oracle mismatch');}
console.log(JSON.stringify({prepared:true,id,cases:cases.length,model:model.id,budget,output}));
if(!values.run||values['prepare-only'])process.exit(0);
const modelFile=join(privateRoot,'private-model.json'),lock=join(privateRoot,'resume.lock');
writeFileSync(lock,JSON.stringify({pid:process.pid,at:new Date().toISOString()}),{flag:'wx'});
try {
writeFileSync(modelFile,JSON.stringify(model),{mode:0o600});
const results=[];
for(const [index,c] of cases.entries()){
  const caseOutput=join(output,`${String(index+1).padStart(2,'0')}-${c.version}-${c.scenario}`);mkdirSync(caseOutput,{recursive:true});
  const name=`tessera-m6-${sha(id).slice(0,8)}-${index+1}`;
  console.log(JSON.stringify({event:'case_start',...c,index:index+1,total:cases.length,at:new Date().toISOString()}));
  const args=['run','--rm','--init','--name',name,'--cpus','2','--memory','2g',
    '--mount',`type=bind,source=${bundle},target=/opt/tessera/m6,readonly`,
    '--mount',`type=bind,source=${caseOutput},target=/results`,
    '--mount',`type=bind,source=${modelFile},target=/run/secrets/m6-model.json,readonly`,
    '-e',`M6_CASE_CONFIG=${JSON.stringify({...c,budget,protocol_id:id})}`,
    protocol.worker_image_id,'node','/opt/tessera/m6/case.mjs'];
  const child=spawnSync('docker',args,{encoding:'utf8',timeout:(budget.seconds+90)*1000,maxBuffer:4*1024*1024});
  if(child.error){spawnSync('docker',['stop','-t','15',name],{timeout:20000});spawnSync('docker',['rm','-f',name],{timeout:15000});}
  const cleaned=String(child.stdout??'')+'\n'+String(child.stderr??'');
  writeFileSync(join(caseOutput,'controller.log'),cleaned.replaceAll(model.api_key,'[redacted]'));
  const result=existsSync(join(caseOutput,'result.json'))?JSON.parse(readFileSync(join(caseOutput,'result.json'),'utf8')):
    {...c,status:'harness_failed',error:child.error?.code??`container_exit_${child.status}`};
  results.push(result);writeFileSync(join(output,'results.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify({event:'case_end',...c,completed:result.completed,input:result.input,output:result.output,
    quality:result.quality,budget_stop:result.budget_stop,error:result.error,at:new Date().toISOString()}));
}
const summary=writeSummary(protocol,output,results);
console.log(JSON.stringify(summary));
const audit=spawnSync(process.execPath,[join(root,'scripts','m6','analyze.mjs'),'--directory',output],{stdio:'inherit'});
if(audit.status!==0)process.exitCode=1;
} finally { rmSync(modelFile,{force:true});rmSync(lock,{force:true}); }
