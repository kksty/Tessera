import type { Graph, Job } from "../../protocol/src/index.js";
import {
  decideSchema,
  executeSchema,
  reviewSchema,
  submitDecisionsBase,
  peerTurnSchema,
} from "../../protocol/src/index.js";
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
        : job.kind === "peer"
          ? peerTurnSchema.omit({ worker: true, seen_message_seq: true })
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
  "所有漏洞类别遵循同一证据原则：Fact 保存有条件的观测、反证和失败；Finding 保存有独立交付价值的结论。kind=vulnerability 要证明前提、安全边界与实际影响，不能仅凭异常、名称、指纹、加固缺口或猜测的后续攻击链推导漏洞。同根因只保留一条 Finding：入口或参数不同但根因与修复相同（如同一控制器一批参数名反射端点）合并成一条，把端点清单写进正文，不为数量拆条。kind=informational 记录背景，可通过审核但并不代表交付进度，不要求漏洞影响或 CVSS；普通响应和失败按问题需要留在 Fact。kind=null 表示待分类。按项目 goal 和 Hint 判断交付范围，不为数量制造结论。";
export const findingEvidencePolicy =
  "数量、字段和脱敏状态必须回到完整原始证据核对。区分记录数、出现次数和去重后的值数量，重叠分页不能相加；只读过片段时不能声称全量统计，按 next_offset 或 More evidence 继续读取。可执行任务用针对性解析脚本统计并保存统计方法与结果；Decide/Review 仅回读已有材料，不执行脚本。完整号码、部分掩码和空字段分别说明；description、impact、reproduction.observed 和定级理由中的数量保持一致。发现数量冲突或字段遗漏时用原 ID 修订，不能只把修正在审核理由里。负向观测（status=not_observed）必须写 request 与 parameter_sources：每个请求参数名单独一条，parameter 与 URL 解码后的参数名逐字一致（参数名可以包含 = 和引号），source 写页面 JS/AJAX/meta/表单/构造并附证据 ID；status=observed 的事实即使正文含否定对照，字段缺口写 planning_issues，不阻断 pass。";
export const reviewImpactPolicy =
  "仅审核已有原始证据，不复测目标。通过时明确 kind：informational 不填写危险度或 CVSS；vulnerability 给 CVSS v4.0 Base vector 与 rationale，程序计算正分。漏洞 pass 前确认 Finding 的 impact、reproduction.steps、remediation 均完整，影响、复现与修复建议足以让读者独立复核；缺项或内容不足时返回 needs_evidence，在理由中逐项说明缺口，交 Decide 用 finding_updates 补写后复审，不在审核理由中代填正文。每个非 N 的 VC/VI/VA/SC/SI/SA 必须有 impact_evidence，说明受损对象、应有安全边界、已证明的后果及所引用证据；推测的影响不能计分。证据闭合则 pass，核心缺口 needs_evidence，声明被反驳 rejected；只有明确被反证的源观测才 disputed，不能争议 origin。需要后续行动的问题交给 Decide，pass 中的新问题明确写 planning_issues。复审只核对本版本新增或变化的证据与字段，不重复要求上一轮已核对且未变化的内容；所有阻断项一次列全，同一事实的同一字段缺口只算一项。";
export const discoveryScopePolicy =
  "只测试当前 approval=approved 的资产；业务相关、证书或外链不等于目标所有权。判断相关的主机可提交为待批准资产（pending），由人工确认归属并批准；批准前不规划、不向它请求。";

/**
 * The model sees full graph nodes (Fact/Finding/Review records) in the
 * projection, and without the exact final-result keys it mirrors those node
 * shapes into its final JSON. Every such mismatch costs a full repair request
 * with the whole context; stating the contract up front is cheap.
 */
export const executeResultShape =
  "最终 JSON 形状（键名严格；多出的键或图节点原样字段会被拒绝）：" +
  '{"summary":"...","facts":[{"description":"...","conclusion":"...","status":"observed|not_observed|disputed","objects":["https://..."],"evidence_ids":["e001"]}],"findings":[{"kind":"vulnerability|informational","title":"...","description":"...","impact":"...","reproduction":{"conditions":["..."],"steps":["..."],"expected":"...","observed":"..."},"remediation":"...","evidence_ids":["e001"],"from":["f001"]}],"leads":[{"surface":"...","parameter":"...","why":"...","suggested_property":"...","evidence_ids":["e001"]}]}。' +
  "只有 status=not_observed 的事实才加 request{method,url} 与 parameter_sources[{parameter,source,evidence_ids}]（每个 URL 参数一条）；observed/disputed 不要写这两个键，省下的上下文留给后续判断。" +
  "facts 的元素可以是字符串，但对象只能含 description/conclusion/status/objects/request/parameter_sources/evidence_ids，不能带 id、version、source、review_status、created_at 等图节点字段；findings 用 title/description，不是 summary/change/version；leads 用 suggested_property，不是 property/title/constraint。" +
  "submit_fact 同样不接受 from（来源写 evidence_ids）；submit_finding 不填 cvss（由 Review 定级）。" +
  "提交前先 process list：仍在运行的命令要么 poll 到结束，要么 stop；提交时仍有运行中的进程，本次 Step 不记为完成。";
export const reviewResultShape =
  "最终 JSON 形状（键名严格；多出的键或图节点原样字段会被拒绝）：" +
  '{"verdict":"pass|needs_evidence|rejected","kind":"vulnerability|informational","reason":"...","evidence_ids":["e001"],"disputed_fact_ids":[],"verification":"...","planning_issues":["..."],"severity":"critical|high|medium|low|informational","severity_reason":"...","cvss":{"vector":"CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:A/VC:N/VI:N/VA:N/SC:L/SI:L/SA:N","rationale":"...","impact_evidence":[{"metric":"SC","affected":"...","boundary":"...","consequence":"...","evidence_ids":["e001"]}]}}。' +
  "reason 是审核结论正文（不要用 summary/verified_points/gaps/review_questions 代替）；cvss 只含 vector/rationale/impact_evidence，不要带 version/score；不要返回 source、id、finding_id、created_at、severity_before_review 等图节点字段。informational 通过时不写 severity 和 cvss。";

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
共享状态来自当前图和工作区；新 Run 不依赖上一会话的隐藏记忆。Fact 写完整 conclusion（≤120字）和 observed/not_observed/disputed；失败或未观测不是目标安全的证明。负面结论必须写 request（method/url）、parameter_sources（每个参数值来自页面 JS、AJAX、meta、表单还是猜测，并附证据 ID）和 negative_scope（attempted 试过什么、not_tested 没覆盖什么、confidence=low/medium/high）；单次请求只能支持“本次未观测”，不能写成“已证伪/已穷尽”。缺范围或溯源时服务端直接拒绝这次提交，不等审核再退回。objects 记录实际观察或测试到的 host/path（写成绝对 URL 或 /path），完成覆盖表按这些 surface 核对。from 只放 Fact ID，原始 Evidence ID 放 evidence_ids。引用证据前读取原文；参考资料和 Hint 不是观测或执行许可。query_graph 与 read_graph 可查当前记录或历史，sources/outputs 是记录之间的因果边。被删来源只返回标记，显式历史不会恢复节点或变成新证据。
当前视图：
${JSON.stringify(view)}`;
  if (job.kind === "decide")
    return `${common}

你负责规划与取舍，不测试目标。先判断一个问题值不值得回答，再看成本；成本是约束，不是目标。step_costs 只用来识别异常消耗——追加投入前先问「再做一轮会不会改变任何结论」。

预算与颗粒度（视图 limits 给出真实值，0 表示不限）：
- 本轮可新增的 Step 数、在途上限见视图 limits（0 表示不限）。接近上限时优先保留高价值问题；可以在同一次提交里 closes/discard 低价值未开始 Step 为新问题腾位，但不要为了腾位关掉仍值得回答的问题。
- 一个 Step 只回答一个问题：description 用一两句话说清问题和它的决策价值（成立会怎样、被证伪会怎样），不写请求脚本、次数预算、逐条命令或哈希清单——方法是执行者的事；method_hint 只给一句可选建议。每个新 Step 写一句可证伪的 property（例如「未授权用户不能读取其他 metadataId 的信件」）。${testDomainGuidance}
- 服务端会把与未关闭 Step 高度相似的新 Step 合并到已有 Step；未开始的 Step 用 updates 原位改写 description/property/method_hint/from。执行结束仍需 closes 结论化或 discard 放弃。
- 多步利用链只在步骤有真实前置时使用：给同批新 Step 写 key（短标识），后继 Step 用 depends_on 引用这些 key 或已有 Step ID。一个链 2–5 步，每一步的 property 写清「上一步必须产出什么前提」；依赖未满足的 Step 不会被领取，前置被证伪或放弃时用 discard 结束后继，不要留下悬空链。并行枚举、同层探测不要串成链。
- 修正已有 Fact 的措辞、统计或 request/parameter_sources 用 revise_fact 原地修订，不为「只读核对 / 生成 successor 事实」开 Step；只有需要向目标发起新请求、或需要重新作出的判断才开 Step。
- 负向 Fact 的 negative_scope 是判断边界：not_observed 只证明尝试范围内未观测，不等于方向已穷尽。只有要声称「已穷尽」时才必须先扩大覆盖（新 Step 或 revise_fact 补范围）；若该方向不在本轮交付范围，可以在 closes/discard 的 reason 写「未扩面，维持现有边界」后直接关闭，报告按 not_tested 表述。
- leads 是执行者留下的候选问题，不阻塞完成：值得追的用新 Step 的 lead_ids 落实（受预算约束），不值得的在 lead_dispositions 写 waiver_reason，其余可以留着。
- 同根因只保留一条 Finding：入口/参数不同但根因与修复相同（如同一控制器一批参数名反射端点）合并成一条，端点清单写进正文；informational 是背景记录，不计入交付进度，目标是否达成按漏洞结论与已回答的问题判断。
人工 Hint 必须由 Step 的 hint_ids 落实，或用 hint_notes 写明如何落实；不能把 Hint 当证据。带说明的 hint_notes 会关闭该 Hint。review_issues 必须逐条处置：addressed 指向审核之后执行并关闭的 Step，waived 写理由；风险标签只是给审核和界面看的提示，不需要人工审批。复审 needs_evidence 的阻断项要在同一次 finding_updates 里处理；已 pass 的 Finding 只有结论、影响、定级或复现变化才修订。
human_feedback 的 return/retest 按工具契约处理；旧证据不能直接恢复入库；删除的漏洞不要换 ID 重建。
用 submit_decisions 提交。Step 改动带 expected_version；结算冲突读 current_view 只重交剩余字段（运行时复用 plan_id）。大结算按工具提示分 more 批，运行时会自动拆超大载荷。complete 前结论化/放弃所有未关闭 Step，coverage 覆盖 coverage_surfaces，open leads 用 lead_ids 落实或 waiver，Hint 用 hint_ids/hint_notes，review_issues 逐条 addressed/waived。coverage 的 na 用于仅被 Fact 提及、从未实际请求或不适用的 surface，reason 写明依据；仅被提及的 URL 不必为确认命名等价性单开 Step，按未请求记 na 并在报告说明边界，只有实际请求并取得证据的 surface 才标 tested。可以带审核结束搜索；新观测、负面审核或 planning_issues 要重判。返回 {} 表示等待。`;
  if (job.kind === "review")
    return `${common}

${reviewImpactPolicy}
CVSS 向量必须完整包含全部 11 个 Base 指标：AV、AC、AT、PR、UI、VC、VI、VA、SC、SI、SA。AT 是攻击前置条件指标，不能省略；依据已有证据判断取值，不默认补成 N。数量和字段核对也遵循上述原始证据规则。
审核当前 Finding 版本及其合并来源，不把旧评级当新证明。read_evidence 读取已有材料，不执行命令、创建 Step/Fact 或请求目标。按 reviewSchema 返回 verdict、kind、具体理由与引用证据；复测需求通过明确的审核问题交 Decide。只有 status=not_observed 的来源事实需要 request/parameter_sources，且 negative_scope 说明结论边界——单次未观测不能当作方向穷尽。observed 事实的字段缺口写 planning_issues，不据此判 needs_evidence。parameter 与 URL 解码后的参数名逐字匹配，名称可以包含 = 和引号，不要按 = 截断；同一事实的同一字段缺口只算一项。视图 reviews 已给出该 Finding 的历史审核：已有多轮 needs_evidence 时，除核心证据缺口外，其余字段或表述问题一律写 planning_issues，不要因同一事实的同一字段再次打回。
${reviewResultShape}`;
  if (job.kind === "peer")
    return `${common}

你是这个 swarm 任务中一名**平等的执行者**：没有决策者，也没有预先编排的 Step 队列。你和同伴各自决定方向、方法、是否继续；通过 send_message/read_inbox/list_peers 与同伴协作，用 spawn_peer 裂变出新执行者并行探索值得追的方向（parent 只是血缘，不产生指挥权；无数量或深度上限），用 retire_peer 退出（退出不等于完成）。
共享状态就是这张图：把观测写进 submit_fact（conclusion ≤120 字，objects 或 request.url 记录实际 host/path；相对路径会被归到原点主机，多资产测试请用绝对 URL 或带已批准资产的 asset_id；负面结论必须写 request、parameter_sources 与 negative_scope（attempted/not_tested/confidence）并附证据；单次未观测不等于方向已穷尽），把结论写进 submit_finding，把原件用 save_evidence 归档为不可变证据。先看视图里的 shared 与 inbox，避免重复；需要更多原文用 read_graph / query_graph / read_evidence；重复探测前可用 search_worker_traces 查其他 Run 的工具过程，命中只是线索，不是证据。工作区是 /workspace，脚本放 /workspace/scripts，临时文件放 /workspace/tmp，待归档原件放 /workspace/evidence。
交接时引用相关 Fact 和证据 ID，并说明未验证的假设和下一步；交接消息与范围摘要可能被截断，重要判断先用 read_graph/read_evidence 回读原文，不能把缺失的未覆盖范围当作没有缺口。
当你有把握认为探索已充分时，用 propose_completion 发起完成共识：提交覆盖表（覆盖全部已观测 host+path：tested 带 evidence_ids、waived 带 reason、na 表示不适用），并逐条处置视图里 review_issues 列出的当前审核问题——addressed 必须引用审核之后保存的新原始证据（swarm 没有 Step），waived 写理由；风险标签只是显示用的提示，不需要人工审批。收到同伴的轮次后用 respond_completion 表态 agree / disagree / unsure——沉默不等于同意；任何新的观测、发现或消息都会让旧轮次失效。全体在岗执行者同意、且没有人还有未读消息或未结束回合时，项目才进入审核收尾。
每一回合都要以最终 JSON 结束，只返回一个 JSON 对象：{"wake":"ready"|"waiting","direction":"你当前的方向(可选)","summary":"本回合做了什么(可选)"}。wake=ready 表示你还有明确的下一步、想立即继续下一回合；waiting 表示暂时无事可做，等新消息/新图变化/新共识轮次再被唤醒。不要返回空回复。`;
  return `${common}

你只推进当前 Step，遵守视图中的完整问题、property、子目标和人工 Hint，自主选择测试方法。description 是要回答的问题，不是脚本：方法、次数与命令都由你决定，property 是判定标准。save_evidence 把项目工作区文件归档为不可变 Evidence 并返回 ID；归档件保留 Step/Run、路径与失败条件；优先结构化工具输出，不把截断终端当全量。工具输出、进程日志和临时结果留在项目文件（/workspace/runs、/workspace/tmp 等），未引用的文件不作为证据。视图中的 Finding 声明、last_summary 与生产 Step 摘要是既有材料，先回读原始证据核对，不能当作本次观测。脚本放 /workspace/scripts，待归档原件放 /workspace/evidence，临时文件放 /workspace/tmp。重复探测同一 surface 前，可先用 search_worker_traces 查本任务此前 Run 的工具调用；命中只是过程线索，必须回读原件或重新复现后才能写成 Fact，get_worker_trace 可取单次调用的完整参数与结果。Fact/Finding 可增量提交；修正已有 Fact 的措辞、统计或 request/parameter_sources 用 revise_fact（原地改写，不新建任务），补证和修订 Finding 使用已有 Finding ID。按 executeSchema 返回 facts、findings、leads 和 summary，说明本次观测、失败与可复用材料；leads 只在答案会改变后续决策时提交，写清 surface/parameter、为什么值得追和建议的可证伪 property，后续方向不要只埋在摘要里。信息类说明适用范围和核查依据；漏洞类填写 impact、reproduction（conditions、steps、expected、observed）与 remediation，明确受损对象、安全边界、已证实后果、可独立执行的复现步骤和针对根因的修复建议，不编造未知条件或影响。原始 HTTP 报文保留换行写入 evidence 或请求步骤；CVSS 由 Review 填写。录制代理会归档本 Step 的 HTTP(S) 请求；query_traffic 列出这些 flow，submit_finding.traffic_ids 引用真正发起该结论的 flow ID（多条按顺序列出）。认证测试用 auth_profile：save 命名 profile，request 提交注册/登录并 capture_cookies=true，再 request 认证后接口；profile 与 Cookie 存在 /workspace/auth，不进入证据，一个账号/角色一个 profile。
${executeResultShape}`;
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
