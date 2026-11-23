// Small fetch wrapper shared by every page. All mutations send the CSRF header.
(function () {
  'use strict';

  class ApiError extends Error {
    constructor(status, message, body) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }

  async function request(method, url, body, { isForm = false } = {}) {
    const headers = { 'X-Requested-With': 'DocFlow', Accept: 'application/json' };
    let payload;
    if (body !== undefined) {
      if (isForm) payload = body;
      else {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
    }
    let res;
    try {
      res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
    } catch {
      throw new ApiError(0, 'Network error. Check your connection and try again.');
    }
    let data = null;
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) data = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401 && !url.startsWith('/api/auth/')) {
        // Come back to this page (e.g. a shared document link) after signing in.
        const next = window.location.pathname + window.location.search;
        window.location.href = `/?next=${encodeURIComponent(next)}`;
        return new Promise(() => {}); // navigation in progress
      }
      throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status}).`, data);
    }
    return data;
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  /** Creates an element with text content only (never innerHTML with user data). */
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
  }

  function toast(message, kind = 'info') {
    // An open modal <dialog> sits in the browser's top layer, so toasts must live inside it to be visible.
    const parent = document.querySelector('dialog[open]') || document.body;
    let host = parent.querySelector(':scope > .toasts');
    if (!host) {
      host = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
      parent.append(host);
    }
    const t = el('div', { class: `toast toast-${kind}`, text: message });
    host.append(t);
    setTimeout(() => t.remove(), 4000);
  }

  /**
   * Accessible confirmation popup built on <dialog>. Resolves true/false.
   * confirmDialog({ title, message, confirmText, danger })
   */
  function confirmDialog({ title, message, confirmText = 'Confirm', cancelText = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      const cancelBtn = el('button', { type: 'button', class: 'btn btn-secondary', text: cancelText });
      const okBtn = el('button', { type: 'button', class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, text: confirmText });
      const dialog = el('dialog', { class: 'dialog dialog-confirm', 'aria-labelledby': 'confirm-title' }, [
        el('h2', { id: 'confirm-title', text: title }),
        el('p', { class: 'muted', text: message }),
        el('div', { class: 'dialog-actions' }, [cancelBtn, okBtn]),
      ]);
      const finish = (value) => {
        dialog.close();
        dialog.remove();
        resolve(value);
      };
      cancelBtn.addEventListener('click', () => finish(false));
      okBtn.addEventListener('click', () => finish(true));
      dialog.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); }); // Esc key
      dialog.addEventListener('click', (e) => { if (e.target === dialog) finish(false); }); // backdrop click
      document.body.append(dialog);
      dialog.showModal();
      cancelBtn.focus();
    });
  }

  async function signOut() {
    const ok = await confirmDialog({
      title: 'Sign out?',
      message: 'You will need to sign in again to access your documents.',
      confirmText: 'Sign out',
    });
    if (!ok) return;
    await request('POST', '/api/auth/logout').catch(() => {});
    window.location.replace('/');
  }

  const PERSON_ICON =
    'M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 2.25c-4.14 0-7.5 2.35-7.5 5.25 0 .41.34.75.75.75h13.5c.41 0 .75-.34.75-.75 0-2.9-3.36-5.25-7.5-5.25Z';

  function personSvg() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', PERSON_ICON);
    svg.append(path);
    return svg;
  }

  /** Person icon in the top bar; clicking it shows the user's name, email and a sign-out button. */
  function mountProfileMenu(container, user) {
    const panel = el('div', { class: 'profile-panel', role: 'dialog', 'aria-label': 'Your profile', hidden: true }, [
      el('div', { class: 'profile-head' }, [
        el('div', { class: 'avatar avatar-lg' }, [personSvg()]),
        el('div', { class: 'profile-text' }, [
          el('div', { class: 'profile-name', text: user.name }),
          el('div', { class: 'muted small profile-email', text: user.email }),
        ]),
      ]),
      el('button', { type: 'button', class: 'btn btn-secondary profile-signout', text: 'Sign out', onclick: signOut }),
    ]);
    const button = el('button', {
      type: 'button',
      class: 'avatar avatar-btn',
      title: `${user.name} (${user.email})`,
      'aria-label': 'Open profile',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
    }, [personSvg()]);
    const toggle = (open) => {
      panel.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
    };
    button.addEventListener('click', (e) => { e.stopPropagation(); toggle(panel.hidden); });
    document.addEventListener('click', (e) => { if (!panel.contains(e.target)) toggle(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggle(false); });
    container.replaceChildren(el('div', { class: 'profile-wrap' }, [button, panel]));
  }

  window.DocFlow = {
    ApiError,
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body),
    put: (url, body) => request('PUT', url, body),
    patch: (url, body) => request('PATCH', url, body),
    del: (url) => request('DELETE', url),
    upload: (url, formData) => request('POST', url, formData, { isForm: true }),
    formatDate,
    el,
    toast,
    confirmDialog,
    signOut,
    mountProfileMenu,
  };
})();
