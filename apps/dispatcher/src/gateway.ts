/**
 * Public surface of the project network gateway. The implementation lives in small,
 * single-purpose modules under ./gateway; this facade keeps every existing import
 * (dispatcher, resource cleanup, checks) stable and gives the feature one clear boundary:
 *
 *  - settings  : enable flag, idle timeout, owned Docker resource names
 *  - ingress   : explicit per-project callback bindings
 *  - callbacks : published port blocks and per-Run slices
 *  - subnet    : pure IPv4 / subnet arithmetic
 *  - runtime   : Docker orchestration (ProjectGateway, host bridge rule)
 */
export { gatewayEnabled, gatewayIdleMilliseconds, gatewayNames } from "./gateway/settings.js";
export { ingressConfig } from "./gateway/ingress.js";
export { allocateCallback, callbackPolicy, callbackRange, callbackSlotCount } from "./gateway/callbacks.js";
export type { CallbackAllocation, CallbackRange } from "./gateway/callbacks.js";
export { CallbackSlotRegistry } from "./gateway/slots.js";
export {
  GATEWAY_SUBNET_BITS,
  gatewaySubnetPool,
  networkAddresses,
  nextFreeSubnet,
  subnetRange,
  subnetsOverlap,
} from "./gateway/subnet.js";
export { ProjectGateway, bridgeForwarding } from "./gateway/runtime.js";
