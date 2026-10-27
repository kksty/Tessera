import type { DispatchConfig, Job } from "../../../packages/protocol/src/index.js";
import { modelRunToken } from "../../../packages/protocol/src/internal-auth.js";
import { modelMetadata } from "../../../packages/models/src/runtime.js";

/** Only this credential-free representation may cross the container boundary. */
export async function workerConfig(job: Job, config: DispatchConfig, secret: string): Promise<DispatchConfig> {
  if (job.worker_config) return job.worker_config;
  if (!config.model) return { ...config }; // Docker control-only fixtures.
  if (!job.run_id || !secret) throw new Error("Model relay requires a Run and dispatcher credential");
  const token = modelRunToken(secret, job.project_id, job.run_id);
  const model = job.kind === "review" ? config.review_model || config.model : config.model;
  const metadata = await modelMetadata(model);
  const endpoint = new URL(metadata.base_url);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error("Model endpoint must not embed credentials or query parameters; use the API key setting");
  const safe = {
    ...model,
    api: metadata.api,
    provider: metadata.provider === "tessera" ? "custom" : metadata.provider,
    base_url: metadata.base_url,
    // Resolve catalog capacity once, so the Runner starts from the same window the
    // settings page and Dispatcher showed instead of re-deriving a different fallback.
    context_window: metadata.context_window,
    max_output_tokens: metadata.max_output_tokens,
    // Pi uses this marker to select Anthropic OAuth wire conventions. It is not an upstream credential.
    api_key: model.api_key.includes("sk-ant-oat")
      ? `sk-ant-oat-${token}`
      : model.api_key.startsWith("sk-")
        ? `sk-${token}`
        : token,
  };
  return {
    ...config,
    model: safe,
    review_model: undefined,
    model_relay: {
      base_url: `${config.server.replace(/\/$/, "")}/api/model/${encodeURIComponent(job.project_id)}/${encodeURIComponent(job.run_id)}`,
    },
  };
}
