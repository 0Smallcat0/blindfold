// All AI in Blindfold goes through Firebase AI Logic (firebase/ai).
//   - privacy models  : InferenceMode.ONLY_ON_DEVICE  -> Gemini Nano in Chrome, can never fall back to the cloud
//   - reasoning model : InferenceMode.ONLY_IN_CLOUD   -> Gemini in the cloud, only ever sees redacted text
//   - quick model     : InferenceMode.PREFER_ON_DEVICE-> safe to use only because its input is already redacted
import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, Schema } from 'firebase/ai';
import { locateEntities, splitChunks, TYPES } from './detect.js';

const env = import.meta.env;
const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

export const CLOUD_MODEL = env.VITE_CLOUD_MODEL || 'gemini-3.5-flash';

// ---- wire monitor: records the real HTTP bodies the Firebase SDK sends to Google, so the UI can prove what left the device
export const wire = [];
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  try {
    const url = typeof input === 'string' ? input : input.url;
    if (/firebasevertexai|firebaseai|generativelanguage/.test(url) && init?.body && typeof init.body === 'string') {
      wire.push({ t: Date.now(), url: url.replace(/\?.*/, ''), body: init.body });
      window.dispatchEvent(new CustomEvent('wire'));
    }
  } catch { /* never break the app for monitoring */ }
  return realFetch(input, init);
};

let app;
let ai;
export function initFirebase() {
  if (ai) return ai;
  app = initializeApp(firebaseConfig);
  const siteKey = env.VITE_RECAPTCHA_SITE_KEY;
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  // Debug provider only on localhost (the token comes from the dev's own .env.local, never from a hosted build).
  if (local) self.FIREBASE_APPCHECK_DEBUG_TOKEN = env.VITE_APPCHECK_DEBUG_TOKEN || true;
  if (siteKey || local) {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(siteKey || 'unset'),
      isTokenAutoRefreshEnabled: true,
    });
  }
  ai = getAI(app, { backend: new GoogleAIBackend() });
  return ai;
}

const entitySchema = Schema.object({
  properties: {
    entities: Schema.array({
      items: Schema.object({
        properties: {
          text: Schema.string(),
          type: Schema.enumString({ enum: Object.keys(TYPES) }),
        },
      }),
    }),
  },
});

let models;
function getModels() {
  if (models) return models;
  const a = initFirebase();
  const en = [{ type: 'text', languages: ['en'] }];
  const base = { createOptions: { expectedInputs: [...en, { type: 'image' }], expectedOutputs: en } };
  models = {
    // detector: never leaves the device
    detector: getGenerativeModel(a, {
      mode: InferenceMode.ONLY_ON_DEVICE,
      onDeviceParams: { ...base, promptOptions: { responseConstraint: entitySchema } },
    }),
    // reader: image -> text, never leaves the device
    reader: getGenerativeModel(a, { mode: InferenceMode.ONLY_ON_DEVICE, onDeviceParams: base }),
    // deep analysis: cloud only
    cloud: getGenerativeModel(a, {
      mode: InferenceMode.ONLY_IN_CLOUD,
      inCloudParams: { model: CLOUD_MODEL, generationConfig: { temperature: 0.3 } },
    }),
    // quick answer on redacted text: on-device when it can, cloud when it can't
    quick: getGenerativeModel(a, {
      mode: InferenceMode.PREFER_ON_DEVICE,
      onDeviceParams: base,
      inCloudParams: { model: CLOUD_MODEL, generationConfig: { temperature: 0.3 } },
    }),
  };
  return models;
}

// ---- on-device model lifecycle
export async function nanoAvailability() {
  if (typeof LanguageModel === 'undefined') return 'unsupported';
  try {
    return await LanguageModel.availability({ expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] });
  } catch {
    return 'unsupported';
  }
}

/** Must be called from a user gesture (button click). Resolves true when Gemini Nano is ready. */
export async function prepareNano(onProgress) {
  const m = getModels();
  try {
    await m.detector.initializeDeviceModel((p) => onProgress?.(p));
    await m.reader.initializeDeviceModel();
    return true;
  } catch (e) {
    console.warn('Gemini Nano not available:', e);
    return false;
  }
}

const DETECT_PROMPT = (chunk) =>
  `You protect people's privacy. Find every piece of personal or identifying information in the text below: ` +
  `people's names, street addresses, phone numbers, email addresses, dates of birth, government ID numbers, ` +
  `and account, policy, member, patient, claim or case numbers. Copy each item EXACTLY as written in the text. ` +
  `Do NOT include organization names, dollar amounts, service dates, medical terms or generic words.\n\nTEXT:\n"""\n${chunk}\n"""`;

const AUDIT_PROMPT = (chunk) =>
  `This text was already anonymized. Tokens like [PERSON_1] or [ID_2] are safe placeholders. ` +
  `Is any real personal information still visible: a person's name, street address, phone number, email, date of birth, ` +
  `or an account / policy / member / claim number? List only what is still visible, copied EXACTLY. ` +
  `If nothing is visible, return an empty list.\n\nTEXT:\n"""\n${chunk}\n"""`;

async function runDetector(text, prompt, source, log) {
  const { detector } = getModels();
  const spans = [];
  for (const chunk of splitChunks(text)) {
    const t0 = performance.now();
    const res = await detector.generateContent(prompt(chunk));
    const src = res.response.inferenceSource;
    if (src && src !== 'on_device') throw new Error('Detector ran off-device (' + src + '); refusing to continue');
    let parsed = { entities: [] };
    try {
      parsed = JSON.parse(res.response.text());
    } catch { /* treat as no findings */ }
    const located = locateEntities(chunk, parsed.entities, source);
    // re-anchor to the full document: spans are located again on the whole text by caller
    spans.push(...located.map((s) => ({ ...s, chunkText: chunk })));
    log?.({ kind: 'on-device', label: source === 'nano-audit' ? 'Nano audit pass' : 'Nano scan', ms: Math.round(performance.now() - t0), found: parsed.entities?.length ?? 0 });
  }
  return spans;
}

/** Gemini Nano finds private values. Returns entity strings (located later against the full text). */
export async function nanoDetect(text, log) {
  const spans = await runDetector(text, DETECT_PROMPT, 'nano', log);
  return spans.filter((s) => !s.ghost).map((s) => ({ text: s.text, type: s.type }));
}

export async function nanoAudit(redactedText, log) {
  const spans = await runDetector(redactedText, AUDIT_PROMPT, 'nano-audit', log);
  return spans.filter((s) => !s.ghost).map((s) => ({ text: s.text, type: s.type }));
}

/** Gemini Nano reads a photo of a document, on-device. */
export async function nanoReadImage(file, log) {
  const { reader } = getModels();
  const data = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
  const t0 = performance.now();
  const res = await reader.generateContent([
    'Transcribe all the text in this document photo exactly as written, preserving line breaks. Output only the text.',
    { inlineData: { data, mimeType: file.type || 'image/png' } },
  ]);
  log?.({ kind: 'on-device', label: 'Nano read photo', ms: Math.round(performance.now() - t0) });
  return res.response.text();
}

const ANALYST = (redacted, question) =>
  `You are a careful assistant helping someone understand a private document. Names, addresses, numbers and IDs were removed ` +
  `and replaced by placeholders like [PERSON_1], [ID_1], [ADDRESS_1]. Use those placeholders exactly as written whenever you refer ` +
  `to those items; never guess what they stand for. Be concrete and brief (under 220 words). Use short paragraphs or "- " bullets.\n\n` +
  `DOCUMENT:\n"""\n${redacted}\n"""\n\nQUESTION: ${question}`;

/** Cloud reasoning on redacted text. `depth` 'deep' = ONLY_IN_CLOUD, 'quick' = PREFER_ON_DEVICE (hybrid). */
const CALLS = [];
function rateLimit(max = 5, windowMs = 60000) {
  if (location.pathname.startsWith('/bench')) return; // benchmark harness
  const now = Date.now();
  while (CALLS.length && now - CALLS[0] > windowMs) CALLS.shift();
  if (CALLS.length >= max) throw new Error(`Slow down: at most ${max} cloud calls per minute per session.`);
  CALLS.push(now);
}

export async function analyze(redacted, question, depth, log) {
  rateLimit();
  const m = getModels();
  const model = depth === 'quick' ? m.quick : m.cloud;
  const t0 = performance.now();
  const res = await model.generateContent(ANALYST(redacted, question));
  const source = res.response.inferenceSource || (depth === 'quick' ? 'unknown' : 'in_cloud');
  log?.({ kind: source === 'on_device' ? 'on-device' : 'cloud', label: depth === 'quick' ? 'Quick answer' : 'Deep analysis', ms: Math.round(performance.now() - t0), source });
  return { text: res.response.text(), source, usage: res.response.usageMetadata };
}
