# Sardine IDV — Web SDK Example (NPM)

A runnable reference implementation of Sardine document/identity verification (IDV)
embedded in a **Sardine-hosted, Sardine-branded** web page using the Incode
**Web SDK** via NPM. Built from the Sardine [Web SDK Integration guide](https://docs.sardine.ai/guides/integration/integration-guides/document-verification/web-sdk)
(NPM tab), the Web UI Customization (styling) guide, and the NodeJS sample server.

This is **Phase 1** of the agreed plan: a Sardine-hosted page with Incode IDV
and Sardine branding. Phase 2 (conditional Bilt/Coinbase assets) is structured
for but not built — see the stubs noted below.

> Reference implementation, not production-hardened. No real auth, secrets
> management, or persistence. See `PRD.md` for full scope.

## Why this exists

In Sardine's no-code / Webview URL path, the IDV screens are served from
`incodesmile.com` with Sardine branding driven by a **single global Incode brand
config** — so it can't be branded per client without changing it for every
Sardine customer. To get **custom branding** (Sardine's here), you host the page yourself and
embed the Web SDK. That's exactly what this repo demonstrates.

## Layout

```
IncodeWebIntegration/
├── PRD.md          ← product/architecture doc
├── README.md       ← you are here
├── backend/        ← Node + Express: token minting + webhook listener
│   ├── server.js
│   ├── package.json
│   └── .env.example
└── frontend/       ← Vanilla JS + Vite: the Sardine-branded SDK page
    ├── index.html
    ├── src/main.js
    ├── src/style.css
    ├── package.json
    └── .env.example
```

## How it works

This follows Sardine's [Two Step Onboarding with Onboarding ID](https://docs.sardine.ai/guides/integration/integration-guides/onboarding/two-step-onboarding)
pattern: there's no permanent `customer.id` until *after* IDV completes, so a
temporary `onboardingId` stands in for it until then.

0. **Onboarding risk check.** Browser shows a name-only form (first + last
   name) and posts it to the backend `POST /onboard`. The backend mints a
   fresh `onboardingId` (kept for the whole onboarding) + `sessionKey`
   (unique per IDV attempt), and calls Sardine `POST /v1/customers` with
   `customer.onboardingId` (no `customer.id` yet). If the returned risk
   `level` is `low`/`medium` we proceed to IDV below; `high`/`very_high` holds
   for manual review instead.
1. Browser loads the Sardine page; the Incode Web SDK 2.0 is bundled via `@incodetech/web` + `@incodetech/core`.
2. Browser calls the backend `POST /verify-token`, passing the `sessionKey` +
   `onboardingId` from step 0, then calls `setup({ apiURL, token })` with the returned token.
3. Backend calls Sardine `POST /v1/identity-documents/tokens` (HTTP Basic auth,
   `clientId:clientSecret`), passing the `onboardingId` as the `customerId`
   field this endpoint expects (no permanent customerId exists yet — confirm
   this mapping is fine for your account with your Sardine team), and returns
   `access_token` + `verification_id`.
4. SDK runs: `<incode-consent>` → `<incode-id>` (front, back if two-sided, and ID processing) → `<incode-selfie>` → `getFinishStatus`.
5. Sardine processes with Incode and POSTs `document_verification.processed` to the backend webhook.
6. **Upgrade to a permanent customerId.** Backend verifies the signature,
   reads the result, mints a permanent `customerId` (standing in for "your
   system creates a customer record now that IDV passed"), and calls Sardine
   `POST /v1/feedbacks` to link it back to the original `onboardingId` —
   Sardine's dashboard now treats both IDs as the same person, and all future
   lookups should use the new `customerId`.

Desktop has no camera flow, so `isDesktopOrEmulated()` shows a QR code to continue on a phone.

## Prerequisites (from your Sardine team)

- Sardine **`clientId` + `clientSecret`** (sandbox).
- A **`consentId`** — provide your legal company name, privacy policy URL, terms
  of use URL, and a data-deletion contact email to have it configured.
- A **webhook signing secret**.
- Incode `apiURL`: sandbox `https://demo-api.incodesmile.com/0` — **keep the `/0` suffix**; it lets Incode read the API key from the Sardine-issued token, and without it the SDK gets HTTP 403.

## Setup & run

### 1) Backend

```bash
cd backend
cp .env.example .env      # fill in SARDINE_CLIENT_ID / SARDINE_SECRET_KEY / etc.
npm install
npm start                 # http://localhost:8080
```

### 2) Frontend

```bash
cd frontend
cp .env.example .env      # set VITE_CONSENT_ID (and VITE_BACKEND_URL if not :8080)
npm install
npm run dev               # http://localhost:5173
```

Open the frontend URL. On desktop you'll get a QR code; scan it from a phone to
run the camera flow.

> **Camera needs HTTPS.** For phone testing, expose your local frontend with a
> tunnel (ngrok / Tailscale / Localtunnel) and scan the QR. Production
> needs HTTPS too (localhost is exempt for development).

## Testing without real documents

Pass these `verificationId`s to the result API (`GET /verify-results?id=...`) to
exercise decisioning logic:

| verificationId      | Risk level |
| ------------------- | ---------- |
| `sardine-test-low`    | low    |
| `sardine-test-medium` | medium |
| `sardine-test-high`   | high   |

## Branding notes

- Phase 1 Sardine branding lives in `frontend/index.html` (page chrome) and
  `frontend/src/style.css` (Incode screen overrides via safe `Incode*` classes).
- The Sardine red (`#E31837`) and the logo are **placeholders** — swap in the
  real brand hex and logo asset.
- Avoid CSS that resizes/repositions capture elements (per the styling guide).
- **Phase 2** (Bilt/Coinbase): `style.css` has a commented `[data-brand="..."]`
  block, and the frontend reads `VITE_BRAND_PROGRAM`. Wire `data-brand` onto
  `<html>` and override the brand tokens per program.

## Known constraint to confirm with Incode/Sardine

Incode's **no-code** brand customization is a single global config (the reason
the SDK route is required for per-client branding). Open item: whether Incode
supports **multiple** brand configs simultaneously — this determines how clean
the Phase 2 multi-program branding can be. Confirm before committing to Phase 2.

## SDK version

This copy targets **Incode Web SDK 2.0** (`@incodetech/web` + `@incodetech/core`,
pinned to `2.3.1`). The original `IncodeWebIntegration` folder stays on the 1.x
SDK (`@incodetech/welcome`, `1.93.0`). The Sardine guide this repo was built from
references the 1.x SDK, and Incode's docs say 2.0's rollout to all clients is
"still TBD" — **confirm with your Sardine/Incode team that 2.0 works with the
Sardine-issued token and your account before go-live.**

Differences from the 1.x version (`frontend/src/main.js`):

- `create()` + `render*` calls are replaced by `setup({ apiURL, token })` and
  `<incode-consent>`, `<incode-id>`, `<incode-selfie>` Web Components.
- `<incode-id>` handles front, back and ID processing, so the separate
  `renderCamera('front'|'back')` and `processId()` steps are gone.
- `apiURL` must end in `/0` (no trailing slash needed); `unsafeMode` has no equivalent and was removed.
- `setup()` is called with `flow: false, theme: false` so no Incode dashboard flow/theme
  is loaded for the Sardine-issued token; module options are set in `main.js`.
- 2.0 renders different DOM/classes than 1.x, so the `Incode*` overrides in
  `style.css` no longer match and the Sardine skin on capture screens needs a
  restyle pass (2.0 exposes theming via `@incodetech/web/themes/*.css` and `setup({ uiConfig })`).

## Webhook signature

`backend/server.js` includes an HMAC-SHA256 signature check over the raw body as
a common pattern, gated on `SARDINE_WEBHOOK_SECRET`. **Confirm the exact header
name and signing scheme with your Sardine team** and adjust accordingly — it's
marked `TODO` in the code.
