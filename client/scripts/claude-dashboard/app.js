/* Claude Code — custom chat + settings UI, wired to the real local router. */
(function () {
  'use strict';

  /* ---------- state ---------- */
  const TOKEN_KEY = 'freellmapi_dashboard_token';
  const PIN_KEY = 'claude_ui_pinned';
  const HEADING_KEY = 'claude_chat_heading_name';
  const BASE = (location.protocol === 'http:' || location.protocol === 'https:')
    ? location.origin.replace(/\/$/, '') : 'http://127.0.0.1:31415';
  let DASH_TOKEN = localStorage.getItem(TOKEN_KEY) || '';
  let UNIFIED_KEY = '';
  let MODELS = [];
  let CONVERSATIONS = [];
  let CURRENT_CHAT = null;
  let CURRENT_MESSAGES = [];
  let ONLINE = false;
  let KEYS = [], KEY_PROVIDERS = [], HEALTH_INFO = null, FALLBACK_ROWS = [], ROUTING_INFO = null;
  let UNIFIED_REVEALED = false;
  let PINNED = [];
  try { PINNED = JSON.parse(localStorage.getItem(PIN_KEY) || '[]'); } catch (e) { PINNED = []; }
  let PENDING_FILES = [];
  let SENDING = false;
  document.title = 'Claude Code';

  const COPY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const RELOAD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';
  const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>';

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  /* Chat heading name: used ONLY by the heading above a brand-new chat.
     Sidebar brand, document title, top title and the embedded dashboard
     never read this key, so renaming cannot leak anywhere else. */
  function chatHeadingName() {
    return (localStorage.getItem(HEADING_KEY) || '').trim() || 'Claude';
  }

  /* Claude-style short title: the first thing the user actually said. */
  function makeTitle(text) {
    let line = String(text || '').split('\n').map(s => s.trim()).find(Boolean) || '';
    let t = line.replace(/\s+/g, ' ').trim();
    t = t.replace(/^(have|has|had)\s+(a|an|the)\s+/i, '').replace(/^(a|an|the)\s+/i, '');
    if (t.length > 40) t = t.slice(0, 39).trimEnd() + '…';
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'New chat';
  }

  /* ---------- attachments (same rules as the original Playground) ---------- */
  const ATT = { MAX: 5, IMG_EDGE: 1024, IMG_BYTES: 1200000, IMG_TOTAL: 3000000, TXT_BYTES: 128000 };
  const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const TEXT_EXTS = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log'];
  function fileExt(n) { const i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(i + 1).toLowerCase(); }
  function classifyFile(f) {
    const type = (f.type || '').toLowerCase(), ext = fileExt(f.name);
    if (IMAGE_MIMES.includes(type)) return 'image';
    if (TEXT_EXTS.includes(ext)) return 'text';
    if (!type && !ext) return null;
    if (type.startsWith('text/') || type === 'application/json') return 'text';
    return null;
  }
  function dataUrlBytes(u) { const i = u.indexOf(','); return Math.floor(((i < 0 ? u : u.slice(i + 1)).length * 3) / 4); }
  function fitWithin(w, h) { const m = Math.max(w, h); if (m <= ATT.IMG_EDGE) return { width: w, height: h }; const s = ATT.IMG_EDGE / m; return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) }; }
  async function readImageAttachment(file) {
    let bitmap = null, objectUrl = '';
    try {
      if (window.createImageBitmap) { bitmap = await createImageBitmap(file); }
      else {
        objectUrl = URL.createObjectURL(file);
        bitmap = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('unreadable')); im.src = objectUrl; });
      }
    } catch (e) { if (objectUrl) URL.revokeObjectURL(objectUrl); throw new Error('unreadable'); }
    const w = bitmap.width || bitmap.naturalWidth, h = bitmap.height || bitmap.naturalHeight;
    const { width, height } = fitWithin(w, h);
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close?.(); if (objectUrl) URL.revokeObjectURL(objectUrl); throw new Error('unreadable'); }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.(); if (objectUrl) URL.revokeObjectURL(objectUrl);
    const src = (file.type || '').toLowerCase();
    const attempts = (src === 'image/png' || src === 'image/webp') ? [['image/png', undefined], ['image/jpeg', .82], ['image/jpeg', .6]] : [['image/jpeg', .82], ['image/jpeg', .6]];
    for (const [type, q] of attempts) { const url = q === undefined ? canvas.toDataURL(type) : canvas.toDataURL(type, q); if (dataUrlBytes(url) <= ATT.IMG_BYTES) return url; }
    throw new Error('too-large');
  }
  async function readTextAttachment(file) { if (file.size > ATT.TXT_BYTES) throw new Error('too-large'); return await file.text(); }
  function fenceLanguage(name) { return { md: 'markdown', markdown: 'markdown', json: 'json', csv: 'csv', tsv: 'tsv' }[fileExt(name)] || 'text'; }
  function inlineTextAttachment(name, text) {
    let run = 0, max = 0; for (const m of String(text).matchAll(/`+/g)) { run = m[0].length; if (run > max) max = run; }
    const fence = '`'.repeat(Math.max(3, max + 1));
    return name + ':\n' + fence + fenceLanguage(name) + '\n' + String(text).replace(/\s+$/, '') + '\n' + fence;
  }
  function composeText(text, atts) {
    return [String(text || '').trim(), ...(atts || []).filter(a => a.kind === 'text').map(a => inlineTextAttachment(a.name, a.text || ''))].filter(Boolean).join('\n\n');
  }
  function attachmentImages(atts) { return (atts || []).filter(a => a.kind === 'image' && a.dataUrl).map(a => a.dataUrl); }
  function toMessageContent(text, images) {
    if (!images || !images.length) return text;
    return [...(text ? [{ type: 'text', text }] : []), ...images.map(url => ({ type: 'image_url', image_url: { url } }))];
  }
  function renderAttachments() {
    const box = document.getElementById('attachments'); if (!box) return;
    box.innerHTML = PENDING_FILES.map(a => {
      const thumb = a.kind === 'image' ? '<img src="' + a.dataUrl + '" alt="">' : '';
      return '<span class="att" title="' + esc(a.name) + '">' + thumb + esc(a.name) + '<b data-remove="' + esc(a.id) + '" title="Remove">×</b></span>';
    }).join('');
  }
  async function addFiles(list) {
    const files = [...(list || [])]; if (!files.length) return;
    const accepted = [];
    let bytes = PENDING_FILES.filter(a => a.kind === 'image').reduce((s, a) => s + dataUrlBytes(a.dataUrl || ''), 0);
    for (const f of files) {
      if (PENDING_FILES.length + accepted.length >= ATT.MAX) { alert('Ek message me max ' + ATT.MAX + ' files attach ho sakte hain.'); break; }
      const kind = classifyFile(f);
      if (!kind) { alert('Unsupported file: ' + f.name + '\nSirf images aur txt/md/csv/json/log attach hote hain.'); continue; }
      try {
        if (kind === 'image') {
          const dataUrl = await readImageAttachment(f);
          if (bytes + dataUrlBytes(dataUrl) > ATT.IMG_TOTAL) { alert('Image size limit ho gaya: ' + f.name); continue; }
          bytes += dataUrlBytes(dataUrl);
          accepted.push({ id: Date.now() + '-' + accepted.length + '-' + Math.random().toString(36).slice(2), kind, name: f.name, dataUrl });
        } else {
          accepted.push({ id: Date.now() + '-' + accepted.length + '-' + Math.random().toString(36).slice(2), kind, name: f.name, text: await readTextAttachment(f) });
        }
      } catch (e) { alert((e.message === 'too-large' ? 'File bahut bada hai: ' : 'File padhi nahi ja saki: ') + f.name); }
    }
    PENDING_FILES.push(...accepted); renderAttachments();
    document.getElementById('fileInput').value = '';
  }

  /* ---------- mic: inline amplitude layer + live transcript ---------- */
  let TRANSCRIBE_MODEL = 'auto', RECORDER = null, REC_CHUNKS = [], REC_STREAM = null, REC_TIMER = null;
  let SPEECH = null, REC_BASE = '', REC_TEXT = '', SPEECH_FINAL = '', SPEECH_INTERIM = '', MIC_BUSY = false;
  let MIC_ACTIVE = false, LEVEL_CTX = null, LEVEL_SRC = null, LEVEL_ANALYSER = null, LEVEL_RAF = 0;
  const LEVEL_BARS = [];

  async function loadTranscriptionModel() {
    try {
      const d = await api('/api/media');
      const ok = (d.models || []).filter(m => m.modality === 'transcription' && m.enabled !== false && (m.keyCount || 0) > 0);
      if (ok.length) TRANSCRIBE_MODEL = ok[0].modelId || 'auto';
    } catch (e) { /* keep auto */ }
  }
  function micUI(active) {
    const level = document.getElementById('micLevel');
    if (level) level.classList.toggle('on', !!active);
    const btn = document.getElementById('micBtn');
    btn.classList.toggle('on', !!active);
    btn.title = active ? 'Recording — click to stop' : 'Speak';
  }
  function startLevel(stream) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const level = document.getElementById('micLevel');
    if (!Ctx || !level) return;
    if (!LEVEL_BARS.length) LEVEL_BARS.push(...level.querySelectorAll('i'));
    try {
      LEVEL_CTX = new Ctx();
      if (LEVEL_CTX.state === 'suspended') LEVEL_CTX.resume();
      LEVEL_SRC = LEVEL_CTX.createMediaStreamSource(stream);
      LEVEL_ANALYSER = LEVEL_CTX.createAnalyser();
      LEVEL_ANALYSER.fftSize = 512;
      LEVEL_ANALYSER.smoothingTimeConstant = .7;
      LEVEL_SRC.connect(LEVEL_ANALYSER);
      const data = new Uint8Array(LEVEL_ANALYSER.fftSize);
      const shape = [4, 7, 10, 14, 10, 7, 4];
      const tick = () => {
        if (!MIC_ACTIVE || !LEVEL_ANALYSER) return;
        LEVEL_ANALYSER.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / data.length);
        const amp = Math.min(1, rms * 7.5);
        LEVEL_BARS.forEach((bar, i) => {
          const h = Math.max(3, Math.round((shape[i] || 6) * (.42 + amp * 1.75)));
          bar.style.height = h + 'px';
          bar.style.opacity = String(.45 + amp * .55);
        });
        level.style.setProperty('--lift', (-amp * 3).toFixed(1) + 'px');
        level.style.setProperty('--wide', (1 + amp * .18).toFixed(2));
        LEVEL_RAF = requestAnimationFrame(tick);
      };
      level.classList.add('on');
      tick();
    } catch (e) { level.classList.remove('on'); }
  }
  function stopLevel() {
    MIC_ACTIVE = false;
    if (LEVEL_RAF) { cancelAnimationFrame(LEVEL_RAF); LEVEL_RAF = 0; }
    try { LEVEL_SRC && LEVEL_SRC.disconnect(); } catch (e) { }
    try { LEVEL_ANALYSER && LEVEL_ANALYSER.disconnect(); } catch (e) { }
    try { LEVEL_CTX && LEVEL_CTX.close(); } catch (e) { }
    LEVEL_CTX = LEVEL_SRC = LEVEL_ANALYSER = null;
    LEVEL_BARS.forEach(bar => { bar.style.height = '4px'; bar.style.opacity = '1'; });
    const level = document.getElementById('micLevel');
    if (level) { level.classList.remove('on'); level.style.removeProperty('--lift'); level.style.removeProperty('--wide'); }
  }
  function liveText() {
    const speech = (SPEECH_FINAL + (SPEECH_INTERIM ? (SPEECH_FINAL ? ' ' : '') + SPEECH_INTERIM : '')).trim();
    return (REC_TEXT || speech).trim();
  }
  function composeLive() {
    const t = liveText();
    const inp = document.getElementById('inp');
    inp.value = (REC_BASE ? REC_BASE.replace(/\s+$/, '') + ' ' : '') + t;
    micUI(true);
  }
  function startSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    try {
      SPEECH = new SR();
      SPEECH.continuous = true;
      SPEECH.interimResults = true;
      SPEECH.lang = (navigator.language || 'en-US').toLowerCase().startsWith('hi') ? 'hi-IN' : 'en-US';
      SPEECH.onresult = e => {
        let fin = SPEECH_FINAL, inter = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) fin += (fin ? ' ' : '') + r[0].transcript;
          else inter += (inter ? ' ' : '') + r[0].transcript;
        }
        SPEECH_FINAL = fin.trim(); SPEECH_INTERIM = inter.trim();
        REC_TEXT = '';
        composeLive();
      };
      SPEECH.onerror = () => { SPEECH = null; };
      SPEECH.onend = () => { SPEECH = null; };
      SPEECH.start();
    } catch (e) { SPEECH = null; }
  }
  function recFilename(type) {
    if (type.startsWith('audio/mp4')) return 'dictation.m4a';
    if (type.startsWith('audio/ogg')) return 'dictation.ogg';
    return 'dictation.webm';
  }
  async function transcribeChunks() {
    if (MIC_BUSY || !REC_CHUNKS.length) return;
    MIC_BUSY = true;
    try {
      const blob = new Blob(REC_CHUNKS, { type: (RECORDER && RECORDER.mimeType) || 'audio/webm' });
      if (!blob.size) return;
      const form = new FormData();
      form.append('file', blob, recFilename(blob.type));
      form.append('model', TRANSCRIBE_MODEL || 'auto');
      form.append('response_format', 'json');
      const r = await fetch(BASE + '/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + UNIFIED_KEY }, body: form });
      if (!r.ok) {
        let msg = 'HTTP ' + r.status;
        try { const e = await r.json(); msg = (e && e.error && e.error.message) || msg; } catch (_) { }
        console.warn('[dictation] failed:', msg);
        return;
      }
      const j = await r.json();
      const text = String(j.text || '').trim();
      if (text) { REC_TEXT = text; composeLive(); }
    } catch (e) { console.warn('[dictation] error:', e); }
    finally { MIC_BUSY = false; }
  }
  async function finalizeMic() {
    let tries = 0;
    while (MIC_BUSY && tries++ < 25) await new Promise(r => setTimeout(r, 200));
    await transcribeChunks();
    const t = liveText();
    if (t) {
      const inp = document.getElementById('inp');
      inp.value = (REC_BASE ? REC_BASE.replace(/\s+$/, '') + ' ' : '') + t;
      inp.focus();
    }
    REC_CHUNKS = []; REC_TEXT = ''; SPEECH_FINAL = ''; SPEECH_INTERIM = ''; REC_BASE = '';
    stopLevel();
    micUI(false);
  }
  function stopMic() {
    if (REC_TIMER) { clearInterval(REC_TIMER); REC_TIMER = null; }
    if (SPEECH) { try { SPEECH.stop(); } catch (e) { } SPEECH = null; }
    micUI(false);
    if (RECORDER && RECORDER.state !== 'inactive') RECORDER.stop();
    else finalizeMic();
  }
  async function startMic() {
    MIC_ACTIVE = true;
    REC_BASE = document.getElementById('inp').value;
    REC_CHUNKS = []; REC_TEXT = ''; SPEECH_FINAL = ''; SPEECH_INTERIM = '';
    micUI(true);
    if (!UNIFIED_KEY) { try { await loadUnifiedKey(); } catch (e) { } }
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(s => {
      if (!MIC_ACTIVE) { try { s.getTracks().forEach(t => t.stop()); } catch (e) { } return; }
      REC_STREAM = s;
      startLevel(s);
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t));
      try { RECORDER = new MediaRecorder(s, mime ? { mimeType: mime } : undefined); }
      catch (e) { try { s.getTracks().forEach(t => t.stop()); } catch (e2) { } return; }
      RECORDER.ondataavailable = e => { if (e.data && e.data.size) REC_CHUNKS.push(e.data); };
      RECORDER.onstop = () => {
        try { REC_STREAM && REC_STREAM.getTracks().forEach(t => t.stop()); } catch (e) { }
        RECORDER = null; REC_STREAM = null;
        finalizeMic();
      };
      RECORDER.start(1000);
      REC_TIMER = setInterval(() => transcribeChunks(), 2500);
    }).catch(() => {
      if (MIC_ACTIVE) stopMic();
    });
  }
  function toggleMic() { if (MIC_ACTIVE) stopMic(); else startMic(); }
  function scrollThread() { const t = document.getElementById('thread'); t.scrollTop = t.scrollHeight; }

  /* ---------- network ---------- */
  async function api(path, opts = {}) {
    const h = new Headers(opts.headers || {});
    if (!h.has('Content-Type') && !(opts.body instanceof FormData)) h.set('Content-Type', 'application/json');
    if (DASH_TOKEN) h.set('Authorization', 'Bearer ' + DASH_TOKEN);
    const r = await fetch(BASE + path, { ...opts, headers: h });
    if (r.status === 401) {
      let type = ''; try { type = (await r.clone().json()).error?.type || ''; } catch (e) { }
      if (type === 'authentication_error') { DASH_TOKEN = ''; localStorage.removeItem(TOKEN_KEY); }
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.status === 204 ? null : r.json();
  }
  async function infer(path, opts = {}) {
    const h = new Headers(opts.headers || {});
    h.set('Content-Type', 'application/json');
    if (UNIFIED_KEY) h.set('Authorization', 'Bearer ' + UNIFIED_KEY);
    return fetch(BASE + path, { ...opts, headers: h });
  }
  function setConn(state, title, sub) {
    document.getElementById('connTitle').textContent = title;
    document.getElementById('connSub').textContent = sub || BASE;
    const chip = document.getElementById('connChip');
    chip.textContent = state === 'ok' ? 'Connected' : state === 'off' ? 'Offline' : '…';
    chip.className = 'chip' + (state === 'ok' ? ' acc' : '');
  }

  /* ---------- boot ---------- */
  async function bootstrap() {
    renderAttachments();
    setConn('…', 'Local server se connect ho raha hai…', BASE);
    try {
      const st = await api('/api/auth/status');
      if (!st.authenticated) {
        if (st.desktop) {
          const s = await api('/api/auth/desktop-session', { method: 'POST' });
          DASH_TOKEN = s.token; localStorage.setItem(TOKEN_KEY, s.token);
        } else { showLogin(); return; }
      }
      await api('/api/ping');
      ONLINE = true;
      setConn('ok', 'Connected · ' + (st.email || 'local desktop'), BASE);
      try { const uk = await api('/api/settings/api-key'); UNIFIED_KEY = uk.apiKey || ''; } catch (e) { }
      await Promise.allSettled([loadProviders(), loadModels(), loadConversations(), loadTranscriptionModel()]);
    } catch (e) {
      ONLINE = false;
      setConn('off', 'Server offline — local app chal rahi hai?', BASE);
      document.getElementById('footText').textContent = 'server offline';
      renderModels([]); renderProviders([], []); renderChats();
    }
  }
  function showLogin() {
    setConn('off', 'Dashboard login zaroori', 'Server install ke liye email/password se login karein');
    document.getElementById('connRow').insertAdjacentHTML('beforeend',
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">' +
      '<input id="lgEmail" placeholder="email" style="border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:7px;padding:6px 9px;font-size:12px">' +
      '<input id="lgPass" type="password" placeholder="password" style="border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:7px;padding:6px 9px;font-size:12px">' +
      '<button class="btn" id="lgBtn">Login</button></div>');
  }
  async function doLogin() {
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: document.getElementById('lgEmail').value, password: document.getElementById('lgPass').value }) });
      DASH_TOKEN = r.token; localStorage.setItem(TOKEN_KEY, r.token);
      document.getElementById('connRow').querySelector('div:last-child')?.remove();
      bootstrap();
    } catch (e) { setConn('off', 'Login failed — dobara try karein', e.message); }
  }

  /* ---------- real providers ---------- */
  async function loadProviders() {
    const [pr, kr] = await Promise.allSettled([api('/api/keys/providers'), api('/api/keys')]);
    const provs = pr.status === 'fulfilled' ? (pr.value.providers || []) : [];
    const keys = kr.status === 'fulfilled' ? (kr.value || []) : [];
    const configured = provs.filter(p => p.configured);
    renderProviders(configured, keys);
    document.getElementById('footText').textContent = configured.length + ' providers connected';
  }
  function renderProviders(provs) {
    /* Chat sidebar only needs the count. Full provider/key controls live in
       the Claude-style Settings card and use their own DOM ids. */
    document.getElementById('footText').textContent = (provs || []).length + ' providers connected';
  }

  /* ---------- real runnable models ---------- */
  async function loadModels() {
    const [adminRes, v1Res] = await Promise.allSettled([
      api('/api/models'),
      UNIFIED_KEY ? infer('/v1/models?available=true').then(r => r.ok ? r.json() : null) : Promise.resolve(null)
    ]);
    const admin = adminRes.status === 'fulfilled' ? (adminRes.value || []) : [];
    const v1 = v1Res.status === 'fulfilled' && v1Res.value ? (v1Res.value.data || []) : [];
    const byId = {}; admin.forEach(m => { if (m.modelId) byId[m.modelId] = m; if (m.qualifiedModelId) byId[m.qualifiedModelId] = m; });
    if (v1.length) {
      MODELS = v1.filter(m => (m.execution_status || m.executionStatus) === 'ready').map(m => {
        const meta = byId[m.id] || {};
        return { id: m.id, name: meta.displayName || m.name || m.id, p: meta.platform || 'connected' };
      });
    } else {
      MODELS = admin.filter(m => m.enabled !== false && (m.keyCount || 0) > 0).map(m => ({
        id: m.qualifiedModelId || m.modelId || String(m.id),
        name: m.displayName || m.modelId || 'model',
        p: m.platform || 'connected'
      }));
    }
    renderModels();
  }

  /* ---------- real conversations ---------- */
  async function loadConversations() {
    try { CONVERSATIONS = await api('/api/conversations'); } catch (e) { CONVERSATIONS = []; }
    renderChats();
  }
  function renderChats() {
    const list = document.getElementById('chatList'), sec = document.getElementById('chatSec');
    if (!CONVERSATIONS.length) { list.innerHTML = ''; sec.style.display = 'none'; return; }
    sec.style.display = '';
    const sorted = [...CONVERSATIONS].sort((a, b) => (PINNED.includes(b.id) ? 1 : 0) - (PINNED.includes(a.id) ? 1 : 0));
    list.innerHTML = sorted.map(c => {
      const pinned = PINNED.includes(c.id);
      return '<div class="chat-line' + (c.id === CURRENT_CHAT ? ' active' : '') + (pinned ? ' pinned' : '') + '" data-line="' + c.id + '">' +
        '<div class="chat-item" data-id="' + c.id + '" title="' + esc(c.title || 'New chat') + '">' + esc(c.title || 'New chat') + '</div>' +
        '<div class="chat-acts">' +
        '<button data-act="pin" data-id="' + c.id + '" class="' + (pinned ? 'pinned' : '') + '" title="' + (pinned ? 'Unpin' : 'Pin') + '">📌</button>' +
        '<button data-act="rename" data-id="' + c.id + '" title="Rename">✎</button>' +
        '<button data-act="delete" data-id="' + c.id + '" title="Delete">🗑</button>' +
        '</div></div>';
    }).join('');
  }
  function togglePin(id) {
    id = Number(id);
    if (PINNED.includes(id)) PINNED = PINNED.filter(x => x !== id);
    else {
      if (PINNED.length >= 5) { alert('Sirf 5 chats pin ho sakti hain.'); return; }
      PINNED.push(id);
    }
    localStorage.setItem(PIN_KEY, JSON.stringify(PINNED)); renderChats();
  }
  function renameChat(id) {
    const line = document.querySelector('.chat-line[data-line="' + id + '"]');
    const item = line && line.querySelector('.chat-item'); if (!item) return;
    const c = CONVERSATIONS.find(x => x.id === Number(id)); if (!c) return;
    const inp = document.createElement('input'); inp.className = 'chat-rename'; inp.value = c.title || 'New chat';
    item.replaceWith(inp); inp.focus(); inp.select();
    const done = async (save) => {
      if (save) {
        const v = inp.value.trim();
        if (v && v !== c.title) { try { await api('/api/conversations/' + id, { method: 'PUT', body: JSON.stringify({ title: v }) }); c.title = v; } catch (e) { } }
      }
      await loadConversations();
    };
    let finished = false;
    const finish = async (save) => { if (finished) return; finished = true; await done(save); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
    inp.addEventListener('blur', () => { if (inp.isConnected) finish(true); }, { once: true });
  }
  async function deleteChat(id) {
    const c = CONVERSATIONS.find(x => x.id === Number(id));
    if (!confirm('Delete chat "' + (c ? c.title : '') + '"?')) return;
    try {
      await api('/api/conversations/' + id, { method: 'DELETE' });
      PINNED = PINNED.filter(x => x !== Number(id)); localStorage.setItem(PIN_KEY, JSON.stringify(PINNED));
      if (CURRENT_CHAT === Number(id)) newChat();
      await loadConversations();
    } catch (e) { alert('Delete nahi ho paya: ' + e.message); }
  }

  /* ---------- messages + Claude-style actions ---------- */
  function actionBar(index) {
    const bar = document.createElement('div'); bar.className = 'msg-acts';
    bar.innerHTML =
      '<button type="button" data-act="copy" data-i="' + index + '" title="Copy" aria-label="Copy">' + COPY_SVG + '</button>' +
      '<button type="button" data-act="reload" data-i="' + index + '" title="Regenerate" aria-label="Regenerate">' + RELOAD_SVG + '</button>';
    return bar;
  }
  function renderUserBubble(content, images, parent, index) {
    const wrap = document.createElement('div'); wrap.className = 'msg-user';
    const u = document.createElement('div'); u.className = 'u';
    (images || []).forEach(src => { const im = document.createElement('img'); im.className = 'att-img'; im.src = src; im.alt = 'attachment'; u.appendChild(im); });
    const t = document.createElement('div'); t.textContent = content || ''; u.appendChild(t);
    wrap.appendChild(u); wrap.appendChild(actionBar(index)); parent.appendChild(wrap);
    return wrap;
  }
  function renderAssistant(content, parent, index) {
    const a = document.createElement('div'); a.className = 'a';
    const b = document.createElement('div'); b.className = 'body';
    const p = document.createElement('p'); p.textContent = content || '';
    b.appendChild(p); a.appendChild(b); a.appendChild(actionBar(index));
    parent.appendChild(a); return a;
  }
  function renderThread() {
    const th = document.getElementById('thIn');
    th.classList.remove('empty-mode'); th.innerHTML = '';
    if (!CURRENT_MESSAGES.length) { emptyState(); return; }
    CURRENT_MESSAGES.forEach((m, i) => {
      if (m.role === 'user') renderUserBubble(m.content, m.images, th, i);
      else renderAssistant(m.content, th, i);
    });
    scrollThread();
  }
  async function openChat(id) {
    try {
      const c = await api('/api/conversations/' + id);
      CURRENT_CHAT = id;
      PENDING_FILES = []; renderAttachments();
      CURRENT_MESSAGES = (c.messages || []).map(m => ({ role: m.role, content: m.content, images: m.images || undefined }));
      document.getElementById('topTitle').textContent = c.title || 'Chat';
      document.title = 'Claude Code';
      document.getElementById('setItem').classList.remove('active');
      view('chat'); renderThread(); renderChats();
    } catch (e) { }
  }
  async function copyMessage(text, btn) {
    let done = false;
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); done = true; } } catch (e) { }
    if (!done) {
      try {
        const ta = document.createElement('textarea'); ta.value = text;
        ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.pointerEvents = 'none';
        document.body.appendChild(ta); ta.focus(); ta.select();
        done = document.execCommand('copy'); ta.remove();
      } catch (e) { }
    }
    if (!done) return;
    btn.innerHTML = CHECK_SVG; btn.classList.add('ok');
    window.setTimeout(() => { btn.innerHTML = COPY_SVG; btn.classList.remove('ok'); }, 1400);
  }
  async function regenerate(i) {
    if (SENDING) return;
    i = Number(i);
    const msg = CURRENT_MESSAGES[i]; if (!msg) return;
    let userIndex = i;
    if (msg.role !== 'user') {
      userIndex = -1;
      for (let k = i - 1; k >= 0; k--) { if (CURRENT_MESSAGES[k].role === 'user') { userIndex = k; break; } }
      if (userIndex < 0) return;
    }
    const insertAt = msg.role === 'user' ? i + 1 : i;
    if (msg.role === 'assistant') CURRENT_MESSAGES.splice(i, 1);
    await persistChat();
    renderThread();
    await streamReply(userIndex, insertAt);
  }

  /* ---------- UI helpers ---------- */
  let CURRENT_MODEL_ID = 'auto';
  function toggleSide() { document.body.classList.toggle('collapsed'); }
  function tog(b) { b.classList.toggle('on'); }
  function setTheme(mode, btn) {
    document.documentElement.classList.toggle('dark', mode === 'dark');
    document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
  }
  function accent(a, b, c, el) {
    document.documentElement.style.setProperty('--accent', a);
    document.documentElement.style.setProperty('--accent-2', b);
    document.documentElement.style.setProperty('--accent-soft', c);
    document.querySelectorAll('.sw').forEach(s => s.classList.remove('sel')); el.classList.add('sel');
  }
  function showCat(cat, btn) {
    document.querySelectorAll('.cat').forEach(c => c.classList.remove('on'));
    btn.classList.add('on');
    document.querySelectorAll('.card').forEach(card => {
      const show = cat === 'all' || card.dataset.cat === cat;
      card.classList.toggle('hide', !show);
      card.classList.remove('show');
      if (show) { void card.offsetWidth; card.classList.add('show'); }
    });
  }
  function view(id) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('on'));
    document.getElementById('v-' + id).classList.add('on');
  }
  /* ---------- settings: real controls inside the Claude-style dashboard ---------- */
  function chip(text, kind) {
    return '<span class="chip' + (kind ? ' ' + kind : '') + '">' + esc(text || '—') + '</span>';
  }
  function maskSecret(s) {
    s = String(s || '');
    if (!s) return '—';
    return s.length <= 12 ? s.slice(0, 2) + '••••' + s.slice(-2) : s.slice(0, 7) + '••••' + s.slice(-4);
  }
  function statusKind(s) {
    s = String(s || '').toLowerCase();
    if (s === 'healthy' || s === 'ok' || s === 'active') return 'acc';
    if (s === 'unknown' || s === 'unchecked') return 'warn';
    if (s === 'invalid' || s === 'error' || s === 'rate_limited') return 'bad';
    return '';
  }
  function flashBtn(btn, msg) {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = msg; btn.disabled = true;
    window.setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1300);
  }
  function settingsError(e) { alert('Kaam nahi hua: ' + (e && e.message ? e.message : e)); }

  async function loadKeySettings() {
    const [kr, pr, hr] = await Promise.allSettled([
      api('/api/keys'), api('/api/keys/providers'), api('/api/health')
    ]);
    KEYS = kr.status === 'fulfilled' && Array.isArray(kr.value) ? kr.value : [];
    KEY_PROVIDERS = pr.status === 'fulfilled' && pr.value && Array.isArray(pr.value.providers) ? pr.value.providers : [];
    HEALTH_INFO = hr.status === 'fulfilled' ? hr.value : null;
    renderProviderOptions();
    renderKeyRows();
  }
  function renderProviderOptions() {
    const sel = document.getElementById('newKeyPlatform');
    if (!sel) return;
    const cur = sel.value;
    const list = KEY_PROVIDERS.length ? KEY_PROVIDERS : [{ platform: 'openrouter', name: 'OpenRouter', keyless: false }];
    sel.innerHTML = list.map(p =>
      '<option value="' + esc(p.platform) + '">' + esc(p.name || p.platform) + (p.keyless ? ' (keyless)' : '') + '</option>'
    ).join('');
    if (cur && Array.from(sel.options).some(o => o.value === cur)) sel.value = cur;
    updateKeyHint();
  }
  function updateKeyHint() {
    const sel = document.getElementById('newKeyPlatform'), hint = document.getElementById('keyFormHint');
    if (!sel || !hint) return;
    const p = KEY_PROVIDERS.find(x => x.platform === sel.value);
    hint.textContent = p && p.keyless
      ? 'Ye provider keyless hai — key khodi kar add karein.'
      : 'Key encrypt karke aapke local SQLite me store hogi.';
  }
  function renderKeyRows() {
    const box = document.getElementById('settingsProviderRows');
    if (!box) return;
    const healthKeys = (HEALTH_INFO && Array.isArray(HEALTH_INFO.keys)) ? HEALTH_INFO.keys : [];
    const byKey = new Map(healthKeys.map(k => [String(k.id), k]));
    const groups = new Map();
    KEY_PROVIDERS.forEach(p => groups.set(p.platform, { platform: p.platform, name: p.name || p.platform, keys: [], meta: p }));
    KEYS.forEach(k => {
      if (!groups.has(k.platform)) groups.set(k.platform, { platform: k.platform, name: k.platform, keys: [], meta: {} });
      groups.get(k.platform).keys.push(k);
    });
    const html = Array.from(groups.values())
      .filter(g => g.keys.length || g.meta.configured)
      .map(g => {
        const allOn = g.keys.length > 0 && g.keys.every(k => k.enabled !== false);
        const head = '<div class="group-head"><div class="live-main"><b>' + esc(g.name) + '</b><small>' +
          esc(g.keys.length + ' key' + (g.keys.length === 1 ? '' : 's') + (g.meta.kind ? ' · ' + g.meta.kind : '')) + '</small></div>' +
          (g.keys.length ? '<button class="toggle live-toggle' + (allOn ? ' on' : '') + '" data-act="platform-toggle" data-platform="' + esc(g.platform) + '" title="Toggle provider"><i></i></button>' : '') +
          '</div>';
        const rows = g.keys.map(k => {
          const h = byKey.get(String(k.id)) || {};
          const status = h.status || k.status || 'unknown';
          return '<div class="live-row"><div class="live-main"><b>' + esc(k.label || k.platform) + '</b><small>' +
            esc(k.maskedKey || maskSecret(k.key) || 'keyless') + ' · status: ' + esc(status) + '</small></div>' +
            chip(status, statusKind(status)) +
            '<button class="toggle live-toggle' + (k.enabled !== false ? ' on' : '') + '" data-act="key-toggle" data-id="' + esc(k.id) + '" title="Enable / disable key"><i></i></button>' +
            '<button class="icon-btn danger" data-act="key-delete" data-id="' + esc(k.id) + '" title="Delete key">×</button></div>';
        }).join('');
        return head + rows;
      }).join('');
    box.innerHTML = html || '<div class="row"><div><b>Koi provider configured nahi</b><small>Upar se key add karein</small></div></div>';
    const tags = document.getElementById('settingsProviderTags');
    if (tags) tags.innerHTML = groups.size ? Array.from(groups.values()).map(g => '<span>' + esc(g.name) + '</span>').join('') : '';
  }
  async function addProviderKey(btn) {
    const platform = document.getElementById('newKeyPlatform').value;
    const key = document.getElementById('newKeyValue').value.trim();
    const label = document.getElementById('newKeyLabel').value.trim();
    if (!platform) return alert('Pehle provider chhuno.');
    const meta = KEY_PROVIDERS.find(p => p.platform === platform);
    if (!key && !(meta && meta.keyless)) return alert('API key daalein.');
    try {
      flashBtn(btn, 'Adding…');
      const body = { platform, key, label: label || undefined };
      await api('/api/keys', { method: 'POST', body: JSON.stringify(body) });
      document.getElementById('newKeyValue').value = '';
      document.getElementById('newKeyLabel').value = '';
      await loadKeySettings();
    } catch (e) { settingsError(e); } finally { flashBtn(btn, 'Add key'); }
  }
  function parseModelList(raw) {
    const seen = new Set();
    return String(raw || '').split(/[\n,]+/).map(s => s.trim()).filter(s => s && !seen.has(s) && seen.add(s));
  }
  async function addCustomProvider(btn) {
    const type = document.getElementById('customType').value;
    const baseUrl = document.getElementById('customBaseUrl').value.trim();
    const label = document.getElementById('customLabel').value.trim();
    const apiKey = document.getElementById('customApiKey').value.trim();
    const models = parseModelList(document.getElementById('customModels').value);
    if (!baseUrl) return alert('Base URL daalein.');
    if (!models.length) return alert('Kam se kam ek model id daalein.');
    const body = type === 'chat'
      ? { baseUrl, models, displayName: label || undefined, apiKey: apiKey || undefined, supportsTools: true, supportsVision: false }
      : type === 'embedding'
        ? { baseUrl, model: models[0], displayName: label || undefined, apiKey: apiKey || undefined }
        : { baseUrl, model: models[0], displayName: label || undefined, apiKey: apiKey || undefined, modality: type };
    const path = type === 'chat' ? '/api/keys/custom' : type === 'embedding' ? '/api/embeddings/custom' : '/api/media/custom';
    try {
      flashBtn(btn, 'Adding…');
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      document.getElementById('customBaseUrl').value = '';
      document.getElementById('customLabel').value = '';
      document.getElementById('customApiKey').value = '';
      document.getElementById('customModels').value = '';
      document.getElementById('customKeyForm').classList.remove('open');
      await loadKeySettings();
    } catch (e) { settingsError(e); } finally { flashBtn(btn, 'Add custom provider'); }
  }
  async function checkAllKeys(btn) {
    try { flashBtn(btn, 'Checking…'); await api('/api/health/check-all', { method: 'POST' }); await loadKeySettings(); }
    catch (e) { settingsError(e); } finally { flashBtn(btn, 'Check all'); }
  }
  async function keyAction(act, el) {
    const id = el.dataset.id || '';
    try {
      if (act === 'key-delete') {
        if (!confirm('Ye key delete karein?')) return;
        await api('/api/keys/' + encodeURIComponent(id), { method: 'DELETE' });
      } else if (act === 'key-toggle') {
        const k = KEYS.find(x => String(x.id) === String(id));
        await api('/api/keys/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ enabled: !(k && k.enabled !== false) }) });
      } else if (act === 'platform-toggle') {
        const platform = el.dataset.platform || '';
        const list = KEYS.filter(k => k.platform === platform);
        const enabled = !(list.length && list.every(k => k.enabled !== false));
        await api('/api/keys/platform/' + encodeURIComponent(platform), { method: 'PATCH', body: JSON.stringify({ enabled }) });
      }
      await loadKeySettings();
    } catch (e) { settingsError(e); }
  }

  async function loadFallbackSettings() {
    try {
      const d = await api('/api/fallback');
      const rows = Array.isArray(d) ? d : ((d && (d.entries || d.models)) || []);
      FALLBACK_ROWS = Array.isArray(rows) ? rows.map((r, i) => Object.assign({}, r, { _i: i })) : [];
      renderFallbackRows();
    } catch (e) {
      const box = document.getElementById('modelRows');
      if (box) box.innerHTML = '<div class="row"><div><b>Model list nahi mili</b><small>' + esc(e.message) + '</small></div></div>';
    }
  }
  function renderFallbackRows() {
    const box = document.getElementById('modelRows');
    if (!box) return;
    const q = (document.getElementById('modelSearch').value || '').toLowerCase();
    const rows = FALLBACK_ROWS.filter(r =>
      ((r.displayName || '') + ' ' + (r.modelId || '') + ' ' + (r.platform || '')).toLowerCase().includes(q)
    );
    box.innerHTML = rows.map(r => {
      const id = r.modelDbId != null ? r.modelDbId : r.id;
      return '<div class="live-row"><div class="live-main"><b>#' + esc(r.priority == null ? '?' : r.priority) + ' · ' + esc(r.displayName || r.modelId || id) + '</b><small>' +
        esc((r.platform || '') + ' · ' + (r.modelId || '') + ' · ' + (r.keyCount == null ? '?' : r.keyCount) + ' keys' + (r.source ? ' · ' + r.source : '')) + '</small></div>' +
        chip(r.enabled === false ? 'Off' : 'On', r.enabled === false ? '' : 'acc') +
        '<button class="toggle live-toggle' + (r.enabled !== false ? ' on' : '') + '" data-act="model-toggle" data-i="' + esc(r._i) + '" title="Enable / disable model"><i></i></button>' +
        '<button class="icon-btn danger" data-act="model-delete" data-id="' + esc(id) + '" title="Delete model">×</button></div>';
    }).join('') || '<div class="row"><div><b>Koi model nahi mila</b><small>Search badlein ya refresh karein</small></div></div>';
  }
  async function setAllModels(enabled, btn) {
    if (!FALLBACK_ROWS.length) return alert('Pehle model list load honi chahiye.');
    const body = FALLBACK_ROWS.map(r => ({
      modelDbId: (r.modelDbId != null ? r.modelDbId : r.id),
      priority: r.priority == null ? 0 : r.priority,
      enabled: !!enabled
    }));
    try { flashBtn(btn, 'Saving…'); await api('/api/fallback', { method: 'PUT', body: JSON.stringify(body) }); await loadFallbackSettings(); }
    catch (e) { settingsError(e); } finally { flashBtn(btn, enabled ? 'Enable all' : 'Disable all'); }
  }
  async function modelAction(act, el) {
    try {
      if (act === 'model-toggle') {
        const r = FALLBACK_ROWS[Number(el.dataset.i)];
        if (!r) return;
        const id = r.modelDbId != null ? r.modelDbId : r.id;
        const next = r.enabled === false;
        await api('/api/models/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ enabled: next, fallbackEnabled: next }) });
      } else if (act === 'model-delete') {
        if (!confirm('Ye model delete karein?')) return;
        await api('/api/models/' + encodeURIComponent(el.dataset.id), { method: 'DELETE' });
      }
      await loadFallbackSettings();
    } catch (e) { settingsError(e); }
  }
  async function loadRoutingSettings() {
    try {
      const d = await api('/api/fallback/routing');
      ROUTING_INFO = d || {};
      const sel = document.getElementById('routingStrategy');
      if (sel && ROUTING_INFO.strategy && Array.from(sel.options).some(o => o.value === ROUTING_INFO.strategy)) {
        sel.value = ROUTING_INFO.strategy;
      }
    } catch (e) { /* model list still works */ }
  }
  async function saveRoutingStrategy(btn) {
    const strategy = document.getElementById('routingStrategy').value;
    try { flashBtn(btn, 'Saving…'); await api('/api/fallback/routing', { method: 'PUT', body: JSON.stringify({ strategy }) }); flashBtn(btn, 'Saved ✓'); }
    catch (e) { settingsError(e); } finally { window.setTimeout(() => { btn.disabled = false; }, 0); }
  }
  async function loadUnifiedKey() {
    try {
      const d = await api('/api/settings/api-key');
      UNIFIED_KEY = d.apiKey || '';
      document.getElementById('unifiedKeyText').textContent = UNIFIED_REVEALED ? (UNIFIED_KEY || '—') : maskSecret(UNIFIED_KEY);
    } catch (e) {
      document.getElementById('unifiedKeyText').textContent = 'Key load nahi hui: ' + e.message;
    }
  }
  async function copyUnifiedKey(btn) {
    if (!UNIFIED_KEY) return alert('Pehle key load honi chahiye.');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(UNIFIED_KEY);
      else {
        const ta = document.createElement('textarea'); ta.value = UNIFIED_KEY; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      }
      flashBtn(btn, 'Copied ✓');
    } catch (e) { settingsError(e); }
  }
  async function regenerateUnifiedKey(btn) {
    if (!confirm('Naya key banayein? Purana key turant band ho jayega.')) return;
    try {
      flashBtn(btn, 'Regenerating…');
      const d = await api('/api/settings/api-key/regenerate', { method: 'POST' });
      UNIFIED_KEY = d.apiKey || '';
      UNIFIED_REVEALED = true;
      await loadUnifiedKey();
      flashBtn(btn, 'Done ✓');
    } catch (e) { settingsError(e); } finally { window.setTimeout(() => { btn.disabled = false; }, 0); }
  }
  async function loadSettingsData() {
    const status = document.getElementById('aboutStatus');
    if (status) { status.textContent = ONLINE ? 'running' : 'offline'; status.className = 'chip' + (ONLINE ? ' acc' : ' bad'); }
    await Promise.allSettled([loadKeySettings(), loadFallbackSettings(), loadRoutingSettings(), loadUnifiedKey()]);
  }
  function wireSettings() {
    const q = id => document.getElementById(id);
    q('addKeyBtn').addEventListener('click', e => addProviderKey(e.currentTarget));
    q('addCustomBtn').addEventListener('click', e => addCustomProvider(e.currentTarget));
    q('checkAllBtn').addEventListener('click', e => checkAllKeys(e.currentTarget));
    q('refreshKeysBtn').addEventListener('click', () => loadSettingsData());
    q('toggleCustomForm').addEventListener('click', e => {
      q('customKeyForm').classList.toggle('open');
      e.currentTarget.textContent = q('customKeyForm').classList.contains('open') ? '− Hide custom form' : '＋ Custom endpoint';
    });
    q('newKeyPlatform').addEventListener('change', updateKeyHint);
    q('enableAllBtn').addEventListener('click', e => setAllModels(true, e.currentTarget));
    q('disableAllBtn').addEventListener('click', e => setAllModels(false, e.currentTarget));
    q('refreshModelsBtn').addEventListener('click', () => loadSettingsData());
    q('modelSearch').addEventListener('input', renderFallbackRows);
    q('saveStrategyBtn').addEventListener('click', e => saveRoutingStrategy(e.currentTarget));
    q('revealUnifiedBtn').addEventListener('click', e => {
      UNIFIED_REVEALED = !UNIFIED_REVEALED;
      q('unifiedKeyText').textContent = UNIFIED_REVEALED ? (UNIFIED_KEY || '—') : maskSecret(UNIFIED_KEY);
      e.currentTarget.textContent = UNIFIED_REVEALED ? 'Hide' : 'Show';
    });
    q('copyUnifiedBtn').addEventListener('click', e => copyUnifiedKey(e.currentTarget));
    q('regenerateUnifiedBtn').addEventListener('click', e => regenerateUnifiedKey(e.currentTarget));
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b || !b.closest('#keysCard, #modelsCard')) return;
      const act = b.dataset.act;
      if (act === 'key-toggle' || act === 'key-delete' || act === 'platform-toggle') keyAction(act, b);
      else if (act === 'model-toggle' || act === 'model-delete') modelAction(act, b);
    });
  }
  function showSettings() {
    view('settings');
    document.title = 'Claude Code · Settings';
    document.getElementById('topTitle').textContent = 'Settings';
    document.getElementById('setItem').classList.add('active');
    /* The original React dashboard is embedded verbatim — every provider,
       model and key control keeps its exact native behaviour and look. */
    const settingsView = document.getElementById('v-settings');
    const frame = document.getElementById('dashFrame');
    if (settingsView && frame) {
      settingsView.classList.add('embed');
      if (frame.getAttribute('src') !== '/react.html') frame.src = '/react.html';
    }
  }
  function emptyState() {
    const th = document.getElementById('thIn');
    th.classList.add('empty-mode');
    th.innerHTML = '<div class="empty"><h1 id="emptyName">' + esc(chatHeadingName()) + '</h1></div>';
  }
  function newChat() {
    CURRENT_CHAT = null; CURRENT_MESSAGES = []; PENDING_FILES = []; renderAttachments();
    emptyState();
    view('chat'); document.getElementById('topTitle').textContent = 'New chat'; document.title = 'Claude Code';
    document.querySelectorAll('.s-item').forEach(x => x.classList.remove('active'));
    renderChats();
  }
  function renderModels(list) {
    if (!list) list = MODELS;
    const q = (document.getElementById('msearch').value || '').toLowerCase();
    const cur = document.getElementById('modelName').textContent;
    const base = [{ id: 'auto', name: 'auto', p: 'router' }, { id: 'fusion', name: 'fusion', p: 'multi-model' }];
    const all = base.concat(list);
    const found = all.filter(m => (m.name + ' ' + m.p + ' ' + m.id).toLowerCase().includes(q));
    document.getElementById('mnote').textContent = 'Connected + runnable · ' + all.length + ' models';
    document.getElementById('mlist').innerHTML = found.map(m =>
      '<div class="m-opt' + (m.name === cur ? ' sel' : '') + '" data-n="' + esc(m.name) + '" data-id="' + esc(m.id) + '"><span>' + esc(m.name) + '</span><small>' + esc(m.p) + '</small></div>'
    ).join('') || '<div class="m-opt" style="color:var(--muted)">' + (ONLINE ? 'Koi runnable model nahi' : 'Server offline') + '</div>';
  }
  function setComposerMode(mode) {
    document.getElementById('plusBtn').classList.toggle('on', mode === 'plus');
    document.getElementById('micBtn').classList.toggle('on', mode === 'mic');
  }
  function togglePlus() {
    if (MIC_ACTIVE) stopMic();
    setComposerMode('plus');
    document.getElementById('fileInput').click();
    window.setTimeout(() => { if (!PENDING_FILES.length) setComposerMode(null); }, 1500);
  }
  function toggleModelMenu(force) {
    const menu = document.getElementById('modelMenu');
    const open = (typeof force === 'boolean') ? force : !menu.classList.contains('open');
    menu.classList.toggle('open', open);
    if (open) { setComposerMode(null); renderModels(); document.getElementById('msearch').focus(); }
  }
  document.addEventListener('click', e => { if (!e.target.closest('.model-wrap')) toggleModelMenu(false); });
  function pick(m, id, el) {
    document.getElementById('modelName').textContent = m;
    CURRENT_MODEL_ID = id || m;
    document.querySelectorAll('.m-opt').forEach(x => x.classList.remove('sel')); el.classList.add('sel');
    setComposerMode(null);
    toggleModelMenu(false);
  }
  async function persistChat() {
    if (!CURRENT_MESSAGES.length) return;
    try {
      if (CURRENT_CHAT) {
        await api('/api/conversations/' + CURRENT_CHAT, { method: 'PUT', body: JSON.stringify({ messages: CURRENT_MESSAGES }) });
      } else {
        const c = await api('/api/conversations', { method: 'POST', body: JSON.stringify({
          title: makeTitle(CURRENT_MESSAGES[0].content), messages: CURRENT_MESSAGES, model: CURRENT_MODEL_ID }) });
        CURRENT_CHAT = c.id;
      }
    } catch (e) { }
  }

  /* ---------- send / streaming reply ---------- */
  async function send() {
    if (SENDING) return;
    toggleModelMenu(false);
    const inp = document.getElementById('inp'), typed = inp.value.trim();
    if (!typed && !PENDING_FILES.length) return;
    const atts = PENDING_FILES.slice(), images = attachmentImages(atts), content = composeText(typed, atts);
    inp.value = ''; PENDING_FILES = []; renderAttachments();
    CURRENT_MESSAGES.push({ role: 'user', content, images: images.length ? images : undefined });
    await persistChat();
    renderThread();
    await streamReply(CURRENT_MESSAGES.length - 1, CURRENT_MESSAGES.length);
  }
  async function streamReply(userIndex, insertAt) {
    SENDING = true;
    const th = document.getElementById('thIn');
    th.classList.remove('empty-mode');
    const a = document.createElement('div'); a.className = 'a typing';
    const body = document.createElement('div'); body.className = 'body';
    body.innerHTML = '<div class="typing-dots"><i></i><i></i><i></i></div>';
    a.appendChild(body);
    const nodes = Array.from(th.children).filter(n => n.classList && (n.classList.contains('msg-user') || n.classList.contains('a')));
    const ref = nodes[insertAt];
    if (ref) th.insertBefore(a, ref); else th.appendChild(a);
    scrollThread();
    let full = '', p = null, started = false;
    const reveal = () => {
      if (started) return; started = true;
      a.classList.remove('typing'); body.innerHTML = '';
      p = document.createElement('p'); body.appendChild(p);
      if (full) p.textContent = full; scrollThread();
    };
    try {
      const r = await infer('/v1/chat/completions', { method: 'POST', body: JSON.stringify({
        model: CURRENT_MODEL_ID || 'auto',
        messages: CURRENT_MESSAGES.slice(0, userIndex + 1).map(m => ({ role: m.role, content: toMessageContent(m.content, m.images) })),
        stream: true, stream_options: { include_usage: true } }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const line = raw.split('\n').find(x => x.startsWith('data:'));
          if (!line) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            if (j.error) { full += '\n' + '[' + (j.error.type || 'error') + '] ' + (j.error.message || ''); reveal(); p.textContent = full; }
            const d = j.choices && j.choices[0] && j.choices[0].delta;
            if (d && d.content) { full += d.content; reveal(); p.textContent = full; scrollThread(); }
          } catch (e) { }
        }
      }
    } catch (e) {
      full = 'Server se jawab nahi mila: ' + e.message;
      reveal(); p.textContent = full;
    }
    if (!started) a.remove();
    if (full) {
      CURRENT_MESSAGES.splice(insertAt, 0, { role: 'assistant', content: full });
      await persistChat(); await loadConversations();
    }
    renderThread();
    SENDING = false;
  }

  /* ---------- CSP-safe event wiring: no inline handlers ---------- */
  function on(sel, ev, fn) { document.querySelectorAll(sel).forEach(el => el.addEventListener(ev, fn)); }
  function wire() {
    on('.hide', 'click', () => toggleSide());
    on('.menu', 'click', () => toggleSide());
    on('.newchat', 'click', () => newChat());
    on('#setItem', 'click', () => showSettings());
    on('#inp', 'keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    on('#inp', 'paste', e => { const files = [...(e.clipboardData && e.clipboardData.files || [])]; if (files.length) { e.preventDefault(); addFiles(files); } });
    on('#plusBtn', 'click', () => togglePlus());
    on('#micBtn', 'click', () => toggleMic());
    on('#modelBtn', 'click', () => toggleModelMenu());
    on('#msearch', 'input', () => renderModels());
    on('.send', 'click', () => send());
    on('.cat', 'click', e => showCat(e.currentTarget.dataset.cat, e.currentTarget));
    on('.theme-btn', 'click', e => setTheme(e.currentTarget.dataset.m, e.currentTarget));
    on('.sw', 'click', e => accent(e.currentTarget.dataset.a, e.currentTarget.dataset.b, e.currentTarget.dataset.c, e.currentTarget));
    on('.toggle:not(.live-toggle)', 'click', e => tog(e.currentTarget));
    wireSettings();
    const fileInput = document.getElementById('fileInput');
    fileInput.accept = [...IMAGE_MIMES, ...TEXT_EXTS.map(x => '.' + x)].join(',');
    on('#fileInput', 'change', e => addFiles(e.target.files));
    on('#attachments', 'click', e => {
      const b = e.target.closest('[data-remove]'); if (!b) return;
      PENDING_FILES = PENDING_FILES.filter(a => a.id !== b.dataset.remove); renderAttachments();
    });
    const comp = document.querySelector('.comp');
    if (comp) {
      comp.addEventListener('dragover', e => e.preventDefault());
      comp.addEventListener('drop', e => { e.preventDefault(); const files = [...(e.dataTransfer && e.dataTransfer.files || [])]; if (files.length) addFiles(files); });
    }
    document.getElementById('chatList').addEventListener('click', e => {
      const act = e.target.closest('[data-act]');
      if (act) {
        e.preventDefault(); e.stopPropagation();
        const id = Number(act.dataset.id), a = act.dataset.act;
        if (a === 'pin') togglePin(id);
        else if (a === 'rename') renameChat(id);
        else if (a === 'delete') deleteChat(id);
        return;
      }
      const it = e.target.closest('.chat-item[data-id]'); if (it) openChat(Number(it.dataset.id));
    });
    document.getElementById('thIn').addEventListener('click', e => {
      const b = e.target.closest('.msg-acts button[data-act]'); if (!b) return;
      const i = Number(b.dataset.i), m = CURRENT_MESSAGES[i]; if (!m) return;
      if (b.dataset.act === 'copy') copyMessage(m.content || '', b);
      else if (b.dataset.act === 'reload') regenerate(i);
    });
    document.getElementById('mlist').addEventListener('click', e => {
      const it = e.target.closest('.m-opt[data-n]'); if (it) pick(it.dataset.n, it.dataset.id, it);
    });
    document.getElementById('connRow').addEventListener('click', e => { if (e.target.closest('#lgBtn')) doLogin(); });

    /* The chat heading follows the name saved in the embedded React
       Settings → General dialog. Nothing else reads this key. */
    const staticEmptyName = document.getElementById('emptyName');
    if (staticEmptyName) staticEmptyName.textContent = chatHeadingName();
  }
  wire();
  bootstrap();
})();
