# Swarm 模式设计（平等执行者）

本文是蜂群架构的设计锚点。蜂群架构与决策者架构是**并行**的两种任务架构，不是新旧或升级关系：蜂群 **无决策者、无 Step、一个或多个平等 peer 执行者自主定向、互相通信、自主裂变与退出**，同时完整复用现有 FGS 图、证据链、独立审核、报告与 UI 框架。创建时选定 `project.mode`（决策者架构默认 `classic` / 蜂群 `swarm`），持久不可变，中途不可切换；蜂群开单必须显式写 `mode: "swarm"`。项目创建时只有一个初始 peer，不裂变时就是单 peer 连续 Agent；完整定位与选择建议见 [两种并行架构](architectures.md)。

## 定位：黑板不是控制面

swarm 中黑板（FGS 图）是**共享记忆与质量基座，不是执行前提**。执行协调走"消息 + 自主读图"；没有任何组件读图决定谁干什么。peer 的写义务：观测落 Fact、结论落 Finding、证据落 Evidence——否则审核、报告与 UI 无从谈起。Step 机制在 swarm 中完全不存在；Lead 由广播消息替代（v1 不提供 Lead 工具）。完成时也不合成 classic 的“完成任务”Step：覆盖表与审核问题处置保存在 `project.completion`。

负向结论必须带边界：`not_observed` 除 `request`/`parameter_sources` 外还要写 `negative_scope`（attempted / not_tested / confidence）。一次未观测只证明该范围内没有结果，不能写成"已证伪/已穷尽"；其他 peer 读到的是一条有范围的观测，不是一个不可复核的全局判决。

## 与 nexora 的协议映射

移植的是协议而非代码（nexora engine.ts 与 dsh 强绑，不搬）：

| nexora                            | Tessera swarm                                                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WorkRecord（`dsh` 进程）          | `Peer` 图记录 + 持久 Pi 会话（`sessions/peers/<peer>.jsonl`），回合制运行                                                                                   |
| spawn/retire 工具                 | `spawn_peer` / `retire_peer` 工具 → 服务端校验 + 系统消息                                                                                                   |
| peer_send/peer_inbox + 投递状态   | `project_messages` 表；`to_peer` 空 = 广播；投递 = 回合开始时进入 prompt（`seen_message_seq` 推进即"已进入上下文"）                                         |
| RoundRecord + sharedStateVersion  | `SwarmRound` 图记录；`revision`（图版本）+ `message_seq`（消息水位）+ 参与者集合三者任一变化即失效                                                          |
| 活动阻塞（工具/PTY 未结算）       | 在途 peer Run 阻塞；长命令未结束阻塞（复用 ProcessSessions 检查）；未读消息阻塞                                                                             |
| completion_propose/respond/commit | `propose_completion`（带覆盖表，复用 coverage.ts 校验）→ 全员 agree → 置 `pending_completion`（搜索结束、审核中）→ 现有 finalizeCompletion 在审核清零后完成 |
| request_id 幂等回执               | 复用 `commit()` / `platform_receipts` 原键重放                                                                                                              |
| state.json 单写入者               | 复用 `Store.mutate()` 事务                                                                                                                                  |

## 数据模型

**图集合新增两个**（低频、是共享状态，变化应推进 revision 并唤醒 peer）：

```ts
Peer { id, graph_id, origin: "initial"|"spawn"|"operator", parent_peer_id?, spawn_reason?,
  direction?, status: "active"|"retired", created_at, retired_at?, retire_reason? }
SwarmRound { id, graph_id, proposer_peer_id, reason?, revision, message_seq,
  peer_ids: string[], opinions: Record<peerId,{opinion:"agree"|"disagree"|"unsure",note?,at}>,
  status: "open"|"committed"|"invalidated", created_at, closed_at?, close_reason?,
  coverage?: CoverageEntry[], review_issues?: ReviewIssueDisposition[] }
```

`Project.mode?: "classic"|"swarm"`（缺省决策者架构，持久化值为 `classic`，旧项目无感）。`Project.completion?: CompletionRecord` 只在 swarm 完成时写入；classic 的同一份记录仍写在合成的完成任务 Step 上，两者字段一致。

**易变协调状态不进图**（避免心跳/已读水位推进 revision 造成全员唤醒风暴），两张新表：

```sql
project_peer_state(project_id, peer_id, wake, seen_revision, seen_message_seq,
  turn_start_revision, turn_start_message_seq, turns, last_turn_at, summary,
  PRIMARY KEY(project_id, peer_id));
project_messages(project_id, seq, id, from_peer, to_peer, kind, body, refs,
  created_at, PRIMARY KEY(project_id, seq));
```

- `wake`: `ready`（下回合立即可领取）| `waiting`（仅新消息/图变化/新轮次唤醒）| `stuck`（连续业务失败被自动停下，需操作员手动重试）。
- peer 回合租约复用 `platform_runs`（`kind="peer"`, `node_id=peer_id`）+ Peer 不写 worker 字段；活跃判定查 runs 表。
- 消息/共识事件写 `platform_events`（kind `peer.message`/`peer.spawn`/`round.*`），复用 SSE changeToken 刷新 UI。

## 调度（Store.claim 的 swarm 分支）

mode=swarm 时：跳过 Decide 分支；Review 调度不变；Step 分支天然为空。peer 回合领取条件（按 `last_turn_at` 升序公平轮转，受 `max_project_workers` 限制）：

1. peer.status === "active" 且该 peer 无 running 状态的 Run；
2. 满足任一唤醒条件：`wake==="ready"`；或有发给它的未读消息（收件箱里 `seq > seen_message_seq`，排除自己发出的广播）；或 `seen_revision < g.revision`（其他 peer 的写入）；或有待其表态的有效 open round。
   - turn-end 时 `seen_message_seq` 取回合开始冻结值（回合中到达的消息下回合再投递一次，至少一次）；`seen_revision` 取回合结束的当前图版本，避免本回合自己的写入立刻把自己再唤醒；`last_turn_at` 在回合结束时更新，停滞宽限期从此计算。

## 共识与完成

- 任一 active peer `propose_completion{reason, coverage, review_issues}`：服务端校验覆盖表（每个 Facts 推导的 host+path 必须 tested/waived/na）与当前 Review 问题处置（`addressed` 引用审核之后保存的新证据，`waived` 写理由；风险标签只是提示，不需要人工审批），创建 open round（快照 revision/message_seq/active peer 集合）。
- `respond_completion{round_id, opinion, note?}`：仅 round 有效（revision/message_seq/参与者集合未变）时可表态；任何图变化、消息发送、peer 加入/退出使 open round 失效（评估时比较即知，无需主动标记）。
- 每次 `mutate` 与消息写入后评估提交条件：round open 且有效 + 全员 agree + 无 running peer Run + 无未读消息 → 置 `project.pending_completion`（搜索结束、审核中），后续审核清零由现有 finalizeCompletion 完成项目。沉默 ≠ 同意；全体退出 → 参与者为空 → 永不完成，需人工介入（重开/停止）。某 peer 被置 `stuck` 时同样无法表态，需操作员重试或让其退休后才能完成。
- 审核门槛完整保留：Finding 仍需 Review pass（或信息类免审）才入漏洞库/报告；`planning_issues` 逐条 addressed/waived 处置即可，没有“只能人工豁免”的类别。
- swarm 完成不合成 classic 的“完成任务”Step：覆盖表、审核问题处置与 `observation_revision` 写入 `project.completion`，网页与报告从项目记录读取。人工 Hint 不阻塞共识（peer 入口仍能看到）；人工重测也不建 Step，而是投递一条 `kind=system` 消息给执行者，并同样要求在 Review 之后保存新证据。

## 失败处理与消息保留

- 失败按执行者分桶：`job_failures["peer:<peer_id>"]` 只累计该 peer 的连续业务失败（模型/基础设施失败不计入）。单个 peer 连续 3 次业务失败后被置为 `wake="stuck"` 并写 `peer.stuck` 事件，**不会暂停整个 swarm**；其余 peer 继续工作。
- 操作员可在「执行者」页对 stuck peer 点「重试」，调用 `POST /api/projects/:id/fgs/peers/:peer/retry`（body `{confirmed:true}`）：清空该 peer 的失败计数、恢复 `wake="ready"`、把最近一次失败的 Run 标为已处理。项目必须处于 active；已退休的 peer 只能另 spawn 替代，不能复活。
- 所有 peer 退休后，操作员可通过执行者页补位（`POST /api/projects/:id/fgs/peers/replacement`），在岗或仍有在途 peer 回合时拒绝。所有在岗 peer 已等待五分钟且没有到期工作时，执行者页提示停滞并允许人工重试；不自动解除 stuck 或反复唤醒。
- 执行者被停下、全员退出或全员停滞与 classic 的待人工事项共用同一套飞书通知（`notify_needs_human`），不会因为架构不同而只在网页提示、漏发消息。
- 消息日志有界保留：每次发消息与回合结束时，删除所有在岗 peer 都已确认投递（`seq ≤ seen_message_seq`）且超出最近 N 条（默认 5000，`TESSERA_SWARM_MESSAGE_KEEP` 可调，至少保留 1 条）的旧消息；运营时间线尾部与任何未投递消息都不会被删除。`project_peer_state` 中图里已不存在 peer 的行也会被清理。
- 新的 `handoff` 消息必须在 `refs` 引用至少一条存在且未删除的非 origin Fact 或 Evidence；`spawn_peer` 的 `start_message` 同样使用 `start_refs`。没有现成观测时可用 question/notice；历史消息仍可读取。引用能定位材料，不能自动证明内容或不确定性完整。

## Runner（kind="peer"）

- 持久会话：`SessionManager` 打开/创建 `sessions/peers/<peer_id>.jsonl`，跨回合恢复（复用现有恢复机制）。
- 回合结构：初始 prompt 注入（目标、Hint、身份、同伴列表、收件箱、自 seen_revision 以来的图变化摘要）→ 自由工作 → 终局 JSON `peerTurnSchema {wake, direction?, summary}` → `POST /peers/:peer/turn-end` 推进 seen 水位。
- 工具 = Execute 工具面（bash/read/write/edit/grep/find/ls、submit_fact/submit_finding/save_evidence/discover_assets/query_traffic、read_graph/query_graph/read_evidence，全部走无 Step 变体端点）+ swarm 工具（send_message/read_inbox/list_peers/spawn_peer/retire_peer/propose_completion/respond_completion）。
- 流量录制：peer 回合与 execute 同等待遇（traffic-launch 放行 kind=peer）。

## UI

- 创建项目可选模式（默认决策者架构），项目徽章标注。
- swarm 项目新增「执行者」页（peer 列表/状态/方向/裂变血缘/回合数）与「消息」页（时间线 + 共识轮次状态）；隐藏 Step 中心视图（任务页改为回合运行记录）。
- Board/时间线/发现/审核/证据/流量/报告原样复用（swarm 图无 Step 节点）。

## 备份

- 项目 ZIP 备份（bundle）在 `graph.json` 中携带 `peers`/`rounds`，并新增 `messages` / `peer-state` 分节；导入后执行者、消息与回合水位都保留。旧备份缺少这些分节时按空处理。

## 明确不做（v1）

- 不引入 dsh / nexora engine 代码；不做长驻容器 daemon。
- Lead、Step、Decide 工具在 swarm 不出现；消息不做逐收件人投递回执（seen_message_seq 足够）。
- 裂变无数量/深度上限（并发上限由 max_project_workers 控制，与 nexora 哲学一致）。
