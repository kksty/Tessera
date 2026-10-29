import { isIPv4 } from "node:net";

/** A published block of host ports a single project may hand out to callbacks. */
export type CallbackAllocation = { host: string; first: number; last: number };

/** One slice of a project's block assigned to a single concurrent Run. */
export type CallbackRange = { first: number; last: number };

/** Callback port pool policy, parsed from TESSERA_CALLBACK_* environment variables. */
export function callbackPolicy() {
  const host = process.env.TESSERA_CALLBACK_HOST || "";
  if (host && !/^[a-zA-Z0-9.-]+$/.test(host))
    throw new Error("TESSERA_CALLBACK_HOST must be an IPv4 address or DNS hostname");
  const range = process.env.TESSERA_CALLBACK_PORTS || "20000-29999";
  const match = /^(\d+)-(\d+)$/.exec(range);
  const size = Number(process.env.TESSERA_CALLBACK_BLOCK_SIZE || "100");
  if (
    !match ||
    Number(match[1]) < 1024 ||
    Number(match[2]) > 65535 ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > 100 ||
    Number(match[2]) - Number(match[1]) + 1 < size
  )
    throw new Error("Invalid callback port pool or block size (1–100)");
  const bind = process.env.TESSERA_CALLBACK_BIND || "0.0.0.0";
  if (!isIPv4(bind)) throw new Error("TESSERA_CALLBACK_BIND must be IPv4");
  return { host, first: Number(match[1]), last: Number(match[2]), size, bind };
}

/** Pick the first fixed-size block that does not overlap any reservation. */
export function allocateCallback(
  policy: ReturnType<typeof callbackPolicy>,
  reserved: CallbackAllocation[],
): CallbackAllocation | null {
  if (!policy.host) return null;
  for (let first = policy.first; first + policy.size - 1 <= policy.last; first += policy.size) {
    const last = first + policy.size - 1;
    if (!reserved.some((item) => first <= item.last && last >= item.first)) return { host: policy.host, first, last };
  }
  throw new Error("Callback port pool exhausted; enlarge TESSERA_CALLBACK_PORTS");
}

/** A project owns one published block; each concurrent Run gets a disjoint slice of it. */
export function callbackSlotCount(allocation: CallbackAllocation | null | undefined, maxSlots: number) {
  if (!allocation || !Number.isInteger(maxSlots) || maxSlots < 1) return 0;
  return Math.max(1, Math.min(maxSlots, allocation.last - allocation.first + 1));
}

export function callbackRange(
  allocation: CallbackAllocation | null | undefined,
  slots: number,
  slot: number,
): CallbackRange | null {
  if (!allocation || !Number.isInteger(slots) || slots < 1 || !Number.isInteger(slot) || slot < 0 || slot >= slots)
    return null;
  const width = allocation.last - allocation.first + 1;
  if (slots > width) return null;
  const stride = Math.floor(width / slots);
  if (stride < 1) return null;
  const first = allocation.first + slot * stride;
  return { first, last: first + stride - 1 };
}
