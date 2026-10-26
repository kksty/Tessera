<#
.SYNOPSIS
  把现有 /data 目录迁移到 Docker 命名卷 tessera-data，并验证迁移结果。

.DESCRIPTION
  SQLite 在 Windows bind mount（9p/grpc-fuse）上写放大 15–90 倍，长尾会拖垮
  claim/commit。迁移只在停服窗口内进行：

    1. 记录基线（evidence 文件数、DB 大小）
    2. docker compose stop（保留卷与工作区）
    3. 备份 DB + WAL 到 datas\release-backups\<stamp>
    4. docker volume create
    5. 用本地 server 镜像以 tar 管道复制（20 万小文件不要逐文件 Copy-Item）
    6. 校验 quick_check / 计数 / evidence 文件数
    7. 用 compose.volume.yaml 启动并等待 /health

  任何一步失败都会停止；源目录全程只读，回退只需不带覆盖层启动。

.PARAMETER Source
  当前数据目录，默认 .\datas\tessera。

.PARAMETER Volume
  目标命名卷，默认 tessera-data。

.PARAMETER Image
  用于复制的本地镜像，默认 tessera-server:latest（避免额外拉取 alpine）。

.PARAMETER SkipBackup
  跳过 DB 备份（仅在已另行备份时使用）。

.EXAMPLE
  pwsh scripts/ops/migrate-data-to-volume.ps1
#>
[CmdletBinding()]
param(
  [string]$Source = ".\datas\tessera",
  [string]$Volume = "tessera-data",
  [string]$Image = "tessera-server:latest",
  [switch]$SkipBackup
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Invoke-Step([string]$Label, [scriptblock]$Action) {
  Write-Host "==> $Label" -ForegroundColor Cyan
  & $Action
}

function Assert-LastExit([string]$Label) {
  if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE)" }
}

$root = (Get-Location).Path
$sourcePath = (Resolve-Path $Source).Path
$dbPath = Join-Path $sourcePath "tessera.db"
$evidencePath = Join-Path $sourcePath "evidence"
$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$backupDir = Join-Path $root "datas\release-backups\$stamp"

if (-not (Test-Path $dbPath)) { throw "找不到数据库：$dbPath" }

Write-Host "源目录 : $sourcePath"
Write-Host "目标卷 : $Volume"
Write-Host "镜像   : $Image"
Write-Host "备份   : $backupDir"

Invoke-Step "记录基线" {
  $script:dbBytes = (Get-Item $dbPath).Length
  $script:evidenceFiles = if (Test-Path $evidencePath) { (Get-ChildItem $evidencePath -Recurse -File).Count } else { 0 }
  Write-Host "    DB $([math]::Round($dbBytes / 1MB, 1)) MiB · evidence $evidenceFiles 个文件"
}

Invoke-Step "停止 tessera 容器（保留卷与工作区）" {
  docker compose stop tessera-server tessera-dispatcher | Out-Host
  Assert-LastExit "docker compose stop"
  # 动态 Worker 不属于 compose，必须一并停止，否则它们会继续写 /data。
  $workers = docker ps -aq --filter "name=tessera-worker-"
  if ($workers) { docker stop $workers | Out-Host; Assert-LastExit "docker stop workers" }
}

if (-not $SkipBackup) {
  Invoke-Step "备份数据库与 WAL" {
    New-Item -ItemType Directory -Force $backupDir | Out-Null
    Copy-Item (Join-Path $sourcePath "tessera.db*") $backupDir -Force
    Write-Host "    已写入 $backupDir"
  }
}

Invoke-Step "创建命名卷" {
  docker volume create $Volume | Out-Host
  Assert-LastExit "docker volume create"
}

Invoke-Step "宿主机打包（避免容器的逐文件 9p 读取）" {
  # 在容器里直接从 Windows bind mount 读 20 万小文件，实测 ~4k 文件/分钟；
  # 改为宿主机本地 tar 打包（约 1 分钟），容器只做一次大文件顺序读取 + 本地解包（约 30 秒）。
  $script:tarFile = Join-Path $root "datas\_migrate-$stamp.tar"
  if (Test-Path $tarFile) { Remove-Item $tarFile -Force }
  tar.exe -cf $tarFile -C $sourcePath .
  Assert-LastExit "host tar"
  Write-Host "    $([math]::Round((Get-Item $tarFile).Length / 1MB, 1)) MiB → $tarFile"
}

Invoke-Step "解包到命名卷" {
  $tarDir = Split-Path $script:tarFile -Parent
  $tarName = Split-Path $script:tarFile -Leaf
  # 解包后删除源库残留的 -shm/-wal：它们是旧进程的共享内存，SQLite 会拒绝或重建。
  docker run --rm -v "${tarDir}:/tars:ro" -v "${Volume}:/to" --entrypoint sh $Image `
    -c "cd /to && tar -xf /tars/$tarName && rm -f /to/tessera.db-shm /to/tessera.db-wal"
  Assert-LastExit "tar extract"
}

Invoke-Step "校验迁移结果" {
  docker run --rm -v "${Volume}:/to" --entrypoint node $Image -e @"
const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync('/to/tessera.db', { readOnly: true });
const quick = d.prepare('PRAGMA quick_check').all();
if (quick.some(row => row.quick_check !== 'ok')) { console.error(quick); process.exit(1); }
const n = d.prepare('SELECT COUNT(*) c FROM platform_projects').get().c;
console.log('quick_check ok · projects ' + n);
d.close();
"@
  Assert-LastExit "database quick_check"

  $inside = (docker run --rm -v "${Volume}:/to" --entrypoint sh $Image -c "find /to/evidence -type f | wc -l").Trim()
  Assert-LastExit "evidence count"
  Write-Host "    卷内 evidence 文件：$inside（迁移前 $evidenceFiles）"
  if ([int]$inside -ne [int]$evidenceFiles) { throw "evidence 文件数不一致：$inside != $evidenceFiles" }
}

Invoke-Step "用命名卷启动" {
  docker compose -f compose.yaml -f compose.volume.yaml up -d | Out-Host
  Assert-LastExit "docker compose up"
}

Invoke-Step "等待健康检查" {
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    & curl.exe -s -m 3 http://127.0.0.1:8000/health *> $null
    if ($LASTEXITCODE -eq 0) { Write-Host "    /health ok"; return }
  }
  throw "服务在 120 秒内未通过 /health；回退：docker compose down; docker compose up -d"
}

if ($script:tarFile -and (Test-Path $script:tarFile)) { Remove-Item $script:tarFile -Force }

Write-Host ""
Write-Host "迁移完成。源目录 $sourcePath 未改动，保留 3–7 天后再删除。" -ForegroundColor Green
Write-Host "回退：docker compose down; docker compose up -d   （不带 compose.volume.yaml）"
Write-Host "复核：docker inspect tessera-tessera-server-1 --format '{{json .Mounts}}'"
