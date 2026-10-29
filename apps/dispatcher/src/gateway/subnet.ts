import { isIPv4 } from "node:net";

/** A project gateway always receives a /29: one gateway address, one worker address,
 *  the Docker IPAM gateway and broadcast slots stay distinct. */
export const GATEWAY_SUBNET_BITS = 29;

/** IPv4 arithmetic for deterministic project subnets; never relies on signed 32-bit bitwise ops. */
function ipv4Value(value: string) {
  if (!isIPv4(value)) throw new Error(`Invalid IPv4 address: ${value}`);
  return value.split(".").reduce((total, octet) => total * 256 + Number(octet), 0);
}

function ipv4Text(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error("Invalid IPv4 value");
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}

export function subnetRange(subnet: string) {
  const [ip, bitsText, ...rest] = subnet.split("/");
  const bits = Number(bitsText);
  if (rest.length || !isIPv4(ip) || !Number.isInteger(bits) || bits < 0 || bits > 32)
    throw new Error(`Invalid IPv4 subnet: ${subnet}`);
  const size = 2 ** (32 - bits);
  const start = Math.floor(ipv4Value(ip) / size) * size;
  return { start, end: start + size - 1, bits };
}

export function subnetsOverlap(left: string, right: string) {
  try {
    const a = subnetRange(left),
      b = subnetRange(right);
    return a.start <= b.end && b.start <= a.end;
  } catch {
    return false;
  }
}

/** First free subnet of a given bit size inside a pool, ignoring invalid/unrelated reservations. */
export function nextFreeSubnet(pool: string, size: number, used: string[]) {
  const range = subnetRange(pool);
  if (!Number.isInteger(size) || size < range.bits || size > 32)
    throw new Error(`Subnet size /${size} does not fit pool ${pool}`);
  const block = 2 ** (32 - size);
  const occupied = used.filter((subnet) => {
    try {
      subnetRange(subnet);
      return true;
    } catch {
      return false;
    }
  });
  for (let start = range.start; start + block - 1 <= range.end; start += block) {
    const candidate = `${ipv4Text(start)}/${size}`;
    if (!occupied.some((subnet) => subnetsOverlap(candidate, subnet))) return candidate;
  }
  throw new Error(`No free /${size} subnet in ${pool}; enlarge TESSERA_GATEWAY_SUBNET_POOL`);
}

export function gatewaySubnetPool() {
  const pool = process.env.TESSERA_GATEWAY_SUBNET_POOL || "10.250.0.0/16";
  if (subnetRange(pool).bits > GATEWAY_SUBNET_BITS)
    throw new Error(`TESSERA_GATEWAY_SUBNET_POOL must be /${GATEWAY_SUBNET_BITS} or larger`);
  return pool;
}

export function networkAddresses(subnet: string) {
  const { bits } = subnetRange(subnet);
  if (bits > GATEWAY_SUBNET_BITS) throw new Error("Gateway requires an IPv4 subnet with at least 8 addresses");
  const value = ipv4Value(subnet.split("/")[0]);
  const address = (offset: number) => ipv4Text(value + offset);
  return { gateway: address(2), worker: address(3) };
}
