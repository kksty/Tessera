# VPS 项目出口与回连

整套 Tessera 部署在同一台 VPS。默认使用 bridge，不使用 host 网络。每个项目由 Dispatcher 自动创建独立网关和隔离网络，模型只使用 Worker 中的工具。

```text
出站：Worker → 项目隔离网络 → 网关（HTTP/HTTPS MITM）→ VPS → 目标
回连：目标 → VPS 公网 IP:项目端口 → Docker 发布端口 → 网关 DNAT → Worker:相同端口
```

Worker 仅连接 `internal + isolated` 网络，没有 Docker bridge 的直连出口；网络命名空间与网关分开。Worker 保留 NET_RAW，移除 NET_ADMIN，不能修改路由或网关规则。一次性可信辅助容器设置默认路由后退出。IPv6 在这版拓扑中关闭。网关私有卷保存 CA 私钥和待归档流量，Worker 只读挂载公共 CA。

## 部署

使用支持 bridge `isolated` gateway mode 的 Linux Docker Engine（建议 28+）和默认 iptables 防火墙后端（含 iptables-nft），需要 `DOCKER-USER` 链；Docker 原生 nftables 后端暂不支持。Docker Desktop 的 Linux 容器也可运行，公网部署以 VPS 为准。现有 `TESSERA_NETWORK` 继续作为 Server、Dispatcher 和网关的上联网络，不需要改为 host；Compose 默认给它固定子网 `10.248.0.0/24`（`TESSERA_UPLINK_SUBNET`），不再占用 Docker 默认的 `172.16.0.0/12`。

Dispatcher 的一次性辅助容器会在宿主机 `DOCKER-USER` 中增加仅匹配该项目网桥“入接口等于出接口”的规则，让数据包经隔离网桥到达网关；不会清空防火墙或放开跨网桥转发。删除项目时移除该规则。

在 `.env` 设置：

```dotenv
# VPS 实际公网 IPv4 或指向它的 DNS 名称，不带协议和端口。
TESSERA_CALLBACK_HOST=your-vps.example.com
TESSERA_CALLBACK_BIND=0.0.0.0
# 10000 个端口，按项目分成 100 个大小为 100 的块。
TESSERA_CALLBACK_PORTS=20000-29999
# 每个并发 Run 会分到项目块里互不重叠的一小段，因此块大小至少等于
# TESSERA_MAX_PROJECT_WORKERS（默认 4；100 时每个 Run 25 个端口）。
TESSERA_CALLBACK_BLOCK_SIZE=100
# 每项目隔离网络从该池切一个显式 /29；默认避开 172.16.0.0/12 和 198.18.0.0/15。
# 若还要测 10.0.0.0/8 目标，改用 100.64.0.0/10 之类的 CGNAT 池。
TESSERA_GATEWAY_SUBNET_POOL=10.250.0.0/16
TESSERA_UPLINK_SUBNET=10.248.0.0/24
# 项目保持 active 但空闲超过该秒数时自动停止网关；下一次 Run 自动拉起。0 关闭。
TESSERA_GATEWAY_IDLE_SECONDS=600
```

未设置 `TESSERA_CALLBACK_HOST` 时不自动发布任何公网端口。配置地址不会自动发现公网 IP，也不会修改云安全组。公网 IP 由云平台 NAT 提供时，`CALLBACK_HOST` 填公网 IP，`CALLBACK_BIND` 仍用 `0.0.0.0`，不要绑定系统网卡上不存在的公网地址。

在云安全组和 VPS 防火墙放行所选端口池的 TCP/UDP；按实际来源限制访问。Docker 发布端口与主机防火墙的交互依赖防火墙后端，不能仅凭 UFW 规则判断访问范围。管理页面仍遵守原来的 `TESSERA_BIND_ADDRESS` 设置，不随回连端口开放。

```sh
docker compose up -d --build
```

Compose 新增 `gateway-image` 构建服务；实际网关按项目创建。已有任务排空后重建 Worker，保留 `/workspace` 命名卷。改变网关镜像、端口池或采集开关，也在排空后应用。旧的 `TESSERA_CAPTURE_UPSTREAM` / `TESSERA_CAPTURE_BYPASS` 必须清空；新拓扑拒绝静默沿用这两项。当前实现默认从 VPS 直接出站，没有安装或配置 sing-box/VPN。

## 模型看到什么

平台自动分配不重叠的端口块，例如首个项目 `20000–20099`，下一个项目 `20100–20199`，TCP/UDP 均映射到相同的 Worker 端口。分配保存在网关容器标签中；普通重启、镜像更新保留原块。端口池耗尽或端口被其他进程占用时任务启动报错，不使用别人的端口。

一个项目可以有多个并发 Run。平台把项目块再切成互不重叠的子段，每个 Run 只拿到自己的子段（例如 100 个端口、4 并发时每个 Run 25 个），避免同一 Worker 容器内多个任务抢同一个回调端口。模型的环境说明和工具进程只看到本 Run 的子段：

```text
TESSERA_CALLBACK_HOST=your-vps.example.com
TESSERA_CALLBACK_PORT_START=20000
TESSERA_CALLBACK_PORT_END=20024
```

模型选择空闲端口，例如在 Worker 运行 `nc -lvnp 20000`，已授权目标执行 `nc your-vps.example.com 20000` 即可建立双向连接。监听必须绑定 `0.0.0.0` 或 Worker 地址，不能只绑定 `127.0.0.1`。不需要知道网关名称、修改路由、管理 Docker 或另外启动 VPN。单个公网 IP 的同一端口不能同时分配给多个项目；范围以外的监听不会自动公开。

回连只在项目 Worker 运行且监听工具存活时可用。项目暂停会停止 Worker 和网关；项目保持 active 但空闲超过 `TESSERA_GATEWAY_IDLE_SECONDS` 时也会停止网关（下一次 Run 自动拉起），避免 mitmproxy 长期白占内存。任务结束仍遵循已有的工具进程清理规则，平台不承诺跨 Run 保活。项目删除一并清理网关、隔离网络、CA/采集卷和端口分配，不影响其他项目。

入站使用 DNAT + SNAT 保证回复路径对称，Worker 看到的对端地址是项目网关地址；这版不保留原始客户端 IP。不影响 TCP/UDP 双向数据传输。

## HTTP/HTTPS 采集边界

- 透明接管出站 TCP，支持 HTTP/HTTPS 非标准端口；显式代理变量仅用于关联 Run/Step，取消变量不会改变出口路径。透明连接没有可信的 Run/Step 标签时，只归入项目，不猜测归属。
- 只有 HTTP hooks 写入归档和前端列表。其他 TCP 由代理透传，UDP/ICMP 由网关转发；入站回连和它的回复走连接跟踪与 DNAT，不送入出站 MITM。TCP 代理会改变握手行为，原始 SYN 探测不能视为目标直接返回的结果。
- 显式声明非 HTTP ALPN 的 TLS 连接透传。没有 ALPN 的 TLS 在解密前无法可靠判定应用协议，可能需要完成 TLS 握手才能识别 HTTP；非 HTTP 内容不保存。证书固定、mTLS 和特殊协议可能不兼容；不自动直连回退。
- 开启采集时拒绝 UDP 443，让支持回退的 HTTP/3 客户端使用 TCP。强制 HTTP/3 的客户端会失败；其他端口的 QUIC 不采集。允许其他协议意味着不能保证看见任意加密隧道内部的 HTTP。
- 控制面和模型中继按服务地址/端口排除。代理失效时受接管 TCP 失败，不放开直连；其他转发仍依赖网关存活。归档故障明确报告缺口，连接不因存储故障自动重试。
- 在设置页关闭采集后，任务排空、网关重建，继续保留路由与入站回连，不新增 HTTP 记录。

## 并发与连接跟踪

网关是常驻监听，不按并发调度：同一 Worker 的多个并发 Run 共用一条默认路由，连接由 conntrack 独立处理，mitmproxy 异步处理多连接。并发扫描会快速产生大量连接，生产前应在 Docker 宿主机提高连接跟踪上限：

```sh
sudo sysctl -w net.netfilter.nf_conntrack_max=262144
echo 'net.netfilter.nf_conntrack_max=262144' | sudo tee /etc/sysctl.d/99-tessera.conf
```

容器内 `/proc/sys` 是只读的，网关启动时只读取并在低于 `TESSERA_CONNTRACK_MIN`（默认 262144）时打告警，不修改宿主机。Docker Desktop 的 WSL 后端通常已是 262144。

## 验证与排查

```sh
docker build --target gateway -t tessera-gateway:network-test .
pnpm test:gateway
```

该检查只创建临时本地目标，验证无代理变量的 HTTP/HTTPS（含非标准端口）、原始 TCP/UDP、双向回连、主机发布端口、规则不可修改和网关停止后的阻断。不会触碰已有项目，也不访问外部测试目标。测试端口为主机 loopback 的 23870–23871，需保持空闲。

排查实际项目时，先确认模型获得的公网地址和端口范围，再确认 Worker 有对应监听、网关健康、Docker 已发布该端口，最后从另一台机器检查云安全组和主机防火墙。公网连通性必须在实际 VPS 上验证，本机 Docker 测试不能代替它。

参考：[Docker isolated 网络](https://docs.docker.com/engine/network/port-publishing/#gateway-modes)、[mitmproxy 透明代理](https://docs.mitmproxy.org/stable/howto/transparent/)、[协议支持范围](https://docs.mitmproxy.org/stable/concepts/protocols/)。
