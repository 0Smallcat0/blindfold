// Synthetic private documents with gold labels, for the Blindfold benchmark.
// Everything is generated from small pools of invented names; nothing here is real data.
// gold   : values that must NOT survive redaction ({text, type, parts?})
// keep   : values that must survive redaction (amounts, dates, organisations): over-redaction is measured on these
// answer : strings the correct answer to `question` must contain (checked after local restore)

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Daniela', 'Kenji', 'Marisol', 'Anthony', 'Priya', 'Tomasz', 'Imani', 'Lars', 'Fatima', 'Mateo', 'Aoife', 'Chidi', 'Soo-jin', 'Hamid', 'Beatriz', 'Dmitri', 'Nia', 'Gustavo', 'Yuki', 'Olumide', 'Ingrid', 'Rafael', 'Leila', 'Callum', 'Thandiwe', 'Arjun', 'Paloma', 'Stellan', 'Mei-Ling', 'Ezekiel'];
const LAST = ['Okonkwo-Reyes', 'Watanabe', 'Vega-Landry', 'Bellamy', 'Raman', 'Wieczorek', 'Okafor', 'Lindqvist', 'Haddad', 'Castellanos', 'Brennan', 'Eze', 'Park', 'Rahimi', 'Figueiredo', 'Volkov', 'Thompson', 'Ibarra', 'Nakamura', 'Adeyemi', 'Sorensen', 'Montoya', 'Khalil', 'MacLeod', 'Dlamini', 'Venkataraman', 'Quintero', 'Berg', 'Zhou', 'Whitfield'];
const STREET = ['Larkspur Hollow', 'Cedar Ridge', 'Harborview', 'Aspen Glen', 'Juniper Bend', 'Marlow Park', 'Kestrel', 'Old Mill', 'Sable Creek', 'Windmere', 'Foxglove', 'Pinecrest'];
const KIND = ['Ln', 'Ct', 'Terrace', 'Rd', 'Ave', 'Dr', 'Blvd', 'Way'];
const CITY = [['Columbus', 'OH', '43215'], ['Portland', 'OR', '97214'], ['Boston', 'MA', '02110'], ['Denver', 'CO', '80206'], ['Austin', 'TX', '78702'], ['Tucson', 'AZ', '85716'], ['Madison', 'WI', '53703'], ['Raleigh', 'NC', '27603']];
const ORG = ['Riverbend Regional Medical Center', 'Northstar Health Plan', 'Cobalt Ridge Property Group', 'Department of Revenue', 'Summit Valley Electric Cooperative', 'Harbor Light Credit Union', 'Meridian Dental Associates', 'Lakeshore Student Housing'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function makeDocs(n, seed = 7) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const digits = (k) => Array.from({ length: k }, () => int(0, 9)).join('');
  let usedNames = new Set();
  const person = () => {
    for (;;) {
      const f = pick(FIRST);
      const l = pick(LAST);
      if (!usedNames.has(f) && !usedNames.has(l)) {
        usedNames.add(f);
        usedNames.add(l);
        return { first: f, last: l, full: `${f} ${l}` };
      }
    }
  };
  const money = (lo, hi) => '$' + int(lo, hi).toLocaleString('en-US') + '.' + digits(2);
  const date = (y = 2026) => ({ long: `${pick(MONTHS)} ${int(1, 28)}, ${y}` });
  const phone = () => {
    const a = int(201, 989), b = int(200, 899), c = digits(4);
    return pick([`(${a}) ${b}-${c}`, `${a}-${b}-${c}`, `${a}.${b}.${c}`, `+1 ${a} ${b} ${c}`, `${a}-${b}-${c} ext. ${int(10, 99)}`]);
  };
  const address = () => {
    const [city, st, zip] = pick(CITY);
    const num = int(11, 9899);
    const street = `${pick(STREET)} ${pick(KIND)}`;
    const unit = pick(['', `, Apt ${int(1, 40)}${pick(['A', 'B', 'C', ''])}`, `, Unit ${int(1, 30)}`, `, #${int(100, 480)}`]);
    return `${num} ${street}${unit}, ${city}, ${st} ${zip}`;
  };
  const email = (p) => pick([`${p.first}.${p.last}`, `${p.first[0]}${p.last}`, `${p.last}${int(1, 99)}`]).toLowerCase().replace(/[^a-z0-9.]/g, '') + '@' + pick(['example.org', 'example.net', 'example.com']);
  const dob = () => pick([`${String(int(1, 12)).padStart(2, '0')}/${String(int(1, 28)).padStart(2, '0')}/${int(1950, 2001)}`, `${pick(MONTHS)} ${int(1, 28)}, ${int(1950, 2001)}`]);

  const docs = [];
  const kinds = ['bill', 'lease', 'tax', 'claim', 'letter'];
  for (let i = 0; i < n; i++) {
    const kind = kinds[i % kinds.length];
    usedNames = new Set();
    const p = person();
    const q = person();
    const org = pick(ORG);
    const gold = [];
    const keep = [{ text: org, type: 'ORG' }];
    const G = (text, type) => { gold.push({ text, type }); return text; };
    const K = (text, type = 'KEEP') => { keep.push({ text, type }); return text; };
    const addr = G(address(), 'ADDRESS');
    const ph = G(phone(), 'PHONE');
    const mail = G(email(p), 'EMAIL');
    const idv = G(pick([`HX-${digits(8)}`, `NS-${digits(4)}-${digits(6)}`, `${digits(4)}-${digits(3)}-${digits(2)}`, `KQ${digits(9)}`]), 'ID');
    const idLabel = pick(['Member ID', 'Account no.', 'Policy number', 'Reference', 'Case #']);
    const fullName = G(p.full, 'PERSON');
    let text, question, answer;
    if (kind === 'bill') {
      const total = money(2000, 9000), due = money(300, 1900), dd = date();
      const svc = K(date().long);
      K(total); K(due); K(dd.long);
      const doc = G(`Dr. ${q.first} ${q.last}`, 'PERSON');
      text = `${org.toUpperCase()}\nPatient Billing Statement\n\nPatient: ${fullName}\n${idLabel}: ${idv}\nBilling address: ${addr}\nPhone: ${ph}   Email: ${mail}\n\nDate of service: ${svc}\nProvider: ${doc}, Emergency Department\n\nTotal charges: ${total}\nAmount you owe: ${due}   Due by ${dd.long}\n\nQuestions about this bill? Call ${ph} and mention ${idLabel.toLowerCase()} ${idv}.\nDear ${p.last.includes('-') ? 'Ms. ' : 'Mr. '}${p.last}, please remit payment promptly.`;
      question = 'How much do I owe and by what date?';
      answer = [due, dd.long];
    } else if (kind === 'lease') {
      const oldRent = int(1100, 1900), newRent = oldRent + int(120, 400), eff = date(), fee = money(75, 250);
      K(`$${oldRent.toLocaleString('en-US')}`); K(`$${newRent.toLocaleString('en-US')}`); K(eff.long); K(fee);
      const landlord = G(q.full, 'PERSON');
      const dl = G(`DL-${digits(4)}-${digits(4)}-${digits(1)}`, 'ID');
      text = `RESIDENTIAL LEASE ADDENDUM\n\nThis addendum is made between Landlord: ${landlord} and Tenant: ${fullName} for the premises at ${addr}.\n\n1. Rent increases from $${oldRent.toLocaleString('en-US')} to $${newRent.toLocaleString('en-US')} beginning ${eff.long}. A late fee of ${fee} applies on the 2nd day.\n2. Entry is permitted with 2 hours' notice, by text to ${ph}.\n3. Notices to Tenant: ${mail}.\n\nTenant ID: ${dl}\nSignatures: ${fullName} / ${landlord}`;
      question = 'What is the new monthly rent and when does it start?';
      answer = [`$${newRent.toLocaleString('en-US')}`, eff.long];
    } else if (kind === 'tax') {
      const ssn = G(`${digits(3)}-${digits(2)}-${digits(4)}`, 'SSN');
      const due = money(900, 4800), dd = date('2026'), emp = K('Northgate Logistics Inc.', 'ORG');
      K(due); K(dd.long);
      const worker = G(`Ms. ${q.first} ${q.last}`, 'PERSON');
      text = `${org.toUpperCase()}\nNotice of Proposed Adjustment\nReference: CP-${digits(8)}\n\nTaxpayer: ${fullName}\nSSN: ${ssn}\nMailing address: ${addr}\n\nWe changed your 2025 return because wages reported by ${emp} do not match your return.\nTotal amount due: ${due} by ${dd.long}\n\nIf you disagree, call ${ph} or write to the address above. Your case worker is ${worker}.`;
      question = 'What total do I owe and what is the deadline?';
      answer = [due, dd.long];
    } else if (kind === 'claim') {
      const billed = money(800, 4800), dd = date(), svc = date().long;
      K(billed); K(dd.long); K(svc);
      const drn = G(`Dr. ${q.first} ${q.last}`, 'PERSON');
      text = `${org.toUpperCase()}\nNotice of Claim Denial\n\nMember: ${fullName}          ${idLabel}: ${idv}\nAddress: ${addr}\n\nWe reviewed your claim for an MRI performed on ${svc} by ${drn}. The claim was denied because prior authorization was not on file.\nBilled amount: ${billed}\n\nYou have until ${dd.long} to appeal. Call ${ph} with your ${idLabel.toLowerCase()}. Your doctor's office may also write to ${mail}.`;
      question = 'What was the billed amount and what is the appeal deadline?';
      answer = [billed, dd.long];
    } else {
      // free-form letter: names and identifiers appear inside prose with no labels
      const amt = money(150, 900), dd = date();
      K(amt); K(dd.long);
      const friend = G(q.full, 'PERSON');
      const ssn4 = G(digits(4), 'ID');
      text = `Hi ${p.first},\n\nThanks for sending the paperwork over to ${org}. I talked with ${friend} yesterday and she confirmed the refund of ${amt} will be issued by ${dd.long}. If anything changes you can reach her on ${ph}, or write to me at ${mail}. I also moved, so please use ${addr} from now on. For the record my card on file ends in ${ssn4}.\n\nBest,\n${fullName}`;
      question = 'What refund amount was confirmed and by when will it be issued?';
      answer = [amt, dd.long];
      // the greeting uses the first name only: it is private too
      G(p.first, 'PERSON');
    }
    docs.push({ id: `${kind}-${i}`, kind, text, gold, keep, question, answer });
  }
  return docs;
}

/** Score one redacted text. recall: gold values fully gone. keep: values that survived. */
export function score(redacted, doc) {
  const low = redacted.toLowerCase();
  const gone = (g) => {
    const toks = g.type === 'PERSON' ? g.text.replace(/^(Dr|Ms|Mr)\.\s+/, '').split(/\s+/).filter((t) => t.length >= 3) : [g.text];
    return toks.every((t) => !low.includes(t.toLowerCase()));
  };
  const leaked = doc.gold.filter((g) => !gone(g));
  const lost = doc.keep.filter((k) => !low.includes(k.text.toLowerCase()));
  return { leaked, lost, nGold: doc.gold.length, nKeep: doc.keep.length };
}
