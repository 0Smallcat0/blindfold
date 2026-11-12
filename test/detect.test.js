import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRules, buildEntities, applyRedaction, restore, findLeaks, locateEntities } from '../src/detect.js';

const DOC = `Patient: Maria Alvarez
DOB: 04/12/1987   Member ID: HX-88213447
Address: 1422 Willow Creek Dr, Apt 5B, Austin, TX 78704
Phone: (512) 555-0187  Email: maria.alvarez@example.com
SSN 123-45-6789. Card 4111 1111 1111 1111.
Dear Maria Alvarez, Ms. Alvarez was billed $1,240.00 on March 3, 2026. Dr. Chen reviewed it.`;

test('rules find the structured identifiers', () => {
  const found = detectRules(DOC).map((s) => `${s.type}:${s.text}`);
  for (const x of ['PERSON:Maria Alvarez', 'DOB:04/12/1987', 'ID:HX-88213447', 'EMAIL:maria.alvarez@example.com',
    'SSN:123-45-6789', 'CARD:4111 1111 1111 1111', 'PHONE:(512) 555-0187', 'PERSON:Chen', 'PERSON:Alvarez'])
    assert.ok(found.includes(x), `missing ${x}\n${found.join('\n')}`);
  assert.ok(found.some((f) => f.startsWith('ADDRESS:1422 Willow Creek Dr')));
  assert.ok(!found.some((f) => f.includes('1,240') || f.includes('March')));
});

test('redact, leak check, restore round trip', () => {
  const ents = buildEntities(DOC, detectRules(DOC));
  const { redacted } = applyRedaction(DOC, ents);
  assert.deepEqual(findLeaks(redacted, ents), []);
  assert.ok(!/Alvarez|555-0187|123-45-6789/.test(redacted), redacted);
  assert.ok(redacted.includes('$1,240.00') && redacted.includes('March 3, 2026'));
  const back = restore(redacted, ents);
  assert.ok(back.includes('Maria Alvarez') && back.includes('(512) 555-0187'));
});

test('surname alias maps to the same placeholder', () => {
  const ents = buildEntities(DOC, detectRules(DOC));
  const { redacted } = applyRedaction(DOC, ents);
  const maria = ents.find((e) => e.text === 'Maria Alvarez');
  assert.ok(redacted.includes(`Ms. [${maria.id}]`));
});

test('model-reported strings must exist in the text', () => {
  const spans = locateEntities(DOC, [{ text: 'Willow Creek', type: 'ADDRESS' }, { text: 'Nonexistent Person', type: 'PERSON' }], 'nano');
  assert.equal(spans.filter((s) => !s.ghost).length >= 1, true);
  assert.equal(spans.filter((s) => s.ghost).length, 1);
});
