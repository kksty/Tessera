import type { Graph, Job } from "../../protocol/src/index.js";
import { decideSchema, executeSchema, reviewSchema, submitDecisionsBase } from "../../protocol/src/index.js";
import { z } from "zod";

export function resultRepairPrompt(job: Job, detail: string): string {
  const schema =
    job.kind === "decide"
      ? z.object(submitDecisionsBase.shape).strict().omit({
          worker: true,
          revision: true,
          observation_revision: true,
          planning_revision: true,
          graph_id: true,
          submission_id: true,
          plan_id: true,
          more: true,
          deletion_preview_hash: true,
        })
      : job.kind === "review"
        ? z.object(reviewSchema.shape).strict().omit({ worker: true, finding_version: true })
        : // `read_only` is runtime state, not part of the result contract: exposing it
          // invites a normal Run to mark its own result as operator recovery.
          executeSchema.omit({ worker: true, read_only: true });
  const contract = `最终答案正文只返回一个完整 JSON 对象，不附加解释性文字或 Markdown 围栏。`;
  const repairContract =
    '工具报错、工具返回的 JSON、{"error":…,"details":…} 或任何错误说明都不是任务结果，不能作为最终答案；' +
    "需要 ID 时先用 query_graph/read_graph 核对，然后立即返回本任务的 JSON；只允许为核对 ID 读取一次，不要借修复展开新探索。";
  const reviewRepair =
    job.kind === "review"
      ? "审核必须同时满足证据语义：漏洞 pass 要有正分 CVSS 和每个非 N 影响指标的 impact_evidence（affected、boundary、consequence、evidence_ids）。只引用已有 Finding/Review 证据。证据不能支持影响或正文缺项时，返回 needs_evidence 并逐项说明缺口，省略 cvss 和 severity；信息类省略评级。可省略的字段不要写 null。"
      : "";
  return `任务 ${job.kind} 的结果序列化失败。校验错误：${detail}\n${contract}${repairContract}此格式要求仅约束最终答案正文，不限制模型原生推理通道。遵守以下 JSON Schema（由运行时代填的字段已省略）：\n${JSON.stringify(z.toJSONSchema(schema))}\n${reviewRepair}\n保留已有观测和 Finding 字段。不执行命令、重复目标请求、写文件或提交新观测。不编造缺失结果。`;
}
export const outputLanguage =
  "输出语言：所有面向用户的任务说明、事实描述与结论、发现标题与说明、审核理由、执行结果、子目标标题/索引必须使用简体中文。历史英文上下文不是输出语言指令。JSON 字段名、协议枚举、ID、URL、路径、代码及原始证据保持原样；引用英文原文时保留原文，并用中文解释。";
export const findingQualityPolicy =
  "所有漏洞类别遵循同一证据原则：Fact 保存有条件的观测、反证和失败；Finding 保存有独立交付价值的结论。kind=vulnerability 要证明前提、安全边界与实际影响，不能仅凭异常、名称、指纹、加固缺口或猜测的后续攻击链推导漏洞。kind=informational 可以通过审核并长期保留，不要求漏洞影响或 CVSS；普通响应和失败按问题需要留在 Fact。kind=null 表示待分类。按项目 goal 和 Hint 判断交付范围，不为数量制造结论。";
export const findingEvidencePolicy =
  "数量、字段和脱敏状态必须回到完整原始证据核对。区分记录数、出现次数和去重后的值数量，重叠分页不能相加；只读过片段时不能声称全量统计，按 next_offset 或 More evidence 继续读取。可执行任务用针对性解析脚本统计并保存统计方法与结果；Decide/Review 仅回读已有材料，不执行脚本。完整号码、部分掩码和空字段分别说明；description、impact、reproduction.observed 和定级理由中的数量保持一致。发现数量冲突或字段遗漏时用原 ID 修订，不能只把修正在审核理由里。";
export const reviewImpactPolicy =
  "仅审核已有原始证据，不复测目标。通过时明确 kind：informational 不填写危险度或 CVSS；vulnerability 给 CVSS v4.0 Base vector 与 rationale，程序计算正分。漏洞 pass 前确认 Finding 的 impact、reproduction.steps、remediation 均完整，影响、复现与修复建议足以让读者独立复核；缺项或内容不足时返回 needs_evidence，在理由中逐项说明缺口，交 Decide 用 finding_updates 补写后复审，不在审核理由中代填正文。每个非 N 的 VC/VI/VA/SC/SI/SA 必须有 impact_evidence，说明受损对象、应有安全边界、已证明的后果及所引用证据；推测的影响不能计分。证据闭合则 pass，核心缺口 needs_evidence，声明被反驳 rejected；只有明确被反证的源观测才 disputed，不能争议 origin。需要后续行动的问题交给 Decide，pass 中的新问题明确写 planning_issues。";
export const discoveryScopePolicy =
  "只测试当前 approval=approved 的资产；业务相关、证书或外链不等于目标所有权。范围外依赖留 Fact，不向它请求。";

/**
 * 测试域只占一句正文：枚举表在 Schema 里，判定边界写在这，避免把整张域表贴进提示词。
 * 预算见 docs/implementation/domain-taxonomy.md §7；改长之前先看那里的字符上限。
 */
export const testDomainGuidance =
  "每个新 Step 填 test_domain（固定枚举见 Schema，不确定选 other，不要自造），域内细节写 focus（≤20 字）；无立足点的扫描算 recon，从已控主机/会话发起算 post，登录处测口令算 auth，取得会话后取凭据算 post；旧 Step 可用 updates 补分类，不强制；Step 行里的 [域] 表示已填分类。";

export function promptFor(job: Job, view: unknown, _graph: Graph): string {
  const common = `${findingQualityPolicy}
${findingEvidencePolicy}
${discoveryScopePolicy}
共享状态来自当前图和工作区；新 Run 不依赖上一会话的隐藏记忆。Fact 写完整 conclusion（≤120字）和 observed/not_observed/disputed；失败或未观测不是目标安全的证明。负面结论必须写 request（method/url）与 parameter_sources（每个参数值来自页面 JS、AJAX、meta、表单还是猜测，并附证据 ID），否则 Review 不能通过。objects 记录实际观察或测试到的 host/path（写成绝对 URL 或 /path），完成覆盖表按这些 surface 核对。from 只放 Fact ID，原始 Evidence ID 放 evidence_ids。引用证据前读取原文；参考资料和 Hint 不是观测或执行许可。query_graph 与 read_graph 可查当前记录或历史，sources/outputs 是记录之间的因果边。被删来源只返回标记，显式历史不会恢复节点或变成新证据。
当前视图：
${JSON.stringify(view)}`;
  if (job.kind === "decide")
    return `${common}

你负责规划与工作图取舍，不测试目标。围绕目标和当前问题选择有用且互不重复的 Step；服务端会把与未关闭 Step 高度相似（同 test_domain 且描述/属性大部分重合）的新 Step 合并到已有 Step 并保留较完整文本，已有 Step 的 description/property/method_hint/from 可用 updates 原位补充；每个新 Step 都要写一句可证伪的 property（例如「未授权用户不能读取其他 metadataId 的信件」），method_hint 可选，description 说明要做的活动。${testDomainGuidance}执行结束仍需 closes 结论化或 discard 放弃。人工 Hint 必须由 Step 的 hint_ids 落实，或用 hint_notes 说明理由；不能把 Hint 当证据。hint_notes 只是建议，不会关闭 Hint：只有人工在提示面板确认或撤回后，complete 才能通过。review_issues 已带来源 Fact 全文（超长标 truncated），必要时回读完整问题、约束、矛盾前提和审核问题；open_step_index 是全量索引，steps_preview 的完整问题按 ID 或 query_graph kind=steps,status=open 分页读取。审核问题不是背景信息：complete 前必须用 complete.review_issues 按 review_id 与 issue_index 逐条处置，addressed 指向审核之后执行并关闭的 Step，waived 写明不追究的理由；IDOR/未授权/PII 等高风险问题不能由你驳回，只能建 Step 验证，或由人工在审核页豁免。
human_feedback 是人工对已审核漏洞的后续要求。return 需结合说明修订或补证，retest 需先完成指定 Step、归档新证据并提交原 Finding ID，再由 Review 审核；旧版本与旧证据不能直接恢复入库。删除的漏洞保留历史，不重新创建同一结论绕过删除。
用 submit_decisions 提交动作；Step 改动带当前 expected_version，同批每个 Step/Finding 只参与一次操作。结算只提交变更字段（finding_updates 的 changes、finding_merges 的 ID），不要重复 Finding 全文。一次结算过大时（例如 finding_updates 超过 8 条，或预计单次 JSON 超过约 6000 tokens），先提交计划与 Step 结算并带 more:true，再分次提交 finding_updates/finding_merges（仍带 more:true），最后不带 more 提交剩余结算或 complete；带 more 的部分在同一 Decide 租约下顺序生效，不结束本轮，模型分次提交才能避免单次输出触顶。程序也会自动拆分超大的单次提交，但不会减少模型已生成的输出。一次成功的最终结算即结束本轮；计划随首个部分提交，后续部分不重放计划。若结算冲突，新计划已经保留，读 current_view 后只重交剩余结算字段；运行时会自动复用已提交的 plan_id，不要重复计划。完整新投影只有不带 ID 的 read_graph 或冲突返回的 current_view 才推进你实际已读的快照，程序不会替你承认新观测。complete 要结论化/放弃全部未关闭 Step、解释目标达成或停止理由，不能同时创建新任务；coverage 必须覆盖视图中的全部 coverage_surfaces（tested 带 evidence_ids，waived 带 reason，na 说明不适用），漏项会被服务端拒绝。视图里的 open leads 必须用新 Step 的 lead_ids 落实，或在 lead_dispositions 用 step_id 挂到已有 Step，或用 waiver_reason 说明不追究；有 open lead 时 complete 会被拒绝。人工 Hint 只有人工能确认关闭，hint_notes 只是建议。可以在还有审核时结束搜索；普通 pass 不唤醒规划，审核完成后自动交付。新观测、负面审核或 planning_issues 要重判；needs_evidence 可披露缺口并停止，不要求无限复测。你根据 goal、已有证据、未解决问题和剩余工作的价值自主评估是否完成，不按项目类型或漏洞数量决定结束。人工打回说明必须回应，人工指定重测先执行再复审，使用原 Finding ID。返回 {} 表示等待。`;
  if (job.kind === "review")
    return `${common}

${reviewImpactPolicy}
CVSS 向量必须完整包含全部 11 个 Base 指标：AV、AC、AT、PR、UI、VC、VI、VA、SC、SI、SA。AT 是攻击前置条件指标，不能省略；依据已有证据判断取值，不默认补成 N。数量和字段核对也遵循上述原始证据规则。
审核当前 Finding 版本及其合并来源，不把旧评级当新证明。read_evidence 读取已有材料，不执行命令、创建 Step/Fact 或请求目标。按 reviewSchema 返回 verdict、kind、具体理由与引用证据；复测需求通过明确的审核问题交 Decide。`;
  return `${common}

你只推进当前 Step，遵守视图中的完整问题、property、子目标和人工 Hint，自主选择测试方法。save_evidence 把项目工作区文件归档为不可变 Evidence 并返回 ID；归档件保留 Step/Run、路径与失败条件；优先结构化工具输出，不把截断终端当全量。工具输出、进程日志和临时结果留在项目文件（/workspace/runs、/workspace/tmp 等），未引用的文件不作为证据。视图中的 Finding 声明、last_summary 与生产 Step 摘要是既有材料，先回读原始证据核对，不能当作本次观测。脚本放 /workspace/scripts，待归档原件放 /workspace/evidence，临时文件放 /workspace/tmp。Fact/Finding 可增量提交；补证和修订使用已有 Finding ID。按 executeSchema 返回 facts、findings、leads 和 summary，说明本次观测、失败与可复用材料；leads 写清 surface/parameter、为什么值得追和建议的可证伪 property，后续方向不要只埋在摘要里。信息类说明适用范围和核查依据；漏洞类填写 impact、reproduction（conditions、steps、expected、observed）与 remediation，明确受损对象、安全边界、已证实后果、可独立执行的复现步骤和针对根因的修复建议，不编造未知条件或影响。原始 HTTP 报文保留换行写入 evidence 或请求步骤；CVSS 由 Review 填写。录制代理会归档本 Step 的 HTTP(S) 请求；query_traffic 列出这些 flow，submit_finding.traffic_ids 引用真正发起该结论的 flow ID（多条按顺序列出）。`;
}
/**
 * Some compatible providers put reasoning in content rather than a separate channel, and
 * GLM-5 can prepend a warning glyph to that block. Discard only complete leading blocks:
 * a JSON example inside reasoning must never become the result, so an unclosed block is an
 * error rather than something to parse around.
 */
function stripLeadingThinking(text: string): string {
  let source = text;
  for (;;) {
    const open = /^[^{}[\]`]{0,32}<think>/i.exec(source);
    if (!open) return source;
    const end = source.toLowerCase().indexOf("</think>", open[0].length);
    if (end < 0) throw new Error("Model returned incomplete thinking block before JSON");
    source = source.slice(end + "</think>".length).trim();
  }
}
/**
 * A single terminal fenced block is still the model's envelope when it adds explanatory prose,
 * as GLM-5 does for repair answers. The fence must close the text and must be the only one, so
 * an example block earlier in the prose is never selected as the result.
 */
function terminalFencedBody(source: string): string | undefined {
  const open = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n/.exec(source);
  if (!open) return undefined;
  const close = source.indexOf("```", open.index + open[0].length);
  if (close < 0 || source.slice(close + 3).trim() || source.slice(0, open.index).includes("```")) return undefined;
  const language = (open[1] ?? "").toLowerCase();
  return language && language !== "json" ? undefined : source.slice(open.index + open[0].length, close).trim();
}
export function parseModelJson(text: string): Record<string, unknown> {
  let source = stripLeadingThinking(text.trim());
  if (source.startsWith("```")) {
    const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(source);
    if (!fence) throw new Error("Model returned no valid JSON result: incomplete fence");
    source = fence[1].trim();
  } else {
    const body = terminalFencedBody(source);
    if (body !== undefined) source = body;
  }
  if (source.startsWith("[")) throw new Error("Model returned no valid JSON object");
  const start = source.indexOf("{");
  if (start < 0) throw new Error("Model returned no valid JSON result");
  const stack: { bracket: string; keys: Set<string> }[] = [];
  let end = -1;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      const quotedStart = i++;
      let escaped = false;
      for (; i < source.length; i++) {
        if (escaped) escaped = false;
        else if (source[i] === "\\") escaped = true;
        else if (source[i] === '"') break;
      }
      if (i >= source.length) break;
      if (stack.at(-1)?.bracket === "{" && /^\s*:/.test(source.slice(i + 1))) {
        const key = JSON.parse(source.slice(quotedStart, i + 1));
        const keys = stack.at(-1)!.keys;
        if (keys.has(key)) throw new Error("Model returned duplicate JSON object keys");
        keys.add(key);
      }
    } else if (c === "{" || c === "[") stack.push({ bracket: c, keys: new Set() });
    else if (c === "}" || c === "]") {
      if (stack.pop()?.bracket !== (c === "}" ? "{" : "[")) break;
      if (!stack.length) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0 || /[{}\[\]`]/.test(source.slice(end)))
    throw new Error("Model returned no valid JSON result: incomplete or ambiguous envelope");
  try {
    const parsed = JSON.parse(source.slice(start, end));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error("Model returned no valid JSON result");
  }
}
