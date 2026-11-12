// In-browser benchmark. Mirrors the scan() pipeline in src/main.js, but records each layer separately.
//   Part 1 (privacy):  for each synthetic document, how many gold private values survive redaction under
//                      rules-only / Nano-only / rules+Nano / rules+Nano+audit, and how many "keep" values
//                      (amounts, dates, organisations) get over-redacted.
//   Part 2 (utility):  the cloud answers the same question on the original and on the redacted text; the answer
//                      is restored locally and checked for the gold facts.
import { detectRules, locateEntities, buildEntities, applyRedaction, restore, findLeaks } from '../src/detect.js';
import { nanoAvailability, prepareNano, nanoDetect, nanoAudit, analyze } from '../src/ai.js';
import { makeDocs, score } from './gen.js';

const $ = (id) => document.getElementById(id);
const out = (s) => { $('out').textContent += s + '\n'; };
const results = { docs: [], utility: [], meta: {} };
window.__bench = results;

const CONFIGS = ['raw', 'rules', 'nano', 'rules+nano', 'rules+nano+audit'];

async function redactAll(text, log) {
  const rules = detectRules(text);
  const t0 = performance.now();
  const found = await nanoDetect(text, log);
  const nanoSpans = locateEntities(text, found, 'nano');
  const tNano = performance.now() - t0;
  const entsRules = buildEntities(text, rules);
  const entsNano = buildEntities(text, nanoSpans);
  const entsBoth = buildEntities(text, [...rules, ...nanoSpans]);
  const first = applyRedaction(text, entsBoth).redacted;
  const t1 = performance.now();
  const missed = await nanoAudit(first, log);
  const extra = locateEntities(text, missed, 'nano').filter((s) => !s.ghost);
  const fresh = extra.filter((s) => !entsBoth.some((e) => [...e.keys, e.text.toLowerCase()].includes(s.text.toLowerCase())));
  const entsAudit = buildEntities(text, [...rules, ...nanoSpans, ...fresh]);
  const tAudit = performance.now() - t1;
  const red = {
    raw: text,
    rules: applyRedaction(text, entsRules).redacted,
    nano: applyRedaction(text, entsNano).redacted,
    'rules+nano': first,
    'rules+nano+audit': applyRedaction(text, entsAudit).redacted,
  };
  return { red, entsAudit, tNano, tAudit };
}

async function part1(n, seed) {
  const docs = makeDocs(n, seed);
  results.meta = { n, seed, started: new Date().toISOString(), cloudModel: 'see ai.js' };
  for (const d of docs) {
    const { red, entsAudit, tNano, tAudit } = await redactAll(d.text, null);
    const per = {};
    for (const c of CONFIGS) per[c] = score(red[c], d);
    results.docs.push({ id: d.id, kind: d.kind, per: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, { leaked: v.leaked.map((g) => g.text + ' [' + g.type + ']'), lost: v.lost.map((k2) => k2.text), nGold: v.nGold, nKeep: v.nKeep }])), tNano: Math.round(tNano), tAudit: Math.round(tAudit), redacted: red['rules+nano+audit'] });
    window.__benchDocs = docs;
    (window.__benchEnts ||= {})[d.id] = entsAudit;
    $('prog').textContent = `part 1: ${results.docs.length}/${n}`;
  }
  summarize();
}

function summarize() {
  // Gold values that never appear in a document (templates differ) are excluded: "present" = still there in the raw text.
  const rows = [];
  for (const c of CONFIGS) {
    let gold = 0, leaked = 0, keep = 0, lost = 0, docsClean = 0;
    for (const d of results.docs) {
      const raw = d.per.raw, s = d.per[c];
      gold += raw.leaked.length;
      leaked += s.leaked.length;
      keep += s.nKeep - raw.lost.length;
      lost += s.lost.length - raw.lost.length;
      if (!s.leaked.length) docsClean++;
    }
    rows.push({ config: c, goldPresent: gold, leaked, leakRate: +(leaked / gold).toFixed(4), keepPresent: keep, overRedacted: lost, overRate: +(lost / keep).toFixed(4), docsFullyClean: `${docsClean}/${results.docs.length}` });
  }
  results.summary = rows;
  $('out').textContent = JSON.stringify(rows, null, 1);
}

async function part2(m) {
  const docs = window.__benchDocs.slice(0, m);
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const rec = results.docs.find((x) => x.id === d.id);
    const text = d.text;
    const ents2 = window.__benchEnts[d.id];
    const redacted = rec.redacted;
    const row = { id: d.id, kind: d.kind };
    for (const [label, input] of [['original', text], ['redacted', redacted]]) {
      try {
        const res = await analyze(input, d.question, 'deep');
        const restored = label === 'redacted' ? restore(res.text, ents2) : res.text;
        const hits = d.answer.filter((a) => restored.includes(a) || restored.replace(/,/g, '').includes(a.replace(/,/g, '')));
        row[label] = { ok: hits.length === d.answer.length, hits: hits.length, of: d.answer.length };
      } catch (e) {
        row[label] = { error: String(e.message || e).slice(0, 120) };
      }
    }
    results.utility.push(row);
    $('prog').textContent = `part 2: ${results.utility.length}/${m}`;
  }
  const okO = results.utility.filter((r) => r.original?.ok).length;
  const okR = results.utility.filter((r) => r.redacted?.ok).length;
  const errs = results.utility.filter((r) => r.original?.error || r.redacted?.error).length;
  results.utilitySummary = { n: results.utility.length, originalCorrect: okO, redactedCorrect: okR, errors: errs };
  out('\nUTILITY ' + JSON.stringify(results.utilitySummary));
}

$('go1').addEventListener('click', async () => {
  $('go1').disabled = true;
  if ((await nanoAvailability()) !== 'available') await prepareNano();
  await part1(Number($('n').value), Number($('seed').value));
});
$('go2').addEventListener('click', async () => {
  $('go2').disabled = true;
  await part2(Number($('m').value));
});
