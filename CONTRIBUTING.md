# 贡献指南

感谢参与 Tessera。提交改动前请先确认它符合项目的实验性定位和安全边界。

## 环境

- Node.js 24+
- pnpm（版本以 `package.json` 的 `packageManager` 为准）
- Python 3（仅流量组件测试）
- Docker Compose v2（容器与浏览器验收）

```sh
pnpm install --frozen-lockfile
pnpm dev          # API
pnpm dev:web      # 另一终端启动前端
```

## 提交前检查

在本地至少运行：

```sh
pnpm format
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm test:traffic
pnpm build
pnpm test:frontend-browser
pnpm test:deletion-config-browser
```

涉及 Docker、Dispatcher 或 Worker 的改动还需要：

```sh
docker compose build
pnpm test:docker
```

真实模型调用会产生费用。默认测试使用模拟 API，不要为了通过测试而调用真实供应商。

## 改动约定

- 保持改动聚焦；行为修复与全仓格式重写分开提交（`pnpm format` 产生的格式变更可单独提交）。
- 新增配置项要同时更新 `.env.example`、相关文档和部署示例。
- 公共协议、运行器或生命周期改动需要补充针对性回归；涉及镜像或调度集成时做隔离 Docker QA。
- 不要在代码、测试、文档或截图里写入真实 API Key、目标地址、证据或个人信息。
- 提交信息使用清晰的英文祈使句；PR 描述说明问题、修改、验证命令和剩余边界。
- 前端颜色、字号和间距使用 `apps/web/src/styles/tokens.css`；通用组件放在 `components`，页面放在 `pages`。
- 提交即表示你同意以 [AGPL-3.0](LICENSE) 许可贡献内容。
