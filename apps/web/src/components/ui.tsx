import type { FormEvent, ReactNode } from "react";
import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "./useDialogFocus.js";
import { Inbox, X } from "lucide-react";
import { reviewTone, severityLabels, severityOrder, statusLabels, statusTone } from "../format.js";
import { pageTitles } from "../workspace.js";

export { pageTitles, statusLabels };

export type Tone = "neutral" | "accent" | "success" | "warn" | "danger" | "info";

const toneOfStatus = (value: string): Tone => {
  if (severityOrder.includes(value as (typeof severityOrder)[number])) {
    return value === "critical" || value === "high" ? "danger" : value === "medium" ? "warn" : "neutral";
  }
  return statusTone(value) as Tone;
};

export const Badge = ({ value, dot = true }: { value: string; dot?: boolean }) => (
  <span className="status-pill" data-tone={toneOfStatus(value)} data-dot={dot || undefined}>
    {dot && <i aria-hidden="true" />}
    {statusLabels[value] || value}
  </span>
);

export const StatusPill = ({ value, label }: { value: string; label?: string }) => (
  <span className="status-pill" data-tone={statusTone(value)}>
    <i aria-hidden="true" />
    {label || statusLabels[value] || value}
  </span>
);

export const ReviewPill = ({ value }: { value: string }) => (
  <span className="status-pill" data-tone={reviewTone(value)}>
    {statusLabels[value] || value}
  </span>
);

export const SeverityBadge = ({ severity, prefix }: { severity?: string | null; prefix?: string }) => (
  <span className="severity-badge" data-severity={severity || "ungraded"}>
    <i aria-hidden="true" />
    {(prefix ? `${prefix} ` : "") + (severityLabels[severity || "ungraded"] || "未定级")}
  </span>
);

export function IconButton({
  label,
  children,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" className={`icon-button ${className}`.trim()} aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

export function Card({
  title,
  note,
  icon,
  actions,
  children,
  className = "",
  flush = false,
  id,
}: {
  title?: ReactNode;
  note?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
  id?: string;
}) {
  return (
    <section className={`card ${className}`.trim()} id={id}>
      {(title || actions) && (
        <header className="card-head">
          <div className="card-head-main">
            {icon && <span className="card-icon">{icon}</span>}
            {title && <h2>{title}</h2>}
            {note && <span className="card-note">{note}</span>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={flush ? "card-body flush" : "card-body"}>{children}</div>
    </section>
  );
}

/** 旧组件沿用的面板 API，与 Card 共用视觉。 */
export function Panel({
  title,
  note,
  extra,
  children,
  tight,
}: {
  title?: string;
  note?: string;
  extra?: ReactNode;
  children: ReactNode;
  tight?: boolean;
}) {
  return (
    <Card title={title} note={note} actions={extra} flush={tight}>
      {children}
    </Card>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  meta,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header-main">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p className="page-lede">{description}</p>}
        {meta && <div className="page-meta">{meta}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Kpi({
  label,
  value,
  note,
  icon,
  tone = "neutral",
  onClick,
  hint,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  icon?: ReactNode;
  tone?: Tone | "critical" | "high" | "medium" | "low";
  onClick?: () => void;
  hint?: string;
}) {
  const content = (
    <>
      <div className="kpi-top">
        <span className="kpi-label">{label}</span>
        {icon && <span className="kpi-icon">{icon}</span>}
      </div>
      <div className="kpi-value">{value}</div>
      {note && <div className="kpi-note">{note}</div>}
    </>
  );
  return onClick ? (
    <button className="kpi" data-tone={tone} onClick={onClick} title={hint} type="button">
      {content}
    </button>
  ) : (
    <div className="kpi" data-tone={tone} title={hint}>
      {content}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  desc,
  action,
  compact = false,
}: {
  icon?: ReactNode;
  title: string;
  desc?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state ${compact ? "compact" : ""}`.trim()}>
      <span className="empty-icon">{icon || <Inbox size={20} />}</span>
      <h3>{title}</h3>
      {desc && <p>{desc}</p>}
      {action}
    </div>
  );
}

export const Skeleton = ({ rows = 3, style }: { rows?: number; style?: React.CSSProperties }) => (
  <div className="skeleton-stack" style={style} aria-hidden="true">
    {Array.from({ length: rows }).map((_, i) => (
      <div className="skeleton" key={i} style={{ height: 12, width: `${94 - i * 12}%` }} />
    ))}
  </div>
);

export function Overlay({ children }: { children: ReactNode }) {
  return createPortal(<div className="modal-backdrop">{children}</div>, document.body);
}

export function Modal({
  label,
  title,
  onClose,
  onSubmit,
  footer,
  children,
  className = "",
  busy,
  width,
}: {
  label: string;
  title: ReactNode;
  onClose: () => void;
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  busy?: boolean;
  width?: number;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(true, dialogRef, onClose, !busy);
  const body = (
    <>
      <header className="modal-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" aria-label="关闭" disabled={busy} onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="modal-content">{children}</div>
      {footer && <footer className="modal-foot">{footer}</footer>}
    </>
  );
  return createPortal(
    <div
      className="modal-backdrop"
      ref={dialogRef}
      tabIndex={-1}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      {onSubmit ? (
        <form
          className={`modal ${className}`.trim()}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          style={width ? { width } : undefined}
          onSubmit={onSubmit}
        >
          {body}
        </form>
      ) : (
        <div
          className={`modal ${className}`.trim()}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          style={width ? { width } : undefined}
        >
          {body}
        </div>
      )}
    </div>,
    document.body,
  );
}

export function Drawer({
  label,
  title,
  onClose,
  children,
  width = 460,
  className,
}: {
  label: string;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  className?: string;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(true, dialogRef, onClose);
  return createPortal(
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside
        className={`drawer ${className || ""}`.trim()}
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        style={{ width }}
      >
        <header className="drawer-head">
          <h2>{title}</h2>
          <button type="button" className="icon-button" aria-label="关闭面板" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </>,
    document.body,
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  size = "md",
}: {
  value: T;
  options: readonly (readonly [T, ReactNode])[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  size?: "sm" | "md";
}) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel} data-size={size}>
      {options.map(([key, text]) => (
        <button
          key={key}
          type="button"
          className={value === key ? "active" : ""}
          aria-pressed={value === key}
          onClick={() => onChange(key)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: readonly (readonly [T, ReactNode])[];
  onChange: (value: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={ariaLabel}>
      {options.map(([key, text]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={value === key}
          className={value === key ? "active" : ""}
          onClick={() => onChange(key)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <label className="field" htmlFor={htmlFor}>
      <span className="field-label">{label}</span>
      {children}
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : (
        hint && <span className="field-hint">{hint}</span>
      )}
    </label>
  );
}

export function Progress({
  value,
  tone = "accent",
  label,
}: {
  value: number;
  tone?: "accent" | "success" | "warn" | "danger";
  label?: string;
}) {
  return (
    <div
      className="progress"
      data-tone={tone}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="kbd">{children}</kbd>;

export function Toast({
  message,
  tone = "success",
  onClose,
}: {
  message: string;
  tone?: "success" | "danger";
  onClose?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="toast" role="status" data-tone={tone} ref={ref}>
      <span>{message}</span>
      {onClose && (
        <button type="button" aria-label="关闭提示" onClick={onClose}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}
