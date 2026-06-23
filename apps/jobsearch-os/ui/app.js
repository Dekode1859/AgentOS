'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  port: null,
  config: null,
  docs: [],          // [{ name, path }] uploaded into workspace/documents
  profile: null,     // parsed profile.json
  editing: false,
};

const PROFILE_PATH = 'profile/profile.json';
const DOCS_FOLDER = 'documents';

// Empty profile matching the agent's schema — used as a render/edit fallback.
function emptyProfile() {
  return {
    name: '', headline: '', summary: '', location: '',
    contact: { email: '', phone: '', links: [] },
    skills: [], experience: [], projects: [], certifications: [], education: [],
  };
}

// ── Bridge (Core) ─────────────────────────────────────────────────────────────
const bridge = (() => {
  const call = (m, ...a) => window.pywebview.api[m](...a).catch(e => { console.error(`bridge.${m}`, e); throw e; });
  return {
    getConfig:        ()             => call('get_config'),
    workspaceTree:    ()             => call('workspace_tree'),
    workspaceList:    (folder)       => call('workspace_list', folder),
    workspaceRead:    (path)         => call('workspace_read', path),
    workspaceWrite:   (path, text)   => call('workspace_write', path, text),
    workspaceDelete:  (path)         => call('workspace_delete', path),
  };
})();

// ── OpenCode HTTP ──────────────────────────────────────────────────────────────
async function oc(path, options = {}) {
  const r = await fetch(`http://127.0.0.1:${state.port}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.text()).slice(0, 300); } catch (_) {}
    throw new Error(`HTTP ${r.status}${detail ? ': ' + detail : ''}`);
  }
  if (r.status === 204) return null;
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// ── Documents ──────────────────────────────────────────────────────────────────
function isTextFile(name) {
  return /\.(txt|md|markdown|json)$/i.test(name);
}

async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  for (const f of files) {
    if (!isTextFile(f.name)) {
      showToast(`Skipped ${f.name} — text files only in V0 (.txt/.md/.json)`);
      continue;
    }
    try {
      const text = await f.text();
      await bridge.workspaceWrite(`${DOCS_FOLDER}/${f.name}`, text);
    } catch (e) {
      showToast(`Could not read ${f.name}`);
    }
  }
  await refreshDocs();
}

async function refreshDocs() {
  try {
    state.docs = await bridge.workspaceList(DOCS_FOLDER) || [];
  } catch (_) {
    state.docs = [];
  }
  renderDocs();
  updateGenerateEnabled();
}

function renderDocs() {
  const el = document.getElementById('doc-list');
  if (!state.docs.length) { el.innerHTML = ''; return; }
  el.innerHTML = state.docs.map(d => `
    <div class="doc-item">
      <sl-icon library="lucide" name="file-text"></sl-icon>
      <span class="doc-name" title="${escAttr(d.name)}">${escHtml(d.name)}</span>
      <button class="doc-del" data-path="${escAttr(d.path)}" title="Remove">&times;</button>
    </div>
  `).join('');
}

function updateGenerateEnabled() {
  const hasPaste = document.getElementById('paste-text').value.trim().length > 20;
  const hasDocs = state.docs.length > 0;
  document.getElementById('btn-generate').disabled = !(hasPaste || hasDocs);
}

async function gatherResumeText() {
  const parts = [];
  const pasted = document.getElementById('paste-text').value.trim();
  if (pasted) parts.push(pasted);
  for (const d of state.docs) {
    try {
      const res = await bridge.workspaceRead(d.path);
      if (res && res.content) parts.push(`# Document: ${d.name}\n${res.content}`);
    } catch (_) {}
  }
  return parts.join('\n\n---\n\n').trim();
}

// ── Extraction ──────────────────────────────────────────────────────────────────
// Defensively pull a JSON object out of an LLM reply (handles stray prose or
// ```json fences, though the agent is instructed to emit raw JSON).
function parseProfileJson(text) {
  let t = (text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

async function generateProfile() {
  const text = await gatherResumeText();
  if (!text) { showToast('Add a document or paste résumé text first.'); return; }

  setGenerating(true);
  try {
    const session = await oc('/session', { method: 'POST', body: '{}' });

    // Synchronous: returns only once the assistant turn completes. The agent is
    // a pure JSON extractor (no tools) — we parse and persist deterministically.
    const msg = await oc(`/session/${session.id}/message`, {
      method: 'POST',
      body: JSON.stringify({
        agent: 'profile',
        parts: [{ type: 'text', text: 'Documents:\n\n' + text }],
      }),
    });

    const reply = (msg?.parts || [])
      .filter(p => p.type === 'text' && p.text)
      .map(p => p.text).join('');

    let parsed;
    try {
      parsed = parseProfileJson(reply);
    } catch (_) {
      // Keep the page usable: editable empty schema.
      state.profile = emptyProfile();
      enterEdit();
      showToast('Could not parse the profile — please edit manually.');
      return;
    }

    state.profile = { ...emptyProfile(), ...parsed };
    await bridge.workspaceWrite(PROFILE_PATH, JSON.stringify(state.profile, null, 2));
    renderProfile();
    showToast('Profile generated.');
  } catch (e) {
    showToast(`Generation failed: ${e.message}`);
  } finally {
    setGenerating(false);
  }
}

function setGenerating(on) {
  document.getElementById('btn-generate').loading = on;
  const s = document.getElementById('gen-status');
  s.classList.toggle('hidden', !on);
  if (on) s.textContent = 'Analyzing your documents…';
}

// ── Profile load / render / edit ─────────────────────────────────────────────────
async function loadProfile() {
  try {
    const res = await bridge.workspaceRead(PROFILE_PATH);
    if (res && res.content && !res.error) {
      state.profile = { ...emptyProfile(), ...JSON.parse(res.content) };
      renderProfile();
      return true;
    }
  } catch (_) {}
  return false;
}

function showProfileEmpty(show) {
  document.getElementById('profile-empty').classList.toggle('hidden', !show);
  document.getElementById('profile-card').classList.toggle('hidden', show);
  document.getElementById('btn-edit').classList.toggle('hidden', show);
}

function renderProfile() {
  const p = state.profile;
  if (!p) { showProfileEmpty(true); return; }
  showProfileEmpty(false);
  state.editing = false;
  document.getElementById('btn-save').classList.add('hidden');
  document.getElementById('btn-edit').classList.remove('hidden');

  const card = document.getElementById('profile-card');
  card.innerHTML = `
    <div class="p-head">
      <div class="p-name">${escHtml(p.name) || 'Unnamed'}</div>
      <div class="p-headline">${escHtml(p.headline || '')}</div>
      <div class="p-meta">
        ${p.location ? `<span><sl-icon library="lucide" name="map-pin"></sl-icon>${escHtml(p.location)}</span>` : ''}
        ${p.contact?.email ? `<span><sl-icon library="lucide" name="mail"></sl-icon>${escHtml(p.contact.email)}</span>` : ''}
        ${(p.contact?.links || []).map(l => `<a href="#" class="p-link">${escHtml(l)}</a>`).join('')}
      </div>
    </div>
    ${p.summary ? `<div class="p-section"><h3>Summary</h3><p>${escHtml(p.summary)}</p></div>` : ''}
    ${chips('Skills', p.skills)}
    ${experienceBlock(p.experience)}
    ${projectsBlock(p.projects)}
    ${chips('Certifications', p.certifications)}
    ${educationBlock(p.education)}
  `;
}

function chips(title, arr) {
  if (!arr || !arr.length) return '';
  return `<div class="p-section"><h3>${title}</h3><div class="chips">${
    arr.map(s => `<span class="chip">${escHtml(String(s))}</span>`).join('')
  }</div></div>`;
}

function experienceBlock(arr) {
  if (!arr || !arr.length) return '';
  return `<div class="p-section"><h3>Experience</h3>${arr.map(e => `
    <div class="entry">
      <div class="entry-head">
        <span class="entry-title">${escHtml(e.title || '')}</span>
        <span class="entry-dates">${escHtml([e.start, e.end].filter(Boolean).join(' – '))}</span>
      </div>
      <div class="entry-sub">${escHtml(e.company || '')}</div>
      ${(e.highlights || []).length ? `<ul>${e.highlights.map(h => `<li>${escHtml(h)}</li>`).join('')}</ul>` : ''}
    </div>`).join('')}</div>`;
}

function projectsBlock(arr) {
  if (!arr || !arr.length) return '';
  return `<div class="p-section"><h3>Projects</h3>${arr.map(pr => `
    <div class="entry">
      <div class="entry-title">${escHtml(pr.name || '')}</div>
      <div class="entry-sub">${escHtml(pr.description || '')}</div>
      ${(pr.tech || []).length ? `<div class="chips small">${pr.tech.map(t => `<span class="chip">${escHtml(t)}</span>`).join('')}</div>` : ''}
    </div>`).join('')}</div>`;
}

function educationBlock(arr) {
  if (!arr || !arr.length) return '';
  return `<div class="p-section"><h3>Education</h3>${arr.map(ed => `
    <div class="entry">
      <div class="entry-title">${escHtml(ed.degree || '')}</div>
      <div class="entry-sub">${escHtml([ed.institution, ed.year].filter(Boolean).join(' · '))}</div>
    </div>`).join('')}</div>`;
}

// Editing: a raw-JSON editor (deterministic + lossless for V0).
function enterEdit() {
  state.editing = true;
  showProfileEmpty(false);
  document.getElementById('btn-edit').classList.add('hidden');
  document.getElementById('btn-save').classList.remove('hidden');
  const card = document.getElementById('profile-card');
  card.innerHTML =
    `<div class="edit-hint">Edit the profile JSON, then Save.</div>` +
    `<textarea id="profile-editor" spellcheck="false"></textarea>`;
  document.getElementById('profile-editor').value =
    JSON.stringify(state.profile || emptyProfile(), null, 2);
}

async function saveProfile() {
  let parsed;
  try {
    parsed = JSON.parse(document.getElementById('profile-editor').value);
  } catch (e) {
    showToast('Invalid JSON — fix and try again.');
    return;
  }
  try {
    await bridge.workspaceWrite(PROFILE_PATH, JSON.stringify(parsed, null, 2));
    state.profile = { ...emptyProfile(), ...parsed };
    renderProfile();
    showToast('Saved.');
  } catch (e) {
    showToast('Save failed.');
  }
}

// ── View switching ───────────────────────────────────────────────────────────
function switchView(view) {
  document.querySelectorAll('.nav-item').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach(v =>
    v.classList.toggle('active', v.id === `view-${view}`));
}

// ── Utils ──────────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escAttr(s) { return escHtml(s); }

let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

// ── Wiring ──────────────────────────────────────────────────────────────────────
function wire() {
  const fileInput = document.getElementById('file-input');
  const dz = document.getElementById('dropzone');

  fileInput.addEventListener('change', e => handleFiles(e.target.files));

  ['dragenter', 'dragover'].forEach(ev =>
    dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev =>
    dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', e => handleFiles(e.dataTransfer.files));

  document.getElementById('paste-text').addEventListener('input', updateGenerateEnabled);
  document.getElementById('btn-generate').addEventListener('click', generateProfile);
  document.getElementById('btn-edit').addEventListener('click', enterEdit);
  document.getElementById('btn-save').addEventListener('click', saveProfile);

  document.getElementById('doc-list').addEventListener('click', async e => {
    const del = e.target.closest('.doc-del');
    if (del) { await bridge.workspaceDelete(del.dataset.path); await refreshDocs(); }
  });

  document.getElementById('nav').addEventListener('click', e => {
    const item = e.target.closest('.nav-item');
    if (item && !item.disabled) switchView(item.dataset.view);
  });
}

// ── Init ────────────────────────────────────────────────────────────────────────
async function init() {
  wire();
  await new Promise(resolve => {
    if (window.pywebview) return resolve();
    window.addEventListener('pywebviewready', resolve, { once: true });
  });

  try {
    const config = await bridge.getConfig();
    state.config = config;
    state.port = config.opencode_port;
    document.title = config.app_title || 'Job Search OS';
    const brand = document.querySelector('.brand span');
    if (brand) brand.textContent = config.app_title || 'Job Search OS';
  } catch (e) {
    showToast('Failed to connect to backend');
    return;
  }

  await refreshDocs();
  await loadProfile();   // show existing profile if present
}

init();
