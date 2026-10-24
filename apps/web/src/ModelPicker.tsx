import { useEffect, useRef, useState } from "react";
import type {
  ModelCatalogStatus,
  ModelConfig,
  ModelMetadata,
  ModelProvider,
} from "../../../packages/protocol/src/model-config.js";
import { api } from "./api.js";

type Locks = Partial<Record<keyof ModelConfig, boolean>>;
type Props = {
  model: ModelConfig;
  onChange: (model: ModelConfig) => void;
  readOnly?: Locks;
  scope?: "model" | "review_model";
};

export function ProviderPicker({ model, onChange, readOnly = {}, scope = "model" }: Props) {
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  useEffect(() => {
    let active = true;
    void api<ModelProvider[]>("/runtime/providers")
      .then((rows) => {
        if (active) setProviders(rows);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return (
    <label>
      供应商
      <select
        aria-label={scope === "model" ? "主模型供应商" : "审核模型供应商"}
        disabled={readOnly.provider || readOnly.base_url || readOnly.api}
        value={model.provider || ""}
        onChange={(event) => {
          const provider = providers.find((p) => p.id === event.target.value);
          onChange({
            ...model,
            provider: event.target.value,
            base_url: "",
            api: provider?.api || "openai-completions",
            id: readOnly.id ? model.id : "",
            api_key: readOnly.api_key ? model.api_key : "",
            context_window: readOnly.context_window ? model.context_window : 0,
            max_output_tokens: readOnly.max_output_tokens ? model.max_output_tokens : 0,
          });
        }}
      >
        <option value="">按 API 地址识别（兼容已有配置）</option>
        <option value="custom">自定义 / 中转 API</option>
        {model.provider && model.provider !== "custom" && !providers.some((p) => p.id === model.provider) && (
          <option value={model.provider}>{model.provider}</option>
        )}
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <span className="settings-hint">
        官方 API 可按地址识别；自定义 / 中转 API 不会仅凭同名模型套用官方容量。主模型与审核模型可独立选择。
      </span>
    </label>
  );
}

type Check = {
  ok: boolean;
  model: ModelMetadata;
  elapsed_ms: number;
  compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  capacity: {
    context_window: number;
    output_limit: number;
    context_probe_tokens: number;
    max_tokens: number | null;
    prompt_tokens: number | null;
    cached_tokens: number | null;
    completion_tokens: number | null;
  };
};
const SOURCE_LABELS: Record<string, string> = {
  pi: "Pi 目录",
  api: "API 声明",
  configured: "已配置上限",
  default: "默认值（未识别）",
};
const sourceLabel = (source: string) => SOURCE_LABELS[source] || source;

export function ModelPicker({ model, onChange, readOnly = {}, scope = "model" }: Props) {
  const [models, setModels] = useState<ModelMetadata[]>([]);
  const [busy, setBusy] = useState(false),
    [checking, setChecking] = useState(false);
  const [error, setError] = useState(""),
    [custom, setCustom] = useState(false);
  const [metadata, setMetadata] = useState<ModelMetadata | null>(null),
    [check, setCheck] = useState<Check | null>(null);
  const [catalogStatus, setCatalogStatus] = useState<ModelCatalogStatus | null>(null);
  const current = useRef(model),
    generation = useRef(0);
  current.current = model;
  const configured = !!model.base_url || (!!model.provider && model.provider !== "custom");
  useEffect(() => {
    let active = true;
    void api<ModelCatalogStatus>("/runtime/catalog-status")
      .then((status) => {
        if (active) setCatalogStatus(status);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    generation.current++;
    setBusy(false);
    setChecking(false);
    setError("");
    setCheck(null);
  }, [
    model.provider,
    model.base_url,
    model.api,
    model.api_key,
    model.id,
    model.context_window,
    model.max_output_tokens,
    scope,
  ]);
  useEffect(() => {
    let active = true;
    setModels([]);
    void api<ModelMetadata[]>("/runtime/catalog", { ...model, api_key: "" })
      .then((rows) => {
        if (active) setModels(rows);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [model.provider, model.base_url, model.api]);
  useEffect(() => {
    let active = true;
    setMetadata(null);
    if (model.id && configured)
      void api<ModelMetadata>("/runtime/model-metadata", { ...model, api_key: "" })
        .then((row) => {
          if (active) setMetadata(row);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [model.provider, model.base_url, model.api, model.id, model.context_window, model.max_output_tokens]);

  async function load() {
    const version = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await api<ModelMetadata[]>("/runtime/models", { ...model, scope });
      if (version !== generation.current) return;
      setModels(result);
      const selected = result.find((m) => m.id === current.current.id);
      if (selected) {
        const next = { ...current.current };
        if (selected.context_source === "api" && !readOnly.context_window && !next.context_window)
          next.context_window = selected.context_window;
        if (selected.output_source === "configured" && !readOnly.max_output_tokens && !next.max_output_tokens)
          next.max_output_tokens = selected.max_output_tokens;
        if (
          next.context_window !== current.current.context_window ||
          next.max_output_tokens !== current.current.max_output_tokens
        )
          onChange(next);
      }
      if (!result.length) setError("接口没有返回模型，可手动填写模型 ID。");
    } catch (e) {
      if (version === generation.current) setError((e as Error).message);
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }
  async function test() {
    const version = ++generation.current;
    setChecking(true);
    setError("");
    setCheck(null);
    try {
      const result = await api<Check>("/runtime/model-check", { ...model, scope });
      if (version === generation.current) {
        setCheck(result);
        setMetadata(result.model);
      }
    } catch (e) {
      if (version === generation.current) setError((e as Error).message);
    } finally {
      if (version === generation.current) setChecking(false);
    }
  }
  async function refreshCatalog() {
    const version = ++generation.current;
    setBusy(true);
    setError("");
    setCheck(null);
    try {
      const status = await api<ModelCatalogStatus>("/runtime/catalog-refresh", {});
      const cfg = { ...current.current, api_key: "" };
      const [rows, details] = await Promise.all([
        api<ModelMetadata[]>("/runtime/catalog", cfg),
        cfg.id && configured ? api<ModelMetadata>("/runtime/model-metadata", cfg) : Promise.resolve(null),
      ]);
      if (version !== generation.current) return;
      setCatalogStatus(status);
      setModels(rows);
      setMetadata(details);
    } catch (e) {
      if (version === generation.current) setError((e as Error).message);
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }
  return (
    <div className="model-picker">
      <div className="model-catalog-status">
        <div>
          <strong>Pi 模型目录</strong>
          <p>
            {!catalogStatus
              ? "正在检查目录…"
              : !catalogStatus.network_enabled
                ? "离线模式：使用内置目录。"
                : catalogStatus.state === "ready"
                  ? "联网目录检查完成；优先使用较新的目录数据。"
                  : catalogStatus.state === "partial"
                    ? "部分供应商刷新失败，继续使用可用目录。"
                    : catalogStatus.state === "failed"
                      ? "联网刷新失败，继续使用已有目录或内置目录。"
                      : "使用内置目录，等待联网检查。"}
          </p>
          {catalogStatus?.checked_at && <p>最近检查：{new Date(catalogStatus.checked_at).toLocaleString()}</p>}
          {!!catalogStatus?.failed_providers.length && (
            <p>刷新失败的供应商：{catalogStatus.failed_providers.join("、")}</p>
          )}
          <p>启用联网时，使用模型目录会每 4 小时自动检查；失败后 5 分钟可重试。刷新目录不会探测中转的真实容量。</p>
        </div>
        <button
          type="button"
          disabled={busy || checking || catalogStatus?.network_enabled === false}
          onClick={() => void refreshCatalog()}
        >
          {busy ? "处理中…" : "刷新 Pi 目录"}
        </button>
      </div>
      <label>
        模型
        <div className="model-picker-row">
          <select
            aria-label="选择模型"
            disabled={readOnly.id}
            value={custom ? "__custom" : model.id}
            onChange={(event) => {
              if (event.target.value === "__custom") {
                setCustom(true);
                return;
              }
              setCustom(false);
              const selected = models.find((m) => m.id === event.target.value);
              onChange({
                ...model,
                id: event.target.value,
                context_window: readOnly.context_window
                  ? model.context_window
                  : selected?.context_source === "api"
                    ? selected.context_window
                    : 0,
                max_output_tokens: readOnly.max_output_tokens
                  ? model.max_output_tokens
                  : selected?.output_source === "configured"
                    ? selected.max_output_tokens
                    : 0,
              });
            }}
          >
            <option value="">暂不选择模型</option>
            {model.id && !models.some((m) => m.id === model.id) && <option value={model.id}>{model.id}</option>}
            {models.map((m) => (
              <option key={`${m.provider}/${m.id}`} value={m.id}>
                {m.name}
              </option>
            ))}
            <option value="__custom">自定义模型名称…</option>
          </select>
          <button type="button" disabled={busy || checking || !configured} onClick={() => void load()}>
            {busy ? "获取中…" : "获取模型"}
          </button>
          <button type="button" disabled={busy || checking || !configured || !model.id} onClick={() => void test()}>
            {checking ? "检测中…" : "检测 API"}
          </button>
        </div>
        <span className="settings-hint">检测会发送一次真实容量请求：上下文检测加当前输出上限，可能需要几十秒。</span>
      </label>
      {custom && (
        <label>
          自定义模型名称
          <input
            disabled={readOnly.id}
            value={model.id}
            onChange={(event) => onChange({ ...model, id: event.target.value })}
            placeholder="接口未列出的模型 ID"
          />
        </label>
      )}
      <div className="settings-grid">
        <label>
          上下文窗口（tokens）
          <input
            type="number"
            min={0}
            step={1}
            disabled={readOnly.context_window}
            value={model.context_window}
            onChange={(event) => onChange({ ...model, context_window: Number(event.target.value) })}
          />
          <span className="settings-hint">
            0 自动：匹配 Pi 目录时使用目录容量，未匹配时默认 128,000。实际生效值见下方。
          </span>
        </label>
        <label>
          输出上限（tokens）
          <input
            type="number"
            min={0}
            step={1}
            disabled={readOnly.max_output_tokens}
            value={model.max_output_tokens ?? 0}
            onChange={(event) => onChange({ ...model, max_output_tokens: Number(event.target.value) })}
          />
          <span className="settings-hint">
            0 自动：使用 Pi 目录输出上限，未匹配时默认 16,384。每次请求还会根据剩余上下文缩减输出预算。
          </span>
        </label>
      </div>
      {metadata && (
        <div className="model-effective-config" aria-label="Pi 模型配置">
          <strong>当前有效配置</strong>
          <p>模型 ID：{metadata.id}</p>
          <p>
            请求协议：{metadata.api} · API 地址：{metadata.base_url}
          </p>
          <p>
            {metadata.catalog_match
              ? `目录已匹配：${metadata.catalog_match.provider} / ${metadata.catalog_match.id}（${metadata.catalog_match.via === "provider" ? "按所选供应商和模型 ID" : "按 API 地址、协议和模型 ID"}）`
              : "目录未匹配：此部署的容量无法从 Pi 目录确定。"}
          </p>
          <dl>
            <div>
              <dt>有效上下文窗口</dt>
              <dd>
                {metadata.context_window.toLocaleString()} tokens{" "}
                <span>来源：{sourceLabel(metadata.context_source)}</span>
              </dd>
            </div>
            <div>
              <dt>有效输出上限</dt>
              <dd>
                {metadata.max_output_tokens.toLocaleString()} tokens{" "}
                <span>来源：{sourceLabel(metadata.output_source)}</span>
              </dd>
            </div>
          </dl>
          {metadata.catalog_match && (
            <p>
              目录参考：上下文 {metadata.catalog_match.context_window.toLocaleString()}；输出{" "}
              {metadata.catalog_match.max_output_tokens.toLocaleString()}{" "}
              tokens。手动配置作为上限，不超过匹配的目录容量。
            </p>
          )}
          {(metadata.context_source === "default" || metadata.output_source === "default") && (
            <p>正在使用未知部署默认值，不代表后端真实上限。请按供应商或中转的实际限制填写。</p>
          )}
          <p>
            能力声明：{metadata.reasoning ? "支持推理" : metadata.catalog_match ? "普通对话" : "推理能力未知"} ·{" "}
            {metadata.input.includes("image") ? "文本 / 图像" : metadata.catalog_match ? "文本" : "按文本模式接入"}
          </p>
          {!check && <p>目录与协议声明不等于部署真实上限；「检测 API」会按当前输出上限发起一次真实容量请求。</p>}
        </div>
      )}
      {check && (
        <p role="status">
          容量探测通过（{check.elapsed_ms.toLocaleString()} ms）：按声明的{" "}
          {check.capacity.context_window.toLocaleString()} tokens 窗口，发送了上下文检测{" "}
          {check.capacity.context_probe_tokens.toLocaleString()} tokens + 输出上限{" "}
          {(check.capacity.max_tokens ?? check.capacity.output_limit).toLocaleString()} tokens
          {check.capacity.prompt_tokens === null
            ? ""
            : `（部署实测提示词 ${check.capacity.prompt_tokens.toLocaleString()} tokens${
                check.capacity.cached_tokens ? `，其中缓存读 ${check.capacity.cached_tokens.toLocaleString()}` : ""
              }、输出 ${(check.capacity.completion_tokens ?? 0).toLocaleString()} tokens）`}
          。自动压缩{check.compaction.enabled ? "已启用" : "已关闭"}，预留{" "}
          {check.compaction.reserveTokens.toLocaleString()} tokens。
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
