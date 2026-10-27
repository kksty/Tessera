import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ChevronRight,
  Cpu,
  Download,
  FileText,
  Gauge,
  Network,
  RotateCcw,
  Save,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { api } from "../api.js";
import { ModelPicker, ProviderPicker } from "../ModelPicker.js";
import type { ModelConfig } from "../../../../packages/protocol/src/model-config.js";
import { Preferences } from "../WorkbenchTools.js";
import { Card, Field, PageHeader, Skeleton } from "../components/ui.js";
import { editableRuntimeUpdate, readOnlyRuntimeField } from "../runtime-config.js";
import { changedPaths, changeSummary, FIELD_LABELS, reviewModelEnabled, runtimeFieldErrors } from "../settings-form.js";
import type { RuntimeConfig, RuntimeModel } from "../workspace.js";
import { useWorkspace } from "../workspace.js";

const API_PROTOCOLS = [
  ["openai-completions", "OpenAI 兼容 · Chat Completions"],
  ["openai-responses", "OpenAI 兼容 · Responses"],
  ["anthropic-messages", "Anthropic Messages"],
] as const;

/** 独立审核模型的初始值；留空保存即恢复为“与主模型共用”。 */
const blankReviewModel = (): RuntimeModel => ({
  id: "",
  base_url: "",
  api_key: "",
  api: "openai-completions",
  provider: "",
  context_window: 0,
  max_output_tokens: 0,
});

/** 分区索引：点击跳转，滚动时高亮当前分区。 */
const SECTIONS = [
  ["model", "主模型"],
  ["review", "审核模型"],
  ["runtime", "执行与调度"],
  ["capture", "流量采集"],
  ["budget", "收尾与预算"],
  ["logs", "运行日志"],
] as const;

type SectionKey = (typeof SECTIONS)[number][0];

const sectionOf = (path: string): SectionKey => {
  if (path.startsWith("model.")) return "model";
  if (path.startsWith("review_model.") || path === "skip_informational_review") return "review";
  if (path === "capture_enabled") return "capture";
  if (path === "closeout_seconds" || path === "tool_timeout_seconds" || path === "result_repairs") return "budget";
  return "runtime";
};

/** 离开设置页后保留未保存的草稿；配置本身变化（保存、外部刷新）时作废。 */
let pendingDraft: { baseline: string; draft: RuntimeConfig; reviewEnabled: boolean } | null = null;

function restoreDraft(config: RuntimeConfig | null) {
  if (!config || !pendingDraft) return null;
  return pendingDraft.baseline === JSON.stringify(editableRuntimeUpdate(config)) ? pendingDraft : null;
}

function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  disabled,
  error,
  wide,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  error?: string;
  wide?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className={wide ? "settings-field-wide" : undefined}>
      <Field label={label} htmlFor={id} hint={hint} error={disabled ? undefined : error}>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          aria-invalid={!disabled && error ? true : undefined}
          value={Number.isFinite(value) ? value : 0}
          onChange={(event) => {
            const next = Number(event.target.value);
            onChange(Number.isFinite(next) ? next : 0);
          }}
        />
      </Field>
    </div>
  );
}

export function SettingsPage() {
  const ws = useWorkspace();
  const baseline = ws.config;
  const restored = restoreDraft(baseline);
  const [draft, setDraft] = useState<RuntimeConfig | null>(restored?.draft ?? baseline);
  const [reviewEnabled, setReviewEnabled] = useState(
    restored ? restored.reviewEnabled : reviewModelEnabled(baseline?.review_model),
  );
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const [clampNote, setClampNote] = useState("");
  const [logProject, setLogProject] = useState("");
  const [activeSection, setActiveSection] = useState<SectionKey>("model");
  const saveRef = useRef<() => void>(() => {});
  const spyPause = useRef(0);
  const navRef = useRef<HTMLElement>(null);
  const selectedLogProject = ws.projects.some((project) => project.id === logProject)
    ? logProject
    : ws.projects[0]?.id || "";

  // App 进入设置页时才拉取配置；这里补一次读取，失败时才能给出可重试的错误态。
  const setConfig = ws.setConfig;
  useEffect(() => {
    if (baseline) return;
    let active = true;
    setLoadError("");
    void api<RuntimeConfig>("/runtime")
      .then((config) => {
        if (active) setConfig(config);
      })
      .catch((failure: unknown) => {
        if (active) setLoadError(failure instanceof Error ? failure.message : "读取运行配置失败");
      });
    return () => {
      active = false;
    };
  }, [baseline, retryKey, setConfig]);

  // 配置变化（首次加载、保存成功、外部刷新）时回到最新配置；只是重新进入页面时恢复未保存草稿。
  useEffect(() => {
    const pending = restoreDraft(ws.config);
    const next = pending?.draft ?? ws.config;
    setDraft(next);
    setReviewEnabled(pending ? pending.reviewEnabled : reviewModelEnabled(next?.review_model));
    setClampNote("");
  }, [ws.config]);

  const changes = useMemo(
    () => (draft && baseline ? changedPaths(editableRuntimeUpdate(baseline), editableRuntimeUpdate(draft)) : []),
    [draft, baseline],
  );
  const dirty = changes.length > 0;
  const errors = useMemo(() => (draft ? runtimeFieldErrors(draft, reviewEnabled) : {}), [draft, reviewEnabled]);
  const errorKeys = useMemo(() => Object.keys(errors), [errors]);
  const invalid = errorKeys.length > 0;
  const summary = useMemo(() => changeSummary(changes), [changes]);
  const changedSections = useMemo(() => new Set(changes.map(sectionOf)), [changes]);
  const ready = draft !== null;
  const locked = (field: string) => (draft ? readOnlyRuntimeField(draft, field) : false);
  const lockedHint = (field: string, hint?: string) =>
    locked(field) ? `${hint ? `${hint} ` : ""}由环境变量管理，不可在此修改。` : hint;
  const reviewLocked =
    locked("review_model.base_url") ||
    locked("review_model.id") ||
    locked("review_model.api_key") ||
    locked("review_model.provider");
  const modelLocks = (scope: "model" | "review_model") =>
    Object.fromEntries(
      ["provider", "id", "base_url", "api", "api_key", "context_window", "max_output_tokens"].map((key) => [
        key,
        locked(`${scope}.${key}`),
      ]),
    );
  const changeModel = (scope: "model" | "review_model", next: ModelConfig) => {
    if (!draft) return;
    const previous = draft[scope];
    // 按地址识别与自定义只改变目录匹配方式，端点没变时保留已保存的密钥。
    const native = (provider?: string) => !!provider && provider !== "custom";
    const reconnected =
      previous?.base_url !== next.base_url ||
      previous?.api !== next.api ||
      (previous?.provider !== next.provider && (native(previous?.provider) || native(next.provider)));
    setDraft({
      ...draft,
      [scope]: {
        ...previous,
        ...next,
        api_key: reconnected && previous?.api_key === next.api_key && !locked(`${scope}.api_key`) ? "" : next.api_key,
        api_key_set: reconnected ? false : previous?.api_key_set,
      },
    });
  };
  const review = draft?.review_model;

  function setReviewModel(enabled: boolean) {
    if (!draft || reviewLocked) return;
    setReviewEnabled(enabled);
    setDraft({
      ...draft,
      review_model: enabled ? (draft.review_model ?? blankReviewModel()) : blankReviewModel(),
    });
  }

  const changeTaskTimeout = (next: number) => {
    if (!draft) return;
    const seconds = Math.max(0, Math.round(next));
    const closeout = draft.closeout_seconds ?? 60;
    const ceiling = Math.max(1, seconds - 1);
    if (seconds > 0 && !locked("closeout_seconds") && closeout > ceiling) {
      setClampNote(`收尾预留已收紧到 ${ceiling} 秒：必须小于单次任务超时。`);
      setDraft({ ...draft, task_timeout_seconds: seconds, closeout_seconds: ceiling });
      return;
    }
    setClampNote("");
    setDraft({ ...draft, task_timeout_seconds: seconds });
  };

  async function save() {
    if (!draft || !dirty || saving || invalid) return;
    setSaving(true);
    try {
      await api<RuntimeConfig>("/runtime", editableRuntimeUpdate(draft), "PUT");
      const fresh = await api<RuntimeConfig>("/runtime");
      ws.setConfig(fresh);
      setDraft(fresh);
      setReviewEnabled(reviewModelEnabled(fresh.review_model));
      setClampNote("");
      ws.setMessage("设置已保存");
    } catch (failure) {
      ws.setError(failure instanceof Error ? failure.message : "保存设置失败");
    } finally {
      setSaving(false);
    }
  }
  saveRef.current = () => {
    void save();
  };

  /** 记下未保存的草稿：切到别的页面再回来时继续编辑，而不是静默丢弃。 */
  useEffect(() => {
    if (!draft || !baseline) {
      pendingDraft = null;
      return;
    }
    const base = editableRuntimeUpdate(baseline);
    const changes = changedPaths(base, editableRuntimeUpdate(draft));
    pendingDraft = changes.length ? { baseline: JSON.stringify(base), draft, reviewEnabled } : null;
  }, [draft, baseline, reviewEnabled]);

  /** 刷新或关闭标签页前提醒，避免误丢修改。 */
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /** ⌘/Ctrl + S 直接保存，与底部保存条一致。 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      saveRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** 滚动时高亮当前分区，分区按钮据此指示位置与未保存修改。 */
  useEffect(() => {
    if (!ready) return;
    const root = document.querySelector<HTMLElement>(".content");
    if (!root) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      // 只有导航真正吸顶时才补上 .content 的上内边距；否则这块背景会盖住
      // 页头的模型状态行，表现为标签被裁掉一半。
      const nav = navRef.current;
      if (nav) {
        const paddingTop = Number.parseFloat(getComputedStyle(root).paddingTop) || 0;
        const stuck = nav.getBoundingClientRect().top <= root.getBoundingClientRect().top + paddingTop + 0.5;
        nav.dataset.stuck = stuck ? "true" : "false";
      }
      if (Date.now() < spyPause.current) return;
      const navHeight = nav?.getBoundingClientRect().height ?? 0;
      const threshold = root.getBoundingClientRect().top + navHeight + 32;
      let current: SectionKey = SECTIONS[0][0];
      for (const [key] of SECTIONS) {
        const section = document.getElementById(`settings-${key}`);
        if (section && section.getBoundingClientRect().top <= threshold) current = key;
      }
      // 滚到底时最后一节可能永远够不到阈值，直接认为它在当前位置。
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) current = SECTIONS[SECTIONS.length - 1][0];
      setActiveSection(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    root.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      root.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ready]);

  const jumpTo = (key: SectionKey) => {
    // 滚动动画期间暂停观察，避免刚选中的分区被中途的位置计算覆盖。
    spyPause.current = Date.now() + 700;
    document.getElementById(`settings-${key}`)?.scrollIntoView({ block: "start" });
    setActiveSection(key);
  };

  if (!draft) {
    return (
      <section className="page page-settings">
        <PageHeader
          eyebrow="WORKSPACE / SETTINGS"
          title="设置"
          description="模型连接、执行并发与收尾预算。密钥只写不回显。"
        />
        {loadError ? (
          <div className="banner danger" role="alert">
            <AlertCircle size={15} aria-hidden="true" />
            <span>{loadError}</span>
            <button type="button" className="button small" onClick={() => setRetryKey((value) => value + 1)}>
              重试
            </button>
          </div>
        ) : (
          <Card>
            <div className="settings-skeleton">
              <Skeleton rows={7} />
            </div>
          </Card>
        )}
      </section>
    );
  }

  const readOnlyCount = draft.read_only_fields?.length ?? 0;
  const closeoutDisabled = locked("closeout_seconds") || draft.task_timeout_seconds === 0;
  const closeoutMax =
    draft.task_timeout_seconds === 0 ? 300 : Math.min(300, Math.max(1, draft.task_timeout_seconds - 1));
  // 仅既有 Pi 原生供应商配置会省略地址；新配置必须填写 API 地址。
  const mainPiAuto = !!draft.model.provider && draft.model.provider !== "custom" && !draft.model.base_url;
  const reviewPiAuto = !!review?.provider && review.provider !== "custom" && !review.base_url;

  return (
    <section className="page page-settings">
      <PageHeader
        eyebrow="WORKSPACE / SETTINGS"
        title="设置"
        description="模型连接、执行并发与收尾预算统一在这里配置；密钥保存在服务端，不回显。"
        meta={
          <>
            <span className="status-pill" data-tone={draft.model.id ? "accent" : "warn"}>
              <i aria-hidden="true" />
              {draft.model.id || "未选择模型"}
            </span>
            <span className="settings-source">
              {readOnlyCount ? `${readOnlyCount} 项由环境变量管理，其余可在此修改` : "当前没有由环境变量锁定的字段"}
            </span>
          </>
        }
      />

      <nav className="settings-nav" aria-label="设置分区" ref={navRef}>
        {SECTIONS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-current={activeSection === key ? "true" : undefined}
            onClick={() => jumpTo(key)}
          >
            {label}
            {changedSections.has(key) && <span className="settings-nav-flag" role="img" aria-label="有未保存修改" />}
          </button>
        ))}
      </nav>

      <div className="section-stack">
        <Card id="settings-model" title="主模型" note="未配置独立审核模型时共用" icon={<Cpu size={15} />}>
          <div className="settings-grid">
            <div className="settings-field-wide">
              <ProviderPicker
                model={draft.model}
                readOnly={modelLocks("model")}
                onChange={(model) => changeModel("model", model)}
              />
            </div>
            <Field
              label="API 地址"
              htmlFor="settings-base-url"
              hint={lockedHint(
                "model.base_url",
                mainPiAuto
                  ? "当前沿用 Pi 原生供应商的默认地址；改选接入方式后需填写 API 地址。"
                  : "必填。官方端点可按地址识别目录容量；中转地址请选择「自定义 / 中转 API」。",
              )}
            >
              <input
                id="settings-base-url"
                type="url"
                autoComplete="off"
                spellCheck={false}
                disabled={locked("model.base_url")}
                value={draft.model.base_url}
                placeholder="https://api.example.com/v1"
                onChange={(event) => changeModel("model", { ...draft.model, base_url: event.target.value })}
              />
            </Field>

            <Field
              label="API Key"
              htmlFor="settings-api-key"
              hint={lockedHint(
                "model.api_key",
                draft.model.api_key_set ? "已保存密钥，留空表示继续沿用。" : "密钥保存在服务端，保存后不再回显。",
              )}
            >
              <input
                id="settings-api-key"
                type="password"
                autoComplete="new-password"
                disabled={locked("model.api_key")}
                value={draft.model.api_key}
                placeholder={draft.model.api_key_set ? "••••••••（已保存）" : "填写密钥"}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    model: { ...draft.model, api_key: event.target.value },
                  })
                }
              />
            </Field>

            <div className="settings-field-wide">
              <Field
                label="接口协议"
                htmlFor="settings-api-protocol"
                hint={lockedHint("model.api", "须与供应商暴露的接口一致。")}
              >
                <select
                  id="settings-api-protocol"
                  disabled={locked("model.api") || mainPiAuto}
                  value={mainPiAuto ? "__pi" : draft.model.api}
                  onChange={(event) => setDraft({ ...draft, model: { ...draft.model, api: event.target.value } })}
                >
                  {mainPiAuto && (
                    <option value="__pi" disabled>
                      Pi 按所选模型自动配置
                    </option>
                  )}
                  {API_PROTOCOLS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="settings-grid-note">
              <p className="settings-hint">
                更换 API 地址、协议或 Pi 原生供应商后需要重新填写密钥；仅在「按 API 地址识别」与「自定义 / 中转
                API」之间切换不会清除密钥。Pi 负责协议、请求重试、输出控制与会话压缩。
              </p>
            </div>
          </div>

          <div className="settings-model">
            <ModelPicker
              model={draft.model}
              readOnly={modelLocks("model")}
              onChange={(model) => changeModel("model", model)}
            />
          </div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={draft.model.disable_thinking === true}
              disabled={locked("model.disable_thinking") || saving}
              onChange={(event) => changeModel("model", { ...draft.model, disable_thinking: event.target.checked })}
            />
            <span>关闭模型思考通道（Qwen / vLLM：enable_thinking=false）</span>
          </label>
          <p className="settings-hint">
            开启后，每次模型请求都会附带 <code>chat_template_kwargs</code> 中的 <code>enable_thinking=false</code>
            ；不识别该参数的供应商会忽略它。
          </p>
          <details className="settings-disclosure">
            <summary>
              <ChevronRight size={12} aria-hidden="true" />
              为什么长上下文下需要关闭思考通道
            </summary>
            <p className="settings-hint">
              长上下文下 Qwen 的思考内容可能被当成正文或工具名（出现 <code>&lt;/think&gt;</code>、
              <code>&lt;/parameter&gt;</code> 等标记），导致空回复或最终 JSON 无效；此时应关闭思考通道。
            </p>
          </details>
        </Card>

        <Card
          id="settings-review"
          title="审核模型"
          note="候选发现可用独立模型审核；未启用时与主模型共用"
          icon={<ShieldCheck size={15} />}
        >
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={reviewEnabled || reviewLocked}
              disabled={reviewLocked || saving}
              onChange={(event) => setReviewModel(event.target.checked)}
            />
            <span>使用独立审核模型</span>
          </label>
          {reviewLocked && <p className="settings-hint">审核模型由环境变量管理，不能在此关闭或修改。</p>}
          {!reviewEnabled && !reviewLocked && <p className="settings-hint">未启用：Review 使用主模型与主模型密钥。</p>}
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={draft.skip_informational_review === true}
              disabled={locked("skip_informational_review") || saving}
              onChange={(event) => setDraft({ ...draft, skip_informational_review: event.target.checked })}
            />
            <span>信息类免审（只审核漏洞类）</span>
          </label>
          <p className="settings-hint">
            {draft.skip_informational_review === true
              ? "已开启：明确标注为信息类、且引用原始证据的发现直接归档，漏洞类与待分类仍需审核。"
              : "关闭：新提交的发现都进入审核；信息类通过后保留在发现页，不计入漏洞库和风险。"}
          </p>
          <details className="settings-disclosure">
            <summary>
              <ChevronRight size={12} aria-hidden="true" />
              免审边界与历史记录
            </summary>
            <p className="settings-hint">
              {draft.skip_informational_review === true
                ? "无证据的候选仍会进入审核；已在审核中的信息类不会被打断；开启会让独立审核对信息类失效，请确认这是有意的审核范围收窄。"
                : "此前已免审的信息类保持原状，需要重审的请在发现页逐条点“重新审核”（或批量重审），历史审核记录不会删除。"}
            </p>
          </details>
          {reviewEnabled && review && (
            <>
              <div className="settings-grid">
                <div className="settings-field-wide">
                  <ProviderPicker
                    scope="review_model"
                    model={review}
                    readOnly={modelLocks("review_model")}
                    onChange={(model) => changeModel("review_model", model)}
                  />
                </div>
                <Field
                  label="API 地址"
                  htmlFor="settings-review-base-url"
                  error={locked("review_model.base_url") ? undefined : errors["review_model.base_url"]}
                  hint={lockedHint(
                    "review_model.base_url",
                    reviewPiAuto
                      ? "当前沿用 Pi 原生供应商的默认地址；改选接入方式后需填写 API 地址。"
                      : "必填。官方端点可按地址识别目录容量；中转地址请选择「自定义 / 中转 API」。",
                  )}
                >
                  <input
                    id="settings-review-base-url"
                    type="url"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={locked("review_model.base_url")}
                    value={review.base_url}
                    placeholder="https://api.example.com/v1"
                    onChange={(event) => changeModel("review_model", { ...review, base_url: event.target.value })}
                  />
                </Field>

                <Field
                  label="API Key"
                  htmlFor="settings-review-api-key"
                  hint={lockedHint(
                    "review_model.api_key",
                    review.api_key_set ? "已保存密钥，留空表示继续沿用。" : "独立审核模型的密钥，保存后不再回显。",
                  )}
                >
                  <input
                    id="settings-review-api-key"
                    type="password"
                    autoComplete="new-password"
                    disabled={locked("review_model.api_key")}
                    value={review.api_key}
                    placeholder={review.api_key_set ? "••••••••（已保存）" : "填写密钥"}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        review_model: { ...review, api_key: event.target.value },
                      })
                    }
                  />
                </Field>

                <div className="settings-field-wide">
                  <Field
                    label="接口协议"
                    htmlFor="settings-review-api-protocol"
                    hint={lockedHint("review_model.api", "须与供应商暴露的接口一致。")}
                  >
                    <select
                      id="settings-review-api-protocol"
                      disabled={locked("review_model.api") || reviewPiAuto}
                      value={reviewPiAuto ? "__pi" : review.api}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          review_model: { ...review, api: event.target.value },
                        })
                      }
                    >
                      {reviewPiAuto && (
                        <option value="__pi" disabled>
                          Pi 按所选模型自动配置
                        </option>
                      )}
                      {API_PROTOCOLS.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                <div className="settings-grid-note">
                  <p className="settings-hint">
                    审核模型须有模型 ID 和 API 地址；密钥独立保存。取消勾选并保存，将恢复与主模型共用。
                  </p>
                </div>
              </div>

              <div className="settings-model">
                <ModelPicker
                  scope="review_model"
                  model={review}
                  readOnly={modelLocks("review_model")}
                  onChange={(model) => changeModel("review_model", model)}
                />
                {!locked("review_model.id") && errors["review_model.id"] && (
                  <p className="field-error" role="alert">
                    {errors["review_model.id"]}
                  </p>
                )}
              </div>
            </>
          )}
        </Card>

        <Card id="settings-runtime" title="执行与调度" note="并发上限、心跳与本地偏好" icon={<Gauge size={15} />}>
          <div className="settings-preferences">
            <Preferences afterChange={ws.action} />
            <span className="settings-hint">
              Actor 与默认布局保存在此浏览器；面板内的心跳超时保存在服务端，独立保存。
            </span>
          </div>
          <div className="settings-grid">
            <NumberField
              id="settings-max-workers"
              label="总并发"
              hint={lockedHint("max_workers", "同时运行的任务上限，1–64。")}
              value={draft.max_workers}
              min={1}
              max={64}
              disabled={locked("max_workers")}
              error={errors.max_workers}
              onChange={(value) => setDraft({ ...draft, max_workers: value })}
            />
            <NumberField
              id="settings-max-project-workers"
              label="单项目并发"
              hint={lockedHint("max_project_workers", "单个项目内同时运行的任务数，1–32。")}
              value={draft.max_project_workers}
              min={1}
              max={32}
              disabled={locked("max_project_workers")}
              error={errors.max_project_workers}
              onChange={(value) => setDraft({ ...draft, max_project_workers: value })}
            />
            <NumberField
              id="settings-max-project-review-workers"
              label="单项目审核并发"
              hint={lockedHint(
                "max_project_review_workers",
                `审核同时运行的上限，默认 1；实际最多 ${draft.max_project_workers} 个。已有任务继续运行。`,
              )}
              value={draft.max_project_review_workers ?? 1}
              min={1}
              max={32}
              disabled={locked("max_project_review_workers")}
              error={errors.max_project_review_workers}
              onChange={(value) => setDraft({ ...draft, max_project_review_workers: value })}
            />
            <NumberField
              id="settings-interval-ms"
              label="调度间隔（毫秒）"
              hint={lockedHint("interval_ms", "调度器轮询新任务的间隔，建议 1000。")}
              value={draft.interval_ms}
              min={500}
              step={100}
              disabled={locked("interval_ms")}
              error={errors.interval_ms}
              onChange={(value) => setDraft({ ...draft, interval_ms: value })}
            />
            <NumberField
              id="settings-debounce-ms"
              label="决策合并等待（毫秒）"
              hint={lockedHint("debounce_ms", "同一批结果合并成一次决策的等待时间，建议 2000。")}
              value={draft.debounce_ms}
              min={0}
              step={100}
              disabled={locked("debounce_ms")}
              error={errors.debounce_ms}
              onChange={(value) => setDraft({ ...draft, debounce_ms: value })}
            />
            <NumberField
              id="settings-task-timeout"
              label="单次任务超时（秒）"
              hint={lockedHint(
                "task_timeout_seconds",
                "0 表示不限时（同时关闭按时间触发的收尾）；其他值需不少于 30 秒。",
              )}
              value={draft.task_timeout_seconds}
              min={0}
              disabled={locked("task_timeout_seconds")}
              error={errors.task_timeout_seconds}
              onChange={changeTaskTimeout}
            />
          </div>
          {clampNote && <p className="settings-clamp">{clampNote}</p>}
        </Card>

        <Card id="settings-capture" title="流量采集" note="录制代理总开关" icon={<Network size={15} />}>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={draft.capture_enabled !== false}
              disabled={locked("capture_enabled") || saving}
              onChange={(event) => setDraft({ ...draft, capture_enabled: event.target.checked })}
            />
            <span>启用录制代理</span>
          </label>
          <p className="settings-hint">
            {draft.capture_enabled !== false
              ? "Execute 会注入 http_proxy / https_proxy 并采集 HTTP / HTTPS 流量；上游默认使用 TLS 1.2。"
              : "已关闭：新执行的 Run 不再注入代理环境变量，工具直连目标，流量页不会新增记录。已有记录保留。"}
          </p>
        </Card>

        <Card
          id="settings-budget"
          title="收尾与工具预算"
          note="超时前预留收尾；工具预算独立生效"
          icon={<Wrench size={15} />}
        >
          <div className="settings-grid">
            <NumberField
              id="settings-closeout"
              label="收尾预留（秒）"
              hint={lockedHint(
                "closeout_seconds",
                draft.task_timeout_seconds === 0
                  ? "单次任务不限时，收尾预留不生效。"
                  : "任务超时前留给收尾的时间，须小于单次任务超时。",
              )}
              value={draft.closeout_seconds ?? 60}
              min={1}
              max={closeoutMax}
              disabled={closeoutDisabled}
              error={errors.closeout_seconds}
              onChange={(value) => setDraft({ ...draft, closeout_seconds: value })}
            />
            <NumberField
              id="settings-tool-timeout"
              label="单条 shell 命令上限（秒）"
              hint={lockedHint("tool_timeout_seconds", "0 表示由模型决定；平台只在超过上限时中止。")}
              value={draft.tool_timeout_seconds ?? 0}
              min={0}
              max={600}
              disabled={locked("tool_timeout_seconds")}
              error={errors.tool_timeout_seconds}
              onChange={(value) => setDraft({ ...draft, tool_timeout_seconds: value })}
            />
            <NumberField
              id="settings-result-repairs"
              label="结果格式修复次数"
              hint={lockedHint("result_repairs", "结果不合规时的自动修复轮数，0–3。")}
              value={draft.result_repairs ?? 1}
              min={0}
              max={3}
              disabled={locked("result_repairs")}
              error={errors.result_repairs}
              onChange={(value) => setDraft({ ...draft, result_repairs: value })}
            />
          </div>
        </Card>

        <Card id="settings-logs" title="运行日志" note="按项目导出诊断日志" icon={<FileText size={15} />}>
          {ws.projects.length ? (
            <div className="settings-grid settings-log-grid">
              <Field label="项目" hint="诊断日志包含运行记录、请求与诊断事件，仅供内部排查。">
                <select value={selectedLogProject} onChange={(event) => setLogProject(event.target.value)}>
                  {ws.projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="settings-log-action">
                <a
                  className="button"
                  href={`/api/projects/${encodeURIComponent(selectedLogProject)}/diagnostics`}
                  download
                >
                  <Download size={14} />
                  导出诊断日志
                </a>
                <p className="quiet">文件可能包含请求内容与凭据字段，请按内部安全规范保管。</p>
              </div>
            </div>
          ) : (
            <p className="quiet">还没有可导出的项目。</p>
          )}
        </Card>
      </div>

      {(dirty || invalid) && (
        <div className="settings-savebar" data-dirty="true" data-invalid={invalid ? "true" : undefined}>
          <div className="settings-savebar-state">
            <span className="settings-savebar-count">
              {invalid ? `${errorKeys.length} 项需要修正` : `${summary.length} 项未保存`}
            </span>
            <span
              className="settings-savebar-list"
              title={invalid ? errorKeys.map((key) => FIELD_LABELS[key] ?? key).join(" · ") : changes.join(" · ")}
            >
              {invalid
                ? `${errorKeys
                    .slice(0, 3)
                    .map((key) => FIELD_LABELS[key] ?? key)
                    .join(" · ")}${errorKeys.length > 3 ? " 等" : ""}，请按字段下方提示修正`
                : `${summary.slice(0, 3).join(" · ")}${summary.length > 3 ? " 等" : ""}`}
            </span>
          </div>
          <div className="settings-savebar-actions">
            <span className="settings-savebar-shortcut" aria-hidden="true">
              ⌘/Ctrl + S
            </span>
            <button
              type="button"
              className="button ghost"
              disabled={!dirty || saving}
              onClick={() => {
                setDraft(baseline);
                setReviewEnabled(reviewModelEnabled(baseline?.review_model));
                setClampNote("");
                pendingDraft = null;
              }}
            >
              <RotateCcw size={14} />
              弃改
            </button>
            <button
              type="button"
              className="button primary"
              disabled={!dirty || saving || invalid}
              title={invalid ? "先修正标红的字段再保存" : undefined}
              onClick={() => void save()}
            >
              <Save size={14} />
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
