# 容器镜像：本地构建、更新与回退

本项目不发布预构建镜像，也没有 GitHub Packages / GHCR 包。`compose.yaml` 直接使用本机从当前源码构建的两个镜像，克隆代码后即可在本地构建。

## 两个镜像

| 镜像                    | 用途                                             | 构建 target                            |
| ----------------------- | ------------------------------------------------ | -------------------------------------- |
| `tessera-server:<tag>`  | Server 与 Dispatcher（同一镜像，不同命令）       | 根目录 `Dockerfile` 的 `server`        |
| `tessera-runtime:<tag>` | Dispatcher 动态创建的项目 Worker，含 Kali 工具链 | 根目录 `Dockerfile` 的 `runtime`/`full` |

两个镜像共用 `Dockerfile` 里同一个 Node 构建 stage；`server` 是最后一个 stage，因此直接执行 `docker build .` 仍然构建服务端镜像。Worker 的 `runtime` / `full` 是显式 target，不会被默认构建。

`worker-image` 是一次性服务：构建并校验 Worker 镜像后执行 `node --version` 退出。实际项目 Worker 由 Dispatcher 按 `TESSERA_WORKER_IMAGE` 创建，不是常驻服务。

## 构建

`docker compose up -d` 在本地缺少镜像时自动构建；也可以只构建不启动：

```sh
docker compose build
```

不经过 Compose 时，显式指定 target：

```sh
docker build --target server  -t tessera-server:latest  .
docker build --target runtime -t tessera-runtime:latest .
```

首次构建包含 Node 依赖和 Kali 工具链，耗时明显长于后续构建；之后复用 Docker 层缓存。构建参数通过 `.env` 覆盖，`.env.example` 中有完整列表：

```sh
DEBIAN_MIRROR=https://mirrors.ustc.edu.cn
KALI_MIRROR=http://mirrors.ustc.edu.cn/kali
COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
# 容器网络无法访问 github.com 时，为 chainreactors 的 release 资源加代理前缀
CHAINREACTORS_PROXY=https://ghproxy.net
# 容器网络无法访问 pypi.org 时，为 dirsearch 兼容 wheel 指定 PyPI 镜像
PIP_INDEX_URL=https://mirrors.ustc.edu.cn/pypi/web/simple
```

`TESSERA_WORKER_TARGET=full` 会构建包含 `kali-linux-headless`、netexec、enum4linux-ng、bloodyad、coercer、pwncat、chisel、naabu、gitleaks、adb 等可选工具的 Worker，体积更大：

```sh
TESSERA_WORKER_TARGET=full docker compose build worker-image
```

## 标签与版本

`TESSERA_IMAGE_TAG`（默认 `latest`）只是本地镜像标签，不指向任何 Registry；Server 与 Worker 共用同一个值，`compose.yaml` 从它派生两个镜像名。

正式部署建议在重建前把 `TESSERA_IMAGE_TAG` 改成版本号（例如 `0.3.0`）。旧镜像会保留在本机，需要回退时改回旧标签并执行 `docker compose up -d`（不要加 `--build`，否则会用当前源码重新构建该标签）。

## 更新

```sh
git pull
docker compose up -d --build
```

- 只重建变化的构建层；应用镜像通常很快，Worker 镜像较慢。
- 旧项目 Worker 在任务排空后按新镜像重建；升级前确认没有在途任务，避免中断正在执行的外部动作。
- 升级前备份平台命名卷与项目工作区卷，见[运行、数据归档与升级](operations.md)；不要删除平台数据卷或项目工作区卷。
- `docker compose down` 只停止容器，不删除数据。

## 数据目录：始终使用命名卷

`/data` 由 `compose.yaml` 直接挂载命名卷 `tessera-data`（可由 `TESSERA_DATA_VOLUME` 改名）。命名卷是唯一形态：没有宿主机目录挂载，也没有兼容覆盖层或迁移脚本。旧目录模式在 Windows 9p/grpc-fuse 上有 15–90× 写放大，已导致过 claim 长尾与数据库页级损坏，因此已删除。

```powershell
# 首次部署：卷在 Compose 中是 external，先创建一次
docker volume create tessera-data

# 日常启动
docker compose up -d
```

- 卷在 Compose 中声明为 `external`：`docker compose down -v` 也不会删除它。
- `TESSERA_DATA_VOLUME` 只决定卷名（默认 `tessera-data`），不会创建数据。换卷名 = 挂一个空卷，会生成新的数据库与登录凭据。
- `docker compose down` 不删除卷；`down -v` 才会。代码回退用 `TESSERA_IMAGE_TAG`，数据回退把备份解包到新卷。
- 详细说明、备份与排查见[运行、数据归档与升级](operations.md#数据目录与命名卷)。

## 使用自行推送的镜像

如果你把镜像推送到了自己的 Registry，可以用完整引用覆盖本地构建名：

```sh
TESSERA_APP_IMAGE=registry.example.com/tessera-server:0.3.0 \
TESSERA_WORKER_IMAGE=registry.example.com/tessera-runtime:0.3.0 \
docker compose up -d
```

两者必须同版本。先 `docker compose pull` 再启动，可避免 Compose 因本地缺少镜像而触发构建。

## 常见问题

- **构建时下载慢或失败**：在 `.env` 设置 Debian / Kali 镜像源和 npm registry 后重试。
- **磁盘占用**：旧标签镜像不会自动清理，确认不再回退后用 `docker image rm <image>:<tag>` 删除。
- **Worker 仍是旧代码**：项目工作区容器要等当前任务结束才会按新镜像重建；确认没有在途任务后重启 `tessera-server` / `tessera-dispatcher` 会重新调度。
- **只想验证镜像能否构建**：`docker compose build` 不启动服务，也不会改动数据目录。
