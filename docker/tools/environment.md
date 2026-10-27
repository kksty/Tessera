# Work 执行环境

Linux / Kali，预装 Node.js、npm、Python。`/workspace` 是各 Step 共享的持久工作区，Step 之间通过它交接文件。

工具：gogo、spray、sqlmap、ffuf、whatweb、nikto、dirsearch、curl、wget、DNS 工具、tcpdump、SSH、proxychains4、smbclient、Impacket、mysql/mariadb、redis-cli、psql、sqlite3、Chromium（`/usr/bin/chromium`）、Playwright CLI、Python/pwntools/pymongo。

Nmap 已移除，不重新安装。端口与服务识别使用 gogo；需要原始套接字或 TCP/UDP 探测时改用 gogo 的对应参数或针对目标的脚本。

Nuclei 已移除，不重新安装引擎或下载模板库。根据当前问题使用已有工具和针对性脚本核查；历史扫描产物仅作为已有证据读取。

按需参考 `/opt/tessera/tools/reference.md`：工具示例、字典路径、证据归档，以及网络代理与录制边界。参数以本机帮助为准，参考资料不规定探索顺序。
