// Pure, dependency-free redaction logic. Runs in the browser and in node (tests).
// Nothing in this file talks to a model: it is the deterministic layer that sits next to
// Gemini Nano (see ai.js) so the pipeline still works, with weaker protection, on devices
// that have no on-device model.

export const TYPES = {
  PERSON: 'Person',
  EMAIL: 'Email',
  PHONE: 'Phone',
  SSN: 'National ID',
  CARD: 'Card number',
  DOB: 'Birth date',
  ADDRESS: 'Address',
  ID: 'Account / record ID',
  IP: 'IP address',
  OTHER: 'Other private value',
};

const DATE = String.raw`(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})`;

const NAME = String.raw`[A-Z][a-zA-Z'’-]+(?:[ 	]+(?:[A-Z]\.|[A-Z][a-zA-Z'’-]+)){1,3}`;
const STREET_WORDS = 'Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Parkway|Pkwy|Circle|Cir';

// Each rule yields spans {start,end,type}. `group` picks a capture group to redact.
const RULES = [
  { type: 'EMAIL', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { type: 'SSN', re: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g },
  { type: 'CARD', re: /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g, check: (s) => luhn(s.replace(/\D/g, '')) },
  { type: 'PHONE', re: /(?<![\w.])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)/g },
  { type: 'PHONE', re: /(?<![\w.])\+\d{1,3}[\s-]?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}(?!\d)/g },
  { type: 'DOB', re: new RegExp(String.raw`\b(?:DOB|D\.O\.B\.|Date of Birth|Birth ?date|Born)\b[:\s]*(${DATE})`, 'gi'), group: 1 },
  { type: 'IP', re: /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/g, check: (s) => s.split('.').every((n) => +n <= 255) },
  {
    type: 'ID',
    re: /\b(?:Account|Acct|Policy|Member|Patient|MRN|Claim|Case|Reference|Ref|Group|Subscriber|Licen[sc]e|Passport|Tax ID|TIN|Employee|Customer|Invoice|Statement|Confirmation|Application)\.?(?:\s+(?:No\.?|Number|#|ID|Nbr))?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,}[A-Z0-9])/gi,
    group: 1,
    check: (s) => /\d/.test(s),
  },
  {
    type: 'ADDRESS',
    re: new RegExp(
      String.raw`\b\d{1,6}\s+(?:[A-Z][\w.'’-]*\s+){1,4}(?:${STREET_WORDS})\b\.?(?:,?\s*(?:Apt|Unit|Suite|Ste|Floor|Fl|#)\.?\s*[\w-]+)?(?:,\s*[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)?`,
      'g',
    ),
  },
  { type: 'ADDRESS', re: /\b[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g },
  { type: 'PERSON', re: new RegExp(String.raw`\b(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof)\.?\s+(${NAME}|[A-Z][a-zA-Z'’-]+)`, 'g'), group: 1 },
  { type: 'PERSON', re: new RegExp(String.raw`\bDear\s+(${NAME})\s*[,:]`, 'g'), group: 1 },
  {
    type: 'PERSON',
    re: new RegExp(
      String.raw`\b(?:Patient|Insured|Policyholder|Member|Subscriber|Tenant|Landlord|Lessee|Lessor|Taxpayer|Account Holder|Cardholder|Employee|Name|Guarantor|Claimant|Borrower|Applicant|Beneficiary|Spouse|Dependent|Parent|Guardian)(?:\s+Name)?\s*[:\-]\s*(${NAME})`,
      'g',
    ),
    group: 1,
  },
];

function luhn(d) {
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = +d[i];
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Deterministic detector. Returns [{start,end,text,type,source:'rules'}]. */
export function detectRules(text) {
  const out = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text))) {
      if (m[0] === '') {
        rule.re.lastIndex++;
        continue;
      }
      const val = rule.group ? m[rule.group] : m[0];
      if (!val) continue;
      if (rule.check && !rule.check(val)) continue;
      const start = rule.group ? m.index + m[0].indexOf(val) : m.index;
      out.push({ start, end: start + val.length, text: val, type: rule.type, source: 'rules' });
    }
  }
  return out;
}

/** Turn entity strings reported by a model into spans, keeping only strings that really occur in `text`. */
export function locateEntities(text, entities, source) {
  const out = [];
  const lower = text.toLowerCase();
  for (const e of entities || []) {
    const s = String(e?.text ?? '').trim();
    if (s.length < 2 || /^\[[A-Z]+_\d+\]$/.test(s) || s.includes('[')) continue; // placeholders are already safe
    const type = TYPES[e.type] ? e.type : 'OTHER';
    const needle = s.toLowerCase();
    let from = 0;
    let idx;
    let found = false;
    while ((idx = lower.indexOf(needle, from)) !== -1) {
      if (isBoundary(text, idx, idx + s.length) && !benign(text, idx, s, source)) {
        out.push({ start: idx, end: idx + s.length, text: text.slice(idx, idx + s.length), type, source });
        found = true;
      }
      from = idx + s.length;
    }
    if (!found) out.push({ start: -1, end: -1, text: s, type, source, ghost: true }); // hallucinated: reported, never applied
  }
  return out;
}

const MONEY = /^[$€£]\s?\d[\d,]*(?:\.\d+)?$/;
const DATE_ONLY = new RegExp('^' + DATE + '$', 'i');
const BIRTH_CUE = /(?:dob|date of birth|birth\s?date|birthday|born)\W{0,3}$/i;

/** Models over-report. Amounts and plain dates are what the cloud needs to reason, so a model-reported money or date
 *  value is only redacted when a birth cue sits right before it. Rules are not filtered. */
function benign(text, idx, s, source) {
  if (!String(source).startsWith('nano')) return false;
  if (MONEY.test(s)) return true;
  if (DATE_ONLY.test(s)) return !BIRTH_CUE.test(text.slice(Math.max(0, idx - 24), idx));
  return false;
}

function isBoundary(text, a, b) {
  const before = a === 0 ? '' : text[a - 1];
  const after = b >= text.length ? '' : text[b];
  return !/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after);
}

/** Merge overlapping spans: longest wins, rules/model type preference on ties. */
export function mergeSpans(spans) {
  const real = spans.filter((s) => !s.ghost && s.start >= 0).sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const s of real) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      if (s.end > last.end) last.end = s.end; // text is re-sliced from the document by the caller
      last.sources = [...new Set([...(last.sources || [last.source]), s.source])];
      continue;
    }
    out.push({ ...s, sources: [s.source] });
  }
  // recompute text from the document for extended spans is done by caller via sliceText
  return out;
}

/** Build the entity table (one entry per distinct private value) from merged spans. */
export function buildEntities(text, spans) {
  const merged = mergeSpans(spans).map((s) => ({ ...s, text: text.slice(s.start, s.end) }));
  const byKey = new Map();
  const counters = {};
  const entities = [];
  for (const s of merged) {
    const key = normalize(s.text);
    let ent = byKey.get(key);
    if (!ent) {
      counters[s.type] = (counters[s.type] || 0) + 1;
      ent = { id: `${s.type}_${counters[s.type]}`, type: s.type, text: s.text, keys: new Set([key]), sources: new Set(), enabled: true, count: 0 };
      byKey.set(key, ent);
      entities.push(ent);
    }
    s.sources.forEach((x) => ent.sources.add(x));
  }
  // fold single-token people ("Alvarez") into a full name that contains them ("Maria Alvarez")
  for (const single of [...entities]) {
    if (single.type !== 'PERSON' || /\s/.test(single.text)) continue;
    const full = entities.find((e) => e !== single && e.type === 'PERSON' && /\s/.test(e.text) && e.text.toLowerCase().split(/\s+/).includes(single.text.toLowerCase()));
    if (full) {
      single.keys.forEach((k) => { full.keys.add(k); byKey.set(k, full); });
      single.sources.forEach((x) => full.sources.add(x));
      entities.splice(entities.indexOf(single), 1);
    }
  }
  // aliases: a person's surname / first name alone should map to the same placeholder
  for (const ent of entities) {
    if (ent.type !== 'PERSON') continue;
    const parts = ent.text.split(/\s+/).filter((p) => /^[A-Z][a-zA-Z'’-]{2,}$/.test(p));
    for (const p of parts) {
      const k = normalize(p);
      if (!byKey.has(k) && !STOP.has(k)) {
        byKey.set(k, ent);
        ent.keys.add(k);
      }
    }
  }
  return entities;
}

const STOP = new Set(['the', 'and', 'for', 'dear', 'sir', 'madam', 'north', 'south', 'east', 'west', 'new', 'san', 'los']);

export function normalize(s) {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} @._+-]/gu, '').trim();
}

function entityTable(entities, onlyEnabled) {
  const table = new Map(); // lowercased literal -> entity
  for (const e of entities) {
    if (onlyEnabled && !e.enabled) continue;
    table.set(e.text.toLowerCase().replace(/\s+/g, ' '), e);
    if (e.type === 'PERSON') for (const k of e.keys) table.set(k, e);
  }
  return table;
}

/** Split text into [{text, entity|null}] segments; every occurrence of every known value (all aliases) becomes a segment. */
export function tokenize(text, entities) {
  const table = entityTable(entities, false);
  const literals = [...table.keys()].filter((l) => l.length >= 2).sort((a, b) => b.length - a.length);
  if (!literals.length) return [{ text, entity: null }];
  const re = new RegExp(`(?<![\p{L}\p{N}])(?:${literals.map(escapeRe).join('|')})(?![\p{L}\p{N}])`, 'giu');
  const segs = [];
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const e = table.get(m[0].toLowerCase().replace(/\s+/g, ' '));
    if (m.index > last) segs.push({ text: text.slice(last, m.index), entity: null });
    segs.push({ text: m[0], entity: e || null });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ text: text.slice(last), entity: null });
  return segs;
}

/** Replace every occurrence of every enabled entity (all aliases) with its placeholder. */
export function applyRedaction(text, entities) {
  for (const e of entities) e.count = 0;
  const redacted = tokenize(text, entities)
    .map((s) => {
      if (s.entity && s.entity.enabled) {
        s.entity.count++;
        return `[${s.entity.id}]`;
      }
      return s.text;
    })
    .join('');
  return { redacted, entities };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');

/** Put real values back into model output. Only known placeholders are touched. */
export function restore(answer, entities) {
  const byId = new Map(entities.map((e) => [e.id, e]));
  return answer.replace(/\[?\b([A-Z]+_\d+)\b\]?/g, (m, id) => (byId.has(id) ? byId.get(id).text : m));
}

/** Last line of defence before anything leaves the device: any known private value still in the payload? */
export function findLeaks(payload, entities) {
  const leaks = [];
  const hay = payload.toLowerCase();
  for (const e of entities) {
    if (!e.enabled) continue;
    for (const lit of new Set([e.text.toLowerCase(), ...(e.type === 'PERSON' ? [...e.keys] : [])])) {
      if (lit.length < 3) continue;
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(lit)}(?![\\p{L}\\p{N}])`, 'iu');
      if (re.test(hay)) leaks.push({ id: e.id, text: lit });
    }
  }
  return leaks;
}

export function splitChunks(text, max = 1400) {
  const paras = text.split(/\n{2,}/);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if (cur && (cur + '\n\n' + p).length > max) {
      chunks.push(cur);
      cur = p;
    } else cur = cur ? cur + '\n\n' + p : p;
    while (cur.length > max * 1.5) {
      chunks.push(cur.slice(0, max));
      cur = cur.slice(max);
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}
