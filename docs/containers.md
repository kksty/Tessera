# 容器镜像与 GHCR

## GHCR 是什么

GHCR（GitHub Container Registry）是 GitHub 提供的 OCI 容器镜像仓库，地址为 `ghcr.io`。它和 GitHub 仓库、Actions、Packages 页面集成，适合存放本项目自己构建的镜像。

- 公开包可以匿名 `docker pull`，不需要登录。
- 私有包需要先用有 `read:packages` 权限的 GitHub Token 登录。
- 镜像按 `<owner>/<image>:<tag>` 命名，例如 `ghcr.io/kksty/tessera-server:0.3.0`。
- 本项目把镜像发布为公开包，用户启动时不需要 Docker Hub 账号。

GHCR 只是默认选择。`compose.yaml` 通过 `TESSERA_IMAGE_REPO` 和 `TESSERA_IMAGE_TAG` 选择镜像，因此也可以使用 Docker Hub、阿里云 ACR、Harbor 或其他符合 OCI 规范的 Registry。

## 本项目的镜像

| 镜像 | 用途 | 来源 |
| --- | --- | --- |
| `tessera-server` | Server 与 Dispatcher（同一镜像，不同命令） | 根目录 `Dockerfile` |
| `tessera-runtime` | Dispatcher 动态创建的项目 Worker，含 Kali 工具链 | `docker/worker.Dockerfile`，默认 `runtime` target |

镜像标签：

- `0.3.0`：与 `package.json` 版本对应的发布标签，`compose.yaml` 默认使用它。
- `latest`：最近一次手动发布或标签发布，便于试用；生产部署建议固定版本。
- `sha-<commit>`：对应提交的可追溯标签。

`worker-image` 是 Compose 中的一次性服务，只负责拉取并校验 Worker 镜像；实际项目 Worker 由 Dispatcher 创建，不是常驻服务。

## 发布流程

[`.github/workflows/images.yml`](../.github/workflows/images.yml) 在两种情况下运行：

1. 推送 `v*` 标签，例如 `v0.3.0`；
2. 在 Actions 页面手动运行 **Publish images**。

workflow 会分别构建并推送 `tessera-server` 和 `tessera-runtime`，使用 BuildKit 缓存和 `linux/amd64` 平台。Worker 镜像较大，首次构建时间明显长于应用镜像。

发布新版本时：

1. 更新 `package.json` 的 `version`；
2. 更新 `.env.example` 的 `TESSERA_IMAGE_TAG` 和 `compose.yaml` 中的默认标签；
3. 推送 `v<version>` 标签，或手动运行 workflow；
4. 在 GitHub Packages 中确认两个包的可见性为 public。

## 首次发布后的包可见性

GHCR 包默认可能是 private。公开仓库的用户要免登录拉取，需要在 GitHub 仓库的 **Packages** 页面分别打开 `tessera-server` 和 `tessera-runtime`，在 **Package settings → Danger Zone → Change visibility** 中改为 public。

如果包保持 private，用户需要：

```sh
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <username> --password-stdin
docker compose pull
```

这里的 Token 至少需要 `read:packages`。

## 使用预构建镜像

默认：

```sh
docker compose up -d
```

指定其他版本：

```sh
TESSERA_IMAGE_TAG=0.3.0 docker compose up -d
```

指定其他 Registry 或镜像代理：

```sh
TESSERA_IMAGE_REPO=ghcr.io/<owner> docker compose up -d
```

完整覆盖单个镜像：

```sh
TESSERA_APP_IMAGE=registry.example.com/tessera-server:custom \
TESSERA_WORKER_IMAGE=registry.example.com/tessera-runtime:custom \
docker compose up -d
```

## 从源码构建

```sh
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

构建参数通过 `.env` 覆盖。中国大陆网络可设置：

```sh
DEBIAN_MIRROR=https://mirrors.ustc.edu.cn
KALI_MIRROR=http://mirrors.ustc.edu.cn/kali
COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
```

Worker 的 `runtime` target 是默认镜像；`full` target 额外安装 `kali-linux-headless`、netexec、enum4linux-ng、bloodyad、coercer、pwncat、chisel、naabu、gitleaks、adb 等可选工具，体积更大：

```sh
TESSERA_WORKER_TARGET=full docker compose -f compose.yaml -f compose.build.yaml build worker-image
```

## 版本与回退

- 应用与 Worker 必须使用同一版本标签；`compose.yaml` 默认从同一个 `TESSERA_IMAGE_TAG` 派生两个镜像。
- 回退时把 `TESSERA_IMAGE_TAG` 改回旧版本并重新 `docker compose up -d`，不要删除平台数据目录或项目工作区卷。
- 旧项目 Worker 会在任务排空后按新镜像重建；升级前应确认没有在途任务。
- 备份时记录应用与 Worker 镜像版本、平台挂载方式和项目卷名称，见[运行、归档与升级](operations.md)。
