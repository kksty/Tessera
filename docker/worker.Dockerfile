FROM node:24.19.0-bookworm-slim AS build
ENV CI=true
ARG DEBIAN_MIRROR=http://deb.debian.org
ARG COREPACK_NPM_REGISTRY=https://registry.npmjs.org
# corepack 只认 COREPACK_NPM_REGISTRY；pnpm 11 忽略 npm_config_registry，只读 .npmrc。
# 不共用这个开关时，pnpm install 会走官方源。中国大陆构建可通过 .env 或 --build-arg
# 切换到 USTC / npmmirror，见 compose.build.yaml。
ENV COREPACK_NPM_REGISTRY=${COREPACK_NPM_REGISTRY} npm_config_registry=${COREPACK_NPM_REGISTRY}
RUN printf 'registry=%s\n' "$COREPACK_NPM_REGISTRY" > "$HOME/.npmrc"
WORKDIR /build
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tests ./tests
COPY docker ./docker
RUN pnpm build && pnpm prune --prod

FROM kalilinux/kali-rolling:latest AS core
ENV DEBIAN_FRONTEND=noninteractive TZ=Asia/Shanghai PYTHONUNBUFFERED=1
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ARG KALI_MIRROR=http://http.kali.org/kali
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    sed -i "s|http://http.kali.org/kali/|${KALI_MIRROR}/|g" /etc/apt/sources.list.d/kali.sources && \
    apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update && \
    apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt -o Acquire::Retries=3 install -y --no-install-recommends \
    ca-certificates curl wget git jq unzip bash tmux procps \
    python3 python3-pip python3-venv ripgrep \
    sqlmap ffuf whatweb nikto dirsearch \
    default-mysql-client redis-tools postgresql-client sqlite3 seclists \
    dnsutils iproute2 iputils-ping tcpdump netcat-openbsd \
    openssh-client sshpass proxychains4 smbclient impacket-scripts \
    chromium \
    fonts-noto-cjk fonts-noto-color-emoji && rm -rf /var/lib/apt/lists/*
# 浏览器截图、PDF 与页面字体渲染走系统字体，Kali 默认不含 CJK/emoji：
# 不装这两个包时中文页面截图全是豆腐块（Chromium / Moli 都一样），与引擎无关。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt -o Acquire::Retries=3 update && \
    apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt -o Acquire::Retries=3 install -y --no-install-recommends \
    python3-pwntools python3-pymongo && rm -rf /var/lib/apt/lists/*
COPY docker/tools/chainreactors.lock.json docker/tools/install-chainreactors.py /opt/tessera/tools/
RUN python3 /opt/tessera/tools/install-chainreactors.py
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
    npm_config_registry=https://registry.npmmirror.com npm install -g @playwright/cli@0.1.22
# playwright-cli 默认去找 Playwright 自带缓存里的浏览器，镜像里只有系统 chromium，
# 没有这份配置时 `playwright-cli open` 直接报 "Daemon process exited with code 1"。
COPY docker/tools/playwright-cli.json /opt/tessera/playwright-cli.json
ENV PLAYWRIGHT_MCP_CONFIG=/opt/tessera/playwright-cli.json
COPY --from=build /build/node_modules /opt/tessera/node_modules
COPY --from=build /build/dist/runner.mjs /build/dist/recover.mjs /build/dist/recover-closeout.mjs /opt/tessera/dist/
COPY docker/traffic /opt/tessera/traffic
COPY docker/traffic/proxychains4-wrapper /usr/local/bin/proxychains4
RUN chmod 755 /usr/local/bin/proxychains4
RUN ln -s proxychains4 /usr/local/bin/proxychains
COPY LICENSE /opt/tessera/LICENSE
COPY docker/tools/environment.md /opt/tessera/environment.md
COPY docker/tools/reference.md /opt/tessera/tools/reference.md
RUN mkdir -p /usr/share/wordlists/tessera && \
    ln -s /usr/share/seclists /usr/share/wordlists/seclists && \
    dpkg-query -W seclists > /usr/share/wordlists/tessera/seclists-version.txt
RUN mkdir -p /workspace
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt -o Acquire::Retries=3 update && \
    apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt -o Acquire::Retries=3 install -y --no-install-recommends \
    mitmproxy libnss3-tools iptables && rm -rf /var/lib/apt/lists/*
RUN useradd --system --user-group --home-dir /var/lib/tessera-proxy --shell /usr/sbin/nologin tessera-proxy && \
    useradd --system --user-group --no-create-home --shell /usr/sbin/nologin tessera-scan
WORKDIR /workspace
# dirsearch 0.4.3 still imports pkg_resources, removed by Kali's setuptools 84.
# Scope the compatibility dependency to this CLI; keep system Python unchanged.
RUN python3 -m venv --system-site-packages /opt/tessera/dirsearch-venv && \
    curl -fL --retry 2 --connect-timeout 20 --max-time 180 \
      https://files.pythonhosted.org/packages/a3/dc/17031897dae0efacfea57dfd3a82fdd2a2aeb58e0ff71b77b87e44edc772/setuptools-80.9.0-py3-none-any.whl \
      -o /tmp/setuptools-80.9.0-py3-none-any.whl && \
    echo '062d34222ad13e0cc312a4c02d73f059e86a4acbfbdea8f8f76b28c99f306922  /tmp/setuptools-80.9.0-py3-none-any.whl' | sha256sum -c - && \
    /opt/tessera/dirsearch-venv/bin/pip install --no-index --no-deps /tmp/setuptools-80.9.0-py3-none-any.whl && \
    rm /tmp/setuptools-80.9.0-py3-none-any.whl
COPY docker/tools/dirsearch-wrapper /usr/local/bin/dirsearch
RUN chmod 755 /usr/local/bin/dirsearch && dirsearch --help > /dev/null
# 执行环境固定以 root 运行：端口扫描、抓包、apt 与 /workspace 文件操作都需要 root 身份。
# Dispatcher 创建容器时也显式传 User: "root"；这里写死镜像默认身份，避免基础镜像或
# 构建参数变化后默认用户漂移，导致工具因权限不足失败。
USER root
CMD ["sleep", "infinity"]

FROM core AS full
RUN apt-get update && apt-get install -y kali-linux-headless \
    netexec enum4linux-ng bloodyad coercer pwncat \
    chisel-common-binaries naabu gitleaks adb && \
    apt-get purge -y nuclei nmap && \
    rm -rf /var/lib/apt/lists/*

# Core is the default image; full remains an explicit optional build target.
FROM core AS runtime
