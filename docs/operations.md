# 运行、数据归档与升级

## 模型凭据边界

长期模型 API Key 只在 Server 的配置和运行快照中使用，调度配置接口也不再返回长期密钥。Dispatcher 收到的任务附带已剥离长期密钥的 Worker 配置，容器仅收到项目 token 和绑定单次 Run 的模型代理凭据。代理从服务端保存的 Run 快照选择模型、地址和长期密钥，不接受客户端指定上游；运行结束、租约失效或项目停止后拒绝新的模型请求。修改模型设置只影响后续 Run。

Runner 保留供应商端点与认证模式的非秘密元数据，让 Pi 正常选择协议、请求字段和压缩行为；实际 HTTP 调用通过异步上下文转发至 Server。三种协议、Anthropic beta/OAuth、GLM 非流式结果修复、普通轮次和会话压缩共用此传输边界。代理保留经过脱敏的供应商错误结构，避免破坏上下文溢出和供应商回退判断；JSON/SSE 字符串值中的上游密钥在响应边界脱敏。

Shell 和看门狗使用显式环境白名单，只传递路径、语言、代理及 CA 等运行环境。Worker 的流量采集配置和 `/proc` 中仍可能看到项目或 Run 凭据，但其中不再有全局模型密钥。项目 token 能访问本项目数据；Worker 的 root、网络权限和真实出口仍不构成多租户隔离。

升级时执行 `git pull` 后用 `docker compose up -d --build` 按新代码重建镜像，并让旧任务退出后重建旧 Worker。旧容器、采集配置、会话或既有外部备份中已经暴露的长期密钥无法通过此代码补丁撤回，应在供应商处轮换。只读恢复入口使用脱敏的代理配置与 `TESSERA_PROJECT_TOKEN`；不要向 Worker 传入全局 `TESSERA_WORKER_TOKEN`。

## 存储和保留策略

`platform_projects.data` 保存项目头，图中的 Fact、Step、Finding、Evidence 等分别保存在 `platform_graph_records`。未改变的记录不写入；心跳等项目头变化不会重写整个图。兼容的旧 JSON 在下一次写入时事务性拆分；维护任务每轮也会处理一个未运行的兼容旧项目。旧格式版本不会自动升级。

维护任务每五分钟运行，默认保留 90 天热事件、30 天热诊断和 30 天热证据原件，每类每轮最多归档 1000 条。设置如下，`0` 表示该类不自动归档：

| 环境变量                      | 默认值 | 作用                        |
| ----------------------------- | -----: | --------------------------- |
| `TESSERA_EVENT_HOT_DAYS`      |     90 | 非运行项目的旧事件压缩入库  |
| `TESSERA_DIAGNOSTIC_HOT_DAYS` |     30 | 已结束 Run 的旧诊断压缩入库 |
| `TESSERA_EVIDENCE_HOT_DAYS`   |     30 | 非运行项目的旧原件压缩入库  |
| `TESSERA_ARCHIVE_BATCH`       |   1000 | 每类每轮归档条数            |

归档保留序号、原始字节和 SHA-256。事件回放、诊断导出、证据下载、报告及全文索引重建均可读取归档数据。原件先校验、提交归档，再移除散文件；运行中的任务不归档。删除项目会同时清理热数据和归档数据。

这是无损的冷热保留策略，不是磁盘总容量上限。压缩后的历史、Run 幂等回执和项目工作区仍会增长；二进制原件不一定明显缩小。证据页只列出被黑板引用的原件，未引用的工具输出、进程日志和临时文件只留在工作区，不进入证据索引。应监控平台目录与 Worker 工作区容量，按组织要求备份、导出并通过操作员确认流程删除已交付项目。当前不会静默删除仍在引用的证据、旧报告或执行回执，也不会自动清理项目工作区中的会话和脚本。

## 一致性备份和恢复

需要一起备份平台命名卷（`/data`，默认 `tessera-data`）和每个项目的 `/workspace` 命名卷。平台卷包含数据库、WAL、归档原件、runtime 配置和内部凭据，按凭据文件的权限保护备份。在线复制单个 `.db` 文件不能替代 SQLite 一致性备份。

一次完整的维护备份应按以下顺序执行：

1. 暂停项目并等所有 Run 退出，停止 Dispatcher 和 Server 写入。
2. 记录应用与 Worker 镜像版本、平台卷名称和项目卷名称。
3. 在同一个备份代次中复制整个平台卷与所有项目工作区卷，并保存文件校验清单。
4. 在隔离的 Compose 项目中恢复，核对项目数、原件 SHA-256、报告、会话和 outbox，再恢复服务。

备份保留代数和异地存放由部署方确定；未完成隔离恢复演练前不要删除旧代次。应用内删除项目不会删除外部备份或模型服务已经保存的数据。

## 单项目完整备份与恢复

除整卷维护备份外，应用本身支持把**一个项目**打包带走并在另一个实例继续工作：

- 导出：项目页「更多项目操作 → 导出完整备份（含日志）」，或登录后 `GET /api/projects/PROJECT_ID/bundle`，得到 `<项目ID>-bundle.zip`。界面使用两阶段导出：先 `POST /api/projects/PROJECT_ID/bundles` 在服务端打包，返回一次性下载地址 `GET /api/projects/PROJECT_ID/bundles/BUNDLE_ID`（含 `Content-Length`），再由隐藏 iframe 下载。打包较慢或失败时进度和错误留在页面内，不会把工作台导航到 `/bundle`；一次性地址 2 小时后清理，下载一次即删。
- 导入：项目页「导入项目」上传该 ZIP，或 `POST /api/projects/import`（`content-type: application/zip`，请求体为 ZIP）。

ZIP 内包含 `manifest.json`（条目 SHA-256、计数、缺失原件警告）、`graph.json`（全部节点）、`events-*.ndjson`、`diagnostics-*.ndjson`、`runs-*.ndjson`、`run-models-*.ndjson`、`request-usage-*.ndjson`、`receipts-*.ndjson`、`submissions-*.ndjson`、`plans-*.ndjson`、`pools-*.ndjson`、`reports-*.ndjson`、`traffic-*.ndjson`、`traffic-status.json`、`traffic-bodies/*` 与 `evidence/*`。归档过的事件、诊断和证据在导出时解压为可读条目，导入后不需要原数据库即可查看历史。

导入规则：

- 保留原项目 ID；目标实例已有同 ID 项目、墓碑记录或遗留证据目录时拒绝导入，不覆盖现有数据。
- 导入前校验每个条目的清单校验和，以及证据原件的大小与 SHA-256；任一失败都不会写入记录。缺少原件的证据在导出时写入 `manifest.json` 的 `warnings` / `missing_evidence`，导入后该证据仍不可读，其余数据照常恢复。
- 导出时仍在运行的 Run 在导入后标记为 `interrupted`，悬空租约、重试计时和工作区卷前缀被清理；`active` 项目可直接继续领取任务。旧的 `/workspace` 卷不在备份内，新的 Run 会使用目标实例的新工作区，因此中断 Run 的会话不能续跑。
- 导入大小上限由 `TESSERA_IMPORT_MAX_BYTES` 控制（默认 4 GiB），解压后总量上限由 `TESSERA_IMPORT_MAX_UNCOMPRESSED_BYTES` 控制（默认 64 GiB）；临时文件放在 `TESSERA_BUNDLE_TMP` 或平台目录下的 `bundle-tmp/`。导出使用独立只读连接和单一事务快照，导入先完整解包并校验后再写入；两者都是维护操作，期间控制面响应可能变慢。
- 备份是 ZIP32：单个压缩包上限 4 GiB（单条目未压缩上限 2 GiB）。更大的项目请按上面的整卷一致性备份迁移，或先拆分/清理项目证据。

项目级备份不替代上面的整卷一致性备份：它不包含平台设置、模型密钥、登录凭据、其他项目和 Docker 工作区卷。需要连同工作区会话一起迁移时，仍按整卷备份流程处理。

## 数据目录与命名卷

`/data` **始终是 Docker 命名卷**（默认 `tessera-data`），也是唯一形态：没有宿主机目录挂载，也没有额外的覆盖层或迁移脚本。2026-10-26 实测：Windows bind mount（9p/grpc-fuse）下 SQLite 写放大可达 15–90 倍，全图读取 92–160 ms（卷内 6–8 ms），20 MB 提交 6.8 s（卷内 77 ms），长尾会把 `POST /jobs/claim` 推到 40–56 s，并最终造成页级损坏；因此目录模式已删除，不再提供兼容路径。

```powershell
# 首次部署：卷在 Compose 中是 external，先创建一次
docker volume create tessera-data

# 日常启动：compose.yaml 直接使用命名卷
docker compose up -d

# 换用另一个已存在的卷（默认 tessera-data）
TESSERA_DATA_VOLUME=other-data docker compose up -d
```

`TESSERA_DATA_VOLUME` 只决定卷名，不会创建数据。该卷在 Compose 中是 `external`：`docker compose down -v` 也不会删除它。换卷名等于挂载空卷，会生成新的数据库与登录凭据。

排查时直接读卷内容，不要挂回宿主机目录再交给 Server 使用：

```powershell
docker run --rm -v tessera-data:/data alpine sh -c "ls -l /data && du -sh /data"
```

卷内包含数据库、WAL、归档原件、`runtime.json`、登录凭据和内部 token。恢复后可用任意 SQLite 工具对导出的副本执行 `PRAGMA quick_check`，并核对项目数、Run 数与 evidence 文件数。

## 超时预算与失败分类

所有控制面调用的超时集中在 `packages/protocol/src/timeouts.ts`，原则是 **lease > heartbeat 最坏情况 > 服务端 p99.9**，且 commit/usage/diagnostics 不阻塞 Run：

| 项                             |                   默认值 | 说明                                                     |
| ------------------------------ | -----------------------: | -------------------------------------------------------- |
| lease（Decide/Execute/Review） |                    180 s | 死 Worker 最多约 150 s 回收（heartbeat 15 s × 3 + 超时） |
| heartbeat                      |    15 s 间隔 / 45 s 超时 | 连续 3 次失败才放弃 Run                                  |
| claim / release                |              90 s / 30 s | 覆盖控制面长尾，仍小于 lease                             |
| commit                         | 30 s，3 次，退避 0.5/1 s | 覆盖 decisions p99 24.5 s                                |
| usage / diagnostics            |              30 s / 15 s | 先写本地 ndjson，后台串行上传；失败继续重试，不永久关闭  |
| 模型中继                       |                    600 s | `TESSERA_MODEL_TIMEOUT_MS` 可调                          |

`TESSERA_LEASE_SECONDS` 只作为首次初始化 `platform_settings` 的默认值；设置页的 `intent_timeout/reason_timeout` 优先，且不允许低于 30 s。旧库中仍是历史默认值 120/120 时，启动会一次性提升到 180/180（`platform_meta.lease_default_180` 记录该迁移）。

Dispatcher 为每次 claim 生成 `claim_id`。claim 超时或异常时它 fire-and-forget 调用 `POST /api/projects/:id/jobs/claim/:claim_id/cancel`：服务端只中断与该 `worker + claim_id` 匹配且在运行中的 Run，设置 5 s 短退避，不增加 `job_failures`、不产生 `needs_attention`。这样慢 claim 不会留下孤儿租约。

Run 结束时写入 `failure_kind`：

| 类别             | 匹配                                                                                     | 处理                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `model`          | 现有模型错误识别                                                                         | 计入 `model_failures`，按原规则退避并在连续 3 次后暂停                                   |
| `infrastructure` | lease expired、claim abandoned、诊断投递失败、连接 reset/refused、超时（且不是模型错误） | 计入 `infra_failures`，5 s→300 s 退避，**不增加 job_failures、不暂停项目**，到期自动重试 |
| `unknown`        | 其他                                                                                     | 保留 3 次业务失败暂停规则                                                                |

项目上同时记录 `last_failure_kind`、`infra_failures`、`infra_retry_at`；项目页对基础设施故障显示“控制面故障，第 N 次退避重试”，运行记录显示模型/基础设施/目标徽标。execute 已放出外部动作时仍升级为 `needs_attention`（安全属性不变），但不再因此停止整个项目。

已升级为 `needs_attention` 的 Execute 不再计入 `model_failures`：它已经被人工闸门停住，再记一次连击会让“一个阻塞任务 + 两次 Decide 抖动”直接暂停整个项目。未被闸门拦住的 Execute 失败仍照常计数。

运行记录的 `failed` 只是那一次尝试的历史，不代表项目在等人：同一种工作已有更高 `attempt` 时显示“已被第 N 次接管”，项目因连续失败暂停时显示“项目已暂停”，只有 `needs_attention` 才显示“需人工检查”并进入人工重试页。

模型偶尔会以“空回复”结束一轮：只有 `stop`、没有正文也没有工具调用（qwen 的 reasoning-only 输出，或工具参数被拒后模型改用不存在的工具）。这类回合不算任务结果：Runner 会先用与 `result_repairs` 相同的预算追问一次（Decide 的提示会点名 `submit_decisions` 并要求每个 `update` 带 `id`，步骤放进 `steps`），记录 `result_repair` 诊断；只有追问后仍为空才按 `model` 失败退避。

最终 JSON 的修复请求对 GLM-5 与 qwen 系列改用**非流式 + JSON mode**（`response_format: {type:"json_object"}`），由 vLLM 的 guided decoding 保证语法有效，避免长上下文下出现 “I've now prepared my full reasoning…” 这类无法解析的碎片。仍按 `result_repairs` 限制次数（默认 2，可设 0–3），修复后不匹配协议才失败。

如果网关把模型的原生工具调用格式（例如 `</think`、`</parameter`、`</function`、`<|…|>`）当成工具名或参数交给 Pi，Runner 会在该回合结束时记录 `tool_protocol_mismatch` 并以 `tool-call protocol mismatch` 失败，提示检查模型服务的 chat template / tool-call parser；不会再用剩余回合反复尝试 “tool not found”。这属于供应商侧配置问题，换用能输出 OpenAI 工具调用的模型或修正 parser 后即可恢复。

模型配置新增 `disable_thinking`（设置页“关闭模型思考通道”）。开启后，Server 的模型中继会在每次 `openai-completions` 请求里附加 `chat_template_kwargs: { enable_thinking: false }`；vLLM/Qwen 会关闭思考通道，不识别该字段的供应商会忽略。实测该端点的思考内容会以 `reasoning` 返回，长上下文下会混入正文/工具名，因此本部署为 qwen 开启此开关。

实测 2026-10-26 的三次 Decide 失败：11:37 是空回复；13:06–13:21 的三次失败中，37/38 次出现了上述原生控制标记（工具名如 `query </think>`）和退化正文，项目按连续 3 次模型失败停止。恢复项目会重置失败计数，但应先修正模型端点。

## 控制面和阶段指标

Server 默认输出结构化错误日志、鉴权失败和超过 500 ms 的慢请求，包含请求 ID、方法、路由模板、状态和耗时，不记录请求体、查询参数、Cookie 或鉴权头。`TESSERA_LOG_LEVEL` 默认 `info`。操作员可读取 `/api/control-plane/timing` 的请求、事务、事件循环和 `stages`；阶段按 Decide、Execute、Review 分组，包含状态分布、成功率、已知 token 和平均已结束耗时。未知用量保持未知，取消和中断单独列出。

2026-10-20 本地只读核对的历史 Review 为 20 次成功、14 次失败、2 次中断、3 次取消；其中错误记录出现 6 次 422、3 次 502、2 次租约错误。不同时间和分母会得到不同成功率，不能把原报告的 49% 当成固定参数。新增本地语义修复与模拟测试不证明真实供应商的成功率、效果或成本已经改善；需要后续真实运行的阶段统计验证。

## 审核范围与信息类免审

`skip_informational_review` 默认 `false`（`configSchema` 与新建部署一致）。免审会让廉价的加固笔记即时归档、而真正的漏洞还在排队复审，形成错误的进度梯度；因此信息类同样可经过 Review（按 `kind=informational` 快速审核，不打分）。2026-10-29 本部署曾用 `.env` 的 `TESSERA_SKIP_INFORMATIONAL_REVIEW=false` 强制关闭并只读，2026-10-30 取消该覆盖，改回设置页控制（当前值取自 `runtime.json`，默认 `false`，可随时勾选）。部署仍可用 `TESSERA_SKIP_INFORMATIONAL_REVIEW=true|false` 强制该值：设置页随后把该项显示为只读，改回需删除该变量并重建服务。

同时新增规划预算 `TESSERA_MAX_NEW_STEPS_PER_ROUND`（默认 2）与 `TESSERA_MAX_OPEN_STEPS`（默认 8），0 表示不限制。超限的 Decide 计划会被整体拒绝且不写入任何节点；近似重复合并与 `updates` 原位改写不计入。人工建单不受该预算限制。

此前免审的发现不会被自动重审；本部署也**不做**重审。若以后需要重新审核，仍可用显式接口（会保留旧 system Review 与证据）：

- `POST /api/projects/:id/findings/:fid/actions`，`action: "review"`：校验 `expected_version`，清除 `review_exempt`，把 `review_status` 置回 `pending`、`reviewed_version=0`、`status=candidate`；重复调用会因已不免审返回 409。
- `POST /api/projects/:id/findings/review`，`{ finding_ids?: string[], all_exempt?: boolean, creator, reason }`：一次最多 50 条；`all_exempt` 选择当前所有免审条目；项目处于 `stopped`/`completed` 时会自动开启只处理审核的 reaudit 窗口。

## 人工批准发现

“批准”是独立于 Review 的人工结案动作，用于把操作员认可的发现从所有待处理队列中拿掉：

- `POST /api/projects/:id/findings/:fid/approval`，`{ approved: boolean, expected_version, creator, reason? }`。批准写入 `finding.human_approval = { at, by, version, reason? }`；撤销批准清除该字段。
- 批准按版本绑定：任何修订都会产生新版本，必须重新批准。审核已驳回的发现不能批准。
- 批准后：`pendingReviews()` 不再返回该发现，因此侧边栏“待审核”计数、审核队列、项目概览与安全总览的待处理项、`GET /api/reviews` 都不再包含它；发现页把它归入「已批准」页签。
- 批准不会取消已在运行的 Review；它只阻止新的领取并隐藏待处理提示。批准不改变审核结论、评分、报告材料或漏洞库口径。
- 发现页默认显示「未批准」，可切换到「已批准」；列表与详情页的“人工处理”卡片都可一键批准/撤销。

## 入口预算（冷热）

入口只列热 Facts/Findings，冷池不设上限（`query_graph status=cold` 浏览、`read_graph` 回热）。两个预算同时生效：节点数 `hot_limit` 与字符数 `hot_char_limit`（默认 64,000，0 关闭字符预算）。新项目默认 80 个节点；从未设置过 `hot_limit` 的旧项目继续按 200 读取，与修复前一致。

- 必显集合收敛为：当前焦点 Step 的 `from`/`fact_ids`、待审 Review 的来源 Fact、focused Finding 的来源、`pinned` 节点。**其他 open Step 的输入不再强制热**，其 ID 仍在 `open_step_index` 中，按需 `read_graph`。这是把 Decide 入口从 12 万字符降下来的关键。
- 事实行只带「请求 + 负向范围摘要 + 证据条数」：`parameter_sources` 的逐参数来源与证据 ID 属于审核材料，Review 由程序校验、详情页与 `read_graph` 给全文，不在每轮 Decide 重复；缺溯源仍在该行标「⚠ 缺参数溯源」。执行结果模板也只在 `status=not_observed` 时要求 `request`/`parameter_sources`，避免 observed 事实白带一份。
- 必显集合自身超预算时不隐藏（不能藏起 open work），但 `cold.hot.over_budget=true` 并在 hint 中建议关闭或合并 Step。
- 观测：`capacity_plan` 新增 `projection_sections`（facts/steps/findings/finding_groups/leads/review_issues/hints/coverage_surfaces/cold/instructions/other 各段字符）与 `projection_sections.hot`；`cold.hint` 带 `hot {nodes, chars, limit, char_limit, mandatory, over_budget}`。先按实测分段调整默认值，不要一次性把预算降到 40。
- `hot_limit=0` 的语义仍是“关闭冷却”（全部热），不是“0 个热节点”。

## 工程检查和容量边界

CI 检查类型、ESLint、增量格式基线、TS 覆盖率、Python、构建、浏览器与 Docker 集成。后端覆盖率门槛为行 80%、分支 70%、函数 80%；React 交互另由浏览器验收覆盖。格式检查对既有未格式化文件使用内容哈希基线，新文件和后续内容变更需要 Prettier 格式，避免把全仓格式重写混入行为修复。

`pnpm test:storage-load --files` 使用临时目录、501 个节点、20 万份合成证据文件，不连接目标或付费模型。已完成的一次 Windows 本地测试：图读取 824 ms，项目头修改 1712 ms，实际写入 1 行，热启动 5 ms，峰值 RSS 743436288 字节。读图与状态比较仍为 O(N)，此结果不是并发、冷索引重建或模型效果基准；大项目控制面延迟仍需结合实际并发观测。

ELK 和 Klay 仍仅在用户选择相应布局时下载；默认 Dagre 不需要这两个包。它们的体积是已知功能成本，未通过删除布局能力来消除。

## 旧数据和许可

登录后的兼容性提示会显示被当前版本隐藏的旧格式项目数和需要重新审核的历史发现数。旧格式项目仍在原数据库中，但不进入当前漏洞库和趋势；重建项目后趋势从新项目开始。历史发现按当前分类与证据规则重新审核，通过前不计入已确认漏洞。升级前应保留可恢复的旧版本备份和导出。审核队列会单独列出停在已完成或暂停项目里的待审发现，并提供「重新审核」入口；该入口只开启审核窗口，不重新规划或执行探索，复核结束后项目恢复原状态。进行中的重新审核可在审核队列或项目审核页取消；取消会停止未完成的审核运行并恢复原项目状态，已经产生的审核结果保留。若本轮审核已产生新的规划问题，项目保持运行中交由决策处理。兼容性提示可以关闭，之后只有待处理数量增加时才重新出现。

仓库的 [LICENSE](../LICENSE) 仍为 AGPL-3.0，本次未修改许可证。
