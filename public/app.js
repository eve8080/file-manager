// Single-page UI. All user-controlled text is inserted with textContent, never innerHTML.

const els = {
  breadcrumbs: document.getElementById('breadcrumbs'),
  listing: document.getElementById('listing'),
  status: document.getElementById('status'),
  sort: document.getElementById('sort'),
  newFolderForm: document.getElementById('new-folder-form'),
  newFolderName: document.getElementById('new-folder-name'),
  uploadInput: document.getElementById('upload-input'),
  uploads: document.getElementById('uploads'),
  uploadLabel: document.querySelector('label.upload'),
};

// Invariant: current.prefix always equals the folder in the URL hash (see load()).
let current = { prefix: '', folders: [], files: [] };
let loadSeq = 0;
let loadController = null;
// Incremented on every navigation (hash change). A create/delete records it when it starts and
// may only update the page if no navigation happened while it was in flight (see stillOn()).
let navSeq = 0;
// Create/delete outcomes ({ text, isError }) in this folder whose reload is still running. A newer
// reload in the same folder makes an older one stale, so whichever reload finishes last reports them
// all. Cleared on navigation (D16); a dropped partial-delete warning is alerted instead.
let pendingReports = [];

function navigationToken() {
  const token = navSeq;
  return { stillOn: () => token === navSeq };
}

// ---- API ----

async function api(method, url, body, signal) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `Request failed (${res.status})`);
    err.code = data.error?.code;
    err.status = res.status;
    err.details = data.error?.details;
    throw err;
  }
  return data;
}

// ---- Navigation: the current folder lives in the URL hash, e.g. #/Documents/Invoices/ ----

function prefixFromHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  try {
    const names = parts.map(decodeURIComponent);
    return names.length ? `${names.join('/')}/` : '';
  } catch {
    return '';
  }
}

function hashFor(prefix) {
  const names = prefix.split('/').filter(Boolean);
  return `#/${names.map(encodeURIComponent).join('/')}${names.length ? '/' : ''}`;
}

// ---- Rendering ----

// Upload is only possible into the folder on screen after it loaded successfully: uploading into a
// folder that failed to load (e.g. 404) would create it implicitly. Only the current load toggles this.
function setUploadEnabled(enabled) {
  els.uploadInput.disabled = !enabled;
  els.uploadLabel.setAttribute('aria-disabled', String(!enabled));
  els.uploadLabel.classList.toggle('disabled', !enabled);
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error', isError);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function renderBreadcrumbs(prefix) {
  els.breadcrumbs.replaceChildren();
  const names = prefix.split('/').filter(Boolean);
  const root = el('a', null, 'Home');
  root.href = hashFor('');
  els.breadcrumbs.append(root);
  names.forEach((name, i) => {
    els.breadcrumbs.append(el('span', 'sep', '/'));
    if (i === names.length - 1) {
      const here = el('span', 'here', name);
      here.setAttribute('aria-current', 'page');
      els.breadcrumbs.append(here);
    } else {
      const link = el('a', null, name);
      link.href = hashFor(`${names.slice(0, i + 1).join('/')}/`);
      els.breadcrumbs.append(link);
    }
  });
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortEntries(folders, files) {
  const [field, direction] = els.sort.value.split('-');
  const sign = direction === 'desc' ? -1 : 1;
  const byName = (a, b) => sign * collator.compare(a.name, b.name);
  const sortedFolders = [...folders].sort(field === 'name' ? byName : (a, b) => collator.compare(a.name, b.name));
  const sortedFiles = [...files].sort((a, b) => {
    if (field === 'size') return sign * (a.size - b.size) || collator.compare(a.name, b.name);
    if (field === 'modified') return sign * a.modified.localeCompare(b.modified) || collator.compare(a.name, b.name);
    return byName(a, b);
  });
  return { folders: sortedFolders, files: sortedFiles };
}

function renderListing() {
  const { folders, files } = sortEntries(current.folders, current.files);
  els.listing.replaceChildren();
  els.listing.dataset.prefix = current.prefix; // lets browser tests check the invariant

  if (folders.length === 0 && files.length === 0) {
    els.listing.append(el('li', 'empty', 'This folder is empty.'));
    return;
  }

  for (const folder of folders) {
    const row = el('li', 'row folder');
    const link = el('a', 'name', folder.name);
    link.href = hashFor(folder.path);
    link.prepend(el('span', 'icon', '📁'));
    const del = el('button', 'danger', 'Delete');
    del.type = 'button';
    del.setAttribute('aria-label', `Delete folder ${folder.name}`);
    del.addEventListener('click', () => deleteFolder(folder));
    row.append(link, el('span', 'meta', 'Folder'), del);
    els.listing.append(row);
  }

  for (const file of files) {
    const row = el('li', 'row file');
    const name = el('span', 'name', file.name);
    name.prepend(el('span', 'icon', '📄'));
    const actions = el('span', 'actions');
    const download = el('a', 'button download', 'Download');
    download.href = `/api/files/download?key=${encodeURIComponent(file.key)}`;
    download.setAttribute('aria-label', `Download ${file.name}`);
    const rename = el('button', null, 'Rename');
    rename.type = 'button';
    rename.setAttribute('aria-label', `Rename file ${file.name}`);
    rename.addEventListener('click', () => renameFile(file));
    const del = el('button', 'danger', 'Delete');
    del.type = 'button';
    del.setAttribute('aria-label', `Delete file ${file.name}`);
    del.addEventListener('click', () => deleteFile(file));
    actions.append(download, rename, del);
    row.append(name, el('span', 'meta', `${formatSize(file.size)} · ${formatDate(file.modified)}`), actions);
    els.listing.append(row);
  }
}

// ---- Actions ----

// Loads the folder named in the URL hash. Rapid navigation can start several loads; only the
// newest may update the page. Older requests are aborted, and any response that still arrives
// late is ignored by comparing sequence numbers, so the URL and `current` never disagree.
// Resolves to { ok: true }, { ok: false, message } (also shown as the status), or { stale: true }.
async function load() {
  const prefix = prefixFromHash();
  // Keep the URL in canonical form (an undecodable hash means the root). replaceState doesn't
  // fire hashchange, so this can't loop, and it adds no history entry.
  const canonical = hashFor(prefix);
  if (location.hash !== canonical) history.replaceState(null, '', canonical);
  const seq = ++loadSeq;
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;

  current = { prefix, folders: [], files: [] };
  renderBreadcrumbs(prefix);
  els.listing.replaceChildren();
  els.listing.dataset.prefix = prefix;
  setUploadEnabled(false);
  setStatus('Loading…');
  try {
    const data = await api('GET', `/api/list?prefix=${encodeURIComponent(prefix)}`, undefined, controller.signal);
    if (seq !== loadSeq) return { stale: true };
    current = { prefix, folders: data.folders, files: data.files };
    renderListing();
    setUploadEnabled(true);
    setStatus('');
    return { ok: true };
  } catch (err) {
    if (seq !== loadSeq || err.name === 'AbortError') return { stale: true };
    const message = err.status === 404 ? 'This folder does not exist.' : err.message;
    setStatus(message, true);
    return { ok: false, message };
  }
}

// After a create/delete, reloads the folder and reports `text` (a sentence, e.g. 'Created folder "x".')
// without hiding a failed reload. If a newer reload supersedes this one, that reload reports `text`
// too. Reports nothing in the status if the user navigated meanwhile (a dropped warning is alerted
// by the hashchange handler, see D16).
async function reloadAndReport(nav, text, isError = false) {
  pendingReports.push({ text, isError });
  const reload = await load();
  if (!nav.stillOn() || reload.stale) return;
  const reports = pendingReports;
  pendingReports = [];
  const joined = reports.map((r) => r.text).join(' ');
  const anyError = reports.some((r) => r.isError);
  if (reload.ok) setStatus(joined, anyError);
  else if (anyError) setStatus(`${joined} The folder could not be reloaded: ${reload.message}`, true);
  else setStatus(`${joined.slice(0, -1)}, but the folder could not be reloaded: ${reload.message}`, true);
}

async function createFolder(event) {
  event.preventDefault();
  const name = els.newFolderName.value.trim();
  if (!name) return;
  if (name.includes('/')) {
    setStatus('Folder names cannot contain "/".', true);
    return;
  }
  const nav = navigationToken();
  try {
    await api('POST', '/api/folders', { path: `${current.prefix}${name}/` });
    if (!nav.stillOn()) return; // the user has moved on; leave the new folder's page alone
    els.newFolderName.value = '';
    await reloadAndReport(nav, `Created folder "${name}".`);
  } catch (err) {
    if (!nav.stillOn()) return;
    setStatus(err.message, true);
  }
}

async function deleteFolder(folder) {
  if (!confirm(`Delete folder "${folder.name}"?`)) return;
  const url = `/api/folders?path=${encodeURIComponent(folder.path)}`;
  const nav = navigationToken();
  try {
    try {
      await api('DELETE', url);
    } catch (err) {
      if (err.code !== 'FOLDER_NOT_EMPTY') throw err;
      // Never ask about deleting a folder the user is no longer looking at.
      if (!nav.stillOn()) return;
      const typed = prompt(
        `"${folder.name}" is not empty. Everything inside it will be permanently deleted.\n\n` +
          'Type the folder name to confirm:',
      );
      if (typed !== folder.name) {
        setStatus('Delete cancelled.');
        return;
      }
      // The server checks `confirm` too; this check only avoids a pointless request.
      await api('DELETE', `${url}&recursive=true&confirm=${encodeURIComponent(typed)}`);
    }
    if (!nav.stillOn()) return;
    await reloadAndReport(nav, `Deleted folder "${folder.name}".`);
  } catch (err) {
    if (err.code === 'DELETE_INCOMPLETE') {
      const d = err.details ?? {};
      const message =
        `Delete of "${folder.name}" stopped partway: ${d.deleted ?? '?'} deleted, ` +
        `${(d.failedCount ?? 0) + (d.unknown ?? 0) + (d.notAttempted ?? 0)} may remain. ${err.message}`;
      if (!nav.stillOn()) {
        // Possible data loss must not go unreported, but the current folder's status isn't ours to change.
        alert(message);
        return;
      }
      await reloadAndReport(nav, message, true); // show what actually remains, and keep the warning
      return;
    }
    if (!nav.stillOn()) return;
    setStatus(err.message, true);
  }
}

// Rename in place, or edit the path to move the file to another folder. The server validates `to`.
async function renameFile(file) {
  const to = prompt(`New name or path for "${file.name}":`, file.key);
  if (to === null || to === file.key) return;
  const nav = navigationToken();
  try {
    await api('POST', '/api/files/move', { from: file.key, to });
    if (!nav.stillOn()) return; // D16
    await reloadAndReport(nav, `Renamed "${file.name}" to "${to}".`);
  } catch (err) {
    if (!nav.stillOn()) return;
    setStatus(err.message, true);
  }
}

async function deleteFile(file) {
  if (!confirm(`Delete file "${file.name}"?`)) return;
  const nav = navigationToken();
  try {
    await api('DELETE', `/api/files?key=${encodeURIComponent(file.key)}`);
    if (!nav.stillOn()) return; // D16: the user has moved on; leave the new folder's status alone
    await reloadAndReport(nav, `Deleted file "${file.name}".`);
  } catch (err) {
    if (!nav.stillOn()) return;
    setStatus(err.message, true);
  }
}

// Uploads the chosen files into the folder shown when they were picked, one request per file, so each
// has its own progress bar and result in the upload list. The list keeps every file's outcome, across
// overlapping uploads and navigation; the folder's status line follows D16 like create/delete.
async function uploadFiles() {
  const files = [...els.uploadInput.files];
  els.uploadInput.value = ''; // allow picking the same file again
  if (files.length === 0 || els.uploadInput.disabled) return; // the folder on screen did not load
  const prefix = current.prefix;
  const nav = navigationToken();
  const items = files.map((file) => {
    const li = el('li');
    li.dataset.state = 'uploading';
    const progress = el('progress');
    progress.max = 100;
    progress.value = 0;
    const result = el('span', 'result', 'Waiting…');
    li.append(el('span', 'name', file.name), progress, result);
    return { li, progress, result };
  });
  // Appended, never replaced: an earlier upload may still be running, and its status line may point at
  // its rows ("see the list below"). The list lasts until the page is reloaded.
  els.uploads.append(...items.map((i) => i.li));

  let uploaded = 0;
  for (const [i, file] of files.entries()) {
    const { li, progress, result } = items[i];
    result.textContent = 'Uploading…';
    const outcome = await uploadOne(prefix, file, progress);
    li.dataset.state = outcome.ok ? 'ok' : 'error';
    result.textContent = outcome.ok ? 'Uploaded' : outcome.message;
    if (outcome.ok) {
      progress.value = 100;
      uploaded += 1;
    }
  }
  if (!nav.stillOn()) return; // D16
  const failed = files.length - uploaded;
  const text =
    failed === 0
      ? `Uploaded ${files.length === 1 ? `"${files[0].name}"` : `${files.length} files`}.`
      : `Uploaded ${uploaded} of ${files.length} files; ${failed} failed (see the list below).`;
  await reloadAndReport(nav, text, failed > 0);
}

// One file in one multipart request; XMLHttpRequest because fetch reports no upload progress.
// Resolves to { ok: true } or { ok: false, message }.
function uploadOne(prefix, file, progress) {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append('files', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/files?prefix=${encodeURIComponent(prefix)}`);
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) progress.value = Math.floor((event.loaded / event.total) * 100);
    });
    xhr.addEventListener('load', () => {
      if (xhr.status === 201) return resolve({ ok: true });
      const error = xhr.response?.error;
      resolve({ ok: false, message: error?.details?.files?.[0]?.error?.message ?? error?.message ?? `Upload failed (${xhr.status})` });
    });
    xhr.addEventListener('error', () => resolve({ ok: false, message: 'Upload failed: the connection was lost.' }));
    xhr.send(form);
  });
}

els.uploadInput.addEventListener('change', uploadFiles);
els.newFolderForm.addEventListener('submit', createFolder);
els.sort.addEventListener('change', renderListing);
window.addEventListener('hashchange', () => {
  navSeq += 1;
  const dropped = pendingReports;
  pendingReports = [];
  load();
  // Possible data loss must not go unreported, but the new folder's status isn't ours to change.
  for (const report of dropped) if (report.isError) alert(report.text);
});
load();
