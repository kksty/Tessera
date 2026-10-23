import { ModelRuntime, SettingsManager, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import {
  MODEL_APIS,
  normalizeModelBaseURL,
  type ModelConfig,
  type ModelMetadata,
  type ModelProvider,
} from "../../protocol/src/model-config.js";
import { CatalogRefresh, createCatalogStore, refreshPublicCatalog } from "./catalog-refresh.js";

type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
const supported = (model: PiModel) => (MODEL_APIS as readonly string[]).includes(model.api);

/** Catalog inspection and API probes never load the user's global Pi credentials/config. */
export function createModelRuntime(options: Pick<CreateModelRuntimeOptions, "catalogBaseUrl" | "modelsStore"> = {}) {
  const credentials: NonNullable<CreateModelRuntimeOptions["credentials"]> = {
    read: async () => undefined,
    list: async () => [],
    modify: async () => {
      throw new Error("Tessera credentials are managed by runtime settings");
    },
    delete: async () => {},
  };
  return ModelRuntime.create({
    ...options,
    credentials,
    modelsPath: null,
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
  const base = normalizeModelBaseURL(cfg.base_url, cfg.api);
  if (!base) return undefined;
  // Exact path matching also distinguishes coding plans from regular API plans.
  return runtime.getModels().find((m) => m.api === cfg.api && normalizeModelBaseURL(m.baseUrl, m.api) === base)
    ?.provider;
}

export function resolveModel(runtime: ModelRuntime, cfg: ModelConfig) {
  const provider = providerFor(runtime, cfg);
  const known = provider ? runtime.getModel(provider, cfg.id) : undefined;
  // Explicit providers use their native protocol unless an endpoint/protocol override is supplied.
  const template = known ?? (provider ? runtime.getModels(provider).find(supported) : undefined);
  const api = cfg.base_url ? cfg.api : (template?.api ?? cfg.api);
  if (!(MODEL_APIS as readonly string[]).includes(api)) throw new Error(`Unsupported model API: ${api}`);
  const compatible = known?.api === api ? known : undefined;
  const baseUrl = normalizeModelBaseURL(cfg.base_url || template?.baseUrl || "", api);
  if (!baseUrl) throw new Error("请先选择 Pi 供应商或填写 API 地址。");
  const catalogWindow = compatible?.contextWindow;
  const contextWindow =
    cfg.context_window > 0
      ? Math.min(cfg.context_window, catalogWindow || cfg.context_window)
      : catalogWindow || 128000;
  const catalogOutput = compatible?.maxTokens;
  const maxTokens = Math.min(
    cfg.max_output_tokens && cfg.max_output_tokens > 0 ? cfg.max_output_tokens : catalogOutput || 16384,
    catalogOutput || Infinity,
    contextWindow - 4096 || 1,
  );
  const model: PiModel = {
    ...compatible,
    id: cfg.id,
    name: compatible?.name || cfg.id,
    provider: provider || "tessera",
    api: api as PiModel["api"],
    baseUrl,
    reasoning: compatible?.reasoning ?? false,
    input: compatible?.input || ["text"],
    contextWindow,
    maxTokens: Math.max(1, maxTokens),
    cost: compatible?.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const metadata: ModelMetadata = {
    id: model.id,
    name: model.name,
    provider: model.provider,
    api,
    base_url: baseUrl,
    context_window: contextWindow,
    max_output_tokens: model.maxTokens,
    context_source:
      cfg.context_window > 0 && (!catalogWindow || cfg.context_window < catalogWindow)
        ? "configured"
        : catalogWindow
          ? "pi"
          : "default",
    output_source:
      cfg.max_output_tokens && cfg.max_output_tokens > 0 && (!catalogOutput || cfg.max_output_tokens < catalogOutput)
        ? "configured"
        : catalogOutput
          ? "pi"
          : "default",
    reasoning: model.reasoning,
    input: model.input,
    ...(compatible
      ? {
          catalog_match: {
            provider: compatible.provider,
            id: compatible.id,
            context_window: compatible.contextWindow,
            max_output_tokens: compatible.maxTokens,
            via: cfg.provider ? ("provider" as const) : ("endpoint" as const),
          },
        }
      : {}),
  };
  return { model, metadata };
}

export async function configuredModel(cfg: ModelConfig) {
  const { model, metadata } = resolveModel(await catalogRuntime(), cfg);
  const runtime = await createModelRuntime();
  runtime.registerProvider(model.provider, { baseUrl: model.baseUrl, models: [model] });
  // Runtime keys are literal, never models.json commands or environment interpolation.
  await runtime.setRuntimeApiKey(model.provider, cfg.api_key || "tessera-no-key");
  return { runtime, model: runtime.getModel(model.provider, model.id)!, metadata };
}

export async function modelCatalog(cfg?: ModelConfig) {
  const runtime = await catalogRuntime();
  const provider = cfg ? providerFor(runtime, cfg) : undefined;
  const rows = runtime
    .getModels(provider)
    .filter((m) => supported(m) && m.baseUrl && runtime.getProvider(m.provider)?.auth.apiKey);
  // Unknown endpoints get no unrelated public models. They can discover IDs or enter one manually.
  if (cfg && !provider) return [];
  return rows
    .filter((m) => !cfg?.base_url || m.api === cfg.api)
    .map(
      (m) =>
        resolveModel(runtime, {
          id: m.id,
          provider: m.provider,
          base_url: cfg?.base_url || "",
          api: cfg?.base_url ? cfg.api : m.api,
          api_key: "",
          context_window: 0,
        }).metadata,
    )
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
  return resolveModel(await catalogRuntime(), cfg).metadata;
}

/** Keep Pi's defaults for ordinary windows; fit its summary and retained history in small deployments. */
export function modelSettings(model: PiModel, recovery = false) {
  const defaults = SettingsManager.inMemory().getCompactionSettings(model);
  return SettingsManager.inMemory({
    compaction: {
      enabled: !recovery,
      reserveTokens: Math.min(defaults.reserveTokens, Math.floor(model.contextWindow / 4)),
      keepRecentTokens: Math.min(defaults.keepRecentTokens, Math.floor(model.contextWindow / 3)),
    },
  });
}
