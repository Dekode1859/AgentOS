'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  port: null,
  config: null,
  docs: [],           // [{ name, path }] uploaded docs in workspace/documents
  profile: null,      // parsed profile.json (v2 schema)
  editingSection: null, // which profile section is in edit mode
  defaultModel: '',   // "providerID/modelID" currently configured
  providers: { featured: [], connected: [] },
  jobs: [],           // persisted job list (jobs/jobs.json)
  activeJobId: null,  // job open in detail view
  browser: { port: null, jobId: null }, // Playwright application browser session
};

const PROFILE_PATH = 'profile/profile.json';
const DOCS_FOLDER = 'documents';

function emptyProfile() {
  return {
    identity:     { name: '', headline: '', summary: '', location: '' },
    contact:      { email: '', phone: '', links: [] },
    skill_buckets: [],
    experience:   [],
    projects:     [],
    education:    [],
    certifications: [],
    publications: [],
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
    getProviders:     ()             => call('get_providers'),
    saveProviderKey:  (pid, key)     => call('save_provider_key', pid, key),
    removeProviderKey:(pid)          => call('remove_provider_key', pid),
    setDefaultModel:  (pid, mid)     => call('set_default_model', pid, mid),
    exportResumePdf:  (html, fname)  => call('export_resume_pdf', html, fname),
    browserOpen:         (url) => call('browser_open', url),
    browserClose:        ()    => call('browser_close'),
    browserDetectFields: ()    => call('browser_detect_fields'),
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

// ── Profile: sub-view ────────────────────────────────────────────────────────
function showProfileSubview(name) {
  ['main', 'ingest'].forEach(n =>
    document.getElementById(`profile-${n}`).classList.toggle('hidden', n !== name));
}

// ── Profile: load ─────────────────────────────────────────────────────────────
async function loadProfile() {
  try {
    const res = await bridge.workspaceRead(PROFILE_PATH);
    if (res && res.content && !res.error) {
      state.profile = { ...emptyProfile(), ...JSON.parse(res.content) };
      return true;
    }
  } catch (_) {}
  return false;
}

// ── Profile: merge (deterministic — agent extracts, app merges) ───────────────
function mergeProfile(existing, extracted) {
  const merged = JSON.parse(JSON.stringify(existing));
  const ext = { ...emptyProfile(), ...extracted };

  for (const k of ['name', 'headline', 'summary', 'location']) {
    if (ext.identity?.[k]) merged.identity[k] = ext.identity[k];
  }
  if (ext.contact?.email) merged.contact.email = ext.contact.email;
  if (ext.contact?.phone) merged.contact.phone = ext.contact.phone;
  for (const link of (ext.contact?.links || [])) {
    if (link.url && !merged.contact.links.some(l => l.url === link.url))
      merged.contact.links.push(link);
  }
  for (const nb of (ext.skill_buckets || [])) {
    if (!nb.category || !nb.skills?.length) continue;
    const eb = merged.skill_buckets.find(
      b => b.category.toLowerCase() === nb.category.toLowerCase()
    );
    if (eb) {
      for (const s of nb.skills) { if (!eb.skills.includes(s)) eb.skills.push(s); }
    } else {
      merged.skill_buckets.push({ category: nb.category, skills: [...nb.skills] });
    }
  }
  const ts = Date.now();
  for (const [i, e] of (ext.experience || []).entries()) {
    if (e.title || e.company) merged.experience.push({ ...e, id: `${ts}e${i}` });
  }
  for (const [i, p] of (ext.projects || []).entries()) {
    if (p.name) merged.projects.push({ ...p, id: `${ts}p${i}` });
  }
  for (const ed of (ext.education || [])) {
    if (ed.degree || ed.institution) merged.education.push(ed);
  }
  for (const c of (ext.certifications || [])) {
    if (c.name) merged.certifications.push(c);
  }
  for (const p of (ext.publications || [])) {
    if (p.title) merged.publications.push(p);
  }
  return merged;
}

// ── Profile: ingest (extract + merge) ────────────────────────────────────────
function parseProfileJson(text) {
  let t = (text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

async function extractAndMerge() {
  const text = await gatherResumeText();
  if (!text) { showToast('Add a document or paste text first.'); return; }
  setGenerating(true);
  try {
    const session = await oc('/session', { method: 'POST', body: '{}' });
    const msg = await oc(`/session/${session.id}/message`, {
      method: 'POST',
      body: JSON.stringify({ agent: 'profile', parts: [{ type: 'text', text: 'Documents:\n\n' + text }] }),
    });
    const reply = (msg?.parts || []).filter(p => p.type === 'text' && p.text).map(p => p.text).join('');
    let extracted;
    try { extracted = parseProfileJson(reply); }
    catch (_) { showToast('Could not parse extraction — try again.'); return; }

    state.profile = mergeProfile(state.profile || emptyProfile(), extracted);
    await bridge.workspaceWrite(PROFILE_PATH, JSON.stringify(state.profile, null, 2));
    state.editingSection = null;
    renderProfileSections();
    showProfileSubview('main');
    showToast('Profile updated.');
  } catch (e) {
    showToast(`Extraction failed: ${e.message}`);
  } finally {
    setGenerating(false);
  }
}

function setGenerating(on) {
  document.getElementById('btn-generate').loading = on;
  const s = document.getElementById('gen-status');
  s.classList.toggle('hidden', !on);
  if (on) s.textContent = 'Extracting and merging into your profile…';
}

// ── Profile: section rendering ────────────────────────────────────────────────
const SECTION_META = {
  identity:       { icon: 'user-round',      label: 'Identity' },
  contact:        { icon: 'at-sign',         label: 'Contact & Links' },
  skills:         { icon: 'layers-3',        label: 'Skills' },
  experience:     { icon: 'briefcase',       label: 'Experience' },
  projects:       { icon: 'folder-open',     label: 'Projects' },
  education:      { icon: 'graduation-cap',  label: 'Education' },
  certifications: { icon: 'award',           label: 'Certifications' },
  publications:   { icon: 'book-open',       label: 'Publications' },
};

function hasProfileData(p) {
  if (!p) return false;
  return !!(p.identity?.name || (p.skill_buckets||[]).length ||
            (p.experience||[]).length || (p.projects||[]).length);
}

function renderProfileSections() {
  const p = state.profile;
  const empty    = document.getElementById('profile-empty-state');
  const sections = document.getElementById('profile-sections');
  if (!hasProfileData(p)) {
    empty.classList.remove('hidden'); sections.classList.add('hidden'); return;
  }
  empty.classList.add('hidden'); sections.classList.remove('hidden');
  sections.innerHTML = Object.keys(SECTION_META).map(renderSection).join('');
}

function renderSection(name) {
  const meta      = SECTION_META[name];
  const isEditing = state.editingSection === name;
  const body      = isEditing ? renderSectionEdit(name) : renderSectionView(name);
  const actions   = isEditing
    ? `<button class="ps-save-btn"   data-section="${name}">Save</button>
       <button class="ps-cancel-btn" data-section="${name}">Cancel</button>`
    : `<button class="ps-edit-btn"   data-section="${name}">
         <sl-icon library="lucide" name="pencil"></sl-icon>
       </button>`;
  return `<div class="profile-section" data-section="${name}">
    <div class="ps-header">
      <div class="ps-title">
        <sl-icon library="lucide" name="${meta.icon}"></sl-icon>${meta.label}
      </div>
      <div class="ps-actions">${actions}</div>
    </div>
    <div class="ps-body">${body}</div>
  </div>`;
}

function replaceSectionInDOM(name) {
  const old = document.querySelector(`.profile-section[data-section="${name}"]`);
  if (!old) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = renderSection(name);
  old.replaceWith(tmp.firstElementChild);
}

// ── Profile: view renderers ───────────────────────────────────────────────────
function renderSectionView(name) {
  const p = state.profile;
  switch (name) {
    case 'identity': {
      const id = p.identity || {};
      if (!id.name && !id.headline && !id.summary)
        return psEmpty('No identity info — click Edit to add.');
      return `
        ${id.name     ? `<div class="ps-name">${escHtml(id.name)}</div>` : ''}
        ${id.headline ? `<div class="ps-headline">${escHtml(id.headline)}</div>` : ''}
        ${id.location ? `<div class="ps-meta-row"><sl-icon library="lucide" name="map-pin"></sl-icon>${escHtml(id.location)}</div>` : ''}
        ${id.summary  ? `<p class="ps-summary">${escHtml(id.summary)}</p>` : ''}`;
    }
    case 'contact': {
      const c = p.contact || {};
      if (!c.email && !c.phone && !(c.links||[]).length)
        return psEmpty('No contact info — click Edit to add.');
      return `
        ${c.email ? `<div class="ps-meta-row"><sl-icon library="lucide" name="mail"></sl-icon>${escHtml(c.email)}</div>` : ''}
        ${c.phone ? `<div class="ps-meta-row"><sl-icon library="lucide" name="phone"></sl-icon>${escHtml(c.phone)}</div>` : ''}
        ${(c.links||[]).map(l => `<div class="ps-meta-row"><sl-icon library="lucide" name="link"></sl-icon>
          <a class="p-link" href="${escAttr(l.url)}" target="_blank">${escHtml(l.label || l.url)}</a></div>`).join('')}`;
    }
    case 'skills': {
      const bs = p.skill_buckets || [];
      if (!bs.length) return psEmpty('No skills — click Edit to add buckets.');
      return bs.map(b => `
        <div class="skill-bucket-view">
          <div class="skill-bucket-label">${escHtml(b.category)}</div>
          <div class="chips">${(b.skills||[]).map(s=>`<span class="chip">${escHtml(s)}</span>`).join('')}</div>
        </div>`).join('');
    }
    case 'experience': {
      const exps = p.experience || [];
      if (!exps.length) return psEmpty('No experience — click Edit to add.');
      return exps.map(e => `
        <div class="ps-list-item">
          <div class="entry-head">
            <span class="entry-title">${escHtml(e.title||'')}</span>
            <span class="entry-dates">${escHtml([e.start,e.end].filter(Boolean).join(' – '))}</span>
          </div>
          <div class="entry-sub">${escHtml(e.company||'')}</div>
          ${e.raw_description ? `<p class="ps-raw-desc">${escHtml(e.raw_description)}</p>` : ''}
          ${(e.highlights||[]).length ? `<ul class="ps-bullets">${e.highlights.map(h=>`<li>${escHtml(h)}</li>`).join('')}</ul>` : ''}
          ${(e.tags||[]).length ? `<div class="chips" style="margin-top:7px">${e.tags.map(t=>`<span class="chip chip-tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
        </div>`).join('');
    }
    case 'projects': {
      const projs = p.projects || [];
      if (!projs.length) return psEmpty('No projects — click Edit to add.');
      return projs.map(pr => `
        <div class="ps-list-item">
          <div class="ps-proj-head">
            <span class="entry-title">${escHtml(pr.name||'')}</span>
            ${pr.url ? `<a class="p-link" href="${escAttr(pr.url)}" target="_blank" style="font-size:13px">
              <sl-icon library="lucide" name="external-link"></sl-icon></a>` : ''}
          </div>
          ${pr.description ? `<div class="entry-sub">${escHtml(pr.description)}</div>` : ''}
          ${pr.raw_description ? `<p class="ps-raw-desc">${escHtml(pr.raw_description)}</p>` : ''}
          ${(pr.tech||[]).length ? `<div class="chips" style="margin-top:7px">${pr.tech.map(t=>`<span class="chip">${escHtml(t)}</span>`).join('')}</div>` : ''}
          ${(pr.highlights||[]).length ? `<ul class="ps-bullets">${pr.highlights.map(h=>`<li>${escHtml(h)}</li>`).join('')}</ul>` : ''}
          ${(pr.tags||[]).length ? `<div class="chips" style="margin-top:7px">${pr.tags.map(t=>`<span class="chip chip-tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
        </div>`).join('');
    }
    case 'education': {
      const eds = p.education || [];
      if (!eds.length) return psEmpty('No education — click Edit to add.');
      return eds.map(ed => `
        <div class="ps-list-item">
          <div class="entry-title">${escHtml(ed.degree||'')}</div>
          <div class="entry-sub">${escHtml([ed.institution,ed.year].filter(Boolean).join(' · '))}</div>
        </div>`).join('');
    }
    case 'certifications': {
      const certs = p.certifications || [];
      if (!certs.length) return psEmpty('No certifications — click Edit to add.');
      return certs.map(c => {
        const obj = typeof c === 'string' ? { name: c, issuer: '', year: '' } : c;
        return `<div class="ps-list-item">
          <div class="entry-title">${escHtml(obj.name||'')}</div>
          ${(obj.issuer||obj.year) ? `<div class="entry-sub">${escHtml([obj.issuer,obj.year].filter(Boolean).join(' · '))}</div>` : ''}
        </div>`;}).join('');
    }
    case 'publications': {
      const pubs = p.publications || [];
      if (!pubs.length) return psEmpty('No publications — click Edit to add.');
      return pubs.map(pub => `
        <div class="ps-list-item">
          <div class="entry-title">${escHtml(pub.title||'')}</div>
          <div class="entry-sub">${escHtml([pub.venue,pub.year].filter(Boolean).join(' · '))}</div>
          ${pub.url ? `<a class="p-link" href="${escAttr(pub.url)}" target="_blank" style="font-size:12.5px">${escHtml(pub.url)}</a>` : ''}
        </div>`).join('');
    }
    default: return '';
  }
}

function psEmpty(msg) {
  return `<div class="ps-empty-msg">${escHtml(msg)}</div>`;
}

// ── Profile: edit renderers ───────────────────────────────────────────────────
function renderSectionEdit(name) {
  const p = state.profile;
  switch (name) {
    case 'identity': {
      const id = p.identity || {};
      return `
        <div class="form-field"><label class="field-label">Name</label>
          <input class="field-input" data-field="name" value="${escAttr(id.name||'')}"/></div>
        <div class="form-field"><label class="field-label">Headline</label>
          <input class="field-input" data-field="headline" value="${escAttr(id.headline||'')}"/></div>
        <div class="form-field"><label class="field-label">Location</label>
          <input class="field-input" data-field="location" value="${escAttr(id.location||'')}"/></div>
        <div class="form-field"><label class="field-label">Summary</label>
          <textarea class="field-input field-textarea" data-field="summary">${escHtml(id.summary||'')}</textarea></div>`;
    }
    case 'contact': {
      const c = p.contact || {};
      const linksHtml = (c.links||[]).map(l => `
        <div class="link-entry ps-list-row">
          <input class="field-input" data-subfield="label" placeholder="Label (LinkedIn, GitHub…)" value="${escAttr(l.label||'')}"/>
          <input class="field-input" data-subfield="url" placeholder="URL" value="${escAttr(l.url||'')}"/>
          <button class="ps-remove-link ps-btn-icon" title="Remove">×</button>
        </div>`).join('');
      return `
        <div class="form-field"><label class="field-label">Email</label>
          <input class="field-input" data-field="email" value="${escAttr(c.email||'')}"/></div>
        <div class="form-field"><label class="field-label">Phone</label>
          <input class="field-input" data-field="phone" value="${escAttr(c.phone||'')}"/></div>
        <div class="form-field"><label class="field-label">Links</label>
          <div id="links-editor">${linksHtml}</div>
          <button class="ps-add-link ps-btn-ghost" style="margin-top:8px">+ Add Link</button>
        </div>`;
    }
    case 'skills':
      return `<div id="buckets-editor">
          ${(p.skill_buckets||[]).map(renderBucketEdit).join('')}
        </div>
        <button class="ps-add-bucket ps-btn-ghost" style="margin-top:10px">+ Add Bucket</button>`;
    case 'experience':
      return `<div id="exp-editor">
          ${(p.experience||[]).map(renderExpItemEdit).join('')}
        </div>
        <button class="ps-add-exp ps-btn-ghost" style="margin-top:10px">+ Add Role</button>`;
    case 'projects':
      return `<div id="proj-editor">
          ${(p.projects||[]).map(renderProjItemEdit).join('')}
        </div>
        <button class="ps-add-proj ps-btn-ghost" style="margin-top:10px">+ Add Project</button>`;
    case 'education':
      return `<div id="edu-editor">
          ${(p.education||[]).map((ed,i) => `
            <div class="ps-list-edit-row" data-idx="${i}">
              <div class="ps-list-edit-fields">
                <input class="field-input" data-subfield="degree" placeholder="Degree" value="${escAttr(ed.degree||'')}"/>
                <input class="field-input" data-subfield="institution" placeholder="Institution" value="${escAttr(ed.institution||'')}"/>
                <input class="field-input" data-subfield="year" placeholder="Year" value="${escAttr(ed.year||'')}"/>
              </div>
              <button class="ps-remove-edu ps-btn-icon">×</button>
            </div>`).join('')}
        </div>
        <button class="ps-add-edu ps-btn-ghost" style="margin-top:10px">+ Add Education</button>`;
    case 'certifications': {
      const certs = (p.certifications||[]).map(c => typeof c === 'string' ? {name:c,issuer:'',year:''} : c);
      return `<div id="cert-editor">
          ${certs.map((c,i) => `
            <div class="ps-list-edit-row" data-idx="${i}">
              <div class="ps-list-edit-fields">
                <input class="field-input" data-subfield="name" placeholder="Certification name" value="${escAttr(c.name||'')}"/>
                <input class="field-input" data-subfield="issuer" placeholder="Issuer" value="${escAttr(c.issuer||'')}"/>
                <input class="field-input" data-subfield="year" placeholder="Year" value="${escAttr(c.year||'')}"/>
              </div>
              <button class="ps-remove-cert ps-btn-icon">×</button>
            </div>`).join('')}
        </div>
        <button class="ps-add-cert ps-btn-ghost" style="margin-top:10px">+ Add Certification</button>`;
    }
    case 'publications':
      return `<div id="pub-editor">
          ${(p.publications||[]).map((pub,i) => `
            <div class="ps-list-edit-row" data-idx="${i}">
              <div class="ps-list-edit-fields">
                <input class="field-input" data-subfield="title" placeholder="Title" value="${escAttr(pub.title||'')}"/>
                <input class="field-input" data-subfield="venue" placeholder="Venue / Journal" value="${escAttr(pub.venue||'')}"/>
                <input class="field-input" data-subfield="year" placeholder="Year" value="${escAttr(pub.year||'')}"/>
                <input class="field-input" data-subfield="url" placeholder="URL" value="${escAttr(pub.url||'')}"/>
              </div>
              <button class="ps-remove-pub ps-btn-icon">×</button>
            </div>`).join('')}
        </div>
        <button class="ps-add-pub ps-btn-ghost" style="margin-top:10px">+ Add Publication</button>`;
    default: return '';
  }
}

function renderBucketEdit(bucket, idx) {
  return `<div class="skill-bucket-edit" data-bucket-idx="${idx}">
    <div class="skill-bucket-edit-header">
      <input class="field-input bucket-name-input" value="${escAttr(bucket.category||'')}" placeholder="Bucket name (e.g. Cloud Platforms)"/>
      <button class="ps-remove-bucket ps-btn-icon" title="Remove bucket">×</button>
    </div>
    <div class="skill-chips-edit">
      ${(bucket.skills||[]).map(s => `<span class="skill-chip-tag" data-skill="${escAttr(s)}">${escHtml(s)}<button class="skill-chip-remove">×</button></span>`).join('')}
      <input class="skill-add-input" placeholder="Add skill, press Enter"/>
    </div>
  </div>`;
}

function renderExpItemEdit(exp, idx) {
  return `<div class="ps-item-edit exp-item-edit" data-idx="${idx}" data-id="${escAttr(exp.id||'')}">
    <div class="ps-item-edit-header">
      <span class="ps-item-num">${idx+1}</span>
      <button class="ps-remove-exp ps-btn-icon">×</button>
    </div>
    <div class="ps-item-grid">
      <div class="form-field"><label class="field-label">Title</label>
        <input class="field-input" data-field="title" value="${escAttr(exp.title||'')}"/></div>
      <div class="form-field"><label class="field-label">Company</label>
        <input class="field-input" data-field="company" value="${escAttr(exp.company||'')}"/></div>
      <div class="form-field"><label class="field-label">Start</label>
        <input class="field-input" data-field="start" value="${escAttr(exp.start||'')}"/></div>
      <div class="form-field"><label class="field-label">End</label>
        <input class="field-input" data-field="end" value="${escAttr(exp.end||'Present')}"/></div>
    </div>
    <div class="form-field"><label class="field-label">Technical description <span class="field-optional">(architecture, tools, scale — feeds future composition)</span></label>
      <textarea class="field-input field-textarea-tall" data-field="raw_description">${escHtml(exp.raw_description||'')}</textarea></div>
    <div class="form-field"><label class="field-label">ATS bullets <span class="field-optional">(Action verb + impact/metric)</span></label>
      <div class="highlights-editor">
        ${(exp.highlights||[]).map(h=>`<div class="highlight-row"><input class="field-input highlight-text" value="${escAttr(h)}"/><button class="ps-remove-highlight ps-btn-icon">×</button></div>`).join('')}
      </div>
      <button class="ps-add-highlight ps-btn-ghost" style="margin-top:6px">+ Add bullet</button>
    </div>
    <div class="form-field"><label class="field-label">Tags</label>
      <div class="tag-chips-edit">
        ${(exp.tags||[]).map(t=>`<span class="tag-chip-tag" data-tag="${escAttr(t)}">${escHtml(t)}<button class="tag-chip-remove">×</button></span>`).join('')}
        <input class="tag-add-input" placeholder="Add tag, press Enter"/>
      </div>
    </div>
  </div>`;
}

function renderProjItemEdit(proj, idx) {
  return `<div class="ps-item-edit proj-item-edit" data-idx="${idx}" data-id="${escAttr(proj.id||'')}">
    <div class="ps-item-edit-header">
      <span class="ps-item-num">${idx+1}</span>
      <button class="ps-remove-proj ps-btn-icon">×</button>
    </div>
    <div class="form-field"><label class="field-label">Name</label>
      <input class="field-input" data-field="name" value="${escAttr(proj.name||'')}"/></div>
    <div class="form-field"><label class="field-label">One-line summary <span class="field-optional">(shown in display)</span></label>
      <input class="field-input" data-field="description" value="${escAttr(proj.description||'')}"/></div>
    <div class="form-field"><label class="field-label">URL <span class="field-optional">(optional)</span></label>
      <input class="field-input" data-field="url" value="${escAttr(proj.url||'')}"/></div>
    <div class="form-field"><label class="field-label">Technical description <span class="field-optional">(architecture, design decisions, scale — feeds future composition)</span></label>
      <textarea class="field-input field-textarea-tall" data-field="raw_description">${escHtml(proj.raw_description||'')}</textarea></div>
    <div class="form-field"><label class="field-label">Tech stack</label>
      <div class="skill-chips-edit">
        ${(proj.tech||[]).map(t=>`<span class="skill-chip-tag" data-skill="${escAttr(t)}">${escHtml(t)}<button class="skill-chip-remove">×</button></span>`).join('')}
        <input class="skill-add-input" placeholder="Add tech, press Enter"/>
      </div>
    </div>
    <div class="form-field"><label class="field-label">ATS bullets <span class="field-optional">(Action verb + impact/metric)</span></label>
      <div class="highlights-editor">
        ${(proj.highlights||[]).map(h=>`<div class="highlight-row"><input class="field-input highlight-text" value="${escAttr(h)}"/><button class="ps-remove-highlight ps-btn-icon">×</button></div>`).join('')}
      </div>
      <button class="ps-add-highlight ps-btn-ghost" style="margin-top:6px">+ Add bullet</button>
    </div>
    <div class="form-field"><label class="field-label">Tags</label>
      <div class="tag-chips-edit">
        ${(proj.tags||[]).map(t=>`<span class="tag-chip-tag" data-tag="${escAttr(t)}">${escHtml(t)}<button class="tag-chip-remove">×</button></span>`).join('')}
        <input class="tag-add-input" placeholder="Add tag, press Enter"/>
      </div>
    </div>
  </div>`;
}

// ── Profile: section edit/save/cancel ────────────────────────────────────────
function editSection(name) {
  state.editingSection = name;
  replaceSectionInDOM(name);
}

async function saveSection(name) {
  const data = collectSectionData(name);
  if (data === null) return;
  if (name === 'skills') state.profile.skill_buckets = data;
  else state.profile[name] = data;
  state.editingSection = null;
  try {
    await bridge.workspaceWrite(PROFILE_PATH, JSON.stringify(state.profile, null, 2));
    showToast('Saved.');
  } catch (_) { showToast('Save failed.'); }
  replaceSectionInDOM(name);
}

function cancelSection(name) {
  state.editingSection = null;
  replaceSectionInDOM(name);
}

// ── Profile: collect form data ────────────────────────────────────────────────
function collectSectionData(name) {
  const body = document.querySelector(`.profile-section[data-section="${name}"] .ps-body`);
  if (!body) return null;
  switch (name) {
    case 'identity':
      return {
        name:     body.querySelector('[data-field="name"]').value.trim(),
        headline: body.querySelector('[data-field="headline"]').value.trim(),
        summary:  body.querySelector('[data-field="summary"]').value.trim(),
        location: body.querySelector('[data-field="location"]').value.trim(),
      };
    case 'contact':
      return {
        email: body.querySelector('[data-field="email"]').value.trim(),
        phone: body.querySelector('[data-field="phone"]').value.trim(),
        links: [...body.querySelectorAll('.link-entry')].map(row => ({
          label: row.querySelector('[data-subfield="label"]').value.trim(),
          url:   row.querySelector('[data-subfield="url"]').value.trim(),
        })).filter(l => l.url),
      };
    case 'skills':
      return [...body.querySelectorAll('.skill-bucket-edit')].map(bel => ({
        category: bel.querySelector('.bucket-name-input').value.trim(),
        skills:   [...bel.querySelectorAll('.skill-chip-tag')].map(el => el.dataset.skill).filter(Boolean),
      })).filter(b => b.category);
    case 'experience':
      return [...body.querySelectorAll('.exp-item-edit')].map(el => ({
        id:              el.dataset.id || `${Date.now()}${Math.random()}`,
        title:           el.querySelector('[data-field="title"]').value.trim(),
        company:         el.querySelector('[data-field="company"]').value.trim(),
        start:           el.querySelector('[data-field="start"]').value.trim(),
        end:             el.querySelector('[data-field="end"]').value.trim(),
        raw_description: el.querySelector('[data-field="raw_description"]').value.trim(),
        highlights:      [...el.querySelectorAll('.highlight-text')].map(i => i.value.trim()).filter(Boolean),
        tags:            [...el.querySelectorAll('.tag-chip-tag')].map(c => c.dataset.tag).filter(Boolean),
      }));
    case 'projects':
      return [...body.querySelectorAll('.proj-item-edit')].map(el => ({
        id:              el.dataset.id || `${Date.now()}${Math.random()}`,
        name:            el.querySelector('[data-field="name"]').value.trim(),
        description:     el.querySelector('[data-field="description"]').value.trim(),
        url:             el.querySelector('[data-field="url"]').value.trim(),
        raw_description: el.querySelector('[data-field="raw_description"]').value.trim(),
        tech:            [...el.querySelectorAll('.skill-chip-tag')].map(c => c.dataset.skill).filter(Boolean),
        highlights:      [...el.querySelectorAll('.highlight-text')].map(i => i.value.trim()).filter(Boolean),
        tags:            [...el.querySelectorAll('.tag-chip-tag')].map(c => c.dataset.tag).filter(Boolean),
      }));
    case 'education':
      return [...body.querySelectorAll('#edu-editor .ps-list-edit-row')].map(row => ({
        degree:      row.querySelector('[data-subfield="degree"]').value.trim(),
        institution: row.querySelector('[data-subfield="institution"]').value.trim(),
        year:        row.querySelector('[data-subfield="year"]').value.trim(),
      })).filter(ed => ed.degree || ed.institution);
    case 'certifications':
      return [...body.querySelectorAll('#cert-editor .ps-list-edit-row')].map(row => ({
        name:   row.querySelector('[data-subfield="name"]').value.trim(),
        issuer: row.querySelector('[data-subfield="issuer"]').value.trim(),
        year:   row.querySelector('[data-subfield="year"]').value.trim(),
      })).filter(c => c.name);
    case 'publications':
      return [...body.querySelectorAll('#pub-editor .ps-list-edit-row')].map(row => ({
        title: row.querySelector('[data-subfield="title"]').value.trim(),
        venue: row.querySelector('[data-subfield="venue"]').value.trim(),
        year:  row.querySelector('[data-subfield="year"]').value.trim(),
        url:   row.querySelector('[data-subfield="url"]').value.trim(),
      })).filter(p => p.title);
    default: return null;
  }
}

// ── Profile: section event helpers (called from delegated handlers) ───────────
function addNewExpItem() {
  const ed = document.getElementById('exp-editor'); if (!ed) return;
  const idx = ed.querySelectorAll('.exp-item-edit').length;
  const tmp = document.createElement('div');
  tmp.innerHTML = renderExpItemEdit({id:'',title:'',company:'',start:'',end:'Present',raw_description:'',highlights:[],tags:[]}, idx);
  ed.appendChild(tmp.firstElementChild);
}
function addNewProjItem() {
  const ed = document.getElementById('proj-editor'); if (!ed) return;
  const idx = ed.querySelectorAll('.proj-item-edit').length;
  const tmp = document.createElement('div');
  tmp.innerHTML = renderProjItemEdit({id:'',name:'',description:'',raw_description:'',tech:[],url:'',highlights:[],tags:[]}, idx);
  ed.appendChild(tmp.firstElementChild);
}
function addNewBucket() {
  const ed = document.getElementById('buckets-editor'); if (!ed) return;
  const idx = ed.querySelectorAll('.skill-bucket-edit').length;
  const tmp = document.createElement('div');
  tmp.innerHTML = renderBucketEdit({category:'',skills:[]}, idx);
  ed.appendChild(tmp.firstElementChild);
}
function addSkillChip(container, skill) {
  const tag = document.createElement('span');
  tag.className = 'skill-chip-tag'; tag.dataset.skill = skill;
  tag.innerHTML = `${escHtml(skill)}<button class="skill-chip-remove">×</button>`;
  const input = container.querySelector('.skill-add-input');
  if (input) container.insertBefore(tag, input);
  else container.appendChild(tag);
}
function addTagChip(container, tag) {
  const el = document.createElement('span');
  el.className = 'tag-chip-tag'; el.dataset.tag = tag;
  el.innerHTML = `${escHtml(tag)}<button class="tag-chip-remove">×</button>`;
  const input = container.querySelector('.tag-add-input');
  if (input) container.insertBefore(el, input);
  else container.appendChild(el);
}
function addHighlightRow(editor) {
  const row = document.createElement('div'); row.className = 'highlight-row';
  row.innerHTML = `<input class="field-input highlight-text" value=""/><button class="ps-remove-highlight ps-btn-icon">×</button>`;
  editor.appendChild(row);
  row.querySelector('input').focus();
}
function addSimpleEditRow(editorId, fields) {
  const ed = document.getElementById(editorId); if (!ed) return;
  const row = document.createElement('div'); row.className = 'ps-list-edit-row';
  row.innerHTML = `<div class="ps-list-edit-fields">${
    fields.map(f => `<input class="field-input" data-subfield="${f.key}" placeholder="${f.placeholder}" value=""/>`).join('')
  }</div><button class="ps-remove-${editorId.split('-')[0]} ps-btn-icon">×</button>`;
  ed.appendChild(row);
}
function addLink() {
  const ed = document.getElementById('links-editor'); if (!ed) return;
  const row = document.createElement('div'); row.className = 'link-entry ps-list-row';
  row.innerHTML = `<input class="field-input" data-subfield="label" placeholder="Label" value=""/>
    <input class="field-input" data-subfield="url" placeholder="URL" value=""/>
    <button class="ps-remove-link ps-btn-icon">×</button>`;
  ed.appendChild(row);
}

// ── Jobs: persistence ────────────────────────────────────────────────────────
const JOBS_PATH = 'jobs/jobs.json';
const STATUS_LABELS = { saved: 'Saved', applied: 'Applied', responded: 'Responded', archived: 'Archived' };
const STATUS_COLORS = {
  saved: 'var(--accent)', applied: 'var(--green)',
  responded: '#f59e0b',   archived: 'var(--dim)',
};

async function loadJobs() {
  try {
    const res = await bridge.workspaceRead(JOBS_PATH);
    if (res && res.content && !res.error) { state.jobs = JSON.parse(res.content); return; }
  } catch (_) {}
  state.jobs = [];
}

async function persistJobs() {
  await bridge.workspaceWrite(JOBS_PATH, JSON.stringify(state.jobs, null, 2));
}

function jobById(id) { return state.jobs.find(j => j.id === id); }

// ── Jobs: sub-view management ────────────────────────────────────────────────
function showJobsSubview(name) {
  ['dashboard', 'add', 'detail'].forEach(n =>
    document.getElementById(`jobs-${n}`).classList.toggle('hidden', n !== name));
}

// ── Jobs: dashboard ──────────────────────────────────────────────────────────
function renderJobsDashboard() {
  const grid  = document.getElementById('job-cards');
  const empty = document.getElementById('jobs-empty-state');
  if (!state.jobs.length) {
    empty.classList.remove('hidden'); grid.classList.add('hidden'); return;
  }
  empty.classList.add('hidden'); grid.classList.remove('hidden');
  grid.innerHTML = state.jobs.map(job => {
    const score    = job.match_score != null ? job.match_score : null;
    const scoreCol = score != null ? scoreColorFor(score) : 'var(--dim)';
    const statCol  = STATUS_COLORS[job.status] || 'var(--dim)';
    const mr       = job.match_result;
    const topSkills = (mr?.skills_matched || []).slice(0, 3);
    const date = job.created_at
      ? new Date(job.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '';
    return `<div class="job-card" data-id="${escAttr(job.id)}">
      <div class="jc-score-ring" style="--c:${scoreCol};--score:${score ?? 0}">
        <span class="jc-score-num">${score != null ? score : '?'}</span>
      </div>
      <div class="jc-body">
        <div class="jc-title">${escHtml(job.title || 'Untitled Role')}</div>
        ${job.company ? `<div class="jc-company">${escHtml(job.company)}</div>` : ''}
        ${topSkills.length ? `<div class="jc-skills">${
          topSkills.map(s => `<span class="chip jc-skill-chip">${escHtml(s)}</span>`).join('')
          }${(mr?.skills_matched||[]).length > 3 ? `<span class="jc-more">+${(mr.skills_matched.length-3)}</span>` : ''}</div>` : ''}
      </div>
      <div class="jc-right">
        <div class="job-status-wrap">
          <span class="job-status-badge" style="--status-color:${statCol}">${escHtml(STATUS_LABELS[job.status] || job.status)}</span>
          <select class="job-status-select" data-id="${escAttr(job.id)}" onclick="event.stopPropagation()">
            ${Object.entries(STATUS_LABELS).map(([v, l]) =>
              `<option value="${v}"${job.status === v ? ' selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        ${date ? `<div class="jc-date">${escHtml(date)}</div>` : ''}
        ${job.link ? `<a class="job-link-icon" href="${escAttr(job.link)}" title="Open apply link"
          target="_blank" onclick="event.stopPropagation()">
          <sl-icon library="lucide" name="external-link"></sl-icon></a>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function updateJobStatus(id, status) {
  const job = jobById(id);
  if (!job) return;
  job.status = status;
  await persistJobs();
  const statCol = STATUS_COLORS[status] || 'var(--dim)';
  document.querySelectorAll(`.job-status-select[data-id="${id}"]`).forEach(sel => {
    const badge = sel.previousElementSibling;
    if (badge?.classList.contains('job-status-badge')) {
      badge.textContent = STATUS_LABELS[status] || status;
      badge.style.setProperty('--status-color', statCol);
    }
  });
}

// ── Jobs: add job ────────────────────────────────────────────────────────────
function openAddJobView() {
  ['add-job-title', 'add-job-company', 'add-job-link', 'add-job-desc']
    .forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('add-job-match-empty').classList.remove('hidden');
  document.getElementById('add-job-match-results').classList.add('hidden');
  document.getElementById('add-job-status-msg').classList.add('hidden');
  document.getElementById('btn-save-job').disabled = true;
  document.getElementById('btn-save-job').loading  = false;
  showJobsSubview('add');
}

async function saveAndAnalyzeJob() {
  const title       = document.getElementById('add-job-title').value.trim();
  const company     = document.getElementById('add-job-company').value.trim();
  const link        = document.getElementById('add-job-link').value.trim();
  const description = document.getElementById('add-job-desc').value.trim();
  if (!description) { showToast('Add a job description first.'); return; }

  if (!state.profile) {
    const ok = await loadProfile();
    if (!ok) { showToast('Generate your About Me profile first.'); return; }
  }

  const job = {
    id: Date.now().toString(), title: title || 'Untitled Role',
    company, link, description, status: 'saved',
    match_score: null, match_result: null, score_history: [],
    resume_draft: null, resume_extra_skills: [],
    created_at: new Date().toISOString(),
  };
  state.jobs.unshift(job);
  await persistJobs();

  const btn = document.getElementById('btn-save-job');
  const msg = document.getElementById('add-job-status-msg');
  btn.loading = true; btn.disabled = true;
  msg.textContent = 'Analyzing against your profile…'; msg.classList.remove('hidden');

  try {
    const result = await runMatchAnalysis(job.title, job.company, job.description);
    job.match_score  = result.match_score;
    job.match_result = result;
    await persistJobs();
    msg.classList.add('hidden');
    renderMatchInto('add-job-match', result, [title, company].filter(Boolean).join(' · '));
    showToast('Job saved and analyzed.');
  } catch (e) {
    msg.textContent = `Saved — analysis failed: ${e.message}`;
    showToast('Job saved; analysis failed.');
  } finally {
    btn.loading = false; btn.disabled = false;
  }
}

// ── Jobs: detail tab switching ────────────────────────────────────────────────
// Measures the actual pixel height available below the active tab pane's top
// edge and publishes it as --pane-h. Called on resize and whenever the detail
// view changes so both .app-layout and .resume-tab-layout track the live window.
function updatePaneHeight() {
  const pane = document.querySelector('.detail-tab-pane:not(.hidden)');
  if (!pane) return;
  const top = pane.getBoundingClientRect().top;
  const h   = Math.max(300, Math.floor(window.innerHeight - top - 28)); // 28 = bottom padding
  document.documentElement.style.setProperty('--pane-h', h + 'px');
}

function switchDetailTab(name) {
  ['analysis', 'resume', 'application'].forEach(n => {
    document.getElementById(`tab-${n}`).classList.toggle('hidden', n !== name);
    document.querySelector(`.detail-tab[data-tab="${n}"]`)?.classList.toggle('active', n === name);
  });
  if (name === 'resume') scaleResumePage();
  if (name === 'application' && state.browser.port) detectApplicationFields();
  updatePaneHeight();
}

// ── Jobs: detail ─────────────────────────────────────────────────────────────
function showJobDetail(id) {
  const job = jobById(id);
  if (!job) return;
  state.activeJobId = id;
  const statCol = STATUS_COLORS[job.status] || 'var(--dim)';

  document.getElementById('detail-header-info').innerHTML =
    `<div class="detail-htitle">${escHtml(job.title || 'Untitled Role')}</div>` +
    (job.company ? `<div class="detail-hcompany">${escHtml(job.company)}</div>` : '');

  const badge = document.getElementById('detail-status-badge');
  badge.textContent = STATUS_LABELS[job.status] || job.status;
  badge.style.setProperty('--status-color', statCol);

  const sel = document.getElementById('detail-status-select');
  sel.dataset.id = job.id;
  sel.innerHTML = Object.entries(STATUS_LABELS)
    .map(([v, l]) => `<option value="${v}"${job.status === v ? ' selected' : ''}>${l}</option>`).join('');

  const applyLink = document.getElementById('detail-apply-link');
  if (job.link) { applyLink.href = job.link; applyLink.classList.remove('hidden'); }
  else applyLink.classList.add('hidden');

  // Close browser if we're switching to a different job
  if (state.browser.port && state.browser.jobId !== id) closeApplicationBrowser();

  renderJobDetailCards(job);
  renderResumeSuggestions(job);
  renderResumePreview(job);
  renderApplicationTab(job);
  switchDetailTab('analysis');
  showJobsSubview('detail');
  // Measure available height after DOM has settled for this detail view.
  requestAnimationFrame(updatePaneHeight);
}

// ── Job detail: card renderer ─────────────────────────────────────────────────
function mcIcon(path) {
  return `<svg class="mc-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}
const MC_ICONS = {
  layers:    `<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9A1 1 0 0 0 22 6z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>`,
  briefcase: `<rect width="20" height="14" x="2" y="7" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>`,
  folder:    `<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>`,
  trending:  `<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>`,
  file:      `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><line x1="10" x2="16" y1="13" y2="13"/><line x1="10" x2="14" y1="17" y2="17"/>`,
};

function renderJobDetailCards(job) {
  const empty  = document.getElementById('detail-match-empty');
  const el     = document.getElementById('detail-match-results');
  const m      = job.match_result;

  if (!m) { empty.classList.remove('hidden'); el.classList.add('hidden'); return; }

  const score  = Math.max(0, Math.min(100, m.match_score || 0));
  const col    = scoreColorFor(score);

  const RD_CFG = {
    apply_now: { cls: 'rd-go',      icon: '✓', label: 'Apply now' },
    stretch:   { cls: 'rd-stretch', icon: '◎', label: 'Stretch role' },
    not_yet:   { cls: 'rd-stop',    icon: '✕', label: 'Not yet' },
  };
  const rd    = m.apply_readiness || {};
  const rdc   = RD_CFG[rd.verdict] || null;

  // helper: chip list
  const chips = (items, color) =>
    `<div class="chips">${items.map(s => `<span class="chip match-chip" style="--chip-color:${color}">${escHtml(String(s))}</span>`).join('')}</div>`;

  // helper: skill group block (only rendered if items exist)
  const skillGroup = (label, cls, items, body) =>
    items?.length ? `<div class="mc-skill-group">
      <div class="mc-skill-label ${cls}">${escHtml(label)} <span class="mc-skill-count">${items.length}</span></div>
      ${body(items)}
    </div>` : '';

  // helper: bullet list
  const dotList = (items, dotColor) =>
    `<ul class="mc-list">${items.map(s =>
      `<li><span class="mc-dot" style="background:${dotColor}"></span>${escHtml(String(s))}</li>`
    ).join('')}</ul>`;

  // ── Card 1: Hero ────────────────────────────────────────────────────────────
  const heroCard = `<div class="mc mc-hero">
    <div class="mc-score-row">
      <div class="mc-ring" style="--c:${col};--score:${score}"><span class="mc-ring-num">${score}</span></div>
      <p class="mc-summary">${escHtml(m.summary || '')}</p>
    </div>
    ${m.application_strategy ? `<div class="mc-strategy"><span class="mc-strategy-arrow">›</span>${escHtml(m.application_strategy)}</div>` : ''}
    ${rdc ? `<div class="mc-readiness ${rdc.cls}">
      <span class="mc-rd-icon">${rdc.icon}</span>
      <span class="mc-rd-label">${rdc.label}</span>
      ${rd.reason ? `<span class="mc-rd-reason">${escHtml(rd.reason)}</span>` : ''}
    </div>` : ''}
  </div>`;

  // ── Card 2: Skills ──────────────────────────────────────────────────────────
  const partialHtml = (m.partial_matches || []).map(pm => `
    <div class="partial-match-row">
      <span class="chip match-chip" style="--chip-color:var(--amber)">${escHtml(pm.skill || '')}</span>
      <span class="partial-match-reason">${escHtml(pm.reason || pm.bucket || '')}</span>
    </div>`).join('');

  const profileGaps = m.profile_gaps || [];

  const skillsCard = `<div class="mc">
    <div class="mc-head">${mcIcon(MC_ICONS.layers)} Skills</div>
    <div class="mc-skill-blocks">
      ${skillGroup('Matched', 'sk-green', m.skills_matched, i => chips(i, 'var(--green)'))}
      ${(m.partial_matches || []).length ? `<div class="mc-skill-group">
        <div class="mc-skill-label sk-amber">Partial — same domain, different tool <span class="mc-skill-count">${m.partial_matches.length}</span></div>
        <div class="partial-matches">${partialHtml}</div>
      </div>` : ''}
      ${skillGroup('Required — gap', 'sk-red', m.required_gaps, i => chips(i, 'var(--red)'))}
      ${skillGroup('Preferred — gap', 'sk-dim', m.nice_to_have_gaps, i => chips(i, 'var(--dim)'))}
    </div>
    ${profileGaps.length ? `<div class="mc-nudge">
      <span class="mc-nudge-icon">⚠</span>
      <div>Based on your experience descriptions, you likely also have <strong>${escHtml(profileGaps.join(', '))}</strong> — but they're not listed in your profile skills. Add them and re-analyze for a more accurate score.</div>
    </div>` : ''}
  </div>`;

  // ── Card 3: Experience ──────────────────────────────────────────────────────
  const expCard = m.relevant_experience ? `<div class="mc">
    <div class="mc-head">${mcIcon(MC_ICONS.briefcase)} Experience fit</div>
    <p class="mc-prose">${escHtml(m.relevant_experience)}</p>
  </div>` : '';

  // ── Card 4: Projects ────────────────────────────────────────────────────────
  const projCard = (m.relevant_projects || []).length ? `<div class="mc">
    <div class="mc-head">${mcIcon(MC_ICONS.folder)} Relevant projects &amp; what to say</div>
    <div class="mc-projects">${(m.relevant_projects || []).map(pr => `
      <div class="mc-proj">
        <div class="mc-proj-name">${escHtml(pr.name || '')}</div>
        <div class="mc-proj-reason">${escHtml(pr.reason || '')}</div>
        ${(pr.talking_points || []).length ? `
          <div class="mc-tp-label">What to say</div>
          <ul class="mc-tp-list">${pr.talking_points.map(tp => `<li>${escHtml(tp)}</li>`).join('')}</ul>
        ` : ''}
      </div>`).join('')}
    </div>
  </div>` : '';

  // ── Card 5: Strengths & gap closure ────────────────────────────────────────
  const hasStrengths = (m.green_flags || []).length;
  const hasFocus     = (m.focus_areas || []).length;
  const gapCard = (hasStrengths || hasFocus) ? `<div class="mc">
    <div class="mc-head">${mcIcon(MC_ICONS.trending)} Strengths &amp; closing the gap</div>
    ${hasStrengths ? `<div class="mc-subhead">Working in your favour</div>${dotList(m.green_flags, 'var(--green)')}` : ''}
    ${hasFocus ? `<div class="mc-subhead"${hasStrengths ? ' style="margin-top:16px"' : ''}>To improve your match</div>${dotList(m.focus_areas, 'var(--accent)')}` : ''}
    ${profileGaps.length ? `<div class="mc-nudge" style="margin-top:14px">
      <span class="mc-nudge-icon">⚠</span>
      <div>Your profile may be underselling you — the agent found skills implied by your experience that aren't listed. Update your profile and hit Re-analyze to see if your score improves.</div>
    </div>` : ''}
    ${rdc?.cls === 'rd-stop' ? `<div class="mc-nudge mc-nudge-soft" style="margin-top:14px">
      <span class="mc-nudge-icon">○</span>
      <div>This role has significant gaps at your current profile level. Consider building more direct experience before applying, or focus applications on closer matches while you grow into this space.</div>
    </div>` : ''}
  </div>` : '';

  // ── Card 6: JD (collapsible) ────────────────────────────────────────────────
  const jdCard = `<details class="mc mc-jd">
    <summary class="mc-head mc-jd-summary">${mcIcon(MC_ICONS.file)} Job Description</summary>
    <div class="mc-jd-content">${renderJD(job.description)}</div>
  </details>`;

  empty.classList.add('hidden');
  el.classList.remove('hidden');
  el.innerHTML = heroCard + skillsCard + expCard + projCard + gapCard + jdCard;
}

// ── Match analysis: shared runner + renderer ──────────────────────────────────
function parseMatchJson(text) {
  let t = (text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

async function runMatchAnalysis(title, company, description) {
  const p = state.profile || {};
  const bucketSummary = (p.skill_buckets || [])
    .filter(b => b.skills?.length)
    .map(b => `  ${b.category}: ${b.skills.join(', ')}`)
    .join('\n');
  const prompt =
    `PROFILE SKILLS BY BUCKET:\n${bucketSummary || '  (none)'}\n\n` +
    `FULL PROFILE:\n${JSON.stringify(p, null, 2)}\n\n` +
    (title || company ? `ROLE: ${[title, company].filter(Boolean).join(' at ')}\n\n` : '') +
    `JOB DESCRIPTION:\n${description}`;
  const session = await oc('/session', { method: 'POST', body: '{}' });
  const msg = await oc(`/session/${session.id}/message`, {
    method: 'POST',
    body: JSON.stringify({ agent: 'jd-match', parts: [{ type: 'text', text: prompt }] }),
  });
  const reply = (msg?.parts || []).filter(p => p.type === 'text' && p.text).map(p => p.text).join('');
  return parseMatchJson(reply);
}

// ── Resume tab: left actions pane ─────────────────────────────────────────────
function renderResumeSuggestions(job) {
  const el = document.getElementById('resume-actions-pane');
  if (!el) return;
  const profileGaps = job.match_result?.profile_gaps || [];
  const accepted    = job.resume_extra_skills || [];
  const hasDraft    = !!job.resume_draft;

  const skillRows = profileGaps.map(skill => `
    <div class="ra-skill-row">
      <span class="ra-skill-name">${escHtml(skill)}</span>
      <div class="ra-skill-btns">
        <label class="rsugg-check" title="Include in next draft">
          <input type="checkbox" class="rsugg-resume-cb" data-skill="${escAttr(skill)}"${accepted.includes(skill) ? ' checked' : ''}>
          <span>Draft</span>
        </label>
        <button class="rsugg-add-profile ps-btn-ghost" data-skill="${escAttr(skill)}">+&nbsp;Profile</button>
      </div>
    </div>`).join('');

  el.innerHTML = `
    <div class="ra-section">
      <div class="ra-section-head">${mcIcon(MC_ICONS.layers)} Inferred Skills</div>
      ${profileGaps.length ? `
        <p class="ra-hint">Skills implied by your experience but not yet in your profile.</p>
        <div class="ra-skills-list">${skillRows}</div>
        <div class="ra-agg-btns">
          <button id="btn-add-all-profile" class="ps-btn-ghost ra-agg-btn">Add all to profile</button>
          <button id="btn-include-all-draft" class="ps-btn-ghost ra-agg-btn">Include all in draft</button>
        </div>
      ` : `
        <p class="ra-hint" style="color:var(--dim)">Profile looks complete for this role — no inferred gaps detected.</p>
      `}
    </div>

    <div class="ra-divider"></div>

    <div class="ra-section">
      <div class="ra-section-head">${mcIcon(MC_ICONS.file)} Resume</div>
      <div class="ra-actions-stack">
        <button id="btn-compose-resume" class="ps-save-btn ra-generate-btn">
          ${hasDraft ? 'Re-generate Draft' : 'Generate Resume'}
        </button>
        <button id="btn-reanalyze-resume" class="ps-btn-ghost ra-reanalyze-btn">Re-analyze Job</button>
      </div>
      <div id="compose-status" class="gen-status hidden"></div>
    </div>`;
}

// ── Resume Composition engine ─────────────────────────────────────────────────
async function runResumeComposition(job, extraSkills) {
  const p = state.profile;
  const prompt =
    `CANDIDATE PROFILE:\n${JSON.stringify(p, null, 2)}\n\n` +
    `JOB ANALYSIS:\n${JSON.stringify(job.match_result, null, 2)}\n\n` +
    `JOB DESCRIPTION:\n${job.description}\n\n` +
    (extraSkills.length ? `EXTRA SKILLS TO INCLUDE IN RESUME:\n${extraSkills.join(', ')}\n\n` : '') +
    `Compose a targeted resume draft for: ${[job.title, job.company].filter(Boolean).join(' at ')}`;
  const session = await oc('/session', { method: 'POST', body: '{}' });
  const msg = await oc(`/session/${session.id}/message`, {
    method: 'POST',
    body: JSON.stringify({ agent: 'resume-composer', parts: [{ type: 'text', text: prompt }] }),
  });
  const reply = (msg?.parts || []).filter(p => p.type === 'text' && p.text).map(p => p.text).join('');
  let t = reply.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

async function composeResume() {
  const job = jobById(state.activeJobId);
  if (!job) return;
  if (!state.profile) { const ok = await loadProfile(); if (!ok) { showToast('Add a profile first.'); return; } }

  const extraSkills = [...document.querySelectorAll('.rsugg-resume-cb:checked')]
    .map(cb => cb.dataset.skill).filter(Boolean);
  job.resume_extra_skills = extraSkills;

  const btn    = document.getElementById('btn-compose-resume');
  const status = document.getElementById('compose-status');
  btn.disabled = true;
  status.textContent = 'Composing targeted resume draft…';
  status.classList.remove('hidden');

  try {
    const draft = await runResumeComposition(job, extraSkills);
    job.resume_draft = draft;
    await persistJobs();
    renderResumeSuggestions(job);
    renderResumePreview(job);
    switchDetailTab('resume');
    showToast('Resume draft ready.');
  } catch (e) {
    status.textContent = `Failed: ${e.message}`;
    btn.disabled = false;
    showToast('Composition failed — try again.');
  }
}

async function addSkillToProfile(skill, silent = false) {
  if (!state.profile) return;
  const p = state.profile;
  if (!p.skill_buckets) p.skill_buckets = [];
  let bucket = p.skill_buckets.find(b => b.category === 'Other');
  if (!bucket) { bucket = { category: 'Other', skills: [] }; p.skill_buckets.push(bucket); }
  if (bucket.skills.includes(skill)) {
    if (!silent) showToast(`"${skill}" is already in your profile.`);
    return;
  }
  bucket.skills.push(skill);
  await bridge.workspaceWrite(PROFILE_PATH, JSON.stringify(p, null, 2));
  if (!silent) showToast(`"${skill}" added to profile.`);
  const cb = document.querySelector(`.rsugg-resume-cb[data-skill="${skill}"]`);
  if (cb) cb.checked = true;
}

async function addAllSkillsToProfile() {
  const job  = jobById(state.activeJobId);
  const gaps = job?.match_result?.profile_gaps || [];
  if (!gaps.length) { showToast('No inferred skills to add.'); return; }
  for (const skill of gaps) await addSkillToProfile(skill, true);
  showToast(`Added ${gaps.length} inferred skill${gaps.length !== 1 ? 's' : ''} to profile.`);
}

function includeAllInDraft() {
  document.querySelectorAll('.rsugg-resume-cb').forEach(cb => { cb.checked = true; });
  showToast('All inferred skills will be included in the next draft.');
}

// ── Application tab ───────────────────────────────────────────────────────────
// ── Application field detection ───────────────────────────────────────────────

async function detectApplicationFields() {
  const body = document.getElementById('app-fields-body');
  if (!body || !state.browser.port) return;

  const btn = document.getElementById('btn-rescan-fields');
  if (btn) btn.disabled = true;

  body.innerHTML = `
    <div class="app-fields-loading">
      <div class="app-spin"></div>
      <span>Scanning page for form fields…</span>
    </div>`;

  try {
    const result = await bridge.browserDetectFields();
    if (!result?.ok || !result.forms?.length) {
      body.innerHTML = `
        <div class="app-fields-empty">
          <sl-icon library="lucide" name="file-search"></sl-icon>
          No form fields found on this page.
          <span class="app-fields-empty-hint">Navigate to the application page and hit Re-scan.</span>
        </div>`;
    } else {
      body.innerHTML = result.forms.map(renderFormCard).join('');
    }
  } catch (e) {
    body.innerHTML = `
      <div class="app-fields-empty">
        Detection error: ${escHtml(e.message)}
      </div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderFormCard(form) {
  const rows = form.fields.map(f => `
    <div class="app-form-field">
      <span class="app-field-type-badge">${escHtml(f.typeName)}</span>
      <div class="app-field-detail">
        <span class="app-field-label">${escHtml(f.label)}${f.required ? ' <span class="app-field-req">*</span>' : ''}</span>
        ${f.helperText ? `<span class="app-field-helper">${escHtml(f.helperText)}</span>` : ''}
        ${f.accept    ? `<span class="app-field-helper">Accepts: ${escHtml(f.accept)}</span>` : ''}
      </div>
    </div>`).join('');

  return `
    <div class="app-form-card">
      <div class="app-form-card-head">
        <span class="app-form-card-name">${escHtml(form.name)}</span>
        <span class="app-form-card-count">${form.fields.length} field${form.fields.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="app-form-field-list">${rows}</div>
    </div>`;
}

function renderApplicationTab(job) {
  const el = document.getElementById('application-tab-content');
  if (!el) return;
  const url      = job?.link || '';
  const hasDraft = !!job?.resume_draft;
  const isOpen   = !!state.browser.port;

  el.innerHTML = `
    <div class="app-layout">

      <div class="app-fields-area">
        <div class="app-fields-bar">
          <sl-icon library="lucide" name="layout-list"></sl-icon>
          Detected Fields
          ${isOpen ? `<button class="app-rescan-btn" id="btn-rescan-fields" title="Re-scan page for fields"><sl-icon library="lucide" name="refresh-cw"></sl-icon></button>` : ''}
        </div>
        <div class="app-fields-body" id="app-fields-body"></div>
      </div>

      <div class="app-ctrl-rail">
        <div class="app-ctrl-top">
          ${isOpen ? `
            <div class="app-url-strip">
              <sl-icon library="lucide" name="globe" class="app-url-icon"></sl-icon>
              <span id="app-current-url" class="app-url-val">—</span>
            </div>
            <button class="app-ctrl-btn app-ctrl-primary" id="btn-focus-browser">
              <sl-icon library="lucide" name="focus"></sl-icon> Focus
            </button>
            <button class="app-ctrl-btn app-ctrl-ghost" id="btn-navigate-browser">
              <sl-icon library="lucide" name="rotate-ccw"></sl-icon> Reset URL
            </button>
            <button class="app-ctrl-btn app-ctrl-danger" id="btn-close-app-browser">
              <sl-icon library="lucide" name="x"></sl-icon> Close
            </button>
          ` : url ? `
            <button class="app-ctrl-btn app-ctrl-primary" id="btn-open-app-browser">
              <sl-icon library="lucide" name="external-link"></sl-icon> Open Application
            </button>
          ` : `
            <p class="app-no-link">No application link for this job.</p>
          `}
        </div>

        ${hasDraft ? `
          <div class="app-ctrl-foot">
            <button class="app-ctrl-btn app-ctrl-ghost" id="btn-export-pdf-app">
              <sl-icon library="lucide" name="download"></sl-icon> Export Resume
            </button>
          </div>
        ` : ''}
      </div>

    </div>`;

  if (isOpen) {
    refreshBrowserStatus();
    detectApplicationFields();
  }

  document.getElementById('btn-rescan-fields')
    ?.addEventListener('click', detectApplicationFields);
}

// ── Browser health polling ────────────────────────────────────────────────────
let _browserPollInterval = null;
let _lastScannedUrl = null;   // track URL so we re-scan on navigation

function _startBrowserPoll() {
  _stopBrowserPoll();
  _lastScannedUrl = null;
  _browserPollInterval = setInterval(async () => {
    const port = state.browser.port;
    if (!port) { _stopBrowserPoll(); return; }
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 3000);
      const r    = await fetch(`http://127.0.0.1:${port}/status`, { signal: ctrl.signal });
      clearTimeout(tid);
      if (!r.ok) throw new Error('not ok');
      const data = await r.json();
      const el = document.getElementById('app-current-url');
      if (el && data.url) el.textContent = data.url;
      // Re-detect fields whenever the user navigates to a new URL
      if (data.url && data.url !== _lastScannedUrl) {
        _lastScannedUrl = data.url;
        const appTab = document.getElementById('tab-application');
        if (appTab && !appTab.classList.contains('hidden')) {
          detectApplicationFields();
        }
      }
    } catch (_) {
      // Connection refused or timeout → subprocess exited (browser closed).
      _handleBrowserDied();
    }
  }, 5000);
}

function _stopBrowserPoll() {
  if (_browserPollInterval) { clearInterval(_browserPollInterval); _browserPollInterval = null; }
}

function _handleBrowserDied() {
  _stopBrowserPoll();
  if (!state.browser.port) return; // already cleaned up
  state.browser.port  = null;
  state.browser.jobId = null;
  // Clean up Python-side subprocess refs and trigger _restore_window_state()
  // (idempotent — safe even if the watcher thread already called it).
  bridge.browserClose().catch(() => {});
  const job = jobById(state.activeJobId);
  if (job) renderApplicationTab(job);
  showToast('Application browser was closed — click "Open Application" to relaunch.');
}

// Called by the bridge watcher thread via evaluate_js the instant the
// browser subprocess exits — no polling lag.
window._onBrowserProcessDied = function() { _handleBrowserDied(); };

async function openApplicationBrowser() {
  const job = jobById(state.activeJobId);
  if (!job?.link) return;
  const btn = document.getElementById('btn-open-app-browser');
  if (btn) { btn.disabled = true; btn.innerHTML = '<sl-spinner style="font-size:13px"></sl-spinner> Launching…'; }
  try {
    const result = await bridge.browserOpen(job.link);
    if (!result?.ok) {
      showToast(`Browser failed: ${result?.error || 'unknown'}`);
      if (btn) { btn.disabled = false; btn.innerHTML = '<sl-icon library="lucide" name="globe" style="vertical-align:-2px"></sl-icon> Open Application'; }
      return;
    }
    state.browser.port  = result.port;
    state.browser.jobId = state.activeJobId;
    renderApplicationTab(job);
    _startBrowserPoll(); // detect if user closes the browser externally
  } catch (e) {
    showToast(`Browser error: ${e.message}`);
    if (btn) { btn.disabled = false; btn.innerHTML = '<sl-icon library="lucide" name="globe" style="vertical-align:-2px"></sl-icon> Open Application'; }
  }
}

async function focusApplicationBrowser() {
  const port = state.browser.port;
  if (!port) return;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/focus`, {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' },
    });
    if (!r.ok) throw new Error(`status ${r.status}`);
  } catch (e) {
    // Focus failure alone doesn't mean the browser died — the health poll
    // handles that. Just surface the error so the user knows to check.
    showToast(`Could not focus browser window: ${e.message}`);
  }
}

async function closeApplicationBrowser() {
  _stopBrowserPoll();
  try { await bridge.browserClose(); } catch (_) {}
  state.browser.port  = null;
  state.browser.jobId = null;
  const job = jobById(state.activeJobId);
  if (job) renderApplicationTab(job);
}

async function resetBrowserUrl() {
  const job  = jobById(state.activeJobId);
  const port = state.browser.port;
  if (!job?.link || !port) return;
  try {
    await fetch(`http://127.0.0.1:${port}/navigate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: job.link }),
    });
    setTimeout(refreshBrowserStatus, 2000);
  } catch (e) { showToast(`Navigate failed: ${e.message}`); }
}

async function refreshBrowserStatus() {
  const port = state.browser.port;
  if (!port) return;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/status`);
    if (!r.ok) return;
    const data = await r.json();
    const el = document.getElementById('app-current-url');
    if (el && data.url) el.textContent = data.url;
  } catch (_) {}
}

// ── Resume Preview tab ────────────────────────────────────────────────────────
function renderResumePreview(job) {
  const el = document.getElementById('resume-preview-content');
  if (!el) return;
  if (!job.resume_draft) {
    el.innerHTML = `<div class="empty" style="padding-top:48px">
      <sl-icon library="lucide" name="file-text" class="empty-icon"></sl-icon>
      <div class="empty-title">No resume draft yet</div>
      <div class="empty-sub">Click "Generate Resume" in the left panel to preview a tailored resume.</div>
    </div>`;
    return;
  }
  const draft = job.resume_draft;
  const p     = state.profile || {};
  el.innerHTML = `
    <div class="rp-toolbar">
      <button id="btn-export-pdf" class="ps-save-btn rp-export-btn">
        <sl-icon library="lucide" name="download" style="vertical-align:-2px"></sl-icon>
        Export PDF
      </button>
    </div>
    <div class="rp-viewport"><div id="rp-scale-wrap"><div class="rp-page" id="rp-page">${renderResumeHTML(draft, p)}</div></div></div>`;
  scaleResumePage();
}

// Builds a self-contained print HTML from the resume inner content.
// Opens in a new window that auto-triggers window.print() — zero pip deps.
// Builds a self-contained HTML document for PDF generation via Playwright.
// Full modern CSS (flex, custom properties) works — Chromium renders it.
// The inner content mirrors the screen preview exactly.
function buildExportHTML(draft, p) {
  const inner = renderResumeHTML(draft, p);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 9.5pt; line-height: 1.35; color: #000; background: #fff; }
.rp-page { width: 8.5in; padding: 16px 12px; }
.rp-header { text-align: center; margin-bottom: 7px; }
.rp-name { font-size: 20pt; font-weight: 700; line-height: 1.2; margin-bottom: 3px; }
.rp-contact { font-size: 9.5pt; color: #222; line-height: 1.5; }
.rp-contact-link { color: #222; text-decoration: none; }
.rp-section { margin-bottom: 7px; }
.rp-section-title { font-size: 11pt; font-weight: 700; border-bottom: 1.5px solid #000; padding-bottom: 2px; margin-bottom: 5px; line-height: 1.2; }
.rp-prose { margin: 3px 0 0; font-size: 9.5pt; line-height: 1.4; }
.rp-skill-list { list-style: disc; margin: 3px 0 0 18px; padding: 0; }
.rp-skill-list li { font-size: 10pt; margin: 1px 0; line-height: 1.35; }
.rp-entry { margin-bottom: 5px; }
.rp-entry:last-child { margin-bottom: 0; }
.rp-entry-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.rp-exp-label { font-size: 9.5pt; flex: 1; min-width: 0; }
.rp-entry-dates { font-size: 10pt; color: #333; white-space: nowrap; flex-shrink: 0; font-style: italic; }
.rp-edu-degree { font-size: 10pt; color: #333; margin-top: 1px; }
.rp-bullets { list-style: disc; margin: 2px 0 0 18px; padding: 0; }
.rp-bullets li { font-size: 10pt; margin: 1px 0; line-height: 1.35; }
.rp-proj-list { list-style: decimal; margin: 3px 0 0 18px; padding: 0; }
.rp-proj-item { margin-bottom: 5px; line-height: 1.35; }
.rp-proj-item:last-child { margin-bottom: 0; }
.rp-proj-name { font-size: 9.5pt; font-weight: 700; color: #000; text-decoration: underline; }
.rp-proj-name-plain { font-size: 9.5pt; font-weight: 700; }
.rp-proj-stack { display: block; font-size: 10pt; font-style: italic; color: #333; margin: 1px 0 2px; }
.rp-pub-list { list-style: decimal; margin: 3px 0 0 18px; padding: 0; }
.rp-pub-item { margin-bottom: 4px; line-height: 1.35; }
.rp-pub-item:last-child { margin-bottom: 0; }
.rp-pub-title { font-size: 9.5pt; font-weight: 700; color: #000; text-decoration: underline; }
.rp-pub-title-plain { font-size: 9.5pt; font-weight: 700; }
.rp-pub-venue { display: block; font-size: 10pt; font-style: italic; color: #333; margin-top: 1px; }
</style>
</head><body>
<div class="rp-page">${inner}</div>
</body></html>`;
}

async function exportResumePDF() {
  const job = jobById(state.activeJobId);
  if (!job?.resume_draft) { showToast('No resume draft to export.'); return; }
  const p = state.profile || {};

  const slug     = s => (s || '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const date     = new Date().toISOString().slice(0, 10);
  const filename = `resume_${slug(job.company)}_${slug(job.title)}_${date}.pdf`;

  const btn       = document.getElementById('btn-export-pdf');
  const resetBtn  = () => {
    if (!btn) return;
    btn.disabled = false;
    btn.innerHTML = '<sl-icon library="lucide" name="download" style="vertical-align:-2px"></sl-icon> Export PDF';
  };
  if (btn) {
    btn.disabled  = true;
    btn.innerHTML = '<sl-spinner style="font-size:13px;--track-width:2px"></sl-spinner> Exporting…';
  }

  try {
    const html   = buildExportHTML(job.resume_draft, p);
    const result = await bridge.exportResumePdf(html, filename);
    if (result?.ok) {
      showToast(`PDF saved to Downloads: ${result.filename}`);
    } else {
      const msg = result?.error || 'unknown error';
      console.error('[exportResumePDF] bridge error:', msg);
      showToast(`Export failed: ${msg}`);
    }
  } catch (err) {
    console.error('[exportResumePDF] exception:', err);
    showToast(`Export error: ${err.message || err}`);
  } finally {
    resetBtn();
  }
}

function scaleResumePage() {
  const viewport = document.querySelector('.rp-viewport');
  const wrap     = document.getElementById('rp-scale-wrap');
  const page     = document.getElementById('rp-page');
  if (!viewport || !wrap || !page) return;
  page.style.transform = '';
  wrap.style.height    = '';
  wrap.style.width     = '';
  const availW = viewport.clientWidth - 48;
  const pageW  = 816;
  const scale  = Math.min(1, availW / pageW);
  if (scale < 1) {
    const pageH = page.offsetHeight;
    page.style.transform       = `scale(${scale})`;
    page.style.transformOrigin = 'top center';
    wrap.style.height          = Math.ceil(pageH * scale) + 'px';
    wrap.style.width           = Math.ceil(pageW * scale) + 'px';
  }
}

function renderResumeHTML(draft, p) {
  const id      = p.identity || {};
  const contact = p.contact  || {};

  // Contact row: phone | email | links — all facts from profile
  const contactParts = [
    contact.phone ? escHtml(contact.phone) : null,
    contact.email ? escHtml(contact.email) : null,
    ...(contact.links || []).map(l => l.url
      ? `<a class="rp-contact-link" href="${escAttr(l.url)}" target="_blank">${escHtml(l.label || l.url)}</a>`
      : null),
  ].filter(Boolean);

  // Section: bold title + bottom border
  const sec = (title, body) => body
    ? `<div class="rp-section"><div class="rp-section-title">${escHtml(title)}</div>${body}</div>`
    : '';

  // Bullet list helper — hard cap at 3
  const bul = (arr) => arr?.length
    ? `<ul class="rp-bullets">${arr.slice(0, 3).map(b => `<li>${escHtml(b)}</li>`).join('')}</ul>`
    : '';

  // ── Skills: group by profile bucket ──────────────────────────────────────
  const draftSkillSet    = new Set(draft.skills || []);
  const allProfileSkills = new Set((p.skill_buckets || []).flatMap(b => b.skills || []));
  const bucketLines = (p.skill_buckets || [])
    .map(b => ({ cat: b.category, skills: (b.skills || []).filter(s => draftSkillSet.has(s)) }))
    .filter(b => b.skills.length);
  const extraSkills = (draft.skills || []).filter(s => !allProfileSkills.has(s));
  if (extraSkills.length) bucketLines.push({ cat: 'Additional', skills: extraSkills });

  const skillsBody = bucketLines.length
    ? `<ul class="rp-skill-list">${
        bucketLines.map(g => `<li><strong>${escHtml(g.cat)}:</strong> ${escHtml(g.skills.join(', '))}</li>`).join('')
      }</ul>`
    : '';

  // ── Experience: facts always from profile, bullets from draft ────────────
  const expBody = (draft.experience || []).slice(0, 3).map(exp => {
    const pe      = (p.experience || []).find(e => e.id === exp.id) || {};
    const company = pe.company || '';
    const title   = pe.title   || '';
    const dates   = [pe.start, pe.end].filter(Boolean).join(' – ');
    const bullets = (exp.bullets?.length ? exp.bullets : pe.highlights || []).slice(0, 3);
    return `<div class="rp-entry">
      <div class="rp-entry-head">
        <span class="rp-exp-label"><strong>${escHtml(company)}</strong> — ${escHtml(title)}</span>
        <span class="rp-entry-dates">${escHtml(dates)}</span>
      </div>
      ${bul(bullets)}
    </div>`;
  }).join('');

  // ── Projects: <ol>, facts from profile, bullets from draft ────────────────
  const projItems = (draft.projects || []).slice(0, 3).map(pr => {
    const pp      = (p.projects || []).find(proj => proj.id === pr.id) || {};
    const name    = pp.name  || '';
    const url     = pp.url   || '';
    const tech    = (pp.tech || []).join(', ');
    const bullets = (pr.bullets?.length ? pr.bullets : pp.highlights || []).slice(0, 3);
    const nameEl  = url
      ? `<a class="rp-proj-name" href="${escAttr(url)}" target="_blank">${escHtml(name)}</a>`
      : `<span class="rp-proj-name-plain">${escHtml(name)}</span>`;
    return `<li class="rp-proj-item">${nameEl}${tech ? `<span class="rp-proj-stack"><em>Stack: ${escHtml(tech)}</em></span>` : ''}${bul(bullets)}</li>`;
  }).join('');
  const projBody = projItems ? `<ol class="rp-proj-list">${projItems}</ol>` : '';

  // ── Education: entirely from profile ─────────────────────────────────────
  const eduBody = (p.education || []).map(ed => `
    <div class="rp-entry">
      <div class="rp-entry-head">
        <span class="rp-exp-label">${escHtml(ed.institution || '')}</span>
        <span class="rp-entry-dates">${escHtml(ed.year || '')}</span>
      </div>
      <div class="rp-edu-degree">${escHtml(ed.degree || '')}</div>
    </div>`).join('');

  // ── Publications: <ol>, entirely from profile ─────────────────────────────
  const pubItems = (p.publications || []).map(pub => {
    const titleEl = pub.title
      ? (pub.url
          ? `<a class="rp-pub-title" href="${escAttr(pub.url)}" target="_blank">${escHtml(pub.title)}</a>`
          : `<span class="rp-pub-title">${escHtml(pub.title)}</span>`)
      : '';
    const venueEl = (pub.venue || pub.year)
      ? `<span class="rp-pub-venue"><em>${[pub.venue, pub.year].filter(Boolean).map(escHtml).join(' ')}</em></span>`
      : '';
    return `<li class="rp-pub-item">${titleEl}${venueEl}</li>`;
  }).join('');
  const pubBody = pubItems ? `<ol class="rp-pub-list">${pubItems}</ol>` : '';

  return `
    <div class="rp-header">
      <div class="rp-name">${escHtml(id.name || 'Your Name')}</div>
      ${contactParts.length ? `<div class="rp-contact">${contactParts.join(' | ')}</div>` : ''}
    </div>
    ${draft.summary
      ? sec('Profile', `<p class="rp-prose">${escHtml(draft.summary)}</p>`)
      : (id.summary ? sec('Profile', `<p class="rp-prose">${escHtml(id.summary)}</p>`) : '')}
    ${sec('Work Experience', expBody)}
    ${sec('Projects', projBody)}
    ${sec('Skills', skillsBody)}
    ${sec('Education', eduBody)}
    ${pubBody ? sec('Publications', pubBody) : ''}
  `;
}

async function reAnalyzeJob() {
  const job = jobById(state.activeJobId);
  if (!job) return;
  if (!state.profile) { const ok = await loadProfile(); if (!ok) { showToast('Profile missing.'); return; } }
  const btn = document.getElementById('btn-reanalyze');
  btn.disabled = true; btn.textContent = 'Analyzing…';
  try {
    const result = await runMatchAnalysis(job.title, job.company, job.description);
    if (job.match_result?.match_score != null) {
      job.score_history = job.score_history || [];
      job.score_history.push({ score: job.match_result.match_score, date: new Date().toISOString() });
    }
    job.match_score = result.match_score;
    job.match_result = result;
    await persistJobs();
    renderJobDetailCards(job);
    renderResumeSuggestions(job);
    renderJobsDashboard();
    showToast('Re-analysis complete.');
  } catch (e) {
    showToast(`Re-analysis failed: ${e.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Re-analyze';
  }
}

function renderJD(text) {
  if (!text) return '<span style="color:var(--dim)">No description provided.</span>';
  const lines = text.split('\n');
  let html = '', inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<div class="jd-spacer"></div>';
      continue;
    }
    const isBullet = /^[-•·*]\s+/.test(line) || /^\d+\.\s+/.test(line);
    const firstThree = line.slice(0, 3);
    const isHeader = line.endsWith(':') && line.length < 80 && !/[a-z]/.test(firstThree);
    if (isBullet) {
      if (!inList) { html += '<ul class="jd-list">'; inList = true; }
      html += `<li>${escHtml(line.replace(/^[-•·*]\s+/, '').replace(/^\d+\.\s+/, ''))}</li>`;
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      if (isHeader) html += `<div class="jd-heading">${escHtml(line)}</div>`;
      else html += `<p class="jd-para">${escHtml(line)}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;
}

function scoreColorFor(n) {
  if (n >= 75) return 'var(--green)';
  if (n >= 50) return 'var(--accent)';
  return 'var(--red)';
}

function matchChip(text, color) {
  return `<span class="chip match-chip" style="--chip-color:${color}">${escHtml(String(text))}</span>`;
}

function matchChips(items, color) {
  if (!items?.length) return '<span class="match-none">None identified</span>';
  return items.map(s => matchChip(s, color)).join('');
}

function renderMatchInto(idPrefix, m, label) {
  const score = Math.max(0, Math.min(100, m.match_score || 0));
  const col   = scoreColorFor(score);

  const listHtml = (arr, dotColor) => (arr || []).length
    ? arr.map(s => `<li class="match-list-item"><span class="match-dot" style="background:${dotColor}"></span>${escHtml(String(s))}</li>`).join('')
    : `<li class="match-list-item match-none">None listed</li>`;

  const partials = (m.partial_matches || []);
  const partialHtml = partials.length
    ? partials.map(pm => `
        <div class="partial-match-row">
          ${matchChip(pm.skill || '', 'var(--amber)')}
          <span class="partial-match-reason">${escHtml(pm.reason || pm.bucket || '')}</span>
        </div>`).join('')
    : '';

  const projectsHtml = (m.relevant_projects || []).length
    ? m.relevant_projects.map(pr => `
        <div class="match-project-row">
          <div class="match-project-name">${escHtml(pr.name || '')}</div>
          <div class="match-project-reason">${escHtml(pr.reason || '')}</div>
          ${(pr.talking_points || []).length ? `<ul class="match-project-bullets">${
            pr.talking_points.map(tp => `<li>${escHtml(tp)}</li>`).join('')
          }</ul>` : ''}
        </div>`).join('')
    : '<span class="match-none">None identified</span>';

  document.getElementById(`${idPrefix}-empty`).classList.add('hidden');
  const el = document.getElementById(`${idPrefix}-results`);
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="match-score-row">
      <div class="match-score-ring" style="--score:${score};--c:${col}">
        <span class="match-score-num">${score}</span>
      </div>
      <div class="match-score-meta">
        ${label ? `<div class="match-role-title">${escHtml(label)}</div>` : ''}
        <p class="match-summary">${escHtml(m.summary || '')}</p>
      </div>
    </div>
    ${m.application_strategy ? `
    <div class="match-strategy">
      <span class="match-strategy-icon">&#9654;</span>
      ${escHtml(m.application_strategy)}
    </div>` : ''}
    <div class="match-skills-grid">
      <div class="match-section">
        <div class="match-section-label match-label-green">Matched</div>
        <div class="chips">${matchChips(m.skills_matched, 'var(--green)')}</div>
      </div>
      ${partials.length ? `
      <div class="match-section">
        <div class="match-section-label match-label-amber">Partial</div>
        <div class="partial-matches">${partialHtml}</div>
      </div>` : ''}
      ${(m.required_gaps || []).length ? `
      <div class="match-section">
        <div class="match-section-label match-label-red">Required gaps</div>
        <div class="chips">${matchChips(m.required_gaps, 'var(--red)')}</div>
      </div>` : ''}
      ${(m.nice_to_have_gaps || []).length ? `
      <div class="match-section">
        <div class="match-section-label match-label-dim">Nice-to-have gaps</div>
        <div class="chips">${matchChips(m.nice_to_have_gaps, 'var(--dim)')}</div>
      </div>` : ''}
    </div>
    ${(m.relevant_projects || []).length ? `
    <div class="match-section">
      <div class="match-section-label">Relevant projects &amp; talking points</div>
      <div class="match-projects">${projectsHtml}</div>
    </div>` : ''}
    ${m.relevant_experience ? `
    <div class="match-section">
      <div class="match-section-label">Experience fit</div>
      <p class="match-prose">${escHtml(m.relevant_experience)}</p>
    </div>` : ''}
    ${(m.green_flags || []).length ? `
    <div class="match-section">
      <div class="match-section-label match-label-green">Strengths</div>
      <ul class="match-list">${listHtml(m.green_flags, 'var(--green)')}</ul>
    </div>` : ''}
    ${(m.focus_areas || []).length ? `
    <div class="match-section">
      <div class="match-section-label">To close the gap</div>
      <ul class="match-list">${listHtml(m.focus_areas, 'var(--accent)')}</ul>
    </div>` : ''}
  `;
}

// ── Settings: providers + model ──────────────────────────────────────────────
function openSettings() {
  document.getElementById('settings-dialog').show();
  loadProviders();
}

async function loadProviders() {
  try {
    const data = await bridge.getProviders();
    state.providers.featured = data.featured || [];
    state.providers.connected = data.connected || [];
    renderConnected();
    populateProviderSelect();
    populateModelProviderSelect();
  } catch (e) {
    setAuthStatus('err', 'Failed to load providers');
  }
}

function renderConnected() {
  const el = document.getElementById('connected-list');
  // OpenCode Zen is always connected and needs no key — don't list it as removable.
  const connected = state.providers.connected.filter(id => id !== 'opencode');
  if (!connected.length) {
    el.innerHTML = '<span class="settings-hint">No keyed providers connected yet.</span>';
    return;
  }
  el.innerHTML = connected.map(id => {
    const p = state.providers.featured.find(x => x.id === id);
    return `<div class="provider-tag">
      <span class="provider-dot"></span>
      <span>${escHtml(p ? p.name : id)}</span>
      <button class="provider-tag-remove" data-pid="${escAttr(id)}" title="Disconnect">&times;</button>
    </div>`;
  }).join('');
}

function populateProviderSelect() {
  const sel = document.getElementById('provider-select');
  // Providers that take an API key (exclude the keyless OpenCode Zen).
  const keyed = state.providers.featured.filter(p => p.id !== 'opencode');
  sel.innerHTML = keyed.map(p => {
    const on = state.providers.connected.includes(p.id);
    return `<sl-option value="${escAttr(p.id)}">${escHtml(p.name)}${on ? ' ✓' : ''}</sl-option>`;
  }).join('');
}

function populateModelProviderSelect() {
  const sel = document.getElementById('model-provider');
  // Any connected provider can supply a model — including free OpenCode Zen.
  const usable = state.providers.featured.filter(p => state.providers.connected.includes(p.id));
  sel.innerHTML = '<sl-option value="">— provider —</sl-option>' +
    usable.map(p => `<sl-option value="${escAttr(p.id)}">${escHtml(p.name)}</sl-option>`).join('');
  const modelSel = document.getElementById('model-select');
  modelSel.innerHTML = '<sl-option value="">— pick a provider —</sl-option>';
  modelSel.disabled = true;
  document.getElementById('btn-set-model').disabled = true;
}

function updateModelSelectForProvider(pid) {
  const modelSel = document.getElementById('model-select');
  const btn = document.getElementById('btn-set-model');
  if (!pid) {
    modelSel.innerHTML = '<sl-option value="">— pick a provider —</sl-option>';
    modelSel.disabled = true; btn.disabled = true; return;
  }
  const p = state.providers.featured.find(x => x.id === pid);
  const models = (p && p.models) || [];
  modelSel.innerHTML = '<sl-option value="">— model —</sl-option>' +
    models.map(m => `<sl-option value="${escAttr(m.id)}">${escHtml(m.name || m.id)}</sl-option>`).join('');
  modelSel.disabled = false;
  btn.disabled = true;
}

async function saveKey() {
  const pid = document.getElementById('provider-select').value;
  const input = document.getElementById('api-key');
  const key = input.value.trim();
  if (!pid) { setAuthStatus('err', 'Pick a provider first.'); return; }
  if (!key) { setAuthStatus('err', 'Enter an API key.'); return; }

  const btn = document.getElementById('btn-save-key');
  btn.loading = true;
  setAuthStatus('info', 'Saving key and restarting the engine…');
  try {
    const res = await bridge.saveProviderKey(pid, key);
    if (!res.ok) throw new Error(res.error || 'Unknown error');
    state.port = res.port;          // server restarted on a new port
    input.value = '';
    setAuthStatus('ok', 'Connected.');
    await loadProviders();
  } catch (e) {
    setAuthStatus('err', e.message);
  } finally {
    btn.loading = false;
  }
}

async function removeKey(pid) {
  setAuthStatus('info', 'Removing credentials and restarting…');
  try {
    const res = await bridge.removeProviderKey(pid);
    if (!res.ok) throw new Error(res.error);
    state.port = res.port;
    setAuthStatus('ok', 'Disconnected.');
    await loadProviders();
  } catch (e) {
    setAuthStatus('err', e.message);
  }
}

async function setModel() {
  const pid = document.getElementById('model-provider').value;
  const mid = document.getElementById('model-select').value;
  if (!pid || !mid) { setModelStatus('err', 'Pick both provider and model.'); return; }
  const btn = document.getElementById('btn-set-model');
  btn.loading = true;
  setModelStatus('info', 'Writing config and restarting…');
  try {
    const res = await bridge.setDefaultModel(pid, mid);
    if (!res.ok) throw new Error(res.error);
    state.port = res.port;
    state.defaultModel = res.model;
    setModelStatus('ok', `Model set: ${res.model}`);
    updateModelBadge();
  } catch (e) {
    setModelStatus('err', e.message);
  } finally {
    btn.loading = false;
  }
}

function setAuthStatus(type, msg) {
  const el = document.getElementById('auth-status');
  el.className = `status-text${type ? ` status-${type}` : ''}`;
  el.textContent = msg;
}
function setModelStatus(type, msg) {
  const el = document.getElementById('model-status');
  el.className = `status-text${type ? ` status-${type}` : ''}`;
  el.textContent = msg;
}

function updateModelBadge() {
  const el = document.getElementById('model-badge-text');
  const cur = document.getElementById('current-model');
  const label = state.defaultModel ? state.defaultModel.split('/').pop() : '—';
  if (el) el.textContent = label;
  if (cur) cur.textContent = state.defaultModel || '—';
}

// ── View switching ───────────────────────────────────────────────────────────
function switchView(view) {
  if (view !== 'jobs' && state.browser.port) closeApplicationBrowser();
  document.querySelectorAll('.nav-item').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach(v =>
    v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'jobs') {
    loadJobs().then(() => { renderJobsDashboard(); showJobsSubview('dashboard'); });
  }
  if (view === 'profile') {
    if (state.profile && hasProfileData(state.profile)) renderProfileSections();
    showProfileSubview('main');
  }
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

  // Profile tab — ingest
  document.getElementById('btn-add-info').addEventListener('click', () => showProfileSubview('ingest'));
  document.getElementById('btn-back-from-ingest').addEventListener('click', () => showProfileSubview('main'));
  document.getElementById('paste-text').addEventListener('input', updateGenerateEnabled);
  document.getElementById('btn-generate').addEventListener('click', extractAndMerge);
  document.getElementById('doc-list').addEventListener('click', async e => {
    const del = e.target.closest('.doc-del');
    if (del) { await bridge.workspaceDelete(del.dataset.path); await refreshDocs(); }
  });

  // Profile tab — section edit/save/cancel (event delegation)
  const ps = document.getElementById('profile-sections');
  ps.addEventListener('click', e => {
    if (e.target.closest('.ps-edit-btn'))   { editSection(e.target.closest('[data-section]').dataset.section); return; }
    if (e.target.closest('.ps-save-btn'))   { saveSection(e.target.closest('[data-section]').dataset.section); return; }
    if (e.target.closest('.ps-cancel-btn')) { cancelSection(e.target.closest('[data-section]').dataset.section); return; }
    if (e.target.closest('.skill-chip-remove')) { e.target.closest('.skill-chip-tag').remove(); return; }
    if (e.target.closest('.tag-chip-remove'))   { e.target.closest('.tag-chip-tag').remove(); return; }
    if (e.target.closest('.ps-remove-bucket'))  { e.target.closest('.skill-bucket-edit').remove(); return; }
    if (e.target.closest('.ps-remove-link'))    { e.target.closest('.link-entry').remove(); return; }
    if (e.target.closest('.ps-remove-exp'))     { e.target.closest('.exp-item-edit').remove(); return; }
    if (e.target.closest('.ps-remove-proj'))    { e.target.closest('.proj-item-edit').remove(); return; }
    if (e.target.closest('.ps-remove-highlight')) { e.target.closest('.highlight-row').remove(); return; }
    if (e.target.closest('.ps-remove-edu'))  { e.target.closest('.ps-list-edit-row').remove(); return; }
    if (e.target.closest('.ps-remove-cert')) { e.target.closest('.ps-list-edit-row').remove(); return; }
    if (e.target.closest('.ps-remove-pub'))  { e.target.closest('.ps-list-edit-row').remove(); return; }
    if (e.target.closest('.ps-add-bucket'))  { addNewBucket(); return; }
    if (e.target.closest('.ps-add-link'))    { addLink(); return; }
    if (e.target.closest('.ps-add-exp'))     { addNewExpItem(); return; }
    if (e.target.closest('.ps-add-proj'))    { addNewProjItem(); return; }
    if (e.target.closest('.ps-add-highlight')) {
      const btn = e.target.closest('.ps-add-highlight');
      const editor = btn.previousElementSibling;
      if (editor?.classList.contains('highlights-editor')) addHighlightRow(editor);
      return;
    }
    if (e.target.closest('.ps-add-edu'))  { addSimpleEditRow('edu-editor',  [{key:'degree',placeholder:'Degree'},{key:'institution',placeholder:'Institution'},{key:'year',placeholder:'Year'}]); return; }
    if (e.target.closest('.ps-add-cert')) { addSimpleEditRow('cert-editor', [{key:'name',placeholder:'Certification name'},{key:'issuer',placeholder:'Issuer'},{key:'year',placeholder:'Year'}]); return; }
    if (e.target.closest('.ps-add-pub'))  { addSimpleEditRow('pub-editor',  [{key:'title',placeholder:'Title'},{key:'venue',placeholder:'Venue'},{key:'year',placeholder:'Year'},{key:'url',placeholder:'URL'}]); return; }
  });

  // Enter key: add skill chip or tag chip
  ps.addEventListener('keydown', e => {
    const skillInput = e.target.closest('.skill-add-input');
    if (skillInput && e.key === 'Enter') {
      e.preventDefault();
      const skill = skillInput.value.trim();
      if (skill) { addSkillChip(skillInput.closest('.skill-chips-edit'), skill); skillInput.value = ''; }
      return;
    }
    const tagInput = e.target.closest('.tag-add-input');
    if (tagInput && e.key === 'Enter') {
      e.preventDefault();
      const tag = tagInput.value.trim();
      if (tag) { addTagChip(tagInput.closest('.tag-chips-edit'), tag); tagInput.value = ''; }
    }
  });

  // Sidebar: collapse toggle
  const sidebar = document.getElementById('sidebar');
  const collapseBtn = document.getElementById('btn-sidebar-collapse');
  const COLLAPSED_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/></svg>`;
  const EXPANDED_SVG  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/></svg>`;
  function setSidebarCollapsed(on) {
    sidebar.classList.toggle('collapsed', on);
    collapseBtn.innerHTML = on ? COLLAPSED_SVG : EXPANDED_SVG;
    collapseBtn.title = on ? 'Expand sidebar' : 'Collapse sidebar';
    localStorage.setItem('sidebar-collapsed', on ? '1' : '');
  }
  collapseBtn.addEventListener('click', () => setSidebarCollapsed(!sidebar.classList.contains('collapsed')));
  if (localStorage.getItem('sidebar-collapsed')) setSidebarCollapsed(true);

  // Sidebar: drag-to-resize
  const handle = document.getElementById('sidebar-resize-handle');
  let resizing = false, resizeStartX = 0, resizeStartW = 0;
  handle.addEventListener('mousedown', e => {
    resizing = true;
    resizeStartX = e.clientX;
    resizeStartW = sidebar.getBoundingClientRect().width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!resizing) return;
    const w = Math.max(52, Math.min(400, resizeStartW + e.clientX - resizeStartX));
    document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    if (w > 80 && sidebar.classList.contains('collapsed')) setSidebarCollapsed(false);
    localStorage.setItem('sidebar-w', w);
  });
  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
  const savedW = localStorage.getItem('sidebar-w');
  if (savedW) document.documentElement.style.setProperty('--sidebar-w', parseInt(savedW) + 'px');

  document.getElementById('nav').addEventListener('click', e => {
    const item = e.target.closest('.nav-item');
    if (item && !item.disabled && item.dataset.view) switchView(item.dataset.view);
  });

  // Jobs tab — dashboard
  document.getElementById('btn-add-job').addEventListener('click', openAddJobView);
  document.getElementById('btn-back-from-add').addEventListener('click', () => {
    renderJobsDashboard(); showJobsSubview('dashboard');
  });
  document.getElementById('btn-back-from-detail').addEventListener('click', () => {
    renderJobsDashboard(); showJobsSubview('dashboard');
  });
  document.getElementById('job-cards').addEventListener('click', e => {
    if (e.target.closest('.job-status-select') || e.target.closest('.job-link-icon')) return;
    const card = e.target.closest('.job-card');
    if (card) showJobDetail(card.dataset.id);
  });
  document.getElementById('job-cards').addEventListener('change', e => {
    const sel = e.target.closest('.job-status-select');
    if (sel) updateJobStatus(sel.dataset.id, sel.value);
  });
  document.getElementById('detail-status-select').addEventListener('change', e => {
    updateJobStatus(e.target.dataset.id, e.target.value);
    const statCol = STATUS_COLORS[e.target.value] || 'var(--dim)';
    const badge = document.getElementById('detail-status-badge');
    badge.textContent = STATUS_LABELS[e.target.value] || e.target.value;
    badge.style.setProperty('--status-color', statCol);
  });
  document.getElementById('btn-reanalyze').addEventListener('click', reAnalyzeJob);

  // Job detail — tab strip + all dynamically rendered buttons
  document.getElementById('jobs-detail').addEventListener('click', e => {
    const tab = e.target.closest('.detail-tab');
    if (tab?.dataset.tab) { switchDetailTab(tab.dataset.tab); return; }
    const tabLink = e.target.closest('.detail-tab-link');
    if (tabLink?.dataset.tab) { switchDetailTab(tabLink.dataset.tab); return; }

    if (e.target.closest('#btn-compose-resume'))     { composeResume(); return; }
    if (e.target.closest('#btn-reanalyze-resume'))   { reAnalyzeJob(); return; }
    if (e.target.closest('#btn-export-pdf'))          { exportResumePDF(); return; }
    if (e.target.closest('#btn-export-pdf-app'))      { exportResumePDF(); return; }
    if (e.target.closest('#btn-add-all-profile'))     { addAllSkillsToProfile(); return; }
    if (e.target.closest('#btn-include-all-draft'))   { includeAllInDraft(); return; }
    if (e.target.closest('#btn-open-app-browser'))    { openApplicationBrowser(); return; }
    if (e.target.closest('#btn-focus-browser'))       { focusApplicationBrowser(); return; }
    if (e.target.closest('#btn-close-app-browser'))   { closeApplicationBrowser(); return; }
    if (e.target.closest('#btn-navigate-browser'))    { resetBrowserUrl(); return; }

    const apBtn = e.target.closest('.rsugg-add-profile');
    if (apBtn?.dataset.skill) { addSkillToProfile(apBtn.dataset.skill); return; }
  });

  // Jobs tab — add job form
  document.getElementById('add-job-desc').addEventListener('input', () => {
    document.getElementById('btn-save-job').disabled =
      document.getElementById('add-job-desc').value.trim().length < 10;
  });
  document.getElementById('btn-save-job').addEventListener('click', saveAndAnalyzeJob);

  // Settings
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-settings-close').addEventListener('click',
    () => document.getElementById('settings-dialog').hide());
  document.getElementById('btn-save-key').addEventListener('click', saveKey);
  document.getElementById('btn-set-model').addEventListener('click', setModel);
  document.getElementById('connected-list').addEventListener('click', e => {
    const btn = e.target.closest('.provider-tag-remove');
    if (btn) removeKey(btn.dataset.pid);
  });
  document.getElementById('model-provider').addEventListener('sl-change', e =>
    updateModelSelectForProvider(e.target.value));
  document.getElementById('model-select').addEventListener('sl-change', e =>
    document.getElementById('btn-set-model').disabled = !e.target.value);

  window.addEventListener('resize', () => { scaleResumePage(); updatePaneHeight(); });
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
    state.defaultModel = config.default_model || '';
    document.title = config.app_title || 'Job Search OS';
    const brand = document.querySelector('.brand span');
    if (brand) brand.textContent = config.app_title || 'Job Search OS';
    updateModelBadge();
  } catch (e) {
    showToast('Failed to connect to backend');
    return;
  }

  await refreshDocs();
  const hasProfile = await loadProfile();
  if (hasProfile) renderProfileSections();
  showProfileSubview('main');
}

init();
