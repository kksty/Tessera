/**
 * 真实模型验收脚本的配置来源。
 *
 * 这些脚本以前直接读 `datas/tessera/runtime.json`：那是宿主机目录挂载时代的
 * 遗留路径，`/data` 现在是命名卷，宿主机上没有对应文件。脚本因此只接受两种
 * 显式来源：
 *   - `TESSERA_ACCEPTANCE_CONFIG`：从平台卷导出的 `runtime.json` 副本；
 *   - `TESSERA_ACCEPTANCE_MODEL_JSON`：单行模型配置 JSON（不需要 runtime.json）。
 * 两者都没有时直接报错，不再猜测路径。
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import type { ModelConfig } from "../../packages/protocol/src/model-config.js";

const HINT =
  "导出配置：docker run --rm -v tessera-data:/data -v ${PWD}:/out alpine cp /data/runtime.json /out/runtime.json，" +
  "再用 TESSERA_ACCEPTANCE_CONFIG 指向该文件；或改用 TESSERA_ACCEPTANCE_MODEL_JSON 直接提供模型配置。";

/** 完整部署配置，供 buildApp / runJob 使用。只给模型 JSON 时退回内置默认值。 */
export function acceptanceRuntime(): RuntimeConfig {
  const file = process.env.TESSERA_ACCEPTANCE_CONFIG;
  if (!file) {
    // 空路径 = 不读取任何文件，只用默认值；脚本不会写回。
    if (process.env.TESSERA_ACCEPTANCE_MODEL_JSON) return new RuntimeConfig("");
    throw new Error(`没有验收配置。${HINT}`);
  }
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`找不到 ${path}。${HINT}`);
  return new RuntimeConfig(path);
}

/** 有效模型配置：单行 JSON 优先，否则取导出的 runtime.json。密钥不写入任何输出。 */
export function acceptanceModel(): ModelConfig {
  const json = process.env.TESSERA_ACCEPTANCE_MODEL_JSON;
  if (json) return JSON.parse(json) as ModelConfig;
  const model = acceptanceRuntime().value.model;
  if (!model.id || !model.api_key) throw new Error(`配置里没有可用的模型或 API Key。${HINT}`);
  return model;
}
