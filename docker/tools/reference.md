# Worker 工具参考

按当前 Step 的问题选择工具。示例参数不是固定流程，执行前查看本机帮助；所有示例变量须自行赋值。

## 文件、变量与证据

示例变量均须赋值：`HOST` 为已批准主机，`BASE_URL` 为已批准 HTTP 基址，`PORTS` 为本次端口，`WORDLIST` 为所选字典的实际路径，`OUT` 为证据文件名前缀。它们不是预设环境变量。示例中的并发、速率与参数可按问题调整。

## 字典

core 自带 dirsearch 字典 `/usr/lib/python3/dist-packages/dirsearch/db/dicc.txt`，其扩展名占位规则不能直接用于 ffuf/spray。SecLists 位于 `/usr/share/seclists/`，也可通过 `/usr/share/wordlists/seclists/` 访问；安装版本见 `/usr/share/wordlists/tessera/seclists-version.txt`。使用前确认具体文件存在并记录哈希；不假定存在 `/usr/share/wordlists/rockyou.txt`。

## 输出与证据

输出参数以安装版本为准，不统一假设存在 `--json`。完整结果写文件，再检索必要字段或片段；必要的请求/响应原文与 stderr 分开保留，结构化结果不一定包含这些原件。

结合退出状态、错误和输出内容判断执行是否成功；解析失败不能视为阴性结果。文件路径和摘要用于定位，原件通过 `save_evidence` 归档并引用返回的 Evidence ID。

| 绝对路径 | 用途 |
|---|---|
| /usr/share/wordlists/seclists/Discovery/Web-Content/ | Web 路径，常用 common.txt |
| /usr/share/wordlists/seclists/Discovery/DNS/ | 域名标签，常用 subdomains-top1million-5000.txt |
| /usr/share/wordlists/seclists/Passwords/ | 口令字典，仅在任务需要认证测试时选择 |
| /usr/share/wordlists/seclists/Usernames/ | 用户名种子 |
| /usr/share/wordlists/seclists/Fuzzing/ | 按协议和问题选择输入 |

## Chromium：浏览器与页面渲染

可执行文件 `/usr/bin/chromium`，系统字体已包含中日韩与 emoji。浏览器自动化用同目录 `playwright-cli工具说明.md`，配置已内置，直接可用。

## Impacket工具族：多种协议与服务交互

本镜像安装 Kali `impacket-scripts`，使用 PATH 中的 **`impacket-名称`**，例如 `impacket-mssqlclient`，通常不带 `.py`。上游 `examples/mssqlclient.py` 和帮助里的 `usage: mssqlclient.py` 是脚本名，不代表应执行 `impacket-mssqlclient.py`。不存在统一的 `impacket` 主命令。先用 `command -v` 或 `dpkg -L impacket-scripts` 确认入口和大小写，再查本机原生用法。

| 常用入口 | 用途 |
|---|---|
| `impacket-smbclient` | SMB 交互客户端，批处理也可优先已有 smbclient |
| `impacket-mssqlclient` | SQL Server/TDS 客户端，支持 SQL 与 Windows 身份认证 |
| `impacket-GetADUsers` | 使用授权凭据查询目录用户属性 |
| `impacket-lookupsid` | SID 与账户名称映射 |
| `impacket-rpcmap` | RPC 接口信息 |
| `impacket-getTGT` / `impacket-getST` | Kerberos 票据客户端 |
| `impacket-ticketConverter` | ccache 与 kirbi 转换，先核对本机大小写 |

常见连接表示为 `[[domain/]username[:password]@]host`，各命令参数不能直接互换。密码优先交互输入，避免进入历史和进程参数。`LMHASH:NTHASH` 是部分命令接受的 NTLM 哈希对格式，并非明文密码。`KRB5CCNAME` 指向 ccache 票据缓存，`.kirbi` 是另一种票据容器，不能只改后缀替换。票据、哈希和凭据按敏感原件保存。

多数入口输出文本，不假设支持 JSON；保留 stdout、stderr、退出状态与必要原件。

## bash：命令与脚本执行

`bash --help`。工具返回 running 或一页输出时，继续通过现有进程接口核对状态和剩余输出。

## curl：保存一次请求的响应头、正文和错误

本机帮助：`curl --help`。

```sh
curl -sS -D "$OUT-response.headers" -o "$OUT-response.body" "$BASE_URL" 2> "$OUT-curl.stderr"
```

## dig：DNS 查询

本机原生命令用法；不要将其他工具的短帮助参数套用到本命令。根据问题选择域名、记录类型和解析器。

## dirsearch：已有字典与明确基址

本机帮助：`dirsearch --help`。

```sh
dirsearch -u "$BASE_URL" -w "$WORDLIST" -t 5 --format=json -o "$OUT-dirsearch.json" > "$OUT-dirsearch.stdout" 2> "$OUT-dirsearch.stderr"
```

## ffuf：明确 fuzz 位置并保存 JSON

本机帮助：`ffuf --help`。

```sh
ffuf -u "${BASE_URL%/}/FUZZ" -w "$WORDLIST" -t 5 -rate 20 -of json -o "$OUT-ffuf.json" > "$OUT-ffuf.stdout" 2> "$OUT-ffuf.stderr"
```

默认匹配规则会漏掉部分状态；应根据已观察到的基线选择匹配/过滤条件，而不是把无结果视为不存在。

## gogo：明确主机与端口，保存原始文件

本机帮助：`gogo --help`。

```sh
gogo -i "$HOST" -p "$PORTS" -t 20 -f "$OUT-gogo.dat" > "$OUT-gogo.stdout" 2> "$OUT-gogo.stderr"
gogo -F "$OUT-gogo.dat" -o json > "$OUT-gogo.json" 2> "$OUT-gogo-format.stderr"
```

格式化只读取已保存结果，不重新扫描。不默认开启 exploit/主动指纹或扩展网段；根据实际问题另行选择功能。

## host：DNS 查询

本机原生命令用法；不要猜用 `-h` 作为帮助。保存查询条件与原始输出。

## jq：JSON 数据检索与转换

`jq --help`。按问题选择必要字段或记录，保留原始文件，不把过滤后的内容误称完整原始结果。

## nikto：Web 配置与已知问题检查

`nikto --help`。按当前问题选择检查项，告警仍需原始证据验证。

## nmap：针对已批准主机的端口/轻量服务识别

本机帮助：`nmap --help`。

```sh
nmap -sT -sV --version-light -p "$PORTS" -oA "$OUT-nmap" "$HOST" > "$OUT-nmap.stdout" 2> "$OUT-nmap.stderr"
```

## node：JavaScript / TypeScript 工具运行环境

Worker 已预装 Node.js；本机帮助 `node --help`，版本用 `node --version` 核对。当前基线为 v24.19.0，无需为了执行脚本再次安装 Node.js。

```sh
node /workspace/scripts/task.mjs
```

示例脚本路径须替换成实际已保存文件。项目脚本和依赖放在工作区，保留输入/输出路径；不修改 `/opt/tessera/` 中的运行器依赖。包管理参见同目录 `npm工具说明.md`；证据保存参见 `通用规范-变量字典与证据保存.md`。

## npm：Node.js 项目依赖管理

Worker 已预装 npm。本机帮助 `npm --help`，版本用 `npm --version` 核对；当前镜像实测为 11.17.0。该版本 `npm --help` 会显示用法但退出码为 1，不能仅据此判定 npm 故障；原生入口 `npm help` 返回相同总览且退出码为 0。

在工作区对应的脚本项目目录管理依赖：已有有效 package-lock.json 时可用 `npm ci`，按任务需要新增依赖时用 `npm install`。不要在 `/opt/tessera/` 中安装或改动运行器依赖。保留 package.json 和锁文件，便于复用与溯源。

## nslookup：DNS 查询

本机原生命令用法；不要猜用 `-h` 作为帮助。根据问题选择域名与记录类型。

## playwright-cli：浏览器交互、页面与截图

镜像已内置浏览器配置（`PLAYWRIGHT_MCP_CONFIG=/opt/tessera/playwright-cli.json`，指向 `/usr/bin/chromium`），`playwright-cli open <url>` 直接可用，不需要再传 `--executablePath`。要接管已在运行的浏览器，用 `playwright-cli attach --cdp=<http://host:port>`。`playwright-cli --help` 查看全部命令。

## proxychains4：代理连接辅助

录制代理、上游与网络限制见本文末尾“代理与录制”；不提供自动公网端口发布。

按当前网络路径创建工作区内的独立配置：`proxychains4 -f /workspace/路径/proxychains.conf 工具 参数`，避免修改全局配置。参数以本机用法为准。只支持动态链接 TCP 客户端；Go 静态程序等应优先使用其原生代理参数。`proxy_dns` 影响解析位置。nmap 经代理时使用 `-sT -Pn -n`；SYN、UDP、ICMP 和原始套接字探测不能通过 proxychains 转发。代理连通不扩大资产授权范围。

## python3：自定义脚本与数据处理

`python3 --help`。复用脚本保留在工作区，记录依赖、输入和输出路径。

## rg：文本与代码检索

`rg --help`。按文件与问题检索，保留准确路径和行号；无匹配不等于目标事实不存在。

## smbclient：SMB 服务交互

`smbclient --help`。依据实际问题选择已批准服务及操作，保存相关原始输出。

## spray：单 URL 检查或基于已有字典的路径 fuzz

本机帮助：`spray --help`。

```sh
spray -u "$BASE_URL" --no-bar --no-color --no-stat -f "$OUT-spray-check.json" > "$OUT-spray-check.stdout" 2> "$OUT-spray-check.stderr"
spray -u "$BASE_URL" -d "$WORDLIST" -t 5 --rate-limit 20 --no-bar --no-color --no-stat -f "$OUT-spray-paths.json" > "$OUT-spray-paths.stdout" 2> "$OUT-spray-paths.stderr"
```

v0.3.2 没有字典、word 或规则时进入检查模式，旧示例中的 `--check-only` 不适用于此版本。需要完整请求资料时再查 `--dump-file` 的本机帮助；结果列表不一定包含全部 HTTP 原文。

## sqlmap：SQL 注入验证

`sqlmap --help`。根据已有输入和观测选择参数，不因使用此工具而默认提升测试强度。

## ssh：SSH 交互

本机原生命令用法；本工具不支持统一的 GNU `--help`，不要把其他工具的帮助参数套过来。保留连接条件、错误与相关记录。

## tcpdump：网络数据包观察

`tcpdump --help`。Tessera 已有项目流量采集；仅在当前问题确有需要时另外观察并保留原始文件，不修改采集服务。

## tmux：持久终端会话

查本机原生命令用法。需要跨执行保留会话时记录准确会话名及用途。

## wget：HTTP 下载

`wget --help`。需要保留下载原文件、来源 URL、执行错误及准确路径。

## whatweb：Web 技术识别

`whatweb --help`。按当前问题选择请求与输出选项，识别结果是待核对的线索。

## 数据库连接 CLI

core 只安装客户端，不启动数据库服务。先查本机帮助，使用已批准主机、端口及授权凭据。

| 入口 | 用途与输出 |
|---|---|
| `mysql` / `mariadb` | MySQL/MariaDB；`--batch --raw` 输出 TSV，`-p` 不带值可提示密码 |
| `redis-cli` | Redis；优先 `--askpass`，`--json` 以本机支持为准 |
| `psql` | PostgreSQL；`-W` 提示密码，`-X` 避免个人启动脚本，`--csv` 以本机支持为准 |
| `sqlite3` | 本地 SQLite；只读检查优先 `-readonly`，`-json/-csv` 以本机支持为准 |
| `impacket-mssqlclient` | SQL Server/TDS，详见 Impacket 工具族说明 |
| Python `pymongo` | MongoDB，复用已有驱动进行脚本化连接 |

只读问题用必要元数据查询，不以写入或全库导出代替连接验证。写入须符合当前任务授权。结果、原始错误、退出状态分开保存。其余约定见同目录通用规范。

## 代理与录制

Execute 尝试为支持的 HTTP 客户端提供录制代理和项目 CA。已有代理环境变量、LD_PRELOAD 或 PROXYCHAINS_CONF_FILE 时保留原设置；不保证所有工具流量被采集。

- 录制入口为 Worker 内的 `http://127.0.0.1:8081`。浏览器或忽略代理环境变量的工具可显式配置；127.0.0.1 仅指当前 Worker。
- `TESSERA_CAPTURE_PROXY_URL` 带 Run/Step 关联信息；CA 为 `/var/lib/tessera-proxy/mitmproxy-ca-cert.pem`。
- HTTP/HTTPS 正文分块保存；当前不新建 TCP/UDP/ICMP 记录。采集故障不会重放请求，也不阻止普通执行。
- 工具自带代理或 `proxychains4 -f /workspace/路径/proxychains.conf 工具 参数` 由任务自主选择。proxychains 包装器保留用户代理，去除自动注入的采集变量。
- Nmap 经 TCP 代理时使用 `-sT -Pn -n`；SYN、UDP、ICMP 及原始套接字不能由 proxychains 转发。Go 静态程序优先使用原生代理参数。
- 设置页的「流量采集」可关闭录制代理；关闭后新 Run 直连，不注入代理环境变量，已有记录保留。
- Dispatcher 可配置 `TESSERA_CAPTURE_UPSTREAM`（http、https、socks5）及 `TESSERA_CAPTURE_BYPASS`。上游失败不回退直连，不重放目标请求。
- 上游 TLS 默认上限为 1.2，旧站点首次请求即可成功；`TESSERA_CAPTURE_TLS_MAX=TLS1_3` 或 `UNBOUNDED` 可放开。放开后若握手被目标直接断开，采集会记录该错误并把后续连接降为 TLS 1.2，首次失败请求仍不重放。降级后 TLS 握手仍失败时，流量页会显示黄色 `tls_notice` 提示（不会把 Run 标失败），该主机后续成功响应会清除提示。目标只接受 TLS 1.2 时，OpenSSL 客户端直连可显式加 `--tlsv1.2 --tls-max 1.2`；不要因为一次 TLS EOF 就判定站点不可达。
- 不存在托管 REM、跨 Run 隧道、自动发布 Worker 公网端口或项目级出口切换接口。普通命令归 Run，结束时清理。
