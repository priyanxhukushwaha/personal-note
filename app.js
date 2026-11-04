(() => {
  'use strict';

  const DB_NAME = 'fieldnotes-offline-notebook-v1';
  const DB_VERSION = 2;
  const MAX_HISTORY = 30;
  const PRIVATE_CONFIG_KEY = 'private-password';
  const PRIVATE_CHECK = 'fieldnotes-private-notes-v1';
  const PBKDF2_ITERATIONS = 310000;
  const THEME_STORAGE_KEY = 'fieldnotes-theme';
  const APPEARANCE_CONFIG_KEY = 'appearance';
  const FONT_FAMILIES = {
    sans: 'Arial, sans-serif',
    system: 'system-ui, sans-serif',
    serif: "Georgia, 'Times New Roman', serif",
    mono: "Consolas, 'Courier New', monospace",
  };
  const $ = (selector) => document.querySelector(selector);
  const appShell = $('.app-shell');
  const ui = {
    noteList: $('#note-list'),
    search: $('#search'),
    title: $('#note-title'),
    folder: $('#note-folder'),
    tags: $('#note-tags'),
    content: $('#note-content'),
    preview: $('#markdown-preview'),
    editor: $('#note-editor'),
    welcome: $('#welcome-state'),
    listTitle: $('#list-title'),
    listEyebrow: $('#list-eyebrow'),
    listEmpty: $('#list-empty'),
    emptyTitle: $('#empty-title'),
    emptyCopy: $('#empty-copy'),
    filterLabel: $('#filter-label'),
    saveState: $('#save-state'),
    wordCount: $('#word-count'),
    duplicate: $('#duplicate-warning'),
    backlinks: $('#backlinks'),
    breadcrumbs: $('#breadcrumbs'),
    noteCount: $('#notes-count'),
    folderList: $('#folder-list'),
    tagList: $('#tag-list'),
    modal: $('#modal-backdrop'),
    modalTitle: $('#modal-title'),
    modalEyebrow: $('#modal-eyebrow'),
    modalContent: $('#modal-content'),
    status: $('#status-message'),
    moreMenu: $('#more-menu'),
  };

  let db;
  let notes = [];
  let privateConfig = null;
  let privateKey = null;
  let appearance = null;
  let selectedId = null;
  let currentView = 'notes';
  let currentFilter = '';
  let previewing = false;
  let saveTimer;
  let statusTimer;
  let installPrompt;
  let lastFocus;

  function applyTheme(theme) {
    const isDark = theme === 'dark';
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('.theme-toggle').forEach((button) => {
      button.setAttribute('aria-label', `Switch to ${isDark ? 'light' : 'dark'} mode`);
      button.title = `Switch to ${isDark ? 'light' : 'dark'} mode`;
    });
    $('meta[name="theme-color"]').content = isDark ? '#000000' : '#f5f7f8';
  }

  function normalizeAppearance(value) {
    if (!value || !/^#[\da-f]{6}$/i.test(value.backgroundColor || '')
      || !/^#[\da-f]{6}$/i.test(value.fontColor || '')
      || !Object.prototype.hasOwnProperty.call(FONT_FAMILIES, value.fontFamily)) return null;
    return {
      backgroundColor: value.backgroundColor,
      fontColor: value.fontColor,
      fontFamily: value.fontFamily,
    };
  }

  function applyAppearance() {
    const root = document.documentElement;
    if (!appearance) {
      delete root.dataset.userCustomized;
      root.style.removeProperty('--user-background');
      root.style.removeProperty('--user-font-color');
      root.style.removeProperty('--user-font-family');
      $('meta[name="theme-color"]').content = root.dataset.theme === 'dark' ? '#000000' : '#f5f7f8';
      return;
    }
    root.dataset.userCustomized = 'true';
    root.style.setProperty('--user-background', appearance.backgroundColor);
    root.style.setProperty('--user-font-color', appearance.fontColor);
    root.style.setProperty('--user-font-family', FONT_FAMILIES[appearance.fontFamily]);
    $('meta[name="theme-color"]').content = appearance.backgroundColor;
  }

  applyTheme(localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark');

  const openDatabase = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('notes')) {
        const store = database.createObjectStore('notes', { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
      if (!database.objectStoreNames.contains('settings')) {
        database.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local notebook storage.'));
  });

  const requestResult = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not read the notebook.'));
  });

  const writeTransaction = (mode, action) => new Promise((resolve, reject) => {
    const transaction = db.transaction('notes', mode);
    action(transaction.objectStore('notes'));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Could not save your note.'));
    transaction.onabort = () => reject(transaction.error || new Error('The save was cancelled.'));
  });

  const bytesToBase64 = (bytes) => {
    let binary = '';
    new Uint8Array(bytes).forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  };
  const base64ToBytes = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  const encodeText = new TextEncoder();
  const decodeText = new TextDecoder();

  function getSetting(key) {
    return requestResult(db.transaction('settings').objectStore('settings').get(key));
  }

  async function saveSetting(value) {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('settings', 'readwrite');
      transaction.objectStore('settings').put(value);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not save your settings.'));
      transaction.onabort = () => reject(transaction.error || new Error('Saving settings was cancelled.'));
    });
  }

  async function removeSetting(key) {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('settings', 'readwrite');
      transaction.objectStore('settings').delete(key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not reset your settings.'));
      transaction.onabort = () => reject(transaction.error || new Error('Resetting settings was cancelled.'));
    });
  }

  async function derivePrivateKey(password, salt) {
    const material = await crypto.subtle.importKey('raw', encodeText.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  async function encryptValue(key, value, id) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encodeText.encode(id) },
      key,
      encodeText.encode(JSON.stringify(value)),
    );
    return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(encrypted) };
  }

  async function decryptValue(key, record) {
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(record.iv),
        additionalData: encodeText.encode(record.id),
      },
      key,
      base64ToBytes(record.ciphertext),
    );
    return JSON.parse(decodeText.decode(decrypted));
  }

  async function encryptNote(note, key = privateKey) {
    if (!key) throw new Error('Unlock Private before saving private notes.');
    const privateData = { ...note };
    delete privateData.encrypted;
    delete privateData.iv;
    delete privateData.ciphertext;
    const sealed = await encryptValue(key, privateData, note.id);
    return {
      id: note.id,
      isPrivate: true,
      encrypted: true,
      updatedAt: note.updatedAt,
      ...(note.deletedAt ? { deletedAt: note.deletedAt } : {}),
      ...sealed,
    };
  }

  async function persistNote(note) {
    const record = note.isPrivate ? await encryptNote(note) : note;
    await writeTransaction('readwrite', (store) => store.put(record));
  }

  async function unlockPrivate(password) {
    if (!privateConfig) throw new Error('Create a password for Private first.');
    const key = await derivePrivateKey(password, base64ToBytes(privateConfig.salt));
    let check;
    try {
      check = await decryptValue(key, { id: PRIVATE_CONFIG_KEY, ...privateConfig.verifier });
    } catch {
      throw new Error('That password is not correct.');
    }
    if (check !== PRIVATE_CHECK) throw new Error('That password is not correct.');
    const decrypted = await Promise.all(notes.map(async (note) => {
      if (!note.isPrivate || !note.encrypted) return note;
      const contents = await decryptValue(key, note);
      if (contents.id !== note.id || !contents.isPrivate) throw new Error('A private note could not be verified.');
      return contents;
    }));
    privateKey = key;
    notes = decrypted;
    return true;
  }

  async function changePrivatePassword(currentPassword, newPassword) {
    if (!privateConfig) throw new Error('Set a Private password before changing it.');
    const wasUnlocked = Boolean(privateKey);
    const oldKey = await derivePrivateKey(currentPassword, base64ToBytes(privateConfig.salt));
    let check;
    try {
      check = await decryptValue(oldKey, { id: PRIVATE_CONFIG_KEY, ...privateConfig.verifier });
    } catch {
      throw new Error('That current password is not correct.');
    }
    if (check !== PRIVATE_CHECK) throw new Error('That current password is not correct.');

    const decryptedNotes = await Promise.all(notes.map(async (note) => {
      if (!note.isPrivate || !note.encrypted) return note;
      const contents = await decryptValue(oldKey, note);
      if (contents.id !== note.id || !contents.isPrivate) throw new Error('A private note could not be verified.');
      return contents;
    }));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const nextKey = await derivePrivateKey(newPassword, salt);
    const verifier = await encryptValue(nextKey, PRIVATE_CHECK, PRIVATE_CONFIG_KEY);
    const config = { key: PRIVATE_CONFIG_KEY, salt: bytesToBase64(salt), verifier };
    const encryptedRecords = await Promise.all(decryptedNotes
      .filter((note) => note.isPrivate)
      .map((note) => encryptNote(note, nextKey)));

    await new Promise((resolve, reject) => {
      const transaction = db.transaction(['notes', 'settings'], 'readwrite');
      encryptedRecords.forEach((record) => transaction.objectStore('notes').put(record));
      transaction.objectStore('settings').put(config);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not update the Private password.'));
      transaction.onabort = () => reject(transaction.error || new Error('Changing the Private password was cancelled.'));
    });

    notes = decryptedNotes;
    privateConfig = config;
    privateKey = nextKey;
    if (!wasUnlocked) {
      privateKey = null;
      await reloadStoredNotes();
    }
  }

  async function createPrivatePassword(password, noteToPrivatize = null) {
    if (!window.crypto || !crypto.subtle) throw new Error('Password protection needs a secure browser context (localhost or HTTPS).');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await derivePrivateKey(password, salt);
    const verifier = await encryptValue(key, PRIVATE_CHECK, PRIVATE_CONFIG_KEY);
    const config = { key: PRIVATE_CONFIG_KEY, salt: bytesToBase64(salt), verifier };
    const updatedNotes = notes.map((note) => note.id === noteToPrivatize ? { ...note, isPrivate: true, archived: false } : note);
    const encryptedRecords = await Promise.all(updatedNotes.filter((note) => note.isPrivate).map((note) => encryptNote(note, key)));
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(['notes', 'settings'], 'readwrite');
      const noteStore = transaction.objectStore('notes');
      encryptedRecords.forEach((record) => noteStore.put(record));
      transaction.objectStore('settings').put(config);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Could not protect private notes.'));
      transaction.onabort = () => reject(transaction.error || new Error('Password setup was cancelled.'));
    });
    notes = updatedNotes;
    privateConfig = config;
    privateKey = key;
  }

  async function reloadStoredNotes() {
    notes = await requestResult(db.transaction('notes').objectStore('notes').getAll());
    notes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  const loadNotes = async () => {
    await reloadStoredNotes();
    privateConfig = await getSetting(PRIVATE_CONFIG_KEY) || null;
    if (!selectedId) {
      const lastOpened = activeNotes().filter((note) => note.openedAt).sort((a, b) => b.openedAt - a.openedAt)[0];
      selectedId = lastOpened ? lastOpened.id : null;
    }
    render();
  };

  const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const liveNotes = () => notes.filter((note) => !note.deletedAt);
  const activeNotes = () => liveNotes().filter((note) => !note.archived && !note.isPrivate);
  const noteById = (id) => notes.find((note) => note.id === id);
  const selectedNote = () => noteById(selectedId);
  const displayTitle = (note) => note.title.trim() || 'Untitled note';
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
  const formatDate = (time) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(time || Date.now());
  const formatDateTime = (time) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(time || Date.now());

  function showStatus(message, isError = false) {
    ui.status.textContent = message;
    ui.status.classList.toggle('error', isError);
    ui.status.classList.remove('hidden');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => ui.status.classList.add('hidden'), 4200);
  }

  function visibleNotes() {
    if (currentView === 'private' && !privateKey) return [];
    let result = activeNotes();
    if (currentView === 'pinned') result = result.filter((note) => note.pinned);
    if (currentView === 'liked') result = result.filter((note) => note.liked);
    if (currentView === 'recent') result = result.filter((note) => note.openedAt).sort((a, b) => b.openedAt - a.openedAt).slice(0, 30);
    if (currentView === 'archive') result = liveNotes().filter((note) => note.archived);
    if (currentView === 'private') result = liveNotes().filter((note) => note.isPrivate);
    if (currentView === 'trash') result = notes.filter((note) => note.deletedAt && (!note.isPrivate || privateKey));
    if (currentView === 'folder') result = result.filter((note) => note.folder === currentFilter || note.folder.startsWith(`${currentFilter}/`));
    if (currentView === 'tag') result = result.filter((note) => note.tags.includes(currentFilter));

    const query = ui.search.value.trim().toLocaleLowerCase();
    if (query) {
      result = result.map((note) => {
        const title = displayTitle(note).toLocaleLowerCase();
        const body = note.content.toLocaleLowerCase();
        const titleIndex = title.indexOf(query);
        const bodyIndex = body.indexOf(query);
        return { note, score: titleIndex === 0 ? 0 : titleIndex >= 0 ? 1 : bodyIndex >= 0 ? 2 : 3 };
      }).filter((item) => item.score < 3)
        .sort((a, b) => a.score - b.score || (b.note.updatedAt || 0) - (a.note.updatedAt || 0))
        .map((item) => item.note);
    } else if (currentView !== 'recent') {
      result.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (b.updatedAt || 0) - (a.updatedAt || 0));
    }
    return result;
  }

  function render() {
    renderNavigation();
    renderNoteList();
    renderEditor();
  }

  function renderNavigation() {
    const liveNotes = activeNotes();
    ui.noteCount.textContent = String(liveNotes.length);
    $('#archive-count').textContent = String(notes.filter((note) => !note.deletedAt && note.archived).length);
    $('#private-count').textContent = String(notes.filter((note) => !note.deletedAt && note.isPrivate).length);
    $('#lock-private').classList.toggle('hidden', !privateKey);
    document.querySelectorAll('.nav-item[data-view]').forEach((item) => {
      const active = item.dataset.view === currentView && !['folder', 'tag'].includes(currentView);
      item.classList.toggle('active', active);
    });

    const folders = [...new Set(liveNotes.flatMap((note) => {
      if (!note.folder) return [];
      const parts = note.folder.split('/');
      return parts.map((part, index) => parts.slice(0, index + 1).join('/'));
    }))].sort((a, b) => a.localeCompare(b));
    ui.folderList.innerHTML = folders.length ? folders.map((folder) => {
      const depth = folder.split('/').filter(Boolean).length - 1;
      return `<button class="nav-item ${currentView === 'folder' && currentFilter === folder ? 'active' : ''}" data-folder="${escapeHtml(folder)}" type="button" style="padding-left:${9 + depth * 10}px" title="${escapeHtml(folder)}"><span class="nav-icon folder-icon">▱</span><span>${escapeHtml(folder.split('/').pop())}</span></button>`;
    }).join('') : '<span class="section-heading" style="letter-spacing:0;text-transform:none">Folders appear as you add them.</span>';
    ui.tagList.innerHTML = [...new Set(liveNotes.flatMap((note) => note.tags))]
      .sort((a, b) => a.localeCompare(b))
      .map((tag) => `<button class="tag-chip ${currentView === 'tag' && currentFilter === tag ? 'active' : ''}" data-tag="${escapeHtml(tag)}" type="button"># ${escapeHtml(tag)}</button>`).join('');
    $('#folder-options').innerHTML = folders.map((folder) => `<option value="${escapeHtml(folder)}"></option>`).join('');
  }

  function renderNoteList() {
    const query = ui.search.value.trim();
    const viewLabels = {
      notes: ['YOUR SPACE', 'All notes'],
      pinned: ['QUICK ACCESS', 'Pinned'],
      liked: ['QUICK ACCESS', 'Liked'],
      recent: ['QUICK ACCESS', 'Recently opened'],
      archive: ['STORED AWAY', 'Archive'],
      private: ['PRIVATE NOTES', 'Private'],
      trash: ['YOUR SPACE', 'Trash'],
      folder: ['FOLDER', currentFilter.split('/').pop()],
      tag: ['TAG', `# ${currentFilter}`],
    };
    const [eyebrow, title] = viewLabels[currentView];
    ui.listEyebrow.textContent = query ? 'SEARCH RESULTS' : eyebrow;
    ui.listTitle.textContent = query ? 'Search' : title;
    ui.filterLabel.textContent = query ? `Results for “${query}”` : currentView === 'folder' && currentFilter.includes('/') ? currentFilter : '';

    const result = visibleNotes();
    ui.noteList.innerHTML = result.map((note) => {
      const previewText = note.content.replace(/[#>*_`~\[\]]/g, '').replace(/\s+/g, ' ').trim() || 'No text yet';
      const date = currentView === 'recent' && note.openedAt ? note.openedAt : note.updatedAt;
      return `<button class="note-card ${note.id === selectedId ? 'selected' : ''}" data-note-id="${escapeHtml(note.id)}" type="button">
        <span class="note-card-title">${note.pinned ? '<span class="card-pin">⌖ </span>' : ''}${note.liked ? '<span class="card-like">♥ </span>' : ''}${escapeHtml(displayTitle(note))}</span>
        <span class="note-card-preview">${escapeHtml(previewText)}</span>
        <span class="note-card-meta"><span>${formatDate(date)}</span><span class="card-tags">${note.tags.slice(0, 2).map((tag) => `<span class="card-tag">${escapeHtml(tag)}</span>`).join('')}</span></span>
      </button>`;
    }).join('');

    ui.listEmpty.classList.toggle('hidden', result.length > 0);
    ui.noteList.classList.toggle('hidden', result.length === 0);
    if (!result.length) {
      const isTrash = currentView === 'trash';
      const filtered = Boolean(query) || ['folder', 'tag', 'pinned', 'liked', 'recent', 'archive', 'private'].includes(currentView);
      ui.emptyTitle.textContent = isTrash ? 'Nothing in the trash.' : filtered ? 'No notes found.' : 'A little room to think.';
      if (currentView === 'archive') ui.emptyTitle.textContent = 'Nothing archived yet.';
      if (currentView === 'private' && !privateKey) {
        ui.emptyTitle.textContent = privateConfig ? 'Private notes are locked.' : 'Set a password for Private.';
        ui.emptyCopy.textContent = privateConfig
          ? 'Unlock your notes with your password. They are encrypted on this device.'
          : 'Set a password to encrypt your private notes. Existing Private notes will be protected too.';
        $('#empty-new').textContent = privateConfig ? 'Unlock Private' : 'Set a password';
      } else if (currentView === 'trash' && notes.some((note) => note.deletedAt && note.isPrivate) && !privateKey) {
        ui.emptyTitle.textContent = 'Private notes are in the trash.';
        ui.emptyCopy.textContent = 'Unlock Private to view or restore them.';
        $('#empty-new').textContent = 'Unlock Private';
        $('#empty-new').classList.remove('hidden');
      } else if (currentView === 'private') {
        ui.emptyTitle.textContent = 'No private notes yet.';
        ui.emptyCopy.textContent = 'Move a note to Private to keep it out of your other lists.';
        $('#empty-new').textContent = 'Create a private note';
      } else {
        ui.emptyCopy.textContent = isTrash ? 'Deleted notes will stay here until you restore or remove them.' : filtered ? 'Notes you move here will show up in this list.' : 'Start with a note. It stays yours, right here on this device.';
        $('#empty-new').textContent = 'Write your first note';
      }
      if (!(currentView === 'trash' && notes.some((note) => note.deletedAt && note.isPrivate) && !privateKey)) {
        $('#empty-new').classList.toggle('hidden', isTrash);
      }
    }
  }

  function renderEditor() {
    const note = selectedNote();
    const hasNote = Boolean(note);
    ui.editor.classList.toggle('hidden', !hasNote);
    ui.welcome.classList.toggle('hidden', hasNote);
    appShell.classList.toggle('note-open', hasNote);
    if (!note) {
      ui.breadcrumbs.innerHTML = '<span>All notes</span>';
      ui.saveState.textContent = 'All changes saved';
      ui.title.value = '';
      ui.folder.value = '';
      ui.tags.value = '';
      ui.content.value = '';
      ui.preview.innerHTML = '';
      ui.duplicate.classList.add('hidden');
      ui.backlinks.classList.add('hidden');
      updateWordCount();
      updatePreview();
      ['#rename-note', '#archive-note', '#private-note', '#permanent-delete'].forEach((selector) => $(selector).classList.add('hidden'));
      ['#pin-note', '#like-note', '#history-note', '#graph-open', '#export-note', '#delete-note', '#preview-toggle'].forEach((selector) => $(selector).classList.add('hidden'));
      $('#lock-private').classList.toggle('hidden', !privateKey);
      return;
    }

    ui.title.value = note.title;
    ui.folder.value = note.folder || '';
    ui.tags.value = note.tags.join(', ');
    ui.content.value = note.content;
    $('#pin-note').classList.toggle('is-pinned', Boolean(note.pinned));
    $('#pin-note').title = note.pinned ? 'Unpin note' : 'Pin note';
    $('#pin-note').setAttribute('aria-label', note.pinned ? 'Unpin note' : 'Pin note');
    $('#pin-note').classList.toggle('hidden', Boolean(note.deletedAt));
    $('#like-note').classList.toggle('is-liked', Boolean(note.liked));
    $('#like-note').textContent = note.liked ? '♥' : '♡';
    $('#like-note').title = note.liked ? 'Unlike note' : 'Like note';
    $('#like-note').setAttribute('aria-label', note.liked ? 'Unlike note' : 'Like note');
    $('#like-note').classList.toggle('hidden', Boolean(note.deletedAt));
    $('#rename-note').classList.toggle('hidden', Boolean(note.deletedAt));
    $('#archive-note').classList.toggle('hidden', Boolean(note.deletedAt));
    $('#archive-note').textContent = note.archived ? 'Remove from archive' : 'Move to archive';
    $('#private-note').classList.toggle('hidden', Boolean(note.deletedAt));
    $('#private-note').textContent = note.isPrivate ? 'Remove from private' : 'Move to private';
    $('#permanent-delete').classList.toggle('hidden', !note.deletedAt);
    $('#archive-note').classList.toggle('hidden', Boolean(note.deletedAt || note.isPrivate));
    $('#private-note').classList.toggle('hidden', Boolean(note.deletedAt || note.archived));
    $('#delete-note').setAttribute('aria-label', note.deletedAt ? 'Restore note' : 'Move note to trash');
    $('#delete-note').title = note.deletedAt ? 'Restore note' : 'Move to trash';
    $('#delete-note').textContent = note.deletedAt ? '↶' : '⌫';
    $('#delete-note').classList.toggle('hidden', false);
    $('#history-note').classList.toggle('hidden', Boolean(note.deletedAt));
    $('#graph-open').classList.toggle('hidden', Boolean(note.deletedAt));
    $('#preview-toggle').classList.toggle('hidden', Boolean(note.deletedAt));
    $('#export-note').classList.toggle('hidden', Boolean(note.deletedAt));
    $('#export-markdown').classList.toggle('hidden', Boolean(note.deletedAt));
    ui.title.disabled = Boolean(note.deletedAt);
    ui.folder.disabled = Boolean(note.deletedAt);
    ui.tags.disabled = Boolean(note.deletedAt);
    ui.content.disabled = Boolean(note.deletedAt);
    ui.saveState.textContent = note.deletedAt ? 'In the trash' : 'All changes saved';
    const crumbs = ['All notes', ...(note.folder ? note.folder.split('/') : [])];
    ui.breadcrumbs.innerHTML = crumbs.map((crumb) => `<span>${escapeHtml(crumb)}</span>`).join('');
    updateWordCount();
    updatePreview();
    renderBacklinks(note);
    checkDuplicates(note);
  }

  function updateWordCount() {
    const words = ui.content.value.trim().match(/\S+/g) || [];
    ui.wordCount.textContent = `${words.length} ${words.length === 1 ? 'word' : 'words'}`;
  }

  function inlineMarkdown(text) {
    let html = escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, href) => {
      const safe = href.trim();
      if (!/^(https?:|mailto:)/i.test(safe)) return label;
      return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    html = html.replace(/\[\[([^[\]]+)\]\]/g, (match, title) => `<span class="wiki-link" data-wiki-title="${escapeHtml(title.trim())}">${escapeHtml(title.trim())}</span>`);
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return html;
  }

  function markdownToHtml(markdown) {
    const lines = markdown.split(/\r?\n/);
    const output = [];
    let paragraph = [];
    let listType = '';
    let inCode = false;
    let codeLines = [];
    const closeList = () => {
      if (listType) output.push(`</${listType}>`);
      listType = '';
    };
    const flushParagraph = () => {
      if (paragraph.length) output.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`);
      paragraph = [];
    };
    for (const line of lines) {
      if (line.trim().startsWith('```')) {
        flushParagraph();
        closeList();
        if (inCode) {
          output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
          codeLines = [];
        }
        inCode = !inCode;
        continue;
      }
      if (inCode) {
        codeLines.push(line);
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (!line.trim()) {
        flushParagraph();
        closeList();
      } else if (heading) {
        flushParagraph(); closeList();
        const level = heading[1].length;
        output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      } else if (unordered || ordered) {
        flushParagraph();
        const nextType = unordered ? 'ul' : 'ol';
        if (listType !== nextType) { closeList(); output.push(`<${nextType}>`); listType = nextType; }
        output.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
      } else if (/^\s*&gt;\s?/.test(escapeHtml(line))) {
        flushParagraph(); closeList();
        output.push(`<blockquote>${inlineMarkdown(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      } else {
        closeList();
        paragraph.push(line);
      }
    }
    flushParagraph();
    closeList();
    if (inCode) output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    return output.join('\n');
  }

  function updatePreview() {
    ui.preview.innerHTML = markdownToHtml(ui.content.value);
    ui.preview.classList.toggle('hidden', !previewing);
    ui.content.classList.toggle('hidden', previewing);
    $('#preview-toggle').textContent = previewing ? 'Write' : 'Preview';
  }

  function renderBacklinks(note) {
    const links = activeNotes().filter((other) => other.id !== note.id && !other.deletedAt)
      .filter((other) => [...other.content.matchAll(/\[\[([^[\]]+)\]\]/g)]
        .some((match) => match[1].trim().toLocaleLowerCase() === displayTitle(note).toLocaleLowerCase()));
    ui.backlinks.classList.toggle('hidden', !links.length);
    if (links.length) {
      ui.backlinks.innerHTML = `<strong>Linked from</strong>${links.map((link) => `<button type="button" data-note-id="${escapeHtml(link.id)}">${escapeHtml(displayTitle(link))}</button>`).join('')}`;
    }
  }

  function similarity(a, b) {
    const words = (value) => new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
    const left = words(a);
    const right = words(b);
    if (left.size < 5 || right.size < 5) return 0;
    let shared = 0;
    left.forEach((word) => { if (right.has(word)) shared += 1; });
    return shared / (left.size + right.size - shared);
  }

  function checkDuplicates(note) {
    if (note.deletedAt || note.content.trim().length < 30) {
      ui.duplicate.classList.add('hidden');
      return;
    }
    const candidate = activeNotes().filter((other) => other.id !== note.id && !other.deletedAt)
      .map((other) => ({ note: other, score: similarity(note.content, other.content) }))
      .sort((a, b) => b.score - a.score)[0];
    if (!candidate || candidate.score < 0.78) {
      ui.duplicate.classList.add('hidden');
      return;
    }
    ui.duplicate.innerHTML = `This looks a lot like <button type="button" data-note-id="${escapeHtml(candidate.note.id)}">${escapeHtml(displayTitle(candidate.note))}</button>.`;
    ui.duplicate.classList.remove('hidden');
  }

  async function saveSelected() {
    const note = selectedNote();
    if (!note || note.deletedAt) return true;
    const next = {
      ...note,
      title: ui.title.value,
      folder: ui.folder.value.trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/'),
      tags: [...new Set(ui.tags.value.split(',').map((tag) => tag.trim().replace(/^#/, '')).filter(Boolean))],
      content: ui.content.value,
      updatedAt: Date.now(),
    };
    const changed = next.title !== note.title || next.content !== note.content;
    if (changed) {
      next.history = [...(note.history || []), { title: note.title, content: note.content, savedAt: Date.now() }].slice(-MAX_HISTORY);
    }
    try {
      await persistNote(next);
      Object.assign(note, next);
      ui.saveState.textContent = 'All changes saved';
      renderNavigation();
      renderNoteList();
      renderBacklinks(note);
      checkDuplicates(note);
      return true;
    } catch (error) {
      ui.saveState.textContent = 'Could not save';
      showStatus(`Your changes could not be saved: ${error.message}`, true);
      return false;
    }
  }

  async function saveBeforeAction() {
    clearTimeout(saveTimer);
    return saveSelected();
  }

  function queueSave() {
    ui.saveState.textContent = 'Saving…';
    updateWordCount();
    updatePreview();
    checkDuplicates(selectedNote() || {});
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSelected, 350);
  }

  async function createNote() {
    if (currentView === 'private' && !privateKey) {
      showPrivatePasswordDialog(privateConfig ? 'unlock' : 'setup', () => createNote());
      return;
    }
    const note = {
      id: makeId(), title: '', content: '', folder: currentView === 'folder' ? currentFilter : '',
      tags: [], pinned: false, isPrivate: currentView === 'private', createdAt: Date.now(), updatedAt: Date.now(),
      openedAt: Date.now(), history: [],
    };
    try {
      if (note.isPrivate) await persistNote(note);
      else await writeTransaction('readwrite', (store) => store.add(note));
      notes.unshift(note);
      selectedId = note.id;
      currentView = note.isPrivate ? 'private' : 'notes';
      currentFilter = '';
      previewing = false;
      render();
      ui.title.focus();
    } catch (error) {
      showStatus(`Could not create a note: ${error.message}`, true);
    }
  }

  async function selectNote(id) {
    if (id === selectedId) return;
    if (!await saveBeforeAction()) return;
    const note = noteById(id);
    if (!note) return;
    selectedId = id;
    note.openedAt = Date.now();
    try {
      await persistNote(note);
      render();
    } catch (error) {
      showStatus(`Could not open this note: ${error.message}`, true);
    }
  }

  async function togglePinned() {
    const note = selectedNote();
    if (!note || note.deletedAt) return;
    if (!await saveBeforeAction()) return;
    note.pinned = !note.pinned;
    note.updatedAt = Date.now();
    try {
      await persistNote(note);
      render();
    } catch (error) {
      showStatus(`Could not update the pin: ${error.message}`, true);
    }
  }

  async function toggleLiked() {
    const note = selectedNote();
    if (!note || note.deletedAt) return;
    if (!await saveBeforeAction()) return;
    note.liked = !note.liked;
    note.updatedAt = Date.now();
    try {
      await persistNote(note);
      render();
      showStatus(note.liked ? 'Note liked.' : 'Like removed.');
    } catch (error) {
      showStatus(`Could not update the like: ${error.message}`, true);
    }
  }

  async function toggleArchive() {
    const note = selectedNote();
    if (!note || note.deletedAt || note.isPrivate) return;
    if (!await saveBeforeAction()) return;
    note.archived = !note.archived;
    note.updatedAt = Date.now();
    try {
      await persistNote(note);
      currentView = note.archived ? 'archive' : 'notes';
      currentFilter = '';
      ui.moreMenu.classList.add('hidden');
      render();
      showStatus(note.archived ? 'Note moved to archive.' : 'Note removed from archive.');
    } catch (error) {
      showStatus(`Could not update the archive: ${error.message}`, true);
    }
  }

  async function togglePrivate() {
    const note = selectedNote();
    if (!note || note.deletedAt || note.archived) return;
    if (!await saveBeforeAction()) return;
    if (!note.isPrivate && !privateKey) {
      if (privateConfig) {
        showPrivatePasswordDialog('unlock', () => togglePrivate());
      } else {
        showPrivatePasswordDialog('setup', () => {
          currentView = 'private';
          ui.moreMenu.classList.add('hidden');
          render();
          showStatus('Note moved to Private and encrypted.');
        }, note.id);
      }
      return;
    }
    if (note.isPrivate && !privateKey) {
      showPrivatePasswordDialog('unlock', () => togglePrivate());
      return;
    }
    note.isPrivate = !note.isPrivate;
    note.updatedAt = Date.now();
    try {
      await persistNote(note);
      currentView = note.isPrivate ? 'private' : 'notes';
      currentFilter = '';
      ui.moreMenu.classList.add('hidden');
      render();
      showStatus(note.isPrivate ? 'Note moved to Private. It is still stored on this device.' : 'Note removed from Private.');
    } catch (error) {
      showStatus(`Could not update Private: ${error.message}`, true);
    }
  }

  async function permanentlyDelete() {
    const note = selectedNote();
    if (!note || !note.deletedAt) return;
    if (!window.confirm(`Permanently delete "${displayTitle(note)}"? This cannot be undone.`)) return;
    try {
      await writeTransaction('readwrite', (store) => store.delete(note.id));
      notes = notes.filter((item) => item.id !== note.id);
      selectedId = null;
      ui.moreMenu.classList.add('hidden');
      render();
      showStatus('Note permanently deleted.');
    } catch (error) {
      showStatus(`Could not permanently delete the note: ${error.message}`, true);
    }
  }

  async function moveToTrash() {
    const note = selectedNote();
    if (!note) return;
    if (note.deletedAt) {
      note.deletedAt = null;
      note.updatedAt = Date.now();
      try {
        await persistNote(note);
        currentView = note.isPrivate ? 'private' : 'notes';
        render();
        showStatus('Note restored.');
      } catch (error) { showStatus(`Could not restore the note: ${error.message}`, true); }
      return;
    }
    if (!await saveBeforeAction()) return;
    note.deletedAt = Date.now();
    note.updatedAt = Date.now();
    try {
      await persistNote(note);
      selectedId = null;
      currentView = 'trash';
      previewing = false;
      render();
      showStatus('Moved to trash. You can restore it any time.');
    } catch (error) { showStatus(`Could not move the note to trash: ${error.message}`, true); }
  }

  async function restoreNote(id) {
    const note = noteById(id);
    if (!note) return;
    note.deletedAt = null;
    note.updatedAt = Date.now();
    try {
      await persistNote(note);
      selectedId = id;
      currentView = note.isPrivate ? 'private' : 'notes';
      render();
      showStatus('Note restored.');
    } catch (error) { showStatus(`Could not restore the note: ${error.message}`, true); }
  }

  function downloadFile(name, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportJson(selection) {
    try {
      await saveSelected();
      const readablePrivateCount = notes.filter((note) => note.isPrivate && !note.deletedAt && !note.encrypted).length;
      const lockedPrivateCount = notes.filter((note) => note.isPrivate && !note.deletedAt && note.encrypted).length;
      if (selection === 'all' && readablePrivateCount
        && !window.confirm('This backup includes Private notes in readable text. Keep the exported file somewhere safe. Continue?')) return;
      const chosen = selection === 'all' ? liveNotes().filter((note) => !note.encrypted) : [selectedNote()].filter((note) => note && !note.encrypted);
      const payload = JSON.stringify({ format: 'fieldnotes', version: 1, exportedAt: new Date().toISOString(), notes: chosen }, null, 2);
      downloadFile(selection === 'all' ? 'fieldnotes-backup.json' : `${fileSlug(displayTitle(chosen[0]))}.json`, payload, 'application/json');
      ui.moreMenu.classList.add('hidden');
      const omittedNotice = lockedPrivateCount ? ' Unlock Private to include locked notes.' : '';
      showStatus(`Exported ${chosen.length} ${chosen.length === 1 ? 'note' : 'notes'}.${omittedNotice}`);
    } catch (error) { showStatus(`Could not export notes: ${error.message}`, true); }
  }

  const fileSlug = (text) => text.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'note';

  async function exportMarkdown() {
    const note = selectedNote();
    if (!note) return;
    await saveSelected();
    const current = selectedNote();
    if (current.isPrivate && !window.confirm('This Markdown file will contain readable text. Keep it somewhere safe. Continue?')) return;
    const frontmatter = [`---`, `title: "${current.title.replace(/"/g, '\\"')}"`, `folder: "${(current.folder || '').replace(/"/g, '\\"')}"`, `tags: [${current.tags.map((tag) => `"${tag.replace(/"/g, '\\"')}"`).join(', ')}]`, `---`, ''].join('\n');
    downloadFile(`${fileSlug(displayTitle(current))}.md`, `${frontmatter}${current.content}`, 'text/markdown;charset=utf-8');
    showStatus('Markdown file exported.');
  }

  function normalizeImportedNote(source) {
    const now = Date.now();
    return {
      id: typeof source.id === 'string' && !noteById(source.id) ? source.id : makeId(),
      title: typeof source.title === 'string' ? source.title.slice(0, 180) : '',
      content: typeof source.content === 'string' ? source.content : '',
      folder: typeof source.folder === 'string' ? source.folder.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/') : '',
      tags: Array.isArray(source.tags) ? [...new Set(source.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean))] : [],
      pinned: Boolean(source.pinned),
      liked: Boolean(source.liked),
      archived: Boolean(source.archived) && !Boolean(source.isPrivate),
      isPrivate: Boolean(source.isPrivate),
      createdAt: Number.isFinite(source.createdAt) ? source.createdAt : now,
      updatedAt: now,
      history: Array.isArray(source.history) ? source.history.slice(-MAX_HISTORY) : [],
    };
  }

  function parseMarkdownImport(text, filename) {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    const content = match ? text.slice(match[0].length) : text;
    const titleMatch = match && match[1].match(/^title:\s*["']?(.*?)["']?\s*$/m);
    const folderMatch = match && match[1].match(/^folder:\s*["']?(.*?)["']?\s*$/m);
    const tagsMatch = match && match[1].match(/^tags:\s*\[(.*?)\]\s*$/m);
    const tags = tagsMatch ? [...tagsMatch[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]) : [];
    return {
      title: titleMatch ? titleMatch[1] : filename.replace(/\.(md|markdown)$/i, ''),
      folder: folderMatch ? folderMatch[1] : '',
      tags,
      content,
    };
  }

  async function importFile(file) {
    try {
      const text = await file.text();
      let sources;
      if (/\.json$/i.test(file.name) || file.type === 'application/json') {
        const parsed = JSON.parse(text);
        const list = Array.isArray(parsed) ? parsed : parsed.notes;
        if (!Array.isArray(list)) throw new Error('This JSON file does not contain a notes list.');
        sources = list;
      } else if (/\.(md|markdown)$/i.test(file.name) || file.type === 'text/markdown') {
        sources = [parseMarkdownImport(text, file.name)];
      } else {
        throw new Error('Choose a JSON backup or a Markdown file.');
      }
      if (!sources.length) throw new Error('There are no notes in this file.');
      const imported = sources.map(normalizeImportedNote);
      if (imported.some((note) => note.isPrivate) && !privateKey) {
        throw new Error('Unlock Private before importing private notes.');
      }
      await Promise.all(imported.map((note) => persistNote(note)));
      await loadNotes();
      showStatus(`Imported ${imported.length} ${imported.length === 1 ? 'note' : 'notes'}.`);
    } catch (error) {
      showStatus(`Import failed: ${error.message}`, true);
    }
    $('#import-file').value = '';
  }

  function openModal(title, content, eyebrow = 'FIELDNOTES') {
    lastFocus = document.activeElement;
    ui.modalTitle.textContent = title;
    ui.modalEyebrow.textContent = eyebrow;
    ui.modalContent.innerHTML = content;
    ui.modal.classList.remove('hidden');
    $('#modal-close').focus();
  }

  function showPrivatePasswordDialog(mode, onSuccess = () => {}, noteToPrivatize = null) {
    const settingUp = mode === 'setup';
    const formTitle = settingUp ? 'Set a Private password' : 'Unlock Private';
    const formCopy = settingUp
      ? 'This password encrypts all Private notes on this device. If you forget it, the notes cannot be recovered.'
      : 'Enter the password you set for Private notes.';
    openModal(formTitle, `
      <form id="private-password-form" class="password-form">
        <p class="password-copy">${escapeHtml(formCopy)}</p>
        <label for="private-password">${settingUp ? 'New password' : 'Password'}</label>
        <input id="private-password" name="password" type="password" minlength="${settingUp ? 8 : 1}" autocomplete="${settingUp ? 'new-password' : 'current-password'}" required>
        ${settingUp ? '<label for="private-password-confirm">Confirm password</label><input id="private-password-confirm" name="confirm-password" type="password" minlength="8" autocomplete="new-password" required>' : ''}
        <p id="private-password-error" class="password-error hidden" role="alert"></p>
        <button class="button button-primary password-submit" type="submit">${settingUp ? 'Encrypt and continue' : 'Unlock'}</button>
      </form>`, settingUp ? 'PASSWORD PROTECTION' : 'PRIVATE NOTES');

    const form = $('#private-password-form');
    const passwordInput = $('#private-password');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const password = passwordInput.value;
      const error = $('#private-password-error');
      error.classList.add('hidden');
      try {
        if (settingUp) {
          if (password.length < 8) throw new Error('Use at least 8 characters.');
          if (password !== $('#private-password-confirm').value) throw new Error('The passwords do not match.');
          await createPrivatePassword(password, noteToPrivatize);
        } else {
          await unlockPrivate(password);
        }
        closeModal();
        currentView = 'private';
        currentFilter = '';
        ui.search.value = '';
        render();
        await onSuccess();
      } catch (reason) {
        error.textContent = reason instanceof Error ? reason.message : 'Could not unlock Private.';
        error.classList.remove('hidden');
        passwordInput.value = '';
        passwordInput.focus();
      }
    });
    passwordInput.focus();
  }

  async function lockPrivate() {
    if (!privateKey) return;
    if (!await saveBeforeAction()) return;
    let storedNotes;
    try {
      storedNotes = await requestResult(db.transaction('notes').objectStore('notes').getAll());
    } catch (error) {
      showStatus(`Could not lock Private: ${error.message}`, true);
      return;
    }
    privateKey = null;
    notes = storedNotes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    selectedId = null;
    currentView = 'private';
    ui.search.value = '';
    ui.moreMenu.classList.add('hidden');
    render();
    showStatus('Private notes are locked.');
  }

  function closeModal() {
    ui.modal.classList.add('hidden');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  async function openSettings() {
    const defaults = document.documentElement.dataset.theme === 'light'
      ? { backgroundColor: '#f5f7f8', fontColor: '#1d2933', fontFamily: 'sans' }
      : { backgroundColor: '#000000', fontColor: '#ffffff', fontFamily: 'sans' };
    const values = appearance || defaults;
    const familyOptions = [
      ['sans', 'Arial'],
      ['system', 'System default'],
      ['serif', 'Georgia (serif)'],
      ['mono', 'Consolas (monospace)'],
    ].map(([value, label]) => `<option value="${value}" ${values.fontFamily === value ? 'selected' : ''}>${label}</option>`).join('');
    openModal('Make it yours', `
      <form id="settings-form" class="settings-form">
        <p class="settings-copy">Personalize how OFFNOTE looks on this device.</p>
        <label for="setting-background">Background color</label>
        <input id="setting-background" name="backgroundColor" type="color" value="${values.backgroundColor}">
        <label for="setting-font-color">Font color</label>
        <input id="setting-font-color" name="fontColor" type="color" value="${values.fontColor}">
        <label for="setting-font-family">Font family</label>
        <select id="setting-font-family" name="fontFamily">${familyOptions}</select>
        <p id="settings-error" class="password-error hidden" role="alert"></p>
        <div class="settings-actions">
          <button class="button button-primary password-submit" type="submit">Save appearance</button>
          <button class="small-button" id="reset-appearance" type="button">Reset</button>
        </div>
        <div class="settings-password">
          <div><strong>Private notes</strong><span>${privateConfig ? 'Change the password that protects your encrypted notes.' : 'Set a password to protect notes in Private.'}</span></div>
          <button class="small-button" id="change-private-password" type="button">${privateConfig ? 'Change password' : 'Set password'}</button>
        </div>
      </form>`, 'SETTINGS');

    $('#settings-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const nextAppearance = normalizeAppearance({
        backgroundColor: data.get('backgroundColor'),
        fontColor: data.get('fontColor'),
        fontFamily: data.get('fontFamily'),
      });
      if (!nextAppearance) {
        const error = $('#settings-error');
        error.textContent = 'Choose valid colors and a font family.';
        error.classList.remove('hidden');
        return;
      }
      try {
        await saveSetting({ key: APPEARANCE_CONFIG_KEY, ...nextAppearance });
        appearance = nextAppearance;
        applyAppearance();
        closeModal();
        showStatus('Appearance settings saved.');
      } catch (error) {
        const message = $('#settings-error');
        message.textContent = error.message;
        message.classList.remove('hidden');
      }
    });
  }

  function showChangePrivatePasswordDialog() {
    if (!privateConfig) {
      showPrivatePasswordDialog('setup');
      return;
    }
    openModal('Change Private password', `
      <form id="change-private-password-form" class="password-form">
        <p class="password-copy">Your private notes will be re-encrypted with the new password. Choose a password you can remember; forgotten passwords cannot be recovered.</p>
        <label for="current-private-password">Current password</label>
        <input id="current-private-password" name="current-password" type="password" autocomplete="current-password" required>
        <label for="new-private-password">New password</label>
        <input id="new-private-password" name="new-password" type="password" minlength="8" autocomplete="new-password" required>
        <label for="confirm-private-password">Confirm new password</label>
        <input id="confirm-private-password" name="confirm-password" type="password" minlength="8" autocomplete="new-password" required>
        <p id="change-private-password-error" class="password-error hidden" role="alert"></p>
        <button class="button button-primary password-submit" type="submit">Re-encrypt private notes</button>
      </form>`, 'PASSWORD PROTECTION');

    const form = $('#change-private-password-form');
    const currentInput = $('#current-private-password');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const newPassword = $('#new-private-password').value;
      const error = $('#change-private-password-error');
      error.classList.add('hidden');
      try {
        if (newPassword.length < 8) throw new Error('Use at least 8 characters for the new password.');
        if (newPassword !== $('#confirm-private-password').value) throw new Error('The new passwords do not match.');
        if (!window.crypto || !crypto.subtle) throw new Error('Password protection needs a secure browser context (localhost or HTTPS).');
        await changePrivatePassword(currentInput.value, newPassword);
        closeModal();
        render();
        showStatus('Private password changed. Your private notes were re-encrypted.');
      } catch (reason) {
        error.textContent = reason instanceof Error ? reason.message : 'Could not change the Private password.';
        error.classList.remove('hidden');
        currentInput.value = '';
        currentInput.focus();
      }
    });
    currentInput.focus();
  }

  function openHistory() {
    const note = selectedNote();
    if (!note) return;
    const history = [...(note.history || [])].reverse();
    const content = history.length ? history.map((entry, index) => `
      <div class="history-item">
        <div class="history-copy"><strong>${escapeHtml(entry.title.trim() || 'Untitled note')}</strong><span>${formatDateTime(entry.savedAt)} · ${entry.content.trim().split(/\s+/).filter(Boolean).length} words</span></div>
        <button class="small-button" type="button" data-restore-history="${history.length - 1 - index}">Restore</button>
      </div>`).join('') : '<p class="modal-empty">Older versions will show up here as you make changes.</p>';
    openModal('Version history', content, 'PAST VERSIONS');
  }

  async function restoreHistory(index) {
    const note = selectedNote();
    const entry = note && note.history[index];
    if (!note || !entry) return;
    const history = [...(note.history || []), { title: note.title, content: note.content, savedAt: Date.now() }].slice(-MAX_HISTORY);
    Object.assign(note, { title: entry.title, content: entry.content, history, updatedAt: Date.now() });
    try {
      await persistNote(note);
      closeModal();
      render();
      showStatus('Earlier version restored.');
    } catch (error) { showStatus(`Could not restore this version: ${error.message}`, true); }
  }

  function openShortcuts() {
    openModal('A few handy keys', `
      <div class="shortcut-list">
        <span>New note</span><kbd>Ctrl / ⌘ + N</kbd>
        <span>Search notes</span><kbd>Ctrl / ⌘ + K</kbd>
        <span>Command palette</span><kbd>Ctrl / ⌘ + Shift + P</kbd>
        <span>Save note</span><kbd>Ctrl / ⌘ + S</kbd>
        <span>Close this window</span><kbd>Esc</kbd>
      </div>`, 'KEYBOARD SHORTCUTS');
  }

  function openCommandPalette() {
    openModal('What would you like to do?', `
      <div class="shortcut-list">
        <button class="palette-action text-button" data-command="new" type="button">Create a new note</button><kbd>Ctrl / ⌘ + N</kbd>
        <button class="palette-action text-button" data-command="search" type="button">Search your notes</button><kbd>Ctrl / ⌘ + K</kbd>
        <button class="palette-action text-button" data-command="pinned" type="button">Show pinned notes</button><kbd></kbd>
        <button class="palette-action text-button" data-command="liked" type="button">Show liked notes</button><kbd></kbd>
        <button class="palette-action text-button" data-command="recent" type="button">Show recent notes</button><kbd></kbd>
        <button class="palette-action text-button" data-command="archive" type="button">Show archived notes</button><kbd></kbd>
        <button class="palette-action text-button" data-command="private" type="button">Show private notes</button><kbd></kbd>
        <button class="palette-action text-button" data-command="export" type="button">Export all notes</button><kbd></kbd>
        <button class="palette-action text-button" data-command="shortcuts" type="button">Keyboard shortcuts</button><kbd></kbd>
      </div>`, 'COMMANDS');
  }

  function showGraph() {
    const available = activeNotes();
    const width = 500;
    const height = 300;
    const centerX = width / 2;
    const centerY = height / 2;
    const nodes = available.map((note, index) => {
      const angle = available.length === 1 ? 0 : (Math.PI * 2 * index / available.length) - Math.PI / 2;
      const radius = Math.min(115, 36 + available.length * 7);
      return { note, x: centerX + (available.length === 1 ? 0 : Math.cos(angle) * radius), y: centerY + (available.length === 1 ? 0 : Math.sin(angle) * radius) };
    });
    const edges = [];
    nodes.forEach((source) => {
      const matches = [...source.note.content.matchAll(/\[\[([^[\]]+)\]\]/g)];
      matches.forEach((match) => {
        const target = nodes.find((node) => displayTitle(node.note).toLocaleLowerCase() === match[1].trim().toLocaleLowerCase());
        if (target) edges.push(`<line class="graph-edge" x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}"/>`);
      });
    });
    const elements = nodes.map(({ note, x, y }) => {
      const label = displayTitle(note).slice(0, 22);
      return `<g data-note-id="${escapeHtml(note.id)}"><circle class="graph-node ${note.id === selectedId ? 'current' : ''}" cx="${x}" cy="${y}" r="8"/><text class="graph-label" x="${x + 12}" y="${y + 4}">${escapeHtml(label)}</text></g>`;
    });
    openModal('Notes, connected', nodes.length ? `<div class="graph-wrap"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Map of notes and their links">${edges.join('')}${elements.join('')}</svg></div><p class="modal-empty">Use [[note title]] in a note to connect it to another.</p>` : '<p class="modal-empty">Your note map will appear here. Link notes with [[note title]] to connect them.</p>', 'NOTE MAP');
  }

  async function navigate(view, filter = '') {
    if (privateKey && currentView === 'private' && view !== 'private') await lockPrivate();
    currentView = view;
    currentFilter = filter;
    appShell.classList.remove('nav-open');
    ui.search.value = '';
    render();
  }

  document.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('.theme-toggle')) {
      const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_STORAGE_KEY, theme);
      applyTheme(theme);
      applyAppearance();
      return;
    }
    const noteButton = target.closest('[data-note-id]');
    if (noteButton) {
      event.preventDefault();
      await selectNote(noteButton.dataset.noteId);
      if (target.closest('.duplicate-warning')) showStatus('Opened the similar note.');
      return;
    }
    const folderButton = target.closest('[data-folder]');
    if (folderButton) { await navigate('folder', folderButton.dataset.folder); return; }
    const tagButton = target.closest('[data-tag]');
    if (tagButton) { await navigate('tag', tagButton.dataset.tag); return; }
    const viewButton = target.closest('[data-view]');
    if (viewButton) {
      if (viewButton.dataset.view === 'private' && !privateKey) {
        showPrivatePasswordDialog(privateConfig ? 'unlock' : 'setup');
      } else {
        await navigate(viewButton.dataset.view);
      }
      return;
    }
    const historyButton = target.closest('[data-restore-history]');
    if (historyButton) { await restoreHistory(Number(historyButton.dataset.restoreHistory)); return; }
    const commandButton = target.closest('[data-command]');
    if (commandButton) {
      const action = commandButton.dataset.command;
      closeModal();
      if (action === 'new') await createNote();
      else if (action === 'search') ui.search.focus();
      else if (['pinned', 'liked', 'recent', 'archive', 'private'].includes(action)) await navigate(action);
      else if (action === 'export') await exportJson('all');
      else if (action === 'shortcuts') openShortcuts();
      return;
    }
    if (target.closest('#settings-open')) {
      if (!await saveBeforeAction()) return;
      await openSettings();
      return;
    }
    if (target.closest('#change-private-password')) { showChangePrivatePasswordDialog(); return; }
    if (target.closest('#reset-appearance')) {
      try {
        await removeSetting(APPEARANCE_CONFIG_KEY);
        appearance = null;
        applyAppearance();
        closeModal();
        showStatus('Appearance settings reset.');
      } catch (error) {
        const message = $('#settings-error');
        message.textContent = error.message;
        message.classList.remove('hidden');
      }
      return;
    }
    if (target.closest('#mobile-nav-toggle')) { appShell.classList.toggle('nav-open'); return; }
    if (target.closest('#back-to-list')) {
      if (privateKey && selectedNote() && selectedNote().isPrivate) {
        await lockPrivate();
      } else {
        clearTimeout(saveTimer);
        await saveSelected();
      }
      selectedId = null;
      appShell.classList.remove('nav-open');
      render();
      return;
    }
    if (target.closest('#empty-new') && currentView === 'trash' && !privateKey && notes.some((note) => note.deletedAt && note.isPrivate)) {
      showPrivatePasswordDialog('unlock', () => {
        currentView = 'trash';
        render();
      });
      return;
    }
    if (target.closest('#new-note, #mobile-new, #empty-new, #welcome-new')) { appShell.classList.remove('nav-open'); await createNote(); return; }
    if (target.closest('#pin-note')) { await togglePinned(); return; }
    if (target.closest('#like-note')) { await toggleLiked(); return; }
    if (target.closest('#rename-note')) {
      ui.moreMenu.classList.add('hidden');
      ui.title.focus();
      ui.title.select();
      return;
    }
    if (target.closest('#archive-note')) { await toggleArchive(); return; }
    if (target.closest('#private-note')) { await togglePrivate(); return; }
    if (target.closest('#lock-private')) { await lockPrivate(); return; }
    if (target.closest('#permanent-delete')) { await permanentlyDelete(); return; }
    if (target.closest('#delete-note')) { await moveToTrash(); return; }
    if (target.closest('#history-note')) { openHistory(); return; }
    if (target.closest('#graph-open')) { showGraph(); return; }
    if (target.closest('#preview-toggle')) { previewing = !previewing; updatePreview(); return; }
    if (target.closest('#export-note')) { await exportJson('selected'); return; }
    if (target.closest('#export-markdown')) { await exportMarkdown(); return; }
    if (target.closest('#menu-open')) { ui.moreMenu.classList.toggle('hidden'); return; }
    if (target.closest('#import-button')) { ui.moreMenu.classList.add('hidden'); $('#import-file').click(); return; }
    if (target.closest('#export-all')) { await exportJson('all'); return; }
    if (target.closest('#install-button')) { if (installPrompt) { installPrompt.prompt(); installPrompt = null; } return; }
    if (target.closest('#command-open')) { ui.moreMenu.classList.add('hidden'); openCommandPalette(); return; }
    if (target.closest('#modal-close')) { closeModal(); return; }
    if (target === ui.modal) { closeModal(); return; }
    if (target.closest('.wiki-link')) {
      const title = target.closest('.wiki-link').dataset.wikiTitle;
      const linked = activeNotes().find((note) => displayTitle(note).toLocaleLowerCase() === title.toLocaleLowerCase());
      if (linked) await selectNote(linked.id);
      else showStatus(`No note titled “${title}” yet.`);
      return;
    }
    if (!target.closest('#more-menu')) ui.moreMenu.classList.add('hidden');
  });

  [ui.title, ui.folder, ui.tags, ui.content].forEach((field) => field.addEventListener('input', queueSave));
  ui.search.addEventListener('input', renderNoteList);
  $('#import-file').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) importFile(file);
  });

  document.addEventListener('keydown', async (event) => {
    const modifier = event.ctrlKey || event.metaKey;
    if (event.key === 'Escape') {
      if (!ui.modal.classList.contains('hidden')) closeModal();
      else ui.moreMenu.classList.add('hidden');
      return;
    }
    if (!modifier) return;
    const key = event.key.toLocaleLowerCase();
    if (key === 'n') { event.preventDefault(); await createNote(); }
    else if (key === 'k') { event.preventDefault(); ui.search.focus(); ui.search.select(); }
    else if (key === 's') { event.preventDefault(); clearTimeout(saveTimer); await saveSelected(); }
    else if (key === 'p' && event.shiftKey) { event.preventDefault(); openCommandPalette(); }
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    $('#install-button').classList.remove('hidden');
  });
  window.addEventListener('appinstalled', () => showStatus('OFFNOTE is ready on your device.'));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && privateKey) lockPrivate();
  });

  async function start() {
    if (!('indexedDB' in window)) {
      showStatus('This browser does not support local notebook storage. Try a newer browser.', true);
      return;
    }
    try {
      db = await openDatabase();
      await loadNotes();
      appearance = normalizeAppearance(await getSetting(APPEARANCE_CONFIG_KEY));
      applyAppearance();
      if ('serviceWorker' in navigator && location.protocol !== 'file:') {
        navigator.serviceWorker.register('./sw.js').catch((error) => showStatus(`Offline support could not start: ${error.message}`, true));
      }
    } catch (error) {
      
      showStatus(`Could not open your notebook: ${error.message}`, true);
      ui.saveState.textContent = 'Storage unavailable';
    }
  }

  start();
})();
