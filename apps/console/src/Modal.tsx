import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

/**
 * Shared dismissable-layer behavior for modal dialogs and drawers:
 * - moves focus into the panel on open,
 * - traps Tab focus inside the panel (keyboard users cannot reach the console
 *   behind the backdrop),
 * - closes on Escape,
 * - restores focus to the previously-focused element on close.
 *
 * `onClose` is held in a ref so the effect only re-runs on `open` changes — an
 * inline `onClose` (new identity each render) must not tear down and re-arm the
 * focus trap on every parent re-render (that yanked focus mid-interaction).
 */
export function useDismissableLayer(
  open: boolean,
  onClose: () => void,
  panelRef: RefObject<HTMLElement | null>,
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;

    const restoreTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusable = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1);

    (focusable()[0] ?? panelRef.current)?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!panelRef.current?.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      restoreTarget?.focus();
    };
  }, [open, panelRef]);
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** id of the title element for aria-labelledby. */
  labelledBy?: string;
  /** Extra class appended to `modal` (e.g. `delete-modal`). */
  className?: string;
  children: ReactNode;
}

/**
 * Backdrop + dialog shell shared by every console modal. Closes on Escape, on a
 * backdrop click (but not on clicks inside the dialog body), and traps focus.
 * Renders nothing when `open` is false.
 */
export function Modal({ open, onClose, labelledBy, className, children }: ModalProps) {
  const panelRef = useRef<HTMLElement>(null);
  useDismissableLayer(open, onClose, panelRef);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-labelledby={labelledBy}
        aria-modal="true"
        className={className ? `modal ${className}` : 'modal'}
        onClick={(event) => event.stopPropagation()}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        {children}
      </section>
    </div>
  );
}
