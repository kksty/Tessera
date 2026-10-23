# Tessera 文档

这里是 Tessera 的详细文档入口。简介、快速启动和镜像发布见根目录 [README](../README.md)；配置字段以 [.env.example](../.env.example) 为准，提示词与行为以源码为准。

## 当前实现

- [项目说明](project.md)：架构、图与任务契约、上下文与提交、部署维护、验证边界与后续工作。这是描述当前实现的唯一主文档。
- [运行、数据归档与升级](operations.md)：模型凭据边界、SQLite 保留策略、一致性备份、控制面指标和升级注意事项。
- [容器镜像与 GHCR](containers.md)：镜像发布、标签、公开包可见性、Registry 覆盖和源码构建参数。

## 设计与历史记录

历史记录中的提交哈希、`test-results/` 路径和本地镜像 ID 来自公开前的开发环境；公开仓库不包含这些对象，复现时以当前源码和最新验证命令为准。

- [安全测试工作台架构调整实施方案](implementation/security-workbench-plan.md)：M0–M5 的设计依据、分阶段验收和回退边界。其中的历史状态不替代当前实现说明。
- [效果对照基线](implementation/effect-baseline.json)：M6 真实模型小集的冻结配置与索引。
- [从 Cairn 到 FGS](background/cairn-ai-pentest-architecture.md)：FGS 图、Decide / Execute、Finding 等概念的设计来源与背景文章。

## 视觉资源

`assets/` 保存 README 使用的品牌横幅。公开截图必须使用合成项目、合成目标和合成数据；不要使用真实业务图、真实主机名、项目 ID 或证据。品牌图形与前端 `brand-art.ts` 保持同组几何。
