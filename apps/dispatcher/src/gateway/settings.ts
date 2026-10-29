/** Gateway mode is opt-in: without a gateway image the dispatcher keeps the legacy topology. */
export const gatewayEnabled = () => Boolean(process.env.TESSERA_GATEWAY_IMAGE);

/** Idle timeout before an active project's gateway is stopped; 0 disables idle shutdown. */
export function gatewayIdleMilliseconds(value = process.env.TESSERA_GATEWAY_IDLE_SECONDS) {
  if (value === undefined || value.trim() === "") return 600_000;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0)
    throw new Error("TESSERA_GATEWAY_IDLE_SECONDS must be a non-negative number of seconds");
  return Math.floor(seconds * 1000);
}

/** All Docker resource names a project gateway owns (container, isolated network, CA and data volumes). */
export function gatewayNames(prefix: string, project: string) {
  if (![prefix, project].every((value) => /^[a-zA-Z0-9_.-]+$/.test(value)))
    throw new Error("Invalid project network name");
  return {
    gateway: `${prefix}-gateway-${project}`,
    network: `${prefix}-isolated-${project}`,
    ca: `${prefix}-gateway-ca-${project}`,
    data: `${prefix}-gateway-data-${project}`,
  };
}
