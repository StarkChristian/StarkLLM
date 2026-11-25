// Web tasks (docs/web-tasks.md): the script that runs inside the page of StarkLLM's browser window. It turns the page
// into what the AI model can read: the elements a person can use, numbered, and the visible text. It also finds an
// element again by its number for a click or for typing. It only reads the page and marks elements with a data
// attribute; clicks and keys come from outside as real input events (webtask.js), like a person's.
//
// The same source runs in the Electron window and in the Playwright test harness (tools/webtask-try.js), so both see
// the page alike. Plain browser JavaScript, no Node, no network.

function pageScript() {
  if (window.__starkllm) return;
  const ATTR = 'data-starkllm-i';
  const MAX_ELEMENTS = 160;
  const MAX_TEXT = 3500;
  const clean = (s, n = 120) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = window.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return false;
    return true;
  };

  const roleOf = (el) => {
    const role = el.getAttribute('role');
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox' || t === 'radio') return t;
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'button';
  };

  const labelOf = (el) => {
    const byAria = el.getAttribute('aria-label');
    if (byAria) return clean(byAria);
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    if (ids.length) {
      const t = ids.map((id) => (document.getElementById(id) || {}).innerText || '').join(' ');
      if (clean(t)) return clean(t);
    }
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab && clean(lab.innerText)) return clean(lab.innerText);
    }
    const wrap = el.closest('label');
    if (wrap && clean(wrap.innerText)) return clean(wrap.innerText);
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (['button', 'submit', 'reset'].includes(t) && el.value) return clean(el.value);
      return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '');
    }
    const text = clean(el.innerText);
    if (text) return text;
    const img = el.querySelector && el.querySelector('img[alt]');
    if (img) return clean(img.getAttribute('alt'));
    return clean(el.getAttribute('title') || el.getAttribute('name') || '');
  };

  // What the safety rules of webtask-core.js need to know about a field: a password, a card number, a one-time code.
  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (type === 'password' || /current-password|new-password/.test(ac)) return 'password';
    if (/^cc-|cc-number|cc-csc|cc-exp/.test(ac)) return 'payment';
    if (ac === 'one-time-code') return 'code';
    if (tag === 'input' && type === 'file') return 'file';
    return '';
  };

  const SELECTOR = [
    'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select', 'summary',
    '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=checkbox]', '[role=radio]', '[role=option]',
    '[role=combobox]', '[role=textbox]', '[role=switch]', '[role=searchbox]', '[contenteditable=true]', '[onclick]',
  ].join(',');

  function snapshot() {
    document.querySelectorAll(`[${ATTR}]`).forEach((e) => e.removeAttribute(ATTR));
    const vh = window.innerHeight;
    const all = [...document.querySelectorAll(SELECTOR)].filter((el) => !el.disabled && visible(el));
    // what the user sees first, then what is just below; far below the page needs a scroll
    const inView = (el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh;
    };
    const near = (el) => {
      const r = el.getBoundingClientRect();
      return r.top >= vh && r.top < vh * 2.5;
    };
    const chosen = [...all.filter(inView), ...all.filter(near)].slice(0, MAX_ELEMENTS);
    const elements = chosen.map((el, k) => {
      const i = k + 1;
      el.setAttribute(ATTR, String(i));
      const role = roleOf(el);
      const item = { i, role, label: labelOf(el) };
      const kind = kindOf(el);
      if (kind) item.kind = kind;
      if (role === 'textbox' && el.value) item.value = clean(el.value, 60);
      if (role === 'checkbox' || role === 'radio') item.checked = !!(el.checked || el.getAttribute('aria-checked') === 'true');
      if (el.tagName.toLowerCase() === 'select') {
        item.options = [...el.options].slice(0, 25).map((o) => clean(o.text, 40));
        // which option is chosen now: without it the model chooses the same option again and again
        const chosenOption = el.options[el.selectedIndex];
        if (chosenOption) item.value = clean(chosenOption.text, 40);
      }
      if (el.tagName.toLowerCase() === 'a') {
        try {
          item.host = new URL(el.href, location.href).host;
        } catch (e) { /* not a web link */ }
      }
      if (!inView(el)) item.below = true;
      return item;
    });
    // the text around what the window shows: after a scroll the model reads further down, not the top again
    const textRoot = document.querySelector('main') || document.body;
    const pageText = textRoot ? String(textRoot.innerText || '').replace(/\s+/g, ' ').trim() : '';
    const height = Math.max(document.documentElement.scrollHeight, 1);
    const from = pageText.length <= MAX_TEXT ? 0 : Math.max(0, Math.min(pageText.length - MAX_TEXT, Math.floor((window.scrollY / height) * pageText.length) - 300));
    const text = (from > 0 ? '… ' : '') + pageText.slice(from, from + MAX_TEXT) + (from + MAX_TEXT < pageText.length ? ' …' : '');
    const more = document.documentElement.scrollHeight > window.scrollY + vh * 1.05;
    return { url: location.href, title: clean(document.title, 150), elements, text, more, scroll: Math.round(window.scrollY) };
  }

  // centre of element i in the window's coordinates, scrolled into view first; null when it is gone
  function rect(i) {
    const el = document.querySelector(`[${ATTR}="${Number(i)}"]`);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), kind: kindOf(el), role: roleOf(el), label: labelOf(el) };
  }

  // after the wait: the centre of element i again, and whether a click there really reaches it (not a banner, not
  // another element of a page that was still scrolling)
  function hit(i) {
    const el = document.querySelector(`[${ATTR}="${Number(i)}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const inView = r.width > 0 && r.height > 0 && x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
    const at = inView ? document.elementFromPoint(x, y) : null;
    return { x, y, ok: Boolean(at && (at === el || el.contains(at) || at.contains(el))) };
  }

  // the click inside the page, for an element a click at its point does not reach
  function clickHere(i) {
    const el = document.querySelector(`[${ATTR}="${Number(i)}"]`);
    if (!el) return false;
    el.click();
    return true;
  }

  // before typing: focus the field and select what is in it, so typed text replaces it
  function focusField(i) {
    const el = document.querySelector(`[${ATTR}="${Number(i)}"]`);
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (typeof el.select === 'function') el.select();
    else if (el.isContentEditable) document.getSelection().selectAllChildren(el);
    return { kind: kindOf(el), role: roleOf(el), label: labelOf(el) };
  }

  function choose(i, option) {
    const el = document.querySelector(`[${ATTR}="${Number(i)}"]`);
    if (!el || el.tagName.toLowerCase() !== 'select') return false;
    const want = clean(option, 80).toLowerCase();
    const opt = [...el.options].find((o) => clean(o.text, 80).toLowerCase() === want) ||
      [...el.options].find((o) => clean(o.text, 80).toLowerCase().includes(want));
    if (!opt) return false;
    el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return clean(opt.text, 80);
  }

  function scrollPage(direction) {
    window.scrollBy({ top: (direction === 'up' ? -0.8 : 0.8) * window.innerHeight });
    return true;
  }

  // the readable text of the whole page, longer than in the snapshot, for read_page
  function read() {
    const root = document.querySelector('main') || document.body;
    return clean(root ? root.innerText : '', 12000);
  }

  window.__starkllm = { snapshot, rect, hit, clickHere, focusField, choose, scrollPage, read };
}

// The source to run in the page: defines window.__starkllm once (a navigation removes it again).
const PAGE_SCRIPT = `(${pageScript.toString()})();`;

module.exports = { PAGE_SCRIPT };
