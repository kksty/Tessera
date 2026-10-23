import { commitPlan } from "../helpers/current-api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { Reports } from "../../packages/core/src/reports.js";
import { createProjectSchema, decideSchema, executeSchema, findingSchema } from "../../packages/protocol/src/index.js";
import { trafficRecordSchema } from "../../packages/protocol/src/traffic.js";
import { confirmedFinding, projectActivity, projectRuntime } from "../../apps/web/src/project-activity.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
const create = (store: Store) => store.create(createProjectSchema.parse({ title:"Project workspace", origin:"https://example.test", goal:"Validate evidence" })).project.id;

test("traffic archives large binary bodies in retryable chunks, previews pages and downloads every byte", async () => {
 const dir=mkdtempSync(join(tmpdir(),"tessera-traffic-bodies-")), store=new Store(join(dir,"db")), id=create(store);
 const app=buildApp(store,new RuntimeConfig(join(dir,"config.json")),join(dir,"web"));
 const headers={"x-tessera-worker-token":testWorkerToken}, url=`/api/projects/${id}/traffic`;
 const block=Buffer.alloc(256*1024); for(let i=0;i<block.length;i++) block[i]=i%251;
 const bodyId=randomUUID(), responseId=randomUUID(), total=26*1024*1024+137;
 const digest=createHash("sha256");
 try {
  const upload=`${url}/bodies/${bodyId}`;
  assert.equal((await app.inject({method:"POST",url:upload,payload:{offset:0,data_base64:""}})).statusCode,403);
  // Recover a partially persisted chunk and accept identical retries without duplicating data.
  for(const data of [block.subarray(0,31),block,block])
   assert.equal((await app.inject({method:"POST",url:upload,headers,payload:{offset:0,data_base64:data.toString("base64")}})).statusCode,200);
  const metadata=trafficRecordSchema.parse({id:"large",created_at:new Date().toISOString(),method:"POST",url:"https://example.test/upload",host:"example.test",
   request:{head:"POST /upload HTTP/1.1\r\nX-Large: "+"a".repeat(70000),body_id:bodyId,size:total}});
  // A record whose body is still incomplete is rejected individually; the batch
  // itself succeeds so the spool cannot loop forever on one poisoned record.
  const incomplete=await app.inject({method:"POST",url,headers,payload:{records:[metadata]}});
  assert.equal(incomplete.statusCode,200); assert.equal(incomplete.json().rejected,1);
  for(let offset=0;offset<total;offset+=block.length) {
   const chunk=block.subarray(0,Math.min(block.length,total-offset)); digest.update(chunk);
   assert.equal((await app.inject({method:"POST",url:upload,headers,payload:{offset,data_base64:chunk.toString("base64")}})).statusCode,200);
  }
  const response=Buffer.from([0,255,1,254,128]);
  assert.equal((await app.inject({method:"POST",url:`${url}/bodies/${responseId}`,headers,payload:{offset:0,data_base64:response.toString("base64")}})).statusCode,200);
  const record={...metadata,status:200,response:{head:"HTTP/1.1 200 OK",body_id:responseId,size:response.length}};
  assert.equal((await app.inject({method:"POST",url,headers,payload:{records:[record]}})).statusCode,200);
  const detail=(await app.inject({url:`${url}/large`})).json();
  assert.equal(detail.request.head.length,metadata.request.head.length); assert.equal(detail.request.body_base64,""); assert.equal(detail.request.truncated,false);
  const first=(await app.inject({url:`${url}/large/request/body`})).json();
  assert.equal(first.size,total); assert.equal(first.next,65536); assert.deepEqual(Buffer.from(first.body_base64,"base64"),block.subarray(0,65536));
  const last=(await app.inject({url:`${url}/large/request/body?offset=${total-137}`})).json();
  assert.equal(last.next,null); assert.deepEqual(Buffer.from(last.body_base64,"base64"),block.subarray(0,137));
  const downloaded=await app.inject({url:`${url}/large/request/body?download=1`});
  assert.equal(downloaded.rawPayload.length,total); assert.equal(createHash("sha256").update(downloaded.rawPayload).digest("hex"),digest.digest("hex"));
  assert.match(downloaded.headers["content-disposition"]!,/attachment/);
  assert.deepEqual((await app.inject({url:`${url}/large/response/body?download=1`})).rawPayload,response);
  assert.equal((await app.inject({url:`${url}/large/request/body?offset=-1`})).statusCode,422);
  const file=store.traffic.bodyPath(id,bodyId); assert.ok(existsSync(file));
  store.remove(id); assert.equal(existsSync(file),false);
 } finally { await app.close();store.close();rmSync(dir,{recursive:true,force:true}); }
});

test("revoking approved assets retires queued and running tasks, retains history, and reapproval needs a fresh plan", () => {
 const store = new Store(":memory:");
 try {
  const id=create(store), [asset]=store.discover(id,[{hostname:"api.example.test",source:"discovery",evidence_ids:[]}]);
  store.approve(id,[asset.id]);
  const planner=store.claim(id,"planner",0)!, planned=store.get(id);
  commitPlan(store, id,decideSchema.parse({worker:planner.worker,revision:planned.revision,observation_revision:planned.observation_revision, planning_revision: planned.planning_revision,
    steps:[{from:["origin"],description:"Test approved asset",asset_id:asset.id}]}));
  const task=store.get(id).steps.find(s => s.asset_id===asset.id)!;
  store.manualHeartbeat(id,task.id,"Human");
  const before=store.get(id).facts.length;
  store.revokeAssets(id,[asset.id]); let graph=store.get(id);
  assert.equal(graph.assets.find(a=>a.id===asset.id)!.approval,"pending");
  assert.equal(graph.steps.find(s=>s.id===task.id)!.discarded,true);
  assert.equal(graph.steps.find(s=>s.id===task.id)!.worker,null);
  assert.equal(graph.facts.length,before);
  assert.throws(()=>store.manualHeartbeat(id,task.id,"Human"));
  store.approve(id,[asset.id]); graph=store.get(id);
  assert.equal(graph.steps.filter(s=>s.asset_id===asset.id && !s.discarded).length,0,
    "reapproval is an observation; it does not pre-create work");
  const second=store.claim(id,"planner-2",0)!, state=store.get(id);
  assert.equal(second.kind,"decide");
  commitPlan(store, id,decideSchema.parse({worker:second.worker,revision:state.revision,observation_revision:state.observation_revision, planning_revision: state.planning_revision,
    steps:[{from:["origin"],description:"Retest approved asset",asset_id:asset.id}]}));
  graph=store.get(id);
  assert.equal(graph.steps.filter(s=>s.asset_id===asset.id && !s.discarded).length,1);
  assert.notEqual(graph.steps.find(s=>s.asset_id===asset.id && !s.discarded)!.id,task.id);
 } finally { store.close(); }
});

test("timeline folds incremental task observations and excludes routine audit by default; review counts use current passing versions", () => {
 const store=new Store(":memory:");
 try {
  const id=create(store), planner=store.claim(id,"planner",0)!, g=store.get(id);
  commitPlan(store, id,decideSchema.parse({worker:planner.worker,revision:g.revision,observation_revision:g.observation_revision, planning_revision: g.planning_revision,steps:[{from:["origin"],description:"对象权限验证"}]}));
  const job=store.claim(id,"executor",0)!;
  store.fact(id,job.step_id!,{worker:job.worker,description:"观察到访问差异",evidence_ids:[]});
  store.submitStepFinding(id,job.step_id!,job.worker,findingSchema.parse({title:"候选漏洞",description:"需要独立验证"}));
  store.execute(id,job.step_id!,executeSchema.parse({worker:job.worker,facts:["第二条事实"],summary:"已完成验证"}));
  const graph=store.get(id), rows=projectActivity(store.events(id),graph);
  const done=rows.find(r=>r.kind==="step.executed")!;
  assert.match(done.title,/对象权限验证/); assert.match(done.detail,/2 条事实.*1 项发现/); assert.equal(done.actor,"executor");
  assert.equal(rows.filter(r=>r.kind==="finding.submitted").length,0);
  assert.equal(rows.filter(r=>r.kind==="fact.observed").length,0);
  assert.ok(projectActivity(store.events(id),graph,true).length>rows.length);
  const f=graph.findings[0]; assert.equal(confirmedFinding(f),false);
  assert.equal(confirmedFinding({...f,review_status:"pass",reviewed_version:f.version}),false);
  assert.equal(confirmedFinding({...f,evidence_ids:["e001"],review_status:"pass",reviewed_version:f.version}),false);
  assert.equal(confirmedFinding({...f,kind:"informational",evidence_ids:["e001"],review_status:"pass",reviewed_version:f.version}),true);
  assert.equal(confirmedFinding({...f,review_status:"pass",reviewed_version:f.version-1}),false);
  const version=f.version; store.reviseFinding(id,f.id,{impact:"New impact"},version);
  assert.throws(()=>store.reviseFinding(id,f.id,{impact:"Stale draft"},version), /版本已更新/);
  assert.equal(store.get(id).findings[0].impact,"New impact");
 } finally { store.close(); }
});

test("report creation and material invalidation appear in the project timeline without heartbeat noise", () => {
 const store=new Store(":memory:");
 try { const id=create(store), reports=new Reports(store); reports.create(id);
  assert.equal(store.events(id).at(-1)!.kind,"report.created");
  store.rename(id,"Updated title");
  assert.equal(reports.list(id)[0].stale,true); assert.equal(store.events(id).at(-1)!.kind,"report.stale");
  const rows=projectActivity(store.events(id),store.get(id)); assert.ok(rows.some(r=>r.category==="delivery"));
 } finally {store.close();}
});

test("traffic API authenticates collectors, preserves response against delayed requests, paginates and never changes graph revisions", async () => {
 const dir=mkdtempSync(join(tmpdir(),"tessera-traffic-")), store=new Store(join(dir,"db")), id=create(store);
 const app=buildApp(store,new RuntimeConfig(join(dir,"config.json")),join(dir,"web"));
 try {
  const url=`/api/projects/${id}/traffic`, before=store.get(id).revision;
  const request=trafficRecordSchema.parse({id:"flow-1",created_at:new Date().toISOString(),method:"POST",url:"https://example.test/api",host:"example.test",request:{head:"POST /api HTTP/1.1\r\nHost: example.test",body_base64:Buffer.from("a=1").toString("base64"),size:3}});
  assert.equal((await app.inject({method:"POST",url,payload:{records:[request]}})).statusCode,403);
  const headers={"x-tessera-worker-token":testWorkerToken};
  assert.equal((await app.inject({method:"POST",url,headers,payload:{records:[request]}})).statusCode,200);
  const full={...request,status:200,response:{head:"HTTP/1.1 200 OK",body_base64:Buffer.from("answer").toString("base64"),size:6,truncated:false}};
  await app.inject({method:"POST",url,headers,payload:{records:[full]}});
  await app.inject({method:"POST",url,headers,payload:{records:[request]}});
  assert.equal((await app.inject({url:url+"/flow-1"})).json().response.size,6);
  store.traffic.ingest(id,[{...request,id:"flow-2"}]);
  const list=(await app.inject({url:url+"?limit=1"})).json(); assert.equal(list.records.length,1); assert.equal(list.records[0].request,undefined);
  const older=(await app.inject({url:url+`?before=${list.records[0].seq}`})).json(); assert.equal(older.records[0].id,"flow-1");
  assert.equal((await app.inject({url:url+"?q=absent"})).json().records.length,0);
  assert.equal((await app.inject({url:url+"/missing"})).statusCode,404);
  assert.equal((await app.inject({method:"POST",url,headers,payload:{records:[{...request,request:{...request.request,body_base64:"%%%"}}]}})).statusCode,422);
  assert.equal(store.get(id).revision,before);
 } finally { await app.close(); store.close(); assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep)); rmSync(dir,{recursive:true,force:true}); }
});

test("traffic list separates HTTP, connection and packet metadata and filters by capture kind", async () => {
 const dir=mkdtempSync(join(tmpdir(),"tessera-traffic-kind-")), store=new Store(join(dir,"db")), id=create(store);
 const app=buildApp(store,new RuntimeConfig(join(dir,"config.json")),join(dir,"web"));
 try {
  const url=`/api/projects/${id}/traffic`, headers={"x-tessera-worker-token":testWorkerToken}, now=new Date().toISOString();
  const message=(head:string,size=0)=>({head,body_base64:"",size,truncated:false});
  const http=trafficRecordSchema.parse({id:"http-1",created_at:now,method:"GET",url:"https://example.test/",host:"example.test",request:message("GET / HTTP/1.1"),status:200,response:message("HTTP/1.1 200 OK",12)});
  // SSH 只记录连接元数据：没有 HTTP 状态码，也没有载荷。
  const open=trafficRecordSchema.parse({id:"tcp-1",capture_kind:"connection",capture_state:"open",created_at:now,last_seen:now,method:"SSH",url:"tcp://10.0.0.9:22",host:"10.0.0.9",protocol:"TCP",packet_count:4,request:message("SSH 10.0.0.5:51000 → 10.0.0.9:22",128)});
  const closed={...open,capture_state:"closed" as const,duration_ms:1500,request:message("SSH 10.0.0.5:51000 → 10.0.0.9:22",2048),response:message("SSH 10.0.0.9:22 → 10.0.0.5:51000",4096)};
  const packet=trafficRecordSchema.parse({id:"network-1",capture_kind:"packet",created_at:now,last_seen:now,method:"UDP",url:"udp://10.0.0.9",host:"10.0.0.9",protocol:"UDP",packet_count:7,request:message("UDP 10.0.0.5:33333 → 10.0.0.9:161",480)});
  for (const record of [http,open,packet]) assert.equal((await app.inject({method:"POST",url,headers,payload:{records:[record]}})).statusCode,200);
  assert.equal((await app.inject({method:"POST",url,headers,payload:{records:[closed]}})).statusCode,200);
  assert.equal((await app.inject({url:url+"/tcp-1"})).json().capture_state,"closed");
  // 迟到的 "连接进行中" 快照不能覆盖已经结束的连接。
  assert.equal((await app.inject({method:"POST",url,headers,payload:{records:[open]}})).statusCode,200);
  assert.equal((await app.inject({url:url+"/tcp-1"})).json().duration_ms,1500);
  const kinds=async (kind:string)=>(await app.inject({url:url+`?kind=${kind}`})).json().records.map((r:{id:string})=>r.id);
  assert.deepEqual(await kinds("http"),["http-1"]);
  assert.deepEqual(await kinds("connection"),["tcp-1"]);
  assert.deepEqual(await kinds("packet"),["network-1"]);
  assert.equal((await app.inject({url:url+"?kind=banana"})).statusCode,422);
  // 列表摘要仍只给尺寸，不带正文。
  const summary=(await app.inject({url:url+"?kind=connection"})).json().records[0];
  assert.equal(summary.request,undefined); assert.equal(summary.response,undefined);
  assert.equal(summary.request_size,2048); assert.equal(summary.response_size,4096); assert.equal(summary.packet_count,4);
 } finally { await app.close(); store.close(); assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep)); rmSync(dir,{recursive:true,force:true}); }
});


 test("revocation ends active execution while retaining uncertainty about already dispatched external actions", () => {
  const store=new Store(":memory:");
  try {
   const id=create(store), [asset]=store.discover(id,[{hostname:"run.example.test",source:"discovery",evidence_ids:[]}]);store.approve(id,[asset.id]);
   const plan=store.claim(id,"planner",0)!, g=store.get(id);
   commitPlan(store, id,decideSchema.parse({worker:plan.worker,revision:g.revision,observation_revision:g.observation_revision, planning_revision: g.planning_revision,
     steps:[{from:["origin"],description:"Test run asset",asset_id:asset.id}]}));
   const job=store.claim(id,"active-executor",0)!;assert.equal(job.kind,"execute");store.externalAction(id,job);
   store.revokeAssets(id,[asset.id]);
   // 撤销资产 = 操作员主动收尾：运行按取消结束，但 external_action_possible 仍留着
   // “可能已对目标动手”的事实，晚到的结果也会被拒。任务不再挂 blocked 标记。
   const run=store.runs(id).find(r=>r.id===job.run_id)!;assert.equal(run.status,"cancelled");assert.ok(run.finished_at);
   assert.equal(run.external_action_possible,true);
   const revoked=store.get(id).steps.find(s=>s.id===job.step_id)!;
   assert.equal(revoked.discarded,true);assert.equal(revoked.blocked_run_id,undefined);
   assert.throws(()=>store.execute(id,job.step_id!,executeSchema.parse({worker:job.worker,summary:"Late result"})));
  } finally {store.close();}
 });

test("project runtime excludes paused intervals and stops accruing after completion", () => {
 const date=(n:number)=>new Date(n).toISOString();
 const events=[{data:{changes:{project:{status:"stopped"}}},created_at:date(10000)}, {data:{changes:{project:{status:"active"}}},created_at:date(30000)}, {data:{changes:{project:{status:"completed"}}},created_at:date(50000)}] as any;
 assert.equal(projectRuntime(events,date(0),90000),30000);
 assert.equal(projectRuntime(events.slice(0,2),date(0),60000),40000);
});

test("revocation also retires legacy tasks inheriting scope from the origin and source facts", () => {
 const store=new Store(":memory:");
 try {const id=create(store), plan=store.claim(id,"planner",0)!, g=store.get(id);
 commitPlan(store, id,decideSchema.parse({worker:plan.worker,revision:g.revision,observation_revision:g.observation_revision, planning_revision: g.planning_revision,steps:[{from:["origin"],description:"Original implicit target"}]}));
 const job=store.claim(id,"executor",0)!;store.revokeAssets(id,[g.assets[0].id]);
 assert.equal(store.get(id).steps.find(s=>s.id===job.step_id)!.discarded,true);
 assert.throws(()=>store.manualStep(id,{from:["origin"],description:"Old approval fact is insufficient",creator:"Human"}),/approved/);
 }finally{store.close();}
});
