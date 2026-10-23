import { commitPlan } from "../helpers/current-api.js";
import { deferDecideMs } from "../helpers/scheduling.js";
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../../packages/core/src/store.js';
import {demuxDockerChunk, type DemuxState} from '../../apps/dispatcher/src/docker.js';
import {createProjectSchema,decideSchema,executeSchema,findingSchema} from '../../packages/protocol/src/index.js';
test('streamed findings attach to their running Step and review waits for completion',()=>{
 const store=new Store(':memory:');
 try{
 const g=store.create(createProjectSchema.parse({title:'Stream fixture',origin:'https://example.test',goal:'Observe results'})),id=g.project.id;
 const plan=store.claim(id,'planner',0)!,snapshot=store.get(id);
 commitPlan(store, id,decideSchema.parse({worker:plan.worker,revision:snapshot.revision,observation_revision:snapshot.observation_revision, planning_revision: snapshot.planning_revision,steps:[{from:['origin'],description:'Long exploration'}]}));
 const job=store.claim(id,'executor',0)!;
 const finding=store.submitStepFinding(id,job.step_id!,job.worker,findingSchema.parse({title:'Streamed finding',description:'Needs final observations'}));assert.equal(finding.graph_id,'main');assert.equal(finding.step_id,job.step_id);
 const next=store.claim(id,'planner2',0)!;assert.equal(next.kind,'decide');store.release(id,next);
 store.execute(id,job.step_id!,executeSchema.parse({worker:job.worker,facts:['Observed proof']}));
 const result=store.get(id);assert.equal(result.findings[0].from[0],'f001');assert.equal(store.claim(id,'reviewer',deferDecideMs)?.kind,'review');
 }finally{store.close();}
});

test('dispatcher demultiplexes docker exec frame headers out of captured output', () => {
  const frame = (payload: string, streamType = 1) => {
    const body = Buffer.from(payload);
    const head = Buffer.alloc(8);
    head[0] = streamType;
    head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  let state: DemuxState = { pending: Buffer.alloc(0) };
  let text = '';
  const feed = (buf: Buffer) => {
    state = demuxDockerChunk(buf, state, (part) => {
      text += part;
    });
  };
  const first = frame('API 409: {"detail":"Graph changed"}\n', 2);
  const second = frame('hello ', 1);
  const third = frame('world\n', 1);
  // 整帧 + 半截帧头
  feed(Buffer.concat([first, second.subarray(0, 3)]));
  assert.equal(text, 'API 409: {"detail":"Graph changed"}\n');
  // 剩余帧头 + 负载前半
  feed(Buffer.concat([second.subarray(3), third.subarray(0, 5)]));
  // 负载后半
  feed(third.subarray(5));
  assert.equal(text, 'API 409: {"detail":"Graph changed"}\nhello world\n');
  assert.equal(state.pending.length, 0);
});
