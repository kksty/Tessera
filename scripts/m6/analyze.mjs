/** Reconcile request-level measurements and inspect pilot failure stages without new model calls. */
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{directory:{type:'string'},partial:{type:'boolean',default:false}}});
if(!values.directory)throw Error('Usage: node scripts/m6/analyze.mjs --directory RESULT_DIRECTORY');
const directory=resolve(values.directory),protocol=JSON.parse(readFileSync(join(directory,'protocol.json')));
const readLines=file=>!existsSync(file)?[]:readFileSync(file,'utf8').split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
const validTokens=value=>Number.isSafeInteger(value)&&value>=0;
const cases=[];
for(const name of readdirSync(directory)){
  const path=join(directory,name),resultFile=join(path,'result.json');if(!/^\d+-/.test(name)||!existsSync(resultFile))continue;
  const result=JSON.parse(readFileSync(resultFile));
  const gateway=readLines(join(path,'gateway.ndjson')),requests=gateway.filter(r=>r.type==='request_end');
  const starts=gateway.filter(r=>r.type==='request_start').length;
  const unknown=requests.filter(r=>!validTokens(r.input)||!validTokens(r.output)).length+Math.max(0,starts-requests.length);
  const upstreamErrors=requests.filter(r=>Number.isInteger(r.status)&&r.status!==200).map(r=>r.status);
  const graph=existsSync(join(path,'final-graph.json'))?JSON.parse(readFileSync(join(path,'final-graph.json'))):null;
  const details=[];
  if(existsSync(join(path,'runs')))for(const worker of readdirSync(join(path,'runs'))){
    const events=readLines(join(path,'runs',worker,'diagnostics.ndjson'));
    const start=events.find(r=>r.type==='run_start');
    const firstPayload=events.find(r=>r.type==='model_request_payload');
    const ends=events.filter(r=>r.type==='model_request_end');
    const usage=readLines(join(path,'runs',worker,'usage.ndjson')).filter(r=>r.stage==='completed');
    const sumKnown=key=>usage.reduce((n,r)=>n+(typeof r[key]==='number'?r[key]:0),0);
    details.push({worker,kind:start?.data.kind??null,build:start?.data.build??null,
      first_payload_chars:firstPayload?.data.chars??null,requests:ends.length,
      input_known:sumKnown('input'),output_known:sumKnown('output'),cache_read_known:sumKnown('cache_read'),
      cache_read_unknown_events:usage.filter(r=>r.cache_read==null).length,
      length_stops:ends.filter(r=>r.data.stop_reason==='length').length,
      repairs:events.filter(r=>r.type==='result_repair').length,
      late_run_write_rejections:events.filter(r=>r.type==='submission'&&r.data.stage==='attempt_error'&&r.data.status===409&&/active Run/.test(r.data.error??'')).length,
      errors:events.filter(r=>r.type==='tool_end'&&r.data.is_error).map(r=>({tool:r.data.tool})),
      run_ended:events.some(r=>r.type==='run_end'),truncated_trace_ids:[...new Set(events.filter(r=>r.type==='validation_trace'&&r.data.truncated).map(r=>r.data.trace_id))].length});
  }
  const issues=[];
  if(result.status==='harness_failed'||!graph)issues.push('harness_failure');
  if(unknown)issues.push('missing_provider_usage');
  if(upstreamErrors.length)issues.push('upstream_http_failure');
  if(gateway.some(r=>r.type==='gateway_error'))issues.push('gateway_transport_failure');
  if(result.requests!==undefined&&result.requests!==starts)issues.push('request_count_reconciliation_gap');
  if(result.budget_exceeded)issues.push('token_budget_exceeded');
  const actualInput=requests.reduce((n,r)=>n+(validTokens(r.input)?r.input:0),0),actualOutput=requests.reduce((n,r)=>n+(validTokens(r.output)?r.output:0),0);
  if(actualInput>protocol.budget.input||actualOutput>protocol.budget.output)if(!issues.includes('token_budget_exceeded'))issues.push('token_budget_exceeded');
  if(result.input!==actualInput||result.output!==actualOutput)issues.push('usage_reconciliation_gap');
  const target=existsSync(join(path,'target-requests.json'))?JSON.parse(readFileSync(join(path,'target-requests.json'))):[];
  const seen=new Set();let repeatedTargetRequests=0;for(const r of target){const key=JSON.stringify([r.method,r.path,r.assigned_account,r.status]);if(seen.has(key))repeatedTargetRequests++;seen.add(key);}
  // Old fixture logs marked HEAD as having returned a body; only GET delivered it.
  const privateRecordObserved=target.some(r=>r.method==='GET'&&r.assigned_account&&r.private_record_returned);
  const roleUsage=['decide','execute','review'].map(kind=>{
    const rows=details.filter(r=>r.kind===kind),sum=key=>rows.reduce((n,r)=>n+r[key],0);
    return {kind,runs:rows.length,input_known:sum('input_known'),output_known:sum('output_known'),cache_read_known:sum('cache_read_known'),
      cache_read_unknown_events:sum('cache_read_unknown_events')};
  });
  const roleUsageReconciled=roleUsage.reduce((n,r)=>n+r.input_known,0)===actualInput&&roleUsage.reduce((n,r)=>n+r.output_known,0)===actualOutput;
  const stage=result.completed?'completed':privateRecordObserved?(result.quality?.true_positive?'confirmed_before_completion':'proof_observed_not_delivered'):
    (graph?.steps.some(s=>s.creator!=='human')?'execution_or_delivery_unfinished':'planning_unfinished');
  cases.push({directory:name,version:result.version,scenario:result.scenario,completed:result.completed??false,
    quality:result.quality??null,stage,budget_stop:result.budget_stop??null,
    provider_requests:starts,
    input_known:actualInput,output_known:actualOutput,
    unknown_usage_requests:unknown,upstream_http_errors:upstreamErrors,comparison_valid:issues.length===0,
    exclusion_reasons:issues,duration_ms:result.duration_ms??null,candidate_findings:graph?.findings.length??0,
    repeated_target_requests:repeatedTargetRequests,run_details:details,
    role_usage:roleUsage,role_usage_reconciled:roleUsageReconciled,
    review_input_share:roleUsageReconciled&&!unknown&&actualInput>0?roleUsage.find(r=>r.kind==='review').input_known/actualInput:null,
    reported_usage_matches_gateway:result.input===actualInput&&result.output===actualOutput,
    late_hint_delivered:result.late_hint_delivered??false,native_report_vulnerabilities:result.native_report_vulnerabilities??null});
}
if(!values.partial&&cases.length!==protocol.order.length)throw Error(`Pilot is incomplete: ${cases.length}/${protocol.order.length}`);
const matched=protocol.scenarios.filter(scene=>protocol.versions.every(v=>cases.some(r=>r.version===v.id&&r.scenario===scene&&r.comparison_valid)));
const aggregate=protocol.versions.map(v=>{
  const rows=cases.filter(c=>c.version===v.id),comparable=rows.filter(c=>matched.includes(c.scenario));
  const sum=(items,key)=>items.reduce((n,r)=>n+(r[key]??0),0);
  return {version:v.id,cases:rows.length,completed:rows.filter(r=>r.completed).length,
    input_known:sum(rows,'input_known'),output_known:sum(rows,'output_known'),unknown_usage_requests:sum(rows,'unknown_usage_requests'),
    duration_ms:sum(rows,'duration_ms'),budget_stops:rows.filter(r=>r.budget_stop).length,
    excluded:rows.filter(r=>!r.comparison_valid).length,
    comparable:{cases:comparable.length,completed:comparable.filter(r=>r.completed).length,
      true_positive:comparable.reduce((n,r)=>n+(r.quality?.true_positive??0),0),
      false_positive:comparable.reduce((n,r)=>n+(r.quality?.false_positive??0),0),
      false_negative:comparable.reduce((n,r)=>n+(r.quality?.false_negative??0),0),
      information_retained:comparable.filter(r=>r.quality?.version_information_retained).length}};
});
const analysis={id:protocol.id,status:cases.length===protocol.order.length?'pilot_analyzed':'partial',cases,aggregate,
  common_valid_scenarios:matched,cost:null,
  role_coverage:Object.fromEntries(['decide','execute','review'].map(kind=>[kind,cases.reduce((n,c)=>n+c.run_details.filter(r=>r.kind===kind).length,0)])),
  delivery_quality_coverage:cases.filter(c=>c.comparison_valid&&c.completed).length,
  interpretation:'Only common valid scenarios can be compared. Missing usage is unknown even for non-200 upstream responses. Budget admission stops are legitimate budget outcomes, not unknown provider costs. Single repeats provide failure examples, not stable effect estimates.',
  limitations:[...protocol.limitations,'Oracle checks the known synthetic authorization defect and retained information; CVSS calibration still requires human review.']};
writeFileSync(join(directory,'analysis.json'),JSON.stringify(analysis,null,2));
const lines=['# M6 小集分析','',`完成样本：${cases.length}/${protocol.order.length}；共同有效场景：${matched.join('、')||'无'}。每场景每版本一次。`,
  '','| 版本 | 项目完成 | 已知输入 tokens | 已知输出 tokens | 用量未知请求 | 预算停止 | 排除样本 |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
for(const g of aggregate)lines.push(`| ${g.version} | ${g.completed}/${g.cases} | ${g.input_known} | ${g.output_known} | ${g.unknown_usage_requests} | ${g.budget_stops} | ${g.excluded} |`);
lines.push('','有用量未知请求时，表中 token 是已知下界，不能按总用量比较成本。费用全部未知。','',
  '| 场景 / 版本 | 完成 | 实际观测私有数据后的阶段 | 确认漏洞 | 保留信息 | 停止原因 | 比较资格 |',
  '| --- | --- | --- | ---: | --- | --- | --- |');
for(const c of cases)lines.push(`| ${c.scenario} / ${c.version} | ${c.completed?'是':'否'} | ${c.stage} | ${c.quality?.confirmed_vulnerabilities??'未知'} | ${c.quality?.version_information_retained?'是':'否'} | ${c.budget_stop??'见运行记录'} | ${c.comparison_valid?'有效':c.exclusion_reasons.join(', ')} |`);
lines.push('','当前结论边界：','',
  '- 预算停止表示当前统一预算和准入规则下尚未完成；需要分别查看规划、执行、证据和审核阶段。',
  `- 准入上界可能在实际 tokens 未用完时拦截请求；本轮结果不等于模型在精确 ${protocol.budget.input.toLocaleString('en-US')} tokens 配额内必然无法完成。`,
  '- 未完成样本没有误报不代表准确；未进入 Review 时也不能评价审核调度或信息类审核效果。',
  '- 供应商错误、用量缺失或驱动故障的样本单独归因，并从共同有效场景对照中排除。',
  '- 首轮驱动预试验与正式小集分开保留，不将其混入新版收益。',
  '- 本轮只有一次重复，不能据此宣布稳定质量或性能提升；没有人工复核全部影响评分。',
  '', '各目录包含最终图、报告、目标请求记录、网关计量和脱敏 Run 日志。现有业务项目未被暂停、重开或并入对照。','');
lines.push('| 场景 / 版本 | Decide 已知输入 / 输出 | Execute 已知输入 / 输出 | Review 已知输入 / 输出 | 审核输入占比 | 角色用量对账 |',
  '| --- | ---: | ---: | ---: | ---: | --- |');
for(const c of cases){
  const tokens=kind=>{const r=c.role_usage.find(r=>r.kind===kind);return `${r.input_known} / ${r.output_known}`;};
  lines.push(`| ${c.scenario} / ${c.version} | ${tokens('decide')} | ${tokens('execute')} | ${tokens('review')} | ${c.review_input_share==null?'未知':(c.review_input_share*100).toFixed(1)+'%'} | ${c.role_usage_reconciled?'一致':'不一致'} |`);
}
lines.push('','角色用量来自各 Run 的已完成用量事件，缓存输入不抵扣；角色日志与网关不一致或存在用量未知时，不给出审核占比。未覆盖 Review 的 0% 只描述本轮活动，不证明审核效率。','');
writeFileSync(join(directory,'analysis.md'),lines.join('\n'));
console.log(JSON.stringify({status:analysis.status,common_valid_scenarios:matched,aggregate}));
