import './style.css';
import { SAMPLES } from './samples.js';
import { TYPES, detectRules, locateEntities, buildEntities, applyRedaction, tokenize, restore, findLeaks } from './detect.js';
import { initFirebase, nanoAvailability, prepareNano, nanoDetect, nanoAudit, nanoReadImage, analyze, wire } from './ai.js';

const $ = (id) => document.getElementById(id);
const state = { text: '', entities: [], redacted: '', nano: 'unknown', ready: false, auditAdded: 0, lastAnswer: null };

// ---------- small DOM helpers (no innerHTML with user text anywhere)
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};
function setStep(n, doneUpTo = n - 1) {
  document.querySelectorAll('.flow li').forEach((li) => {
    const s = +li.dataset.step;
    li.classList.toggle('on', s === n);
    li.classList.toggle('done', s <= doneUpTo);
  });
}
function banner(msg, kind = '') {
  const b = $('banner');
  b.hidden = !msg;
  b.className = 'banner ' + kind;
  b.textContent = msg || '';
}
function log(entry) {
  const li = el('li');
  const dev = entry.kind === 'on-device';
  li.append(el('span', { className: 'b ' + (dev ? 'dev' : 'cloud'), textContent: dev ? 'ON-DEVICE' : 'CLOUD' }), el('span', { textContent: entry.label + (entry.found != null ? ` (${entry.found} found)` : '') }), el('time', { textContent: entry.ms + ' ms' }));
  $('log').prepend(li);
}

// ---------- device status
function setPill(id, cls, text) {
  const p = $('pill-' + id);
  p.className = 'pill ' + cls;
  p.querySelector('b').textContent = text;
}
async function refreshDevice() {
  state.nano = await nanoAvailability();
  const map = {
    available: ['ok', 'Gemini Nano ready'],
    downloadable: ['warn', 'download needed'],
    downloading: ['warn', 'downloading…'],
    unavailable: ['bad', 'not supported here'],
    unsupported: ['bad', 'not supported here'],
  };
  const [cls, text] = map[state.nano] || ['warn', state.nano];
  setPill('device', cls, text);
  $('enable').hidden = !(state.nano === 'downloadable' || state.nano === 'downloading');
  if (state.nano === 'unavailable' || state.nano === 'unsupported') {
    banner('Gemini Nano is not available in this browser (it needs desktop Chrome 139+ with the on-device model). Blindfold falls back to rule-based redaction only: it catches numbers, emails, phones, IDs and labeled names, but can miss free-text names and addresses. Review the highlights yourself before you ask.');
  } else banner('');
}
function refreshNet() {
  setPill('net', navigator.onLine ? 'ok' : 'warn', navigator.onLine ? 'online' : 'offline');
}
window.addEventListener('online', refreshNet);
window.addEventListener('offline', refreshNet);

$('enable').addEventListener('click', async () => {
  $('enable').disabled = true;
  setPill('device', 'warn', 'downloading 0%');
  const ok = await prepareNano((p) => setPill('device', 'warn', `downloading ${Math.round(p * 100)}%`));
  state.ready = ok;
  await refreshDevice();
  $('enable').disabled = false;
});

async function ensureNano() {
  if (state.ready) return true;
  if (state.nano === 'unknown') await refreshDevice(); // scan clicked before the first availability check finished
  if (state.nano === 'available' || state.nano === 'downloading') {
    state.ready = await prepareNano();
    await refreshDevice();
  }
  return state.ready;
}

// ---------- rendering
function renderMarked() {
  const box = $('marked');
  box.hidden = !state.entities.length;
  box.replaceChildren();
  for (const seg of tokenize(state.text, state.entities)) {
    if (!seg.entity) {
      box.append(seg.text);
      continue;
    }
    const m = el('mark', { textContent: seg.text, tabIndex: 0, title: `${TYPES[seg.entity.type]} → [${seg.entity.id}]. Click to ${seg.entity.enabled ? 'let it through' : 'hide it'}.` });
    m.className = seg.entity.enabled ? '' : 'off';
    m.dataset.id = seg.entity.id;
    box.append(m);
  }
}
function renderRedacted() {
  const { redacted } = applyRedaction(state.text, state.entities);
  state.redacted = redacted;
  const box = $('redacted');
  box.replaceChildren();
  box.append(...withPlaceholders(redacted, (id) => el('span', { className: 'ph', textContent: `[${id}]` })));
  const leaks = findLeaks(redacted, state.entities);
  const tag = $('leak-tag');
  const hidden = state.entities.filter((e) => e.enabled).length;
  if (leaks.length) {
    tag.className = 'tag bad';
    tag.textContent = `${leaks.length} private value${leaks.length > 1 ? 's' : ''} still visible`;
  } else {
    tag.className = 'tag ok';
    tag.textContent = `${hidden} private value${hidden === 1 ? '' : 's'} hidden · 0 visible`;
  }
  $('ask').disabled = !!leaks.length || !state.text.trim();
}
function renderEntities() {
  const box = $('entities');
  box.hidden = !state.entities.length;
  box.replaceChildren();
  for (const e of state.entities) {
    const src = [...e.sources].map((s) => (s === 'rules' ? 'rules' : 'Nano')).filter((v, i, a) => a.indexOf(v) === i).join(' + ');
    const chip = el('button', { className: 'chip' + (e.enabled ? '' : ' off'), type: 'button', title: `${TYPES[e.type]} found by ${src}. Click to toggle.` }, el('code', { textContent: e.id }), `${e.count}×`, el('small', { textContent: src }));
    chip.addEventListener('click', () => toggle(e.id));
    box.append(chip);
  }
}
function renderAll() {
  renderMarked();
  renderRedacted();
  renderEntities();
}
function toggle(id) {
  const e = state.entities.find((x) => x.id === id);
  if (!e) return;
  e.enabled = !e.enabled;
  renderAll();
}
$('marked').addEventListener('click', (ev) => ev.target.dataset?.id && toggle(ev.target.dataset.id));
$('marked').addEventListener('keydown', (ev) => (ev.key === 'Enter' || ev.key === ' ') && ev.target.dataset?.id && (ev.preventDefault(), toggle(ev.target.dataset.id)));

// split text on [TYPE_n] placeholders into text + nodes
function withPlaceholders(text, make) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/\[([A-Z]+_\d+)\]/g)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(make(m[1]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// custom selection -> hide
document.addEventListener('selectionchange', () => {
  const sel = getSelection();
  const inside = sel && !sel.isCollapsed && $('marked').contains(sel.anchorNode) && $('marked').contains(sel.focusNode);
  $('add-sel').hidden = !inside;
});
$('add-sel').addEventListener('click', () => {
  const s = getSelection().toString().trim();
  if (s.length < 2) return;
  const n = state.entities.filter((e) => e.type === 'OTHER').length + 1;
  if (!state.entities.some((e) => e.text.toLowerCase() === s.toLowerCase())) state.entities.push({ id: `OTHER_${n}`, type: 'OTHER', text: s, keys: new Set([s.toLowerCase()]), sources: new Set(['you']), enabled: true, count: 0 });
  getSelection().removeAllRanges();
  renderAll();
});

// ---------- scan
async function scan() {
  const text = $('input').value.replace(/\r\n/g, '\n');
  if (!text.trim()) return;
  state.text = text;
  $('scan').disabled = true;
  $('scan').textContent = 'Scanning…';
  setStep(1, 0);
  try {
    const t0 = performance.now();
    let spans = detectRules(text);
    log({ kind: 'on-device', label: 'Rule scan', ms: Math.round(performance.now() - t0), found: spans.length });
    const nano = await ensureNano();
    state.auditAdded = 0;
    if (nano) {
      try {
        const found = await nanoDetect(text, log);
        spans.push(...locateEntities(text, found, 'nano'));
        let ents = buildEntities(text, spans);
        // second look: ask Nano to audit the already-redacted text and catch what the first pass missed
        const first = applyRedaction(text, ents).redacted;
        const missed = await nanoAudit(first, log);
        const extra = locateEntities(text, missed, 'nano').filter((s) => !s.ghost);
        const fresh = extra.filter((s) => !ents.some((e) => [...e.keys, e.text.toLowerCase()].includes(s.text.toLowerCase())));
        if (fresh.length) {
          state.auditAdded = new Set(fresh.map((s) => s.text.toLowerCase())).size;
          spans.push(...fresh);
        }
      } catch (err) {
        console.warn(err);
        banner('Gemini Nano hit an error mid-scan, so only the rule-based layer ran. Review the highlights yourself.');
      }
    }
    state.entities = buildEntities(text, spans);
    renderAll();
    setStep(2, 1);
    if (state.auditAdded) log({ kind: 'on-device', label: `Audit pass caught ${state.auditAdded} more`, ms: 0 });
    $('question').focus();
  } finally {
    $('scan').disabled = false;
    $('scan').textContent = 'Scan on device';
  }
}
$('scan').addEventListener('click', scan);

// ---------- ask
async function ask() {
  const question = $('question').value.trim() || 'Summarize this document and point out anything I should double-check.';
  const depth = document.querySelector('input[name=depth]:checked').value;
  const { redacted } = applyRedaction(state.text, state.entities);
  const leaks = findLeaks(redacted, state.entities);
  if (leaks.length) return renderRedacted(); // never send while a known private value is visible
  if (!navigator.onLine && depth === 'deep') {
    banner('You are offline. Deep analysis needs the cloud. Switch to Quick, which runs on the device model, or reconnect.', 'info');
    return;
  }
  $('ask').disabled = true;
  $('ask').textContent = 'Thinking…';
  $('answer').textContent = '';
  setStep(3, 2);
  const wireBefore = wire.length;
  try {
    const { text, source } = await analyze(redacted, question, depth, log);
    state.lastAnswer = { text, source };
    renderAnswer();
    setStep(4, 4);
    const sent = wire.slice(wireBefore);
    if (sent.length) {
      const body = sent.map((w) => w.body).join('\n\n');
      const wireLeaks = findLeaks(body, state.entities);
      $('wire').textContent = `POST ${sent[0].url}\n\n` + prettyBody(sent[0].body);
      $('wire-box').hidden = false;
      log({ kind: 'on-device', label: `Wire check: ${sent.reduce((n, w) => n + w.body.length, 0).toLocaleString()} bytes sent, ${wireLeaks.length} private values`, ms: 0 });
    } else if (source === 'on_device') $('wire-box').hidden = true;
  } catch (err) {
    console.error(err);
    $('answer').textContent = 'The request failed: ' + (err?.message || err);
  } finally {
    $('ask').textContent = 'Ask';
    renderRedacted();
  }
}
function prettyBody(b) {
  try {
    return JSON.stringify(JSON.parse(b), null, 2);
  } catch {
    return b;
  }
}
function renderAnswer() {
  const a = state.lastAnswer;
  if (!a) return;
  const raw = $('raw-toggle').checked;
  const box = $('answer');
  box.replaceChildren();
  $('answer-tools').hidden = false;
  if (raw) {
    box.append(...withPlaceholders(a.text, (id) => el('span', { className: 'ph', textContent: `[${id}]` })));
  } else {
    const byId = new Map(state.entities.map((e) => [e.id, e]));
    box.append(...withPlaceholders(a.text, (id) => (byId.has(id) ? el('span', { className: 'ph restored', textContent: byId.get(id).text, title: `Restored on your device from [${id}]. The cloud never saw this.` }) : el('span', { className: 'ph', textContent: `[${id}]` }))));
  }
}
$('raw-toggle').addEventListener('change', renderAnswer);
$('ask').addEventListener('click', ask);
$('question').addEventListener('keydown', (e) => e.key === 'Enter' && !$('ask').disabled && ask());

// ---------- samples and photos
const sampleBox = $('samples');
for (const s of SAMPLES) {
  const b = el('button', { type: 'button', textContent: s.label });
  b.addEventListener('click', () => {
    $('input').value = s.text;
    $('question').value = s.question;
    state.entities = [];
    $('marked').hidden = true;
    $('entities').hidden = true;
    $('redacted').replaceChildren(el('p', { className: 'muted', textContent: "Scan the document and the cloud's view appears here." }));
    $('leak-tag').className = 'tag';
    $('leak-tag').textContent = 'waiting for a scan';
    $('ask').disabled = true;
    setStep(1, 0);
  });
  sampleBox.append(b);
}
$('photo').addEventListener('change', async (ev) => {
  const f = ev.target.files?.[0];
  if (!f) return;
  const ok = await ensureNano();
  if (!ok) return banner('Reading photos needs Gemini Nano on this device. Paste the text instead.');
  $('input').value = 'Reading the photo on this device…';
  try {
    $('input').value = await nanoReadImage(f, log);
  } catch (e) {
    $('input').value = '';
    banner('Gemini Nano could not read that image: ' + (e?.message || e));
  }
});

// ---------- boot
initFirebase();
refreshNet();
refreshDevice().then(() => {
  setStep(1, 0);
  $('samples').firstChild?.click();
});
window.__blindfold = { state, scan, ask }; // for tests and the demo
