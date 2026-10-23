import { useEffect, useRef, type RefObject } from "react";

const dialogs: HTMLElement[] = [];
const focusable = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Only the top dialog handles keyboard input; closing it restores its trigger. */
export function useDialogFocus(open: boolean, ref: RefObject<HTMLElement | null>, onClose: () => void, canClose = true) {
  const close = useRef(onClose);
  const allowed = useRef(canClose);
  const restore = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  wasOpen.current = open;
  close.current = onClose;
  allowed.current = canClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const previous = restore.current;
    dialogs.push(dialog);
    const elements = () => [...dialog.querySelectorAll<HTMLElement>(focusable)].filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0 && !element.closest('[inert]'));
    if (!dialog.contains(document.activeElement)) (elements().find(element => element.matches('input, textarea, select')) || elements()[0] || dialog).focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (dialogs.at(-1) !== dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (allowed.current) close.current();
      }
      if (event.key !== "Tab") return;
      const targets = elements();
      const first = targets[0], last = targets.at(-1);
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      if (!dialog.contains(document.activeElement) || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        (event.shiftKey ? last! : first).focus();
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      dialogs.splice(dialogs.indexOf(dialog), 1);
      document.removeEventListener("keydown", keydown, true);
      if (previous?.isConnected && (!dialogs.length || dialogs.at(-1)?.contains(previous))) previous.focus({ preventScroll: true });
    };
  }, [open, ref]);
}
