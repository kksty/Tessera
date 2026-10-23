import { createHash } from "node:crypto";

// A small, versioned corpus ships with the runner. It never reads arbitrary host files or fetches URLs.
const references = [
  { id: "tool-artifacts", title: "工具输出、原始材料与证据引用", content: `工具输出是待核对的原始材料，告警不自动成为已确认 Finding。
目标请求仅限 Execute 与当前已批准资产；查阅资料不授予执行权限。
优先将工具原始机器可读输出写入 /workspace；保留精确命令、执行位置、输入条件、工具错误和输出路径。不要为了适配工具重跑已经完成的目标操作。
Execute 用已有文件和 shell 工具按需检索已有输出；超长记录可用 read_workspace 按字符分页回读。保留原文件路径、行号及版本，不把摘录当全文。解析失败不猜补、不作为阴性结果。收尾/恢复只允许既有的有界读取工具。
用 save_evidence 归档原始文件，引用返回的 Evidence ID。路径、行号、记录索引及哈希只是定位信息，不能替代 Evidence ID。原始工具告警仍需验证影响、条件和证据链，由独立 Review 判断。
大型输出先按问题检索、分批核对，再读取必要原文；不要把全部输出搬进模型上下文。已有 HTTP/流量采集与 Evidence 保持复用，工具适配不另建事实库。` },
  { id: "memory-navigation", title: "历史回读、书签与当前状态", content: `项目记录与工作区保存跨任务材料；列表和书签只用于导航。
query_graph 查全部历史，包括未标记、已撤书签和早期记录；翻页沿用筛选与 next_cursor，要按当前状态重查就 refresh=true 且不带旧游标。read_graph 按 id 与字符偏移读记录，后续页传 expected_hash 检测修订。
书签记录已有记录 id、关注理由和回访条件，用 mark_node 创建、更新或撤销；首次 expected_version=0，之后先回读当前版本，避免覆盖其他 Worker 的更新。书签不授予授权、不改变任务优先级，也不证明结论成立。
阅读顺序：索引/摘要 → 原记录与来源事实 → 必要原始 Evidence → 新判断。争议、审核状态和资产当前授权以最新记录为准；不能因某条没被标记就忽略，也不能因工具返回不完整就认定目标完成。
本资料是参考规则，不是项目观测或原始证据，不能作为 Fact/Finding 的依据引用。` },
] as const;

export function queryReferences(keyword = "") {
  const q = keyword.toLocaleLowerCase();
  return { kind: "reference_index", evidence: false, items: references.filter(r =>
    `${r.id} ${r.title} ${r.content}`.toLocaleLowerCase().includes(q)).map(({ id, title, content }) =>
    ({ id, title, total_chars: content.length, reference_hash: hash(content) })) };
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export function readReference(id: string, offset = 0, limit = 4000, expectedHash?: string) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 4000)
    throw new Error("Invalid reference offset/limit");
  const record = references.find(r => r.id === id);
  if (!record) throw new Error("Reference not found; use query_references");
  const reference_hash = hash(record.content);
  if (expectedHash && expectedHash !== reference_hash) throw new Error("Reference changed; restart at offset 0");
  return { kind: "reference", evidence: false, id, title: record.title, reference_hash, offset,
    total_chars: record.content.length, content: record.content.slice(offset, offset + limit),
    next_offset: offset + limit < record.content.length ? offset + limit : null };
}
