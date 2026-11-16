import { useEffect, useRef } from 'react';

// Closes a window with the Escape key while it is open. Only the most recently opened window reacts, so Escape in a
// window opened from another window closes just that one.
const stack = [];

export function useEscape(onClose, open = true) {
  const handler = useRef(onClose);
  handler.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const entry = {};
    stack.push(entry);
    const onKey = (e) => {
      if (e.key !== 'Escape' || stack[stack.length - 1] !== entry) return;
      e.stopPropagation();
      handler.current && handler.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [open]);
}
