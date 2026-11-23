(function () {
  'use strict';
  const { get, post, del, upload, el, formatDate, toast, confirmDialog, signOut, mountProfileMenu } = window.DocFlow;

  const ownedList = document.getElementById('owned-list');
  const sharedList = document.getElementById('shared-list');
  const importInput = document.getElementById('import-input');
  const SUPPORTED = ['.txt', '.md', '.markdown', '.docx'];
  const MAX_BYTES = 2 * 1024 * 1024;

  const openDoc = (id) => { window.location.href = `/editor?id=${encodeURIComponent(id)}`; };

  function emptyState(text) {
    return el('li', { class: 'empty', text });
  }

  function ownedItem(doc) {
    const people = doc.share_count ? `Shared with ${doc.share_count}` : '';
    const link = doc.link_access ? `Anyone with link (${doc.link_access === 'editor' ? 'edit' : 'view'})` : '';
    const shareLabel = [people, link].filter(Boolean).join(' · ') || 'Private';
    const isShared = Boolean(doc.share_count || doc.link_access);
    return el('li', { class: 'doc-item' }, [
      el('a', { class: 'doc-link', href: `/editor?id=${encodeURIComponent(doc.id)}` }, [
        el('span', { class: 'doc-title', text: doc.title }),
        el('span', { class: 'doc-meta', text: `Edited ${formatDate(doc.updated_at)}` }),
      ]),
      el('span', { class: `badge ${isShared ? 'badge-shared' : ''}`, text: shareLabel }),
      el('button', {
        class: 'btn btn-ghost btn-small danger',
        'aria-label': `Delete ${doc.title}`,
        text: 'Delete',
        onclick: async () => {
          const ok = await confirmDialog({
            title: 'Delete document?',
            message: `"${doc.title}" will be permanently deleted for you and everyone it is shared with. This cannot be undone.`,
            confirmText: 'Delete',
            danger: true,
          });
          if (!ok) return;
          try {
            await del(`/api/docs/${encodeURIComponent(doc.id)}`);
            toast('Document deleted.');
            load();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }),
    ]);
  }

  function sharedItem(doc) {
    return el('li', { class: 'doc-item' }, [
      el('a', { class: 'doc-link', href: `/editor?id=${encodeURIComponent(doc.id)}` }, [
        el('span', { class: 'doc-title', text: doc.title }),
        el('span', { class: 'doc-meta', text: `Owner: ${doc.owner_name} · Edited ${formatDate(doc.updated_at)}` }),
      ]),
      el('span', { class: `badge badge-${doc.role}`, text: doc.role === 'editor' ? 'Can edit' : 'View only' }),
    ]);
  }

  async function load() {
    try {
      const { owned, shared } = await get('/api/docs');
      ownedList.replaceChildren(...(owned.length ? owned.map(ownedItem) : [emptyState('No documents yet. Create one or import a file.')]));
      sharedList.replaceChildren(...(shared.length ? shared.map(sharedItem) : [emptyState('Nothing has been shared with you yet.')]));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  const newDocBtn = document.getElementById('new-doc');
  newDocBtn.addEventListener('click', async () => {
    newDocBtn.disabled = true;
    try {
      const { document: doc } = await post('/api/docs', {});
      openDoc(doc.id);
    } catch (err) {
      toast(err.message, 'error');
      newDocBtn.disabled = false;
    }
  });

  importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    importInput.value = '';
    if (!file) return;
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!SUPPORTED.includes(ext)) return toast('Unsupported file type. Use .txt, .md or .docx.', 'error');
    if (file.size > MAX_BYTES) return toast('File is too large. The limit is 2 MB.', 'error');
    const form = new FormData();
    form.append('file', file);
    toast(`Importing ${file.name}…`);
    try {
      const { document: doc } = await upload('/api/docs/import', form);
      openDoc(doc.id);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('logout').addEventListener('click', signOut);

  get('/api/auth/me').then(({ user }) => {
    mountProfileMenu(document.getElementById('profile'), user);
    load();
  });
})();
