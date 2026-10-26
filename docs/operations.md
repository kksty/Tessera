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

这是无损的冷热保留策略，不是磁盘总容量上限。压缩后的历史、Run 幂等回执和项目工作区仍会增长；二进制原件不一定明显缩小。应监控平台目录与 Worker 工作区容量，按组织要求备份、导出并通过操作员确认流程删除已交付项目。当前不会静默删除仍在引用的证据、旧报告或执行回执，也不会自动清理项目工作区中的会话和脚本。

## 一致性备份和恢复

需要一起备份平台目录（默认 `datas/tessera`）和每个项目的 `/workspace` 命名卷。平台目录包含数据库、WAL、归档原件、runtime 配置和内部凭据，按凭据文件的权限保护备份。在线复制单个 `.db` 文件不能替代 SQLite 一致性备份。

一次完整的维护备份应按以下顺序执行：

1. 暂停项目并等所有 Run 退出，停止 Dispatcher 和 Server 写入。
2. 记录应用与 Worker 镜像版本、平台挂载方式和项目卷名称。
3. 在同一个备份代次中复制整个平台目录与所有项目工作区卷，并保存文件校验清单。
4. 在隔离的 Compose 项目中恢复，核对项目数、原件 SHA-256、报告、会话和 outbox，再恢复服务。

备份保留代数和异地存放由部署方确定；未完成隔离恢复演练前不要删除旧代次。应用内删除项目不会删除外部备份或模型服务已经保存的数据。

## 数据目录与命名卷

默认部署把宿主机目录 `./datas/tessera` 绑定到容器的 `/data`。Docker Desktop 在 Windows 上通过 9p/grpc-fuse 暴露绑定目录，SQLite 的写放大可达 15–90 倍：实测全图读取 92–160 ms（卷内 6–8 ms），20 MB 提交 6.8 s（卷内 77 ms），长尾直接把 `POST /jobs/claim` 推到 40–56 s。**生产部署应使用命名卷**，并用 `compose.volume.yaml` 覆盖层启用：

```powershell
docker compose -f compose.yaml -f compose.volume.yaml up -d
```

覆盖层不迁移已有数据。迁移是一次停机操作（约 15–30 分钟，取决于证据文件数），使用脚本完成停服 → 备份 → tar 管道复制 → 校验 → 启动 → 健康检查：

```powershell
pwsh scripts/ops/migrate-data-to-volume.ps1                 # 源目录、卷名、镜像均可参数化
node scripts/ops/verify-data-volume.mjs datas/tessera/tessera.db datas/tessera/evidence
```

要点：

- 必须停服：DB 与 WAL 在写入中途复制会不一致；脚本先 `docker compose stop`，再单独停止 `tessera-worker-*`。
- 20 万级小文件不要在容器里直接从 bind mount 逐文件读取：实测约 4k 文件/分钟（近 1 小时）。脚本改为宿主机 `tar` 打包（约 1 分钟，单文件 ~1 GB），容器只做一次顺序读取并解包到卷（约 30 秒）。`tar` 保留 `600 root` 权限。
- 解包后删除源库残留的 `tessera.db-shm` / `tessera.db-wal`（旧进程共享内存，SQLite 会重建）。
- 校验 `PRAGMA quick_check`、项目/Run/证据计数与 evidence 文件数；`/health` 返回 ok 后才算完成。
- 源目录全程只读，保留 3–7 天。回退只需不带覆盖层启动：`docker compose down; docker compose up -d`。命名卷不会被自动删除。
- 迁移后重新确认 `docker inspect tessera-tessera-server-1 --format '{{json .Mounts}}'` 指向命名卷，并观察 1 小时 `/api/control-plane/timing` 的 claim p99 与事务 max。

## 超时预算与失败分类

所有控制面调用的超时集中在 `packages/protocol/src/timeouts.ts`，原则是 **lease > heartbeat 最坏情况 > 服务端 p99.9**，且 commit/usage/diagnostics 不阻塞 Run：

| 项 | 默认值 | 说明 |
| --- | ---: | --- |
| lease（Decide/Execute/Review） | 180 s | 死 Worker 最多约 150 s 回收（heartbeat 15 s × 3 + 超时） |
| heartbeat | 15 s 间隔 / 45 s 超时 | 连续 3 次失败才放弃 Run |
| claim / release | 90 s / 30 s | 覆盖控制面长尾，仍小于 lease |
| commit | 30 s，3 次，退避 0.5/1 s | 覆盖 decisions p99 24.5 s |
| usage / diagnostics | 30 s / 15 s | 先写本地 ndjson，后台串行上传；失败继续重试，不永久关闭 |
| 模型中继 | 600 s | `TESSERA_MODEL_TIMEOUT_MS` 可调 |

`TESSERA_LEASE_SECONDS` 只作为首次初始化 `platform_settings` 的默认值；设置页的 `intent_timeout/reason_timeout` 优先，且不允许低于 30 s。旧库中仍是历史默认值 120/120 时，启动会一次性提升到 180/180（`platform_meta.lease_default_180` 记录该迁移）。

Dispatcher 为每次 claim 生成 `claim_id`。claim 超时或异常时它 fire-and-forget 调用 `POST /api/projects/:id/jobs/claim/:claim_id/cancel`：服务端只中断与该 `worker + claim_id` 匹配且在运行中的 Run，设置 5 s 短退避，不增加 `job_failures`、不产生 `needs_attention`。这样慢 claim 不会留下孤儿租约。

Run 结束时写入 `failure_kind`：

| 类别 | 匹配 | 处理 |
| --- | --- | --- |
| `model` | 现有模型错误识别 | 计入 `model_failures`，按原规则退避并在连续 3 次后暂停 |
| `infrastructure` | lease expired、claim abandoned、诊断投递失败、连接 reset/refused、超时（且不是模型错误） | 计入 `infra_failures`，5 s→300 s 退避，**不增加 job_failures、不暂停项目**，到期自动重试 |
| `unknown` | 其他 | 保留 3 次业务失败暂停规则 |

项目上同时记录 `last_failure_kind`、`infra_failures`、`infra_retry_at`；项目页对基础设施故障显示“控制面故障，第 N 次退避重试”，运行记录显示模型/基础设施/目标徽标。execute 已放出外部动作时仍升级为 `needs_attention`（安全属性不变），但不再因此停止整个项目。

## 控制面和阶段指标

Server 默认输出结构化错误日志、鉴权失败和超过 500 ms 的慢请求，包含请求 ID、方法、路由模板、状态和耗时，不记录请求体、查询参数、Cookie 或鉴权头。`TESSERA_LOG_LEVEL` 默认 `info`。操作员可读取 `/api/control-plane/timing` 的请求、事务、事件循环和 `stages`；阶段按 Decide、Execute、Review 分组，包含状态分布、成功率、已知 token 和平均已结束耗时。未知用量保持未知，取消和中断单独列出。

2026-10-20 本地只读核对的历史 Review 为 20 次成功、14 次失败、2 次中断、3 次取消；其中错误记录出现 6 次 422、3 次 502、2 次租约错误。不同时间和分母会得到不同成功率，不能把原报告的 49% 当成固定参数。新增本地语义修复与模拟测试不证明真实供应商的成功率、效果或成本已经改善；需要后续真实运行的阶段统计验证。

## 审核范围与信息类免审

`skip_informational_review` 默认 `false`（`configSchema` 与新建部署一致）。本部署保留操作员原有选择：`datas/tessera/runtime.json` 中为 `true`，即明确标注为信息类且引用原始证据的发现直接归档、不启动 Review。开启后独立审核对信息类失效，这是审核范围的收窄，不应在未确认时改动。部署可用 `TESSERA_SKIP_INFORMATIONAL_REVIEW=true|false` 强制该值，设置页随后显示该项只读。

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
