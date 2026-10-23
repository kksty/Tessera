import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

export const sha=value=>createHash('sha256').update(value).digest('hex');
export const caseDirectory=(index,c)=>`${String(index+1).padStart(2,'0')}-${c.version}-${c.scenario}`;

/** Check every frozen executable before resuming; never rebuild a candidate. */
export function verifyBundles(protocol,bundle){
  const expected=[...protocol.versions.map(v=>[`${v.id}.mjs`,v.bundle_sha256]),
    ['lab.mjs',protocol.fixture_sha256],['case.mjs',protocol.controller_sha256],
    ['gateway.mjs',protocol.gateway_sha256],['evaluation.mjs',protocol.evaluator_sha256]];
  for(const [file,hash] of expected){
    if(!hash||sha(readFileSync(join(bundle,file)))!==hash)throw Error(`Frozen artifact mismatch: ${file}`);
  }
}

/** A started case without final artifacts needs reconciliation, never a paid replay. */
export function collectCases(protocol,directory){
  return protocol.order.map((c,index)=>{
    const name=caseDirectory(index,c),path=join(directory,name),file=join(path,'result.json');
    if(!existsSync(file)){
      if(existsSync(path)&&readdirSync(path).length)throw Error(`Interrupted case needs reconciliation: ${name}`);
      return {spec:c,index,path,pending:true};
    }
    const result=JSON.parse(readFileSync(file,'utf8'));
    if(result.version!==c.version||result.scenario!==c.scenario||result.protocol_id!==protocol.id||
      JSON.stringify(result.budget)!==JSON.stringify(protocol.budget))throw Error(`Case protocol mismatch: ${name}`);
    return {spec:c,index,path,pending:false,result};
  });
}

export function writeSummary(protocol,directory,results){
  const groups=protocol.versions.map(v=>{
    const rows=results.filter(r=>r.version===v.id),sum=fn=>rows.reduce((n,r)=>n+fn(r),0);
    return {version:v.id,cases:rows.length,completed:sum(r=>Number(r.completed??false)),
      true_positive:sum(r=>r.quality?.true_positive??0),false_positive:sum(r=>r.quality?.false_positive??0),
      false_negative:sum(r=>r.quality?.false_negative??0),information_retained:sum(r=>Number(r.quality?.version_information_retained??false)),
      input:sum(r=>r.input??0),output:sum(r=>r.output??0),duration_ms:sum(r=>r.duration_ms??0),
      budget_stops:sum(r=>Number(!!r.budget_stop)),invalid:sum(r=>Number(r.status==='harness_failed'||r.budget_exceeded||r.usage_complete===false)),cost:null};
  });
  const summary={status:results.length===protocol.order.length?'pilot_finished':'partial',id:protocol.id,cases:results.length,groups,limitations:protocol.limitations};
  writeFileSync(join(directory,'results.json'),JSON.stringify(results,null,2));
  writeFileSync(join(directory,'summary.json'),JSON.stringify(summary,null,2));
  const lines=['# M6 隔离任务小集对照','',`模型：${protocol.model.id}；Pi：${protocol.pi_sdk}；每场景每版本一次，共 ${results.length}/${protocol.order.length} 次。`,
    '',`预算：每次 ${protocol.budget.seconds/60} 分钟、输入 ${protocol.budget.input} / 输出 ${protocol.budget.output} tokens、单请求最多输出 ${protocol.budget.request_output} tokens。所有角色及重试合计；保守输入准入可能提前停止。费用未知。`,
    '','| 版本 | 完成 | 命中 | 误报 | 漏报 | 保留信息 | 已知输入 tokens | 已知输出 tokens | 总分钟 | 预算停止 | 待审计样本 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for(const g of groups)lines.push(`| ${g.version} | ${g.completed}/${g.cases} | ${g.true_positive} | ${g.false_positive} | ${g.false_negative} | ${g.information_retained}/${g.cases} | ${g.input} | ${g.output} | ${(g.duration_ms/60000).toFixed(2)} | ${g.budget_stops} | ${g.invalid} |`);
  lines.push('','此表仅为原始汇总。用量未知时 tokens 为已知下界；样本资格、共同有效场景和失败归因以 analysis.json / analysis.md 为准。未完成样本没有误报不代表质量通过；一次重复不能证明稳定收益。','');
  writeFileSync(join(directory,'report.md'),lines.join('\n'));
  return summary;
}
