import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelConfig } from "../../protocol/src/model-config.js";

type Transport = { original: string; relay: string };
const context = new AsyncLocalStorage<Transport>();
const upstream = globalThis.fetch;
// Pi's ordinary turns and compaction both use fetch. Async context keeps concurrent Runs isolated.
globalThis.fetch = async (input, init) => {
  const transport = context.getStore();
  if (!transport) return upstream(input, init);
  const request = new Request(input, init);
  const url = request.url;
  if (!url.startsWith(transport.original + "/")) return upstream(input, init);
  const suffix = url.slice(transport.original.length);
  return upstream(new Request(transport.relay + suffix, request));
};

export function withModelRelay<T>(relay: { base_url: string } | undefined, model: ModelConfig, run: () => T): T {
  return relay
    ? context.run(
        {
          original: new URL(model.base_url).toString().replace(/\/$/, ""),
          relay: new URL(relay.base_url).toString().replace(/\/$/, ""),
        },
        run,
      )
    : run();
}
