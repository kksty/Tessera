import type { CreateModelRuntimeOptions, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelCatalogStatus } from "../../protocol/src/model-config.js";
import { MODEL_APIS } from "../../protocol/src/model-config.js";

const REFRESH_INTERVAL = 4 * 60 * 60 * 1000;
const RETRY_INTERVAL = 5 * 60 * 1000;

type ModelsStore = NonNullable<CreateModelRuntimeOptions["modelsStore"]>;
export function createCatalogStore(): ModelsStore {
  const entries = new Map<string, NonNullable<Awaited<ReturnType<ModelsStore["read"]>>>>();
  return {
    read: async (id) => entries.get(id),
    write: async (id, entry) => {
      entries.set(id, structuredClone(entry));
    },
    delete: async (id) => {
      entries.delete(id);
    },
  };
}

/** Pi's general refresh skips unauthenticated providers. Public catalog hooks need no credentials. */
export async function refreshPublicCatalog(
  runtime: ModelRuntime,
  store: ModelsStore,
  options: NonNullable<Parameters<ModelRuntime["refresh"]>[0]>,
) {
  const signal = options.signal ?? AbortSignal.timeout(8000);
  const errors = new Map<string, Error>();
  const providers = runtime
    .getProviders()
    .filter(
      (provider) =>
        provider.refreshModels &&
        provider.auth.apiKey &&
        (!options.providers || options.providers.includes(provider.id)) &&
        runtime.getModels(provider.id).some((model) => (MODEL_APIS as readonly string[]).includes(model.api)),
    );
  await Promise.all(
    providers.map(async (provider) => {
      try {
        await provider.refreshModels!({
          credential: undefined,
          stored: await store.read(provider.id),
          allowNetwork: true,
          force: options.force,
          signal,
          publish: async (publication) => {
            if (signal.aborted) return false;
            if (publication.persist === null) await store.delete(provider.id);
            else if (publication.persist !== undefined) await store.write(provider.id, publication.persist);
            if (signal.aborted) return false;
            publication.update?.();
            return true;
          },
        });
      } catch (error) {
        errors.set(provider.id, error instanceof Error ? error : new Error(String(error)));
      }
    }),
  );
  // Rebuild the runtime snapshot from the same cache, without resolving request credentials or fetching.
  await runtime.refresh({ allowNetwork: false });
  return { aborted: signal.aborted, errors };
}

/** Coalesce settings/runner reads; a failed refresh never prevents using the catalog. */
export class CatalogRefresh {
  private pending?: Promise<void>;
  private nextCheck = 0;
  readonly status: ModelCatalogStatus;

  constructor(
    private runtime: Pick<ModelRuntime, "refresh">,
    networkEnabled = process.env.PI_OFFLINE === undefined,
  ) {
    this.status = {
      network_enabled: networkEnabled,
      checked_at: null,
      refreshed_at: null,
      state: networkEnabled ? "builtin" : "offline",
      failed_providers: [],
      refresh_interval_ms: REFRESH_INTERVAL,
    };
  }

  async refresh(force = false) {
    if (!this.status.network_enabled) return;
    if (this.pending) return this.pending;
    if (!force && Date.now() < this.nextCheck) return;
    this.pending = this.update(force).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async update(force: boolean) {
    this.status.checked_at = new Date().toISOString();
    try {
      const result = await this.runtime.refresh({
        allowNetwork: true,
        force: force || this.status.state === "partial" || this.status.state === "failed",
        signal: AbortSignal.timeout(8000),
      });
      this.status.failed_providers = [...result.errors.keys()];
      this.status.state = result.aborted ? "failed" : result.errors.size ? "partial" : "ready";
      if (this.status.state === "ready") this.status.refreshed_at = new Date().toISOString();
    } catch {
      this.status.state = "failed";
      this.status.failed_providers = [];
    }
    this.nextCheck = Date.now() + (this.status.state === "ready" ? REFRESH_INTERVAL : RETRY_INTERVAL);
  }
}
