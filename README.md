# Blindfold

**Show the cloud everything it needs to think. Nothing it shouldn't see.**

Blindfold lets you get a cloud model's help with private documents (medical bills, leases, tax notices, insurance denials) without the cloud ever seeing who you are.

1. **Scan on device.** Gemini Nano (Chrome's built-in model) plus deterministic rules find names, addresses, phone numbers, emails, dates of birth, SSNs, card numbers and account IDs. A second Nano "audit pass" re-reads the already-redacted text for anything that slipped through.
2. **You review.** The cloud's view is shown side by side with the original. Click any value to let it through or keep it hidden.
3. **Reason in the cloud.** Only the redacted text (`[PERSON_1]`, `[ADDRESS_1]`, ...) is sent to a Gemini model.
4. **Restore on device.** Real values are put back into the answer locally. A leak check blocks the request if a known private value is still in the outgoing text, and a wire monitor shows the exact bytes the SDK sent to Google.

It is built on **Firebase AI Logic hybrid inference** (`firebase/ai`):

| Step | Mode | Why |
| --- | --- | --- |
| Detect and audit PII, read a photo of a document | `ONLY_ON_DEVICE` | Raw text must never leave the device, so these steps can never fall back to the cloud. The code also throws if `inferenceSource` is not `on_device`. |
| Deep analysis | `ONLY_IN_CLOUD` | Needs the strongest model; only ever sees redacted text. |
| Quick answer | `PREFER_ON_DEVICE` | Safe to run on either side because its input is already redacted. |

If Gemini Nano is unavailable (unsupported browser or hardware), Blindfold falls back to the rule-based scanner and says so in a banner.

## Try it

Live: https://blindfold-hybrid.web.app (Chrome desktop with Gemini Nano enabled gives the full on-device flow; click "Enable on-device AI" once to download the model).

Pick a sample document (all people, addresses and numbers are invented), press **Scan on device**, then **Ask**.

## Run locally

```
npm install
cp .env.example .env.local   # fill in your Firebase web app config
npm run dev
npm test
```

You need a Firebase project with Firebase AI Logic enabled (Gemini Developer API, free Spark plan is enough). On `localhost` the app uses an App Check debug token: open the console, copy the printed token, and register it under App Check > Apps > Manage debug tokens. For a hosted build, create a reCAPTCHA key for your domain, register it under App Check > Apps (Fraud Defense / reCAPTCHA Enterprise) and set `VITE_RECAPTCHA_SITE_KEY`; the hosted build contains no debug token. The app limits itself to 5 cloud calls per minute per session. `VITE_CLOUD_MODEL` overrides the cloud model (default `gemini-3.5-flash`).

## Layout

- `src/detect.js` rules, entity table, placeholder redaction, restore, leak check (pure functions, covered by `test/`).
- `src/ai.js` Firebase setup, the four hybrid models, Nano lifecycle, wire monitor.
- `src/main.js`, `index.html`, `src/style.css` the UI (no framework, no innerHTML for user text).
- `src/samples.js` four fictional sample documents.

## License

Apache-2.0, see `LICENSE`.
