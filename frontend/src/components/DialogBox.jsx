// The box of a dialog: role="dialog", aria-modal, its name from the heading (labelledBy, the id of the heading) or
// a label, and the keyboard behaviour of useDialog (focus moves in and back, Tab stays inside, Escape closes).
// Rendered only while the dialog is open. innerRef: the component's own ref to the box, when it needs one.
import React, { useRef } from 'react';
import { useDialog } from '../hooks/useDialog';

export default function DialogBox({ onClose, labelledBy, label, closeOnEscape = true, alert = false, innerRef, children, ...rest }) {
  const ref = useRef(null);
  useDialog(ref, { open: true, onClose, closeOnEscape });
  const setRef = (el) => {
    ref.current = el;
    if (typeof innerRef === 'function') innerRef(el);
    else if (innerRef) innerRef.current = el;
  };
  return (
    <div
      ref={setRef}
      role={alert ? 'alertdialog' : 'dialog'}
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      {...rest}
    >
      {children}
    </div>
  );
}
