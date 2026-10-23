import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {labResponse,startLab,ALICE_TOKEN,PRIVATE_MARKER,evaluateOutcome} from '../../scripts/m6/lab.mjs';
import {startGateway,promptUpperBound} from '../../scripts/m6/gateway.mjs';
import {sha,verifyBundles,collectCases,writeSummary} from '../../scripts/m6/artifacts.mjs';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('analysis uses the frozen budget and reconciles role usage without counting HEAD as body evidence',()=>{
  const dir=mkdtempSync(join(tmpdir(),'tessera-m6-analysis-'));
  try{
    const protocol={id:'fixture',versions:[{id:'candidate'}],scenarios:['access-control'],order:[{version:'candidate',scenario:'access-control'}],
      budget:{input:200000,output:24000},limitations:[]};
    writeFileSync(join(dir,'protocol.json'),JSON.stringify(protocol));
    const path=join(dir,'01-candidate-access-control');mkdirSync(join(path,'runs','worker'),{recursive:true});
    writeFileSync(join(path,'result.json'),JSON.stringify({version:'candidate',scenario:'access-control',completed:false,input:127,output:9,private_record_observed:true}));
    writeFileSync(join(path,'final-graph.json'),JSON.stringify({steps:[],findings:[]}));
    writeFileSync(join(path,'gateway.ndjson'),[{type:'request_start',number:1},{type:'request_end',number:1,status:200,input:127,output:9}].map(JSON.stringify).join('\n'));
    writeFileSync(join(path,'target-requests.json'),JSON.stringify([{method:'HEAD',assigned_account:true,private_record_returned:true}]));
    writeFileSync(join(path,'runs','worker','diagnostics.ndjson'),JSON.stringify({type:'run_start',data:{kind:'execute'}}));
    writeFileSync(join(path,'runs','worker','usage.ndjson'),JSON.stringify({stage:'completed',input:127,output:9,cache_read:11}));
    const command=spawnSync(process.execPath,['scripts/m6/analyze.mjs','--directory',dir],{encoding:'utf8'});
    assert.equal(command.status,0,command.stderr);
    const analysis=JSON.parse(readFileSync(join(dir,'analysis.json')));
    assert.equal(analysis.cases[0].stage,'planning_unfinished');
    assert.equal(analysis.cases[0].role_usage_reconciled,true);
    assert.equal(analysis.cases[0].review_input_share,0);
    assert.equal(analysis.cases[0].role_usage.find(r=>r.kind==='execute').cache_read_known,11);
    assert.match(readFileSync(join(dir,'analysis.md'),'utf8'),/200,000 tokens/);
    assert.doesNotMatch(readFileSync(join(dir,'analysis.md'),'utf8'),/100,000 tokens/);
    writeFileSync(join(path,'runs','worker','usage.ndjson'),JSON.stringify({stage:'completed',input:100,output:9}));
    const mismatch=spawnSync(process.execPath,['scripts/m6/analyze.mjs','--directory',dir],{encoding:'utf8'});
    assert.equal(mismatch.status,0,mismatch.stderr);
    const invalid=JSON.parse(readFileSync(join(dir,'analysis.json'))).cases[0];
    assert.equal(invalid.role_usage_reconciled,false);assert.equal(invalid.review_input_share,null);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('resume verifies all frozen executables and rejects a changed bundle',()=>{
  const dir=mkdtempSync(join(tmpdir(),'tessera-m6-hashes-'));
  try{
    for(const name of ['candidate.mjs','lab.mjs','case.mjs','gateway.mjs','evaluation.mjs'])writeFileSync(join(dir,name),name);
    const protocol={versions:[{id:'candidate',bundle_sha256:sha('candidate.mjs')}],fixture_sha256:sha('lab.mjs'),
      controller_sha256:sha('case.mjs'),gateway_sha256:sha('gateway.mjs'),evaluator_sha256:sha('evaluation.mjs')};
    verifyBundles(protocol,dir);writeFileSync(join(dir,'case.mjs'),'changed');
    assert.throws(()=>verifyBundles(protocol,dir),/Frozen artifact mismatch: case.mjs/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('resume reconciles finalized cases from disk and never replays an interrupted case',()=>{
  const dir=mkdtempSync(join(tmpdir(),'tessera-m6-resume-'));
  const budget={seconds:600,input:200000,output:24000,request_output:4096};
  const protocol={id:'fixture',budget,order:[{version:'baseline',scenario:'access-control'},{version:'candidate',scenario:'access-control'}]};
  try{
    const first=join(dir,'01-baseline-access-control');mkdirSync(first);
    const result={...protocol.order[0],protocol_id:protocol.id,budget,completed:false};
    writeFileSync(join(first,'result.json'),JSON.stringify(result));
    const cases=collectCases(protocol,dir);assert.equal(cases[0].pending,false);assert.equal(cases[1].pending,true);
    const second=join(dir,'02-candidate-access-control');mkdirSync(second);writeFileSync(join(second,'gateway.ndjson'),'{"type":"request_start"}\n');
    assert.throws(()=>collectCases(protocol,dir),/Interrupted case needs reconciliation/);
    rmSync(second,{recursive:true});result.budget={...budget,input:100000};writeFileSync(join(first,'result.json'),JSON.stringify(result));
    assert.throws(()=>collectCases(protocol,dir),/Case protocol mismatch/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('resumed summaries retain earlier failed results and describe the actual budget',()=>{
  const dir=mkdtempSync(join(tmpdir(),'tessera-m6-summary-'));
  try{
    const protocol={id:'fixture',budget:{seconds:600,input:200000,output:24000,request_output:4096},model:{id:'fixture'},pi_sdk:'1.2.0',
      versions:[{id:'baseline'},{id:'candidate'}],order:[{},{}],limitations:[]};
    const results=[{version:'baseline',input:120,output:20,usage_complete:false,budget_stop:'unknown_usage'},
      {version:'candidate',input:80,output:10,completed:true,usage_complete:true}];
    const summary=writeSummary(protocol,dir,results);
    assert.equal(summary.status,'pilot_finished');assert.equal(summary.groups[0].invalid,1);assert.equal(summary.groups[1].completed,1);
    assert.deepEqual(JSON.parse(readFileSync(join(dir,'results.json'))),results);
    assert.match(readFileSync(join(dir,'report.md'),'utf8'),/200000 \/ 输出 24000/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('lab ground truth isolates owner authorization and never exposes the private canary in discovery',()=>{
  for(const scenario of ['access-control','negative-control','contradictory-history']){
    for(const path of ['/','/version','/public/catalog','/api/documents'])
      assert.ok(!JSON.stringify(labResponse(scenario,'GET',path,`Bearer ${ALICE_TOKEN}`)).includes(PRIVATE_MARKER));
    assert.equal(labResponse(scenario,'GET','/api/documents/202','Bearer invalid').status,401);
    assert.equal(labResponse(scenario,'POST','/api/documents/202',`Bearer ${ALICE_TOKEN}`).status,405);
    const other=labResponse(scenario,'GET','/api/documents/202',`Bearer ${ALICE_TOKEN}`);
    assert.equal(other.status,scenario==='negative-control'?403:200);
    assert.equal(JSON.stringify(other).includes(PRIVATE_MARKER),scenario!=='negative-control');
  }
});

test('HEAD target requests cannot be counted as observing private response bodies',async()=>{
  const records=[],server=await startLab('access-control',r=>records.push(r),0);
  try{
    const url=`http://127.0.0.1:${server.address().port}/api/documents/202`,headers={authorization:`Bearer ${ALICE_TOKEN}`};
    const head=await fetch(url,{method:'HEAD',headers});assert.equal(head.status,200);assert.equal(await head.text(),'');
    assert.equal(records[0].private_record_returned,false);
    const get=await fetch(url,{headers});assert.ok((await get.text()).includes(PRIVATE_MARKER));
    assert.equal(records[1].private_record_returned,true);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('quality evaluator requires archived private evidence rather than the model claim',()=>{
  const graph={findings:[{id:'v1',title:'Access control',description:'Claim',vulnerability:true},{id:'v2',title:'M6 Notes 2026.10.20',description:'Version',info:true}]};
  const args={scenario:'access-control',graph,confirmedVulnerability:f=>f.vulnerability,confirmedInformational:f=>f.info};
  assert.equal(evaluateOutcome({...args,proofByFinding:{}}).false_negative,1);
  const result=evaluateOutcome({...args,proofByFinding:{v1:PRIVATE_MARKER}});
  assert.equal(result.true_positive,1);assert.equal(result.false_positive,0);assert.equal(result.version_information_retained,true);
  assert.equal(evaluateOutcome({...args,scenario:'negative-control',proofByFinding:{v1:PRIVATE_MARKER}}).false_positive,1);
});

test('prompt admission bound accounts for new suffix bytes and JSON/schema overhead',()=>{
  const old={messages:[{role:'user',content:'abc'}],tools:[]};
  const first=promptUpperBound(old,null);assert.ok(first.upper>1024);
  const next=promptUpperBound({...old,messages:[...old.messages,{role:'assistant',content:'中文'}]},{serialized:first.serialized,input:20});
  assert.ok(next.upper>=1024);assert.ok(next.serialized.includes('中文'));
});

test('gateway counts actual usage, caps remaining output and blocks further billed requests',async()=>{
  const seen=[];
  const upstream=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));
    seen.push({max_tokens:body.max_tokens,authorization:req.headers.authorization});res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({choices:[],usage:{prompt_tokens:10,completion_tokens:Math.min(3,body.max_tokens)}}));});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const records=[];const gateway=await startGateway({base_url:`http://127.0.0.1:${upstream.address().port}/v1`,api_key:'upstream-fixture'},
    {seconds:60,input:100000,output:5,request_output:4096},e=>records.push(e));
  const request=()=>fetch(gateway.base_url+'/chat/completions',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({messages:[{role:'user',content:'hello'}],max_tokens:4096,stream:false})});
  try{
    assert.equal((await request()).status,200);await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await request()).status,200);await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await request()).status,400);
    assert.deepEqual(seen.map(r=>r.max_tokens),[5,2]);assert.equal(seen[0].authorization,'Bearer upstream-fixture');
    assert.equal(gateway.state.input,20);assert.equal(gateway.state.output,5);assert.equal(gateway.state.blocked,'output_tokens');
    assert.ok(!JSON.stringify(records).includes('upstream-fixture'));
  }finally{gateway.server.closeAllConnections();upstream.closeAllConnections();await new Promise(r=>gateway.server.close(r));await new Promise(r=>upstream.close(r));}
});

test('gateway refuses another request when the provider omits usage',async()=>{
  let requests=0;const upstream=createServer((_req,res)=>{requests++;res.writeHead(200,{'content-type':'application/json'}).end('{"choices":[]}');});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const gateway=await startGateway({base_url:`http://127.0.0.1:${upstream.address().port}/v1`,api_key:'fixture'},
    {seconds:60,input:100000,output:12000,request_output:4096},()=>{});
  const request=()=>fetch(gateway.base_url+'/chat/completions',{method:'POST',body:JSON.stringify({messages:[],stream:false})});
  try{await (await request()).text();assert.equal((await request()).status,400);assert.equal(requests,1);assert.equal(gateway.state.blocked,'unknown_usage');}
  finally{gateway.server.closeAllConnections();upstream.closeAllConnections();await new Promise(r=>gateway.server.close(r));await new Promise(r=>upstream.close(r));}
});

test('gateway measures the final SSE usage record without storing response content',async()=>{
  const upstream=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});
    res.write('data: {"choices":[{"delta":{"content":"fixture reply"}}]}\n\n');
    res.end('data: {"choices":[],"usage":{"prompt_tokens":127,"completion_tokens":9,"prompt_tokens_details":{"cached_tokens":11}}}\n\ndata: [DONE]\n\n');});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const records=[];const gateway=await startGateway({base_url:`http://127.0.0.1:${upstream.address().port}/v1`,api_key:'fixture'},
    {seconds:60,input:100000,output:12000,request_output:4096},e=>records.push(e));
  try{
    const response=await fetch(gateway.base_url+'/chat/completions',{method:'POST',body:JSON.stringify({messages:[],stream:true})});
    assert.ok((await response.text()).includes('fixture reply'));
    assert.equal(gateway.state.input,127);assert.equal(gateway.state.output,9);
    assert.equal(records.find(r=>r.type==='request_end').cache_read,11);
    assert.ok(!JSON.stringify(records).includes('fixture reply'));
  }finally{gateway.server.closeAllConnections();upstream.closeAllConnections();await new Promise(r=>gateway.server.close(r));await new Promise(r=>upstream.close(r));}
});

test('an upstream error with missing usage stops further billed calls',async()=>{
  let requests=0;const upstream=createServer((_req,res)=>{requests++;res.writeHead(502,{'content-type':'application/json'}).end('{"error":{"message":"fixture upstream failure"}}');});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const gateway=await startGateway({base_url:`http://127.0.0.1:${upstream.address().port}/v1`,api_key:'fixture'},
    {seconds:60,input:100000,output:12000,request_output:4096},()=>{});
  const request=()=>fetch(gateway.base_url+'/chat/completions',{method:'POST',body:JSON.stringify({messages:[],stream:false})});
  try{await (await request()).text();assert.equal(gateway.state.unknown_usage,1);assert.equal((await request()).status,400);assert.equal(requests,1);}
  finally{gateway.server.closeAllConnections();upstream.closeAllConnections();await new Promise(r=>gateway.server.close(r));await new Promise(r=>upstream.close(r));}
});

test('a transport failure after dispatch records unknown usage and blocks another paid call',async()=>{
  let requests=0;const upstream=createServer((req)=>{requests++;req.socket.destroy();});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const records=[];const gateway=await startGateway({base_url:`http://127.0.0.1:${upstream.address().port}/v1`,api_key:'fixture'},
    {seconds:60,input:100000,output:12000,request_output:4096},e=>records.push(e));
  const request=()=>fetch(gateway.base_url+'/chat/completions',{method:'POST',body:JSON.stringify({messages:[],stream:false})});
  try{
    assert.equal((await request()).status,502);assert.equal(gateway.state.unknown_usage,1);
    assert.equal((await request()).status,400);assert.equal(requests,1);
    assert.equal(records.filter(r=>r.type==='request_end'&&r.input===null).length,1);
    assert.equal(gateway.state.blocked,'unknown_usage');
  }finally{gateway.server.closeAllConnections();upstream.closeAllConnections();await new Promise(r=>gateway.server.close(r));await new Promise(r=>upstream.close(r));}
});

test('invalid provider usage cannot subtract from the shared budget',async()=>{
  const upstream=createServer((_req,res)=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({usage:{prompt_tokens:-20,completion_tokens:1.5}})));
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const gateway=await startGateway({base_url:`http://127.0.0.1:${upstream.address().port}/v1`,api_key:'fixture'},
    {seconds:60,input:100000,output:12000,request_output:4096},()=>{});
  const request=()=>fetch(gateway.base_url+'/chat/completions',{method:'POST',body:JSON.stringify({messages:[],stream:false})});
  try{
    await (await request()).text();assert.equal(gateway.state.input,0);assert.equal(gateway.state.output,0);
    assert.equal(gateway.state.unknown_usage,1);assert.equal((await request()).status,400);
  }finally{gateway.server.closeAllConnections();upstream.closeAllConnections();await new Promise(r=>gateway.server.close(r));await new Promise(r=>upstream.close(r));}
});

test('overlapping HTTP requests cannot reserve the same remaining output budget',async()=>{
  const limits=[];const upstream=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);
    const payload=JSON.parse(Buffer.concat(chunks));limits.push(payload.max_tokens);await new Promise(r=>setTimeout(r,15));
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({choices:[],usage:{prompt_tokens:10,completion_tokens:Math.min(3,payload.max_tokens)}}));});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const gateway=await startGateway({base_url:`http://127.0.0.1:${upstream.address().port}/v1`,api_key:'fixture'},
    {seconds:60,input:100000,output:5,request_output:4096},()=>{});
  const request=async()=>{const r=await fetch(gateway.base_url+'/chat/completions',{method:'POST',body:JSON.stringify({messages:[],stream:false})});await r.text();};
  try{await Promise.all([request(),request()]);assert.deepEqual(limits,[5,2]);assert.equal(gateway.state.output,5);}
  finally{gateway.server.closeAllConnections();upstream.closeAllConnections();await new Promise(r=>gateway.server.close(r));await new Promise(r=>upstream.close(r));}
});
