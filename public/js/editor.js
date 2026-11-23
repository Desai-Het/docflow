(function () {
  'use strict';
  const { get, post, patch, put, del, el, toast, formatDate, ApiError, mountProfileMenu } = window.DocFlow;
  const DocFlow = window.DocFlow;

  const AUTOSAVE_DELAY_MS = 1000;
    const RETRY_DELAY_MS = 5000;

  const docId = new URLSearchParams(window.location.search).get('id');
  if (!docId) {
    window.location.replace('/dashboard');
    return;
  }
  const docUrl = `/api/docs/${encodeURIComponent(docId)}`;

  const titleInput = document.getElementById('doc-title');
  const statusEl = document.getElementById('save-status');
  const roleBadge = document.getElementById('role-badge');
  const ownerLine = document.getElementById('owner-line');
  const shareBtn = document.getElementById('share-btn');
  const exportBtn = document.getElementById('export-btn');
  const conflictBanner = document.getElementById('conflict-banner');

  const state = {
    version: 0,
    role: null,
    title: '',
    dirty: false, // local changes not yet sent
    saving: false, // a save request is in flight
    conflict: false,
    timer: null,
  };

  // Only formats the server accepts are enabled, so pasted content is normalised too.
  const quill = new window.Quill('#editor', {
    theme: 'snow',
    placeholder: 'Start writing…',
    formats: ['header', 'bold', 'italic', 'underline', 'list'],
    modules: {
      toolbar: [
        [{ header: [1, 2, 3, false] }],
        ['bold', 'italic', 'underline'],
        [{ list: 'ordered' }, { list: 'bullet' }],
        ['clean'],
      ],
      history: { userOnly: true },
    },
  });
  quill.disable();

  function setStatus(text, kind = '') {
    statusEl.textContent = text;
    statusEl.className = `save-status ${kind}`;
  }

  function canEdit() {
    return state.role === 'owner' || state.role === 'editor';
  }

  function applyDocument(doc, { initial = false } = {}) {
    state.version = doc.version;
    state.role = doc.role;
    state.title = doc.title;
    document.title = `${doc.title} · DocFlow`;
    if (document.activeElement !== titleInput) titleInput.value = doc.title;

    const range = quill.getSelection();
    quill.setContents(doc.content, 'silent');
    if (initial) quill.history.clear();
    if (range) quill.setSelection(Math.min(range.index, quill.getLength() - 1), 0, 'silent');

    const viaLink = doc.access_via === 'link' ? ' (via link)' : '';
    roleBadge.textContent = { owner: 'Owner', editor: 'Can edit', viewer: 'View only' }[doc.role] + viaLink;
    roleBadge.className = `badge badge-${doc.role}`;
    ownerLine.textContent = doc.role === 'owner' ? '' : `Owned by ${doc.owner.name}`;
    shareBtn.hidden = doc.role !== 'owner';
    exportBtn.href = `${docUrl}/export.md`;
    document.getElementById('readonly-banner').hidden = canEdit();
    document.querySelector('.ql-toolbar').hidden = !canEdit();
    titleInput.disabled = !canEdit();
    if (canEdit()) quill.enable();
    else quill.disable();
    setStatus(`Saved · ${formatDate(doc.updated_at)}`, 'ok');
  }

  async function load() {
    try {
      const { document: doc } = await get(docUrl);
      document.getElementById('loading').remove();
      applyDocument(doc, { initial: true });
      if (canEdit()) quill.focus();
    } catch (err) {
      document.getElementById('loading').textContent =
        err.status === 404 ? 'Document not found, or you do not have access to it.' : err.message;
    }
  }

  // ---- Autosave with optimistic concurrency ---------------------------------
  function scheduleSave() {
    if (state.conflict) return;
    state.dirty = true;
    setStatus('Unsaved changes…', 'pending');
    clearTimeout(state.timer);
    state.timer = setTimeout(save, AUTOSAVE_DELAY_MS);
  }

  async function save() {
    clearTimeout(state.timer);
    if (!state.dirty || state.conflict || !canEdit()) return;
    if (state.saving) {
      state.timer = setTimeout(save, 300);
      return;
    }
    state.saving = true;
    state.dirty = false;
    setStatus('Saving…', 'pending');
    try {
      const { document: saved } = await patch(docUrl, { content: quill.getContents(), version: state.version });
      state.version = saved.version;
      if (!state.dirty) setStatus(`Saved · ${formatDate(saved.updated_at)}`, 'ok');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        state.conflict = true;
        conflictBanner.hidden = false;
        setStatus('Not saved (conflict)', 'error');
      } else if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        setStatus('Not saved', 'error');
        toast('Your access to this document has changed.', 'error');
        quill.disable();
      } else if (err instanceof ApiError && err.status === 400) {
        setStatus('Not saved', 'error');
        toast(err.message, 'error');
      } else {
        // Network or server hiccup: keep the changes and retry.
        state.dirty = true;
        setStatus('Offline · retrying…', 'error');
        state.timer = setTimeout(save, RETRY_DELAY_MS);
      }
    } finally {
      state.saving = false;
    }
  }

  quill.on('text-change', (delta, old, source) => {
    if (source === 'user') scheduleSave();
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty || state.saving) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  document.getElementById('conflict-reload').addEventListener('click', async () => {
    state.conflict = false;
    state.dirty = false;
    conflictBanner.hidden = true;
    try {
      const { document: doc } = await get(docUrl);
      applyDocument(doc);
      toast('Loaded the latest version.');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // ---- Pick up other people's saves while idle ------------------------------
  // ---- Presence heartbeat: who else is here, their cursors, and their saves ----
  // Polls every second while someone else is in the document, every 4 seconds when alone.
  const FAST_MS = 1000;
  const SLOW_MS = 4000;
  const TYPING_WINDOW_MS = 10000;
  let lastTypedAt = 0;
  let heartbeatBusy = false;
  let heartbeatAgain = false;
  let heartbeatTimer = null;
  let othersPresent = false;
  let remoteUsers = [];
  const presenceEl = document.getElementById('presence');

  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  }
  const describe = (p) => `${p.name}\n${p.email} · ${p.editing ? 'editing' : 'viewing'}`;

  function renderPresence(active) {
    presenceEl.replaceChildren(
      ...active.map((p) => el('span', {
        class: `presence-avatar color-${p.user_id % 6}${p.editing ? ' is-editing' : ''}`,
        'data-tooltip': describe(p), // custom hover card: name, email, viewing/editing
        'aria-label': `${p.name} (${p.email}) is ${p.editing ? 'editing' : 'viewing'}`,
        tabindex: '0',
        text: initials(p.name),
      }))
    );
    const editors = active.filter((p) => p.editing);
    const label = editors.length
      ? `${editors.map((p) => p.name.split(' ')[0]).join(', ')} ${editors.length > 1 ? 'are' : 'is'} editing…`
      : active.length ? `${active.length} other${active.length > 1 ? 's' : ''} viewing` : '';
    if (label) {
      presenceEl.append(el('span', {
        class: 'presence-label',
        tabindex: '0',
        'data-tooltip': active.map((p) => `${p.email} · ${p.editing ? 'editing' : 'viewing'}`).join('\n'),
        text: label,
      }));
    }
  }

  // ---- Remote cursors: a coloured caret + name flag per editor, drawn over the editor ----
  const cursorLayer = el('div', { class: 'remote-cursors', 'aria-hidden': 'true' });
  quill.container.append(cursorLayer);

  function renderCursors() {
    const maxIndex = Math.max(0, quill.getLength() - 1);
    const nodes = [];
    for (const p of remoteUsers) {
      if (!p.cursor) continue;
      const color = `color-${p.user_id % 6}`;
      const start = Math.min(p.cursor.index, maxIndex);
      const end = Math.min(p.cursor.index + p.cursor.length, maxIndex);
      // Selection highlight, one rectangle per line it spans.
      let pos = start;
      while (pos < end) {
        const [line, offset] = quill.getLine(pos);
        if (!line) break;
        const lineRemaining = line.length() - offset; // includes the line's trailing newline (always >= 1)
        const segEnd = Math.min(end, pos + lineRemaining - 1);
        if (segEnd > pos) {
          const r = quill.getBounds(pos, segEnd - pos);
          if (r) nodes.push(el('div', { class: `remote-selection ${color}`, style: `left:${r.left}px;top:${r.top}px;width:${Math.max(r.width, 2)}px;height:${r.height}px` }));
        }
        pos += lineRemaining;
      }
      const caret = quill.getBounds(end, 0);
      if (!caret) continue;
      nodes.push(el('div', {
        class: `remote-caret ${color}`,
        style: `left:${caret.left}px;top:${caret.top}px;height:${caret.height}px`,
      }, [el('span', { class: `remote-flag ${color}`, text: p.name.split(' ')[0] })]));
    }
    cursorLayer.replaceChildren(...nodes);
  }
  quill.on('text-change', () => renderCursors());
  window.addEventListener('resize', renderCursors);

  function myCursor() {
    if (!canEdit() || !quill.hasFocus()) return null;
    const range = quill.getSelection();
    return range ? { index: range.index, length: range.length } : null;
  }

  async function heartbeat() {
    if (heartbeatBusy) { heartbeatAgain = true; return; }
    clearTimeout(heartbeatTimer);
    if (document.hidden || !state.role) { scheduleHeartbeat(); return; }
    heartbeatBusy = true;
    try {
      const res = await post(`${docUrl}/presence`, {
        editing: Date.now() - lastTypedAt < TYPING_WINDOW_MS,
        cursor: myCursor(),
      });
      othersPresent = res.active.length > 0;
      if (res.title !== state.title && document.activeElement !== titleInput) {
        state.title = res.title;
        titleInput.value = res.title;
        document.title = `${res.title} · DocFlow`;
      }
      const changed = res.version !== state.version || res.role !== state.role;
      if (changed && !state.dirty && !state.saving && !state.conflict) {
        const { document: doc } = await get(docUrl);
        if (!state.dirty && !state.saving) {
          applyDocument(doc);
          // When collaborators are visibly present, their avatars/cursors already explain the change.
          if (!res.active.length) toast('Document updated with the latest changes.');
        }
      }
      remoteUsers = res.active;
      renderPresence(res.active);
      renderCursors();
    } catch (err) {
      if (err.status === 404) {
        toast('You no longer have access to this document.', 'error');
        setTimeout(() => window.location.replace('/dashboard'), 1500);
      }
    } finally {
      heartbeatBusy = false;
      if (heartbeatAgain) { heartbeatAgain = false; heartbeat(); } else scheduleHeartbeat();
    }
  }
  function scheduleHeartbeat() {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(heartbeat, othersPresent ? FAST_MS : SLOW_MS);
  }
  heartbeat();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) heartbeat(); });
  quill.on('text-change', (d, o, source) => { if (source === 'user') lastTypedAt = Date.now(); });

  // Share my cursor quickly when it moves (throttled), only if someone else is watching.
  let cursorSendTimer = null;
  quill.on('selection-change', () => {
    if (!othersPresent || cursorSendTimer) return;
    cursorSendTimer = setTimeout(() => { cursorSendTimer = null; heartbeat(); }, 250);
  });

  // Tell others we left (keepalive lets the request finish during page unload).
  window.addEventListener('pagehide', () => {
    fetch(`${docUrl}/presence`, {
      method: 'DELETE', keepalive: true, credentials: 'same-origin', headers: { 'X-Requested-With': 'DocFlow' },
    }).catch(() => {});
  });

  // ---- Export menu: Markdown download or PDF via the browser's print dialog ----
  const exportToggle = document.getElementById('export-toggle');
  const exportMenu = document.getElementById('export-menu');
  const setMenu = (open) => {
    exportMenu.hidden = !open;
    exportToggle.setAttribute('aria-expanded', String(open));
  };
  exportToggle.addEventListener('click', (e) => { e.stopPropagation(); setMenu(exportMenu.hidden); });
  document.addEventListener('click', (e) => { if (!exportMenu.contains(e.target)) setMenu(false); });
  document.getElementById('export-btn').addEventListener('click', () => setMenu(false));
  document.getElementById('export-pdf').addEventListener('click', () => {
    setMenu(false);
    document.title = state.title; // browsers use the page title as the default PDF file name
    window.addEventListener('afterprint', () => { document.title = `${state.title} · DocFlow`; }, { once: true });
    window.print(); // print stylesheet hides the app chrome; choose "Save as PDF" as the destination
  });

  // ---- Version history ----
  const historyDialog = document.getElementById('history-dialog');
  const historyList = document.getElementById('history-list');
  const historyLabel = document.getElementById('history-label');
  const restoreBtn = document.getElementById('history-restore');
  const viewer = new window.Quill('#history-viewer', {
    theme: 'snow', readOnly: true, modules: { toolbar: false },
    formats: ['header', 'bold', 'italic', 'underline', 'list'],
  });
  let selectedVersion = null;
  let currentVersionNumber = 0;
  const KIND_LABEL = { created: 'Created', imported: 'Imported from file', edited: 'Edited', restored: 'Restored an earlier version' };

  async function selectVersion(item, li) {
    historyList.querySelectorAll('li').forEach((n) => n.classList.toggle('selected', n === li));
    historyLabel.textContent = 'Loading…';
    try {
      const { version } = await get(`${docUrl}/versions/${item.id}`);
      selectedVersion = version;
      viewer.setContents(version.content, 'silent');
      const isCurrent = version.version === currentVersionNumber;
      historyLabel.textContent = isCurrent
        ? 'This is the current version.'
        : `${KIND_LABEL[version.kind]} by ${version.author_name || 'a former user'} · ${formatDate(version.updated_at)}`;
      restoreBtn.hidden = isCurrent || !canEdit();
    } catch (err) {
      historyLabel.textContent = err.message;
    }
  }

  async function openHistory() {
    if (state.dirty) await save(); // make sure the latest edits are part of the history
    historyList.replaceChildren(el('li', { class: 'empty', text: 'Loading…' }));
    viewer.setContents([{ insert: '\n' }], 'silent');
    restoreBtn.hidden = true;
    historyLabel.textContent = 'Select a version to preview it.';
    historyDialog.showModal();
    try {
      const { versions, current_version: current } = await get(`${docUrl}/versions`);
      currentVersionNumber = current;
      if (!versions.length) {
        historyList.replaceChildren(el('li', { class: 'empty', text: 'No history yet.' }));
        return;
      }
      historyList.replaceChildren(...versions.map((v) => {
        const li = el('li', { class: 'history-item', tabindex: '0' }, [
          el('div', { class: 'history-when', text: formatDate(v.updated_at) }),
          el('div', { class: 'muted small', text: `${KIND_LABEL[v.kind]} · ${v.author_name || 'former user'}` }),
          v.version === current ? el('span', { class: 'badge badge-owner', text: 'Current' }) : null,
        ]);
        li.addEventListener('click', () => selectVersion(v, li));
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectVersion(v, li); } });
        return li;
      }));
      historyList.querySelector('li').click();
    } catch (err) {
      historyList.replaceChildren(el('li', { class: 'empty', text: err.message }));
    }
  }

  restoreBtn.addEventListener('click', async () => {
    if (!selectedVersion) return;
    const ok = await DocFlow.confirmDialog({
      title: 'Restore this version?',
      message: `The document will be replaced with the version from ${formatDate(selectedVersion.updated_at)}. The current content stays in the history, so you can switch back.`,
      confirmText: 'Restore',
    });
    if (!ok) return;
    try {
      await post(`${docUrl}/versions/${selectedVersion.id}/restore`, { version: state.version });
      historyDialog.close();
      const { document: doc } = await get(docUrl);
      applyDocument(doc);
      toast(`Restored the version from ${formatDate(selectedVersion.updated_at)}.`);
    } catch (err) {
      historyLabel.textContent = err.message;
    }
  });
  document.getElementById('history-btn').addEventListener('click', openHistory);
  document.getElementById('history-close').addEventListener('click', () => historyDialog.close());

  // ---- Rename ----------------------------------------------------------------
  async function commitTitle() {
    const next = titleInput.value.trim();
    if (next === state.title) return;
    if (!next) {
      titleInput.value = state.title;
      return toast('Title cannot be empty.', 'error');
    }
    try {
      const { document: saved } = await patch(docUrl, { title: next });
      state.title = saved.title;
      titleInput.value = saved.title;
      document.title = `${saved.title} · DocFlow`;
      toast('Renamed.');
    } catch (err) {
      titleInput.value = state.title;
      toast(err.message, 'error');
    }
  }
  titleInput.addEventListener('blur', commitTitle);
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); titleInput.blur(); }
    if (e.key === 'Escape') { titleInput.value = state.title; titleInput.blur(); }
  });

  // ---- Sharing dialog (owner only) ------------------------------------------
  const dialog = document.getElementById('share-dialog');
  const shareForm = document.getElementById('share-form');
  const shareList = document.getElementById('share-list');
  const shareError = document.getElementById('share-error');

  const shareStatus = (msg) => {
    shareError.textContent = '';
    const el2 = document.getElementById('share-status');
    el2.textContent = msg;
    clearTimeout(el2._t);
    el2._t = setTimeout(() => { el2.textContent = ''; }, 3000);
  };

  function renderShares(shares) {
    if (!shares.length) {
      shareList.replaceChildren(el('li', { class: 'empty', text: 'Only you can access this document.' }));
      return;
    }
    shareList.replaceChildren(
      ...shares.map((s) => {
        const select = el('select', {
          'aria-label': `Role for ${s.email}`,
          onchange: async () => {
            try {
              renderShares((await put(`${docUrl}/shares`, { email: s.email, role: select.value })).shares);
              shareStatus(`${s.name} is now ${select.value === 'editor' ? 'an editor' : 'a viewer'}.`);
            } catch (err) {
              shareError.textContent = err.message;
            }
          },
        }, [
          el('option', { value: 'editor', text: 'Can edit', selected: s.role === 'editor' }),
          el('option', { value: 'viewer', text: 'View only', selected: s.role === 'viewer' }),
        ]);
        return el('li', { class: 'share-item' }, [
          el('div', {}, [el('strong', { text: s.name }), el('div', { class: 'muted small', text: s.email })]),
          select,
          el('button', {
            type: 'button',
            class: 'btn btn-ghost btn-small danger',
            text: 'Remove',
            onclick: async () => {
              try {
                renderShares((await del(`${docUrl}/shares/${s.user_id}`)).shares);
                shareStatus(`Removed ${s.name}.`);
              } catch (err) {
                shareError.textContent = err.message;
              }
            },
          }),
        ]);
      })
    );
  }

  // ---- General access ("Anyone with the link") ----
  const linkScope = document.getElementById('link-scope');
  const linkRole = document.getElementById('link-role');
  const linkHelp = document.getElementById('link-help');
  const docLink = `${window.location.origin}/editor?id=${encodeURIComponent(docId)}`;

  function renderLinkAccess(access) {
    linkScope.value = access ? 'link' : 'restricted';
    linkRole.hidden = !access;
    if (access) linkRole.value = access;
    linkHelp.textContent = access
      ? `Anyone with the link who is signed in to DocFlow ${access === 'editor' ? 'can edit' : 'can view'} this document.`
      : 'Only people added above can open this document.';
  }

  async function saveLinkAccess() {
    const access = linkScope.value === 'link' ? linkRole.value : null;
    linkScope.disabled = linkRole.disabled = true;
    try {
      const res = await put(`${docUrl}/link-access`, { access });
      renderLinkAccess(res.link_access);
      linkHelp.textContent += ' Saved.';
    } catch (err) {
      shareError.textContent = err.message;
    } finally {
      linkScope.disabled = linkRole.disabled = false;
    }
  }
  linkScope.addEventListener('change', () => {
    if (linkScope.value === 'link') linkRole.value = 'viewer';
    saveLinkAccess();
  });
  linkRole.addEventListener('change', saveLinkAccess);

  const copyBtn = document.getElementById('copy-link');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(docLink);
      copyBtn.textContent = 'Link copied ✓';
      setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 2000);
    } catch {
      window.prompt('Copy this link:', docLink);
    }
  });

  shareBtn.addEventListener('click', async () => {
    shareError.textContent = '';
    shareForm.reset();
    dialog.showModal();
    try {
      const res = await get(`${docUrl}/shares`);
      renderShares(res.shares);
      renderLinkAccess(res.link_access);
    } catch (err) {
      shareError.textContent = err.message;
    }
  });
  document.getElementById('share-close').addEventListener('click', () => dialog.close());

  shareForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    shareError.textContent = '';
    const email = shareForm.email.value.trim();
    if (!email) {
      shareError.textContent = 'Enter an email address.';
      return;
    }
    const button = shareForm.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      renderShares((await put(`${docUrl}/shares`, { email, role: shareForm.role.value })).shares);
      shareForm.email.value = '';
      shareStatus(`Shared with ${email}.`);
    } catch (err) {
      shareError.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });

  get('/api/auth/me').then(({ user }) => mountProfileMenu(document.getElementById('profile'), user)).catch(() => {});
  load();
})();
