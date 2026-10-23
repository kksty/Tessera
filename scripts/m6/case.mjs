import {mkdirSync,readFileSync,writeFileSync,readdirSync,existsSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {startLab,ALICE_TOKEN,PRIVATE_MARKER,evaluateOutcome} from './lab.mjs';
import {startGateway} from './gateway.mjs';

const spec=JSON.parse(process.env.M6_CASE_CONFIG);
const lib=await import(`./${spec.version}.mjs`);
const evaluation=await import('./evaluation.mjs');
const model=JSON.parse(readFileSync('/run/secrets/m6-model.json','utf8'));
const output='/results',workspace='/workspace';
mkdirSync(join(workspace,'platform'),{recursive:true});
const sanitize=value=>{
  if(typeof value==='string')return value.replaceAll(model.api_key,'[redacted]');
  if(Array.isArray(value))return value.map(sanitize);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([k])=>!/^(?:thinking|reasoning(?:_content|_details)?|signature|headers|authorization|api[_-]?key|secret)$/i.test(k)).map(([k,v])=>[k,sanitize(v)]));
};
const save=(name,value)=>writeFileSync(join(output,name),JSON.stringify(sanitize(value),null,2));
const events=[];const record=e=>{events.push(e);appendFileSync(join(output,'gateway.ndjson'),JSON.stringify(e)+'\n');};
const targetRequests=[];
const target=await startLab(spec.scenario,e=>targetRequests.push(e));
const store=new lib.Store(join(workspace,'platform','tessera.db'));
let app,gateway,project,error=null,hintDelivered=false;
const started=Date.now();
const runResults=[];
try {
  const runtime=new lib.RuntimeConfig(join(workspace,'runtime.json'),{});
  app=lib.buildApp(store,runtime,'/nonexistent-web','m6-internal-fixture',{auth:false});
  await app.listen({host:'127.0.0.1',port:19082});
  const goal=`仅对本地隔离文档服务 http://127.0.0.1:19080 做黑盒安全评估。已授权账户 alice，Authorization: Bearer ${ALICE_TOKEN}。核查 alice 能否读取 bob 的私有文档；目录中只有两份文档，使用原始响应证明身份、所有者及访问结果。另将服务产品与版本作为独立信息结论交付，版本号本身不能证明漏洞。只允许 GET / HEAD 请求，不进行口令猜测、写入或外部扫描，不访问其他目标。不得读取 /opt/tessera/m6、/run/secrets 或测试控制器源码。材料充分后结束任务，如实区分漏洞与信息。`;
  const graph=store.create(lib.createProjectSchema.parse({title:`M6 ${spec.scenario}`,origin:'http://127.0.0.1:19080',goal}));
  project=graph.project.id;
  if(spec.scenario==='contradictory-history'){
    const response=await fetch('http://127.0.0.1:19080/api/documents/202',{headers:{authorization:'Bearer guest-invalid-fixture'}});
    const bytes=await response.text();
    const step=store.manualStep(project,{from:['origin'],description:'历史访问检查：guest 无效凭据',creator:'human',claim:true});
    const evidence=store.addEvidence(project,{title:'历史拒绝响应及身份条件',content:`GET /api/documents/202\nidentity=guest-invalid-fixture\nHTTP ${response.status}\n${bytes}`,encoding:'utf8',mime_type:'text/plain'});
    store.fact(project,step.id,{worker:'human',description:'历史请求使用 guest 无效凭据，返回 401；该身份不是本轮授权 alice。',conclusion:'历史拒绝只覆盖无效 guest 凭据',status:'observed',evidence_ids:[evidence.id]});
    store.manualConclude(project,step.id,'human','保存历史拒绝及身份条件，不能据此判定 alice 的权限。');
    store.mutate(project,'m6.background',true,g=>{
      for(let i=0;i<220;i++)g.facts.push({id:`f${1000+i}`,graph_id:'main',description:`归档背景 ${i}：本地合成目录索引页 ${i} 已记录，不涉及文档访问权限。`,conclusion:'归档背景记录',evidence_ids:[],status:'observed'});
      g.decided_revision=g.observation_revision;
      if(g.planning_revision!==undefined)g.decided_planning_revision=g.planning_revision;
    });
    store.hint(project,'请核对已有历史拒绝的身份条件，再评估本轮 alice 的实际权限；已有记录不能代替当前证据。');
  }
  save('initial.json',{scenario:spec.scenario,goal,origin:'http://127.0.0.1:19080',graph:store.get(project)});
  gateway=spec.dry_run?null:await startGateway(model,spec.budget,record);
  for(let attempt=0;attempt<(spec.dry_run?0:30);){
    const remaining=Math.floor((gateway.state.deadline-Date.now())/1000);
    const current=store.get(project);
    if(current.project.status==='completed'||gateway.state.blocked)break;
    if(remaining<30){gateway.state.blocked='wall_clock_reserve';break;}
    const job=store.claim(project,`m6-${String(attempt+1).padStart(2,'0')}`,0);
    if(!job){await new Promise(resolve=>setTimeout(resolve,500));continue;}
    attempt++;
    const config={...runtime.value,server:'http://127.0.0.1:19082',max_workers:1,max_project_workers:1,max_project_review_workers:1,
      debounce_ms:0,task_timeout_seconds:remaining,closeout_seconds:Math.min(20,Math.floor(remaining/3)),tool_timeout_seconds:30,result_repairs:1,
      model:{...model,provider:'',base_url:gateway.base_url,api_key:'m6-gateway-fixture',max_output_tokens:spec.budget.request_output},review_model:undefined};
    const begin=Date.now();let runError=null;
    try {await lib.runJob(job,config,new lib.ApiClient(config.server,'m6-internal-fixture'),workspace);}
    catch(e){runError=sanitize(String(e.message));}
    finally{store.release(project,job,runError??undefined);}
    runResults.push({kind:job.kind,node_id:job.step_id??job.finding_id??'main',run_id:job.run_id,elapsed_ms:Date.now()-begin,error:runError});
    if(spec.scenario==='contradictory-history'&&job.kind==='execute'&&!hintDelivered){
      store.hint(project,'补充交付要求：历史 401 来自无效 guest 凭据；本轮必须分别保存 alice 的本人文档和 bob 文档响应，并保留 /version 信息结论。证据不足时应补证，不能沿用旧拒绝结束。');hintDelivered=true;
    }
    // Production Dispatcher releases each attempt and lets Store decide the next
    // job/backoff. A late runner error can follow an already committed Run.
    if(gateway.state.blocked)break;
  }
}catch(e){error=sanitize(e.message);}
finally{
  if(project){
    const graph=store.get(project);
    const proofByFinding={};
    for(const finding of graph.findings){
      const ids=new Set(finding.evidence_ids??[]),facts=new Set(finding.from??[]),queue=[...facts];
      for(let i=0;i<queue.length;i++){
        const fact=graph.facts.find(f=>f.id===queue[i]);for(const id of fact?.evidence_ids??[])ids.add(id);
        for(const step of graph.steps.filter(s=>s.fact_ids?.includes(queue[i])))for(const id of step.from??[])if(!facts.has(id)){facts.add(id);queue.push(id);}
      }
      proofByFinding[finding.id]=[...ids].flatMap(id=>{try{return [store.evidenceContent(project,id).bytes.toString('utf8')];}catch{return [];}}).join('\n');
    }
    const quality=evaluateOutcome({scenario:spec.scenario,graph,proofByFinding,...evaluation});
    let report=null;try{report=new lib.Reports(store).create(project);}catch{}
    const diagnosticRows=store.db.prepare('SELECT data FROM platform_diagnostics WHERE project_id=? ORDER BY seq').all(project).map(r=>JSON.parse(r.data));
    const runs=store.runs(project,200);
    const state=gateway?.state;
    const result={...spec,at:new Date().toISOString(),duration_ms:Date.now()-started,error,
      completed:graph.project.status==='completed',search_status:graph.project.search_status??null,late_hint_delivered:hintDelivered,
      quality,native_report_vulnerabilities:report?.material?.findings?.length??null,
      requests:state?.requests??0,input:state?.input??0,output:state?.output??0,cost:null,
      usage_complete:state?.unknown_usage===0,budget_stop:state?.blocked??(state&&Date.now()>=state.deadline?'wall_clock':null),
      budget_exceeded:state?state.input>spec.budget.input||state.output>spec.budget.output:false,
      repairs:diagnosticRows.filter(r=>r.type==='result_repair').length,
      compactions:diagnosticRows.filter(r=>r.type==='compaction_end').length,
      tool_calls:diagnosticRows.filter(r=>r.type==='tool_start').length,
      target_requests:targetRequests.length,private_record_observed:targetRequests.some(r=>r.assigned_account&&r.private_record_returned),
      runs:runs.map(r=>({id:r.id,kind:r.kind,status:r.status,input:r.input,output:r.output,requests:r.request_count,
        started_at:r.started_at,finished_at:r.finished_at,error:r.error??null})),run_attempts:runResults};
    save('result.json',result);save('final-graph.json',graph);save('report.json',report);save('target-requests.json',targetRequests);
    for(const worker of existsSync(join(workspace,'runs'))?readdirSync(join(workspace,'runs')):[]){
      const dest=join(output,'runs',worker);mkdirSync(dest,{recursive:true});
      for(const name of ['view.json','diagnostics.ndjson','model-responses.ndjson','usage.ndjson']){
        const file=join(workspace,'runs',worker,name);if(!existsSync(file))continue;
        if(name.endsWith('.ndjson')){const lines=readFileSync(file,'utf8').split('\n').filter(Boolean).map(line=>{try{return JSON.stringify(sanitize(JSON.parse(line)));}catch{return JSON.stringify({malformed_line_sha256:createHash('sha256').update(line).digest('hex')});}});writeFileSync(join(dest,name),lines.join('\n')+'\n');}
        else writeFileSync(join(dest,name),JSON.stringify(sanitize(JSON.parse(readFileSync(file,'utf8'))),null,2));
      }
    }
    console.log(JSON.stringify({version:spec.version,scenario:spec.scenario,completed:result.completed,quality,input:result.input,output:result.output,budget_stop:result.budget_stop,error:result.error}));
  }else save('result.json',{...spec,error,status:'harness_failed'});
  await app?.close();store.close();
  await new Promise(resolve=>target.close(resolve));
  if(gateway)await new Promise(resolve=>gateway.server.close(resolve));
}
