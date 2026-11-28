// Keyboard behaviour of every dialog (WCAG 2.1.2, 2.4.3; docs/accessibility.md): while it is open, Tab and Shift+Tab
// stay inside it, Escape closes it, focus moves into it when it opens and goes back to the button that opened it when
// it closes. Dialogs opened on top of another one (the document viewer from the sources) are stacked: only the top one
// reacts to the keys.
//
//   const ref = useRef(null);
//   useDialog(ref, { open: isOpen, onClose });
//   <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="…">
import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  'textarea:not([disabled])', 'iframe', 'audio[controls]', 'video[controls]', '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const stack = [];

/** The elements in root a keyboard user can reach with Tab, in order (visible ones only). */
export function focusableIn(root) {
  if (!root) return [];
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0 && !el.closest('[inert]'));
}

export function useDialog(ref, { open = true, onClose, closeOnEscape = true } = {}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const escapeRef = useRef(closeOnEscape);
  escapeRef.current = closeOnEscape;

  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    const entry = {};
    stack.push(entry);

    // focus into the dialog, unless a field in it took the focus already (autoFocus)
    const frame = requestAnimationFrame(() => {
      const root = ref.current;
      if (!root || root.contains(document.activeElement)) return;
      const wanted = root.querySelector('[data-autofocus]') || focusableIn(root)[0];
      if (wanted) wanted.focus();
      else {
        if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
        root.focus();
      }
    });

    const onKey = (e) => {
      if (stack[stack.length - 1] !== entry) return;
      const root = ref.current;
      if (!root) return;
      if (e.key === 'Escape' && escapeRef.current && onCloseRef.current) {
        e.stopPropagation();
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusableIn(root);
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const inside = root.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);  // bubbling: a field inside that handles Escape itself (and stops it) keeps it

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey);
      const at = stack.indexOf(entry);
      if (at >= 0) stack.splice(at, 1);
      // back to the button that opened the dialog (when it is still there)
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
        setTimeout(() => { if (!ref.current || !document.contains(ref.current)) opener.focus(); }, 0);
      }
    };
  }, [open, ref]);
}
