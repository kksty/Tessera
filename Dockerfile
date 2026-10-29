# syntax=docker/dockerfile:1.7
# One build graph for both images:
#   docker build --target server  -t tessera-server:<tag>  .
#   docker build --target runtime -t tessera-runtime:<tag> .
#   docker build --target full    -t tessera-runtime:<tag> .
# The last stage is `server`, so a plain `docker build .` keeps building the app image.
ARG NODE_VERSION=24.19.0

# ---------- shared Node build ----------
FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV CI=true
ARG DEBIAN_MIRROR=http://deb.debian.org
ARG COREPACK_NPM_REGISTRY=https://registry.npmjs.org
ARG PNPM_VERSION=11.25.0
# COREPACK_NPM_REGISTRY keeps the existing .env name; it is the registry used by
# both npm and pnpm. Install pnpm through npm instead of corepack: corepack's 10s
# download timeout is too short for the slower mirrors used by local builds.
ENV COREPACK_NPM_REGISTRY=${COREPACK_NPM_REGISTRY} \
    npm_config_registry=${COREPACK_NPM_REGISTRY}
RUN printf 'registry=%s\n' "$COREPACK_NPM_REGISTRY" > "$HOME/.npmrc" && mkdir -p /pnpm
WORKDIR /build
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@${PNPM_VERSION} --registry=${COREPACK_NPM_REGISTRY}
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=tessera-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store
COPY tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tests ./tests
COPY docker ./docker
RUN pnpm typecheck && pnpm build && pnpm prune --prod

# ---------- worker runtime (Kali) ----------
FROM kalilinux/kali-rolling:latest AS worker-core
ENV DEBIAN_FRONTEND=noninteractive TZ=Asia/Shanghai PYTHONUNBUFFERED=1
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ARG KALI_MIRROR=http://http.kali.org/kali
ARG COREPACK_NPM_REGISTRY=https://registry.npmjs.org
ARG PLAYWRIGHT_CLI_VERSION=0.1.22
# Optional GitHub-release prefix for networks where github.com is unreachable.
ARG CHAINREACTORS_PROXY=
# Optional PyPI index for the dirsearch compatibility wheel.
ARG PIP_INDEX_URL=https://pypi.org/simple
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
# Chromium and PDF rendering use system fonts; Kali has no CJK/emoji by default.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt -o Acquire::Retries=3 update && \
    apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt -o Acquire::Retries=3 install -y --no-install-recommends \
    python3-pwntools python3-pymongo && rm -rf /var/lib/apt/lists/*
COPY docker/tools/chainreactors.lock.json docker/tools/install-chainreactors.py /opt/tessera/tools/
RUN CHAINREACTORS_PROXY="${CHAINREACTORS_PROXY}" python3 /opt/tessera/tools/install-chainreactors.py
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
    npm_config_registry=${COREPACK_NPM_REGISTRY} npm install -g @playwright/cli@${PLAYWRIGHT_CLI_VERSION}
# playwright-cli otherwise looks for Playwright's own browser cache; the image only
# ships the system Chromium, so point it at the checked-in config.
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
# The requirements hash is the wheel SHA-256, so a mirror cannot change the payload.
RUN python3 -m venv --system-site-packages /opt/tessera/dirsearch-venv && \
    printf 'setuptools==80.9.0 --hash=sha256:062d34222ad13e0cc312a4c02d73f059e86a4acbfbdea8f8f76b28c99f306922\n' \
      > /tmp/setuptools-requirements.txt && \
    /opt/tessera/dirsearch-venv/bin/pip install --no-cache-dir --no-deps --require-hashes \
      --disable-pip-version-check --index-url "${PIP_INDEX_URL}" -r /tmp/setuptools-requirements.txt && \
    rm /tmp/setuptools-requirements.txt
COPY docker/tools/dirsearch-wrapper /usr/local/bin/dirsearch
RUN chmod 755 /usr/local/bin/dirsearch && dirsearch --help > /dev/null
# Worker containers run as root: port scanning, capture and /workspace need it.
USER root
CMD ["sleep", "infinity"]

FROM worker-core AS full
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y kali-linux-headless \
    netexec enum4linux-ng bloodyad coercer pwncat \
    chisel-common-binaries naabu gitleaks adb && \
    apt-get purge -y nuclei nmap && \
    rm -rf /var/lib/apt/lists/*

FROM worker-core AS runtime

# ---------- trusted per-project router ----------
# Kept separate from Kali tools and model processes. Only the public CA is mounted in Workers.
FROM kalilinux/kali-rolling:latest AS gateway
ARG KALI_MIRROR=http://http.kali.org/kali
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN sed -i "s|http://http.kali.org/kali/|${KALI_MIRROR}/|g" /etc/apt/sources.list.d/kali.sources && \
    apt-get -o Acquire::Retries=3 update && apt-get install -y --no-install-recommends \
    python3 mitmproxy ca-certificates iptables iproute2 dnsmasq-base && rm -rf /var/lib/apt/lists/*
COPY docker/traffic /opt/tessera/traffic
HEALTHCHECK --interval=2s --timeout=2s --start-period=15s --retries=3 CMD python3 -c "from pathlib import Path; import os,socket; assert Path('/var/lib/tessera-proxy/ready').exists(); s=socket.create_connection((os.environ['TESSERA_GATEWAY_IP'],8080 if os.environ.get('TESSERA_CAPTURE_ENABLED','1')=='1' else 53),1); s.close()"
CMD ["python3", "/opt/tessera/traffic/gateway.py"]

# ---------- server / dispatcher ----------
# Keep this stage last so `docker build .` defaults to the app image.
FROM node:${NODE_VERSION}-bookworm-slim AS server
ENV NODE_ENV=production TESSERA_DB=/data/tessera.db TESSERA_CONFIG=/data/runtime.json TESSERA_PORT=8000
WORKDIR /opt/tessera
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY package.json LICENSE ./
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=10 CMD node -e "fetch('http://127.0.0.1:8000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.mjs"]
