import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SettingsManager, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import {
  MODEL_APIS,
  normalizeModelBaseURL,
  sameModelEndpoint,
  type ModelConfig,
  type ModelMetadata,
  type ModelProvider,
} from "../../protocol/src/model-config.js";
import { CatalogRefresh, createCatalogStore, refreshPublicCatalog } from "./catalog-refresh.js";

type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
const supported = (model: PiModel) => (MODEL_APIS as readonly string[]).includes(model.api);

/**
 * Pi's own models.json schema. Tessera generates this document from its runtime
 * settings and lets Pi compose the provider and model: defaults, API selection,
 * catalog metadata, compatibility flags and request transport all stay in Pi.
 */
type ModelDefinition = {
  id: string;
  name?: string;
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: PiModel["input"];
  inputLimits?: PiModel["inputLimits"];
  thinkingLevelMap?: PiModel["thinkingLevelMap"];
  cost?: PiModel["cost"];
  promptCache?: PiModel["promptCache"];
  samplingParams?: PiModel["samplingParams"];
  samplingParamsByThinkingLevel?: PiModel["samplingParamsByThinkingLevel"];
  compat?: PiModel["compat"];
};
type ProviderDefinition = {
  name?: string;
  baseUrl?: string;
  api?: string;
  models?: ModelDefinition[];
  modelOverrides?: Record<string, { contextWindow?: number; maxTokens?: number }>;
};
type ModelsDocument = { providers: Record<string, ProviderDefinition> };
type ModelPlan = {
  provider: string;
  known?: PiModel;
  /** The composed model really takes its capacity from the catalog definition. */
  capacityFromCatalog?: boolean;
  document: ModelsDocument;
};
type LoadedModel = { runtime: ModelRuntime; model: PiModel; metadata: ModelMetadata };

/** Catalog inspection and API probes never load the user's global Pi credentials/config. */
export function createModelRuntime(
  options: Pick<CreateModelRuntimeOptions, "catalogBaseUrl" | "modelsStore" | "modelsPath"> = {},
) {
  const credentials: NonNullable<CreateModelRuntimeOptions["credentials"]> = {
    read: async () => undefined,
    list: async () => [],
    modify: async () => {
      throw new Error("Tessera credentials are managed by runtime settings");
    },
    delete: async () => {},
  };
  const { modelsPath, ...rest } = options;
  return ModelRuntime.create({
    ...rest,
    credentials,
    modelsPath: modelsPath ?? null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
}

let catalog: Promise<ModelRuntime> | undefined;
let catalogRefresh: CatalogRefresh | undefined;
const catalogStore = createCatalogStore();
async function catalogRuntime(force = false) {
  const runtime = await (catalog ??= createModelRuntime({ modelsStore: catalogStore }).catch((error) => {
    catalog = undefined;
    throw error;
  }));
  catalogRefresh ??= new CatalogRefresh({
    refresh: (options) => refreshPublicCatalog(runtime, catalogStore, options ?? {}),
  });
  await catalogRefresh.refresh(force);
  return runtime;
}

export async function modelCatalogStatus(force = false) {
  await catalogRuntime(force);
  if (force) clearConfiguredCache();
  return { ...catalogRefresh!.status };
}

/** An ID alone cannot identify a deployment or its capabilities. */
function providerFor(runtime: ModelRuntime, cfg: ModelConfig) {
  if (cfg.provider === "custom") return undefined;
  if (cfg.provider) {
    const provider = runtime.getProvider(cfg.provider);
    if (!provider || !runtime.getModels(cfg.provider).some(supported) || !provider.auth.apiKey)
      throw new Error(`Unsupported Pi API provider: ${cfg.provider}`);
    return cfg.provider;
  }
  if (!normalizeModelBaseURL(cfg.base_url, cfg.api)) return undefined;
  // Exact path matching also distinguishes coding plans from regular API plans;
  // a trailing /v1 is the one documented spelling difference we tolerate.
  return runtime.getModels().find((m) => m.api === cfg.api && sameModelEndpoint(cfg.base_url, m.baseUrl, cfg.api))
    ?.provider;
}

function modelCaps(cfg: ModelConfig) {
  return {
    ...(cfg.context_window > 0 ? { contextWindow: cfg.context_window } : {}),
    ...(cfg.max_output_tokens && cfg.max_output_tokens > 0 ? { maxTokens: cfg.max_output_tokens } : {}),
  };
}

function customPlan(cfg: ModelConfig): ModelPlan {
  const baseUrl = normalizeModelBaseURL(cfg.base_url, cfg.api);
  if (!baseUrl) throw new Error("请先填写 API 地址。");
  return {
    provider: "tessera",
    document: {
      providers: {
        tessera: {
          name: "Tessera",
          baseUrl,
          api: cfg.api,
          models: [{ id: cfg.id, name: cfg.id, api: cfg.api, reasoning: false, input: ["text"], ...modelCaps(cfg) }],
        },
      },
    },
  };
}

function officialPlan(runtime: ModelRuntime, cfg: ModelConfig, provider: string): ModelPlan {
  const known = runtime.getModel(provider, cfg.id);
  const baseUrl = cfg.base_url ? normalizeModelBaseURL(cfg.base_url, cfg.api) : undefined;
  // A catalog model with its native protocol keeps the catalog definition. Only
  // the deployment-specific capacity or endpoint is overlaid via modelOverrides.
  if (known && known.api === cfg.api) {
    return {
      provider,
      known,
      capacityFromCatalog: true,
      document: {
        providers: {
          [provider]: {
            ...(baseUrl ? { baseUrl } : {}),
            modelOverrides: { [cfg.id]: modelCaps(cfg) },
          },
        },
      },
    };
  }
  // An unknown ID or an explicit protocol change is still composed by Pi from a
  // models.json definition, not by hand-building a model in Tessera.
  const modelBase = known?.baseUrl || runtime.getModels(provider).find(supported)?.baseUrl;
  const resolvedBase = baseUrl || modelBase;
  if (!resolvedBase) throw new Error(`Pi 供应商 ${provider} 没有可用的 API 地址。`);
  return {
    provider,
    known,
    document: {
      providers: {
        [provider]: {
          baseUrl: resolvedBase,
          api: cfg.api,
          models: [
            {
              id: cfg.id,
              name: known?.name ?? cfg.id,
              api: cfg.api,
              ...(known
                ? {
                    reasoning: known.reasoning,
                    input: known.input,
                    inputLimits: known.inputLimits,
                    thinkingLevelMap: known.thinkingLevelMap,
                    cost: known.cost,
                    promptCache: known.promptCache,
                    samplingParams: known.samplingParams,
                    samplingParamsByThinkingLevel: known.samplingParamsByThinkingLevel,
                    compat: known.compat,
                  }
                : { reasoning: false, input: ["text"] }),
              ...modelCaps(cfg),
            },
          ],
        },
      },
    },
  };
}

function planModel(runtime: ModelRuntime | undefined, cfg: ModelConfig): ModelPlan {
  if (!runtime) return customPlan(cfg);
  const provider = providerFor(runtime, cfg);
  return provider ? officialPlan(runtime, cfg, provider) : customPlan(cfg);
}

const MODELS_DIR = join(tmpdir(), "tessera-pi-models");
async function writeModelsDocument(document: ModelsDocument) {
  const body = JSON.stringify(document);
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 32);
  const path = join(MODELS_DIR, `${hash}.json`);
  await mkdir(MODELS_DIR, { recursive: true });
  await writeFile(path, body, { mode: 0o600 });
  return path;
}

function metadataFor(model: PiModel, cfg: ModelConfig, known?: PiModel, capacityFromCatalog = !!known): ModelMetadata {
  const compaction = modelSettings(model).getCompactionSettings(model);
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    api: model.api,
    base_url: model.baseUrl,
    context_window: model.contextWindow,
    max_output_tokens: model.maxTokens,
    // A known catalog ID with a different protocol is composed from a models.json
    // definition, so its unset capacity comes from Pi's defaults, not the catalog.
    context_source: cfg.context_window > 0 ? "configured" : capacityFromCatalog ? "pi" : "default",
    output_source:
      cfg.max_output_tokens && cfg.max_output_tokens > 0 ? "configured" : capacityFromCatalog ? "pi" : "default",
    reasoning: model.reasoning,
    input: model.input,
    compaction: {
      enabled: compaction.enabled,
      reserveTokens: compaction.reserveTokens,
      keepRecentTokens: compaction.keepRecentTokens,
      // Pi compacts when context > window - reserve; a window smaller than the
      // reserve yields a non-positive threshold and compacts immediately.
      threshold: model.contextWindow - compaction.reserveTokens,
    },
    ...(known
      ? {
          catalog_match: {
            provider: known.provider,
            id: known.id,
            context_window: known.contextWindow,
            max_output_tokens: known.maxTokens,
            via: cfg.provider ? ("provider" as const) : ("endpoint" as const),
          },
        }
      : {}),
  };
}

function configuredKey(cfg: ModelConfig) {
  // The catalog refresh replaces model metadata; a refreshed timestamp starts a new
  // cache generation instead of serving a stale window from the previous catalog.
  const catalogVersion = cfg.provider === "custom" ? "custom" : (catalogRefresh?.status.refreshed_at ?? "");
  return `${catalogVersion}\n${JSON.stringify(cfg)}`;
}

const configuredCache = new Map<string, Promise<LoadedModel>>();
const CONFIGURED_CACHE_LIMIT = 16;
export function clearConfiguredCache() {
  configuredCache.clear();
}

async function buildConfigured(cfg: ModelConfig): Promise<LoadedModel> {
  // A custom endpoint is explicitly outside the Pi catalog. Do not trigger the
  // public catalog network check for a local vLLM or proxy.
  const runtimeCatalog = cfg.provider === "custom" ? undefined : await catalogRuntime();
  const plan = planModel(runtimeCatalog, cfg);
  const modelsPath = await writeModelsDocument(plan.document);
  // Reuse the refreshed public catalog snapshot; otherwise modelOverrides would
  // overlay the older bundled catalog and lose its compatibility metadata.
  const runtime = await createModelRuntime({ modelsPath, modelsStore: catalogStore });
  // Apply the catalog snapshot already installed by catalogRuntime (without a
  // network request), so modelOverrides act on the same model metadata the
  // settings page and API probe saw.
  await runtime.refresh({ allowNetwork: false });
  const model = runtime.getModel(plan.provider, cfg.id);
  if (!model) throw new Error(`Pi 未加载模型：${plan.provider}/${cfg.id}`);
  await runtime.setRuntimeApiKey(plan.provider, cfg.api_key || "tessera-no-key");
  return { runtime, model, metadata: metadataFor(model, cfg, plan.known, plan.capacityFromCatalog ?? false) };
}

async function loadConfigured(cfg: ModelConfig) {
  const key = configuredKey(cfg);
  let loaded = configuredCache.get(key);
  if (!loaded) {
    loaded = buildConfigured(cfg).catch((error) => {
      configuredCache.delete(key);
      throw error;
    });
    configuredCache.set(key, loaded);
    if (configuredCache.size > CONFIGURED_CACHE_LIMIT) {
      const oldest = configuredCache.keys().next().value;
      if (oldest) configuredCache.delete(oldest);
    }
  }
  return loaded;
}

export async function configuredModel(cfg: ModelConfig) {
  const { runtime, model, metadata } = await loadConfigured(cfg);
  return { runtime, model, metadata };
}

export async function modelCatalog(cfg?: ModelConfig) {
  // 自定义端点不继承目录模型；直接返回空列表，也不触发公共目录联网刷新。
  if (cfg?.provider === "custom") return [];
  const runtime = await catalogRuntime();
  const provider = cfg ? providerFor(runtime, cfg) : undefined;
  const rows = runtime
    .getModels(provider)
    .filter((m) => supported(m) && m.baseUrl && runtime.getProvider(m.provider)?.auth.apiKey);
  // Unknown endpoints get no unrelated public models. They can discover IDs or enter one manually.
  if (cfg && !provider) return [];
  return rows
    .filter((m) => !cfg?.base_url || m.api === cfg.api)
    .map((m) => {
      const base = cfg ?? {
        id: m.id,
        provider: m.provider,
        base_url: "",
        api_key: "",
        api: m.api,
        context_window: 0,
      };
      const metadata = metadataFor(
        m,
        {
          ...base,
          id: m.id,
          provider: cfg?.provider || m.provider,
          api: m.api,
          context_window: 0,
          max_output_tokens: 0,
        },
        m,
      );
      return {
        ...metadata,
        base_url: cfg?.base_url ? normalizeModelBaseURL(cfg.base_url, cfg.api) : m.baseUrl,
      };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}

export async function modelProviders(): Promise<ModelProvider[]> {
  const runtime = await catalogRuntime();
  return runtime
    .getProviders()
    .flatMap((p) => {
      const model = runtime.getModels(p.id).find(supported);
      return model && p.auth.apiKey ? [{ id: p.id, name: p.name, base_url: model.baseUrl, api: model.api }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function modelMetadata(cfg: ModelConfig) {
  return (await loadConfigured(cfg)).metadata;
}

/**
 * Settings stay in memory: Tessera never reads Pi's settings.json. Pi owns the
 * compaction policy and its defaults; Tessera only disables it for read-only recovery.
 */
export function modelSettings(_model: PiModel, recovery = false) {
  return SettingsManager.inMemory({ compaction: { enabled: !recovery } });
}
