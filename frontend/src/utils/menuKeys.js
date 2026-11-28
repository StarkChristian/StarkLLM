// Keys inside a small menu (role="menu"): arrow up/down and Home/End move between the items, Escape closes it and
// gives the focus back to the button that opened it (the element with aria-expanded next to the menu).
export function menuKeys(e, close) {
  const menu = e.currentTarget;
  const items = [...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].filter((el) => !el.disabled);
  const at = items.indexOf(document.activeElement);
  let next = null;
  if (e.key === 'ArrowDown') next = items[(at + 1) % items.length];
  else if (e.key === 'ArrowUp') next = items[(at - 1 + items.length) % items.length];
  else if (e.key === 'Home') next = items[0];
  else if (e.key === 'End') next = items[items.length - 1];
  else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    const opener = menu.parentElement && menu.parentElement.querySelector('[aria-expanded]');
    close();
    if (opener) opener.focus();
    return;
  }
  if (next) { e.preventDefault(); next.focus(); }
}

// Keys in a row of tabs (role="tablist"): left/right (and Home/End) move to the next tab and choose it.
export function tabKeys(e) {
  const tabs = [...e.currentTarget.querySelectorAll('[role="tab"]')].filter((el) => !el.disabled);
  const at = tabs.indexOf(document.activeElement);
  if (at < 0) return;
  const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
  let next = null;
  if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) next = tabs[(at + 1) % tabs.length];
  else if (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) next = tabs[(at - 1 + tabs.length) % tabs.length];
  else if (e.key === 'Home') next = tabs[0];
  else if (e.key === 'End') next = tabs[tabs.length - 1];
  if (next) { e.preventDefault(); next.focus(); next.click(); }
}
