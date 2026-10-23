import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";

interface MenuAction {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  danger?: boolean;
}

/** A viewport-aligned menu that can escape table overflow and header stacking. */
export function ActionMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<"first" | "last">("first");
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !menu.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      if (anchor.bottom <= 0 || anchor.top >= innerHeight || anchor.right <= 0 || anchor.left >= innerWidth) { close(); return; }
      const gap = 6, inset = 8;
      const box = menu.current.getBoundingClientRect();
      const maxHeight = Math.max(0, innerHeight - inset * 2);
      const height = Math.min(box.height, maxHeight);
      const below = innerHeight - anchor.bottom - gap - inset;
      const above = anchor.top - gap - inset;
      const top = height > below && above > below ? anchor.top - gap - height : anchor.bottom + gap;
      const next = {
        left: Math.max(inset, Math.min(anchor.right - box.width, innerWidth - box.width - inset)),
        top: Math.max(inset, Math.min(top, innerHeight - height - inset)),
        maxHeight,
      };
      setPosition(previous => previous?.left === next.left && previous.top === next.top && previous.maxHeight === next.maxHeight ? previous : next);
    };
    place();
    const observer = new ResizeObserver(place);
    if (menu.current) observer.observe(menu.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, close]);

  const positioned = position !== null;
  useLayoutEffect(() => {
    if (!open || !positioned) return;
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    (initialFocus.current === "last" ? items?.[items.length - 1] : items?.[0])?.focus({ preventScroll: true });
  }, [open, positioned]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, close]);

  return <div className="project-more">
    <button ref={trigger} id={`${id}-trigger`} type="button" className="icon-button project-more-trigger"
      aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { initialFocus.current = "first"; if (open) close(); else setOpen(true); }}
      onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); initialFocus.current = event.key === "ArrowUp" ? "last" : "first"; setOpen(true);
        }
      }}><MoreHorizontal size={17} aria-hidden="true" /></button>
    {open && createPortal(<div ref={menu} id={id} className="project-more-menu" role="menu" aria-labelledby={`${id}-trigger`}
      style={{ left: position?.left ?? 0, top: position?.top ?? 0, maxHeight: position?.maxHeight, visibility: positioned ? "visible" : "hidden" }}
      onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) close(); }}
      onKeyDown={event => {
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[index]?.focus();
        } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
        else if (event.key === "Tab") close(true);
      }}>
      {actions.map((action, index) => <div key={action.label} role="none">
        {action.danger && index > 0 && <div className="project-menu-separator" role="separator" />}
        <button type="button" role="menuitem" tabIndex={-1} data-danger={action.danger || undefined}
          onClick={() => { close(true); action.onSelect(); }}>{action.icon}<span>{action.label}</span></button>
      </div>)}
    </div>, document.body)}
  </div>;
}
