import type { RuntimeConfig } from "./workspace.js";

export const readOnlyRuntimeField = (config: RuntimeConfig, path: string) =>
  (config.read_only_fields ?? []).some(field => field === path || path.startsWith(field + "."));

/** Source metadata controls behavior only; no env labels are rendered, and locked fields are not submitted. */
export function editableRuntimeUpdate(config: RuntimeConfig) {
  const value = JSON.parse(JSON.stringify(config)) as Record<string, any>;
  delete value.read_only_fields;
  for (const key of ["model", "review_model"]) if (value[key]) delete value[key].api_key_set;
  for (const path of config.read_only_fields ?? []) {
    const [parent, field] = path.split(".");
    if (!field) delete value[parent];
    else if (value[parent]) {
      delete value[parent][field];
      if (!Object.keys(value[parent]).length) delete value[parent];
    }
  }
  return value;
}
