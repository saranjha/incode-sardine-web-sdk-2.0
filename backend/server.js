/**
 * Sardine IDV — example backend (Node + Express)
 *
 * Why this exists:
 *   The browser must NEVER hold the Sardine clientSecret, so every Sardine
 *   call happens server-side. This server exposes four routes:
 *
 *     POST /onboard                       -> risk check with a provisional onboardingId
 *     POST /verify-token                  -> mints the SDK session token (required)
 *     GET  /verify-results?id=<id>        -> reads a result (DEBUG ONLY)
 *     POST /webhooks/document-verification-> receives the result + upgrades onboardingId -> customerId
 *     POST /webhooks/sardine              -> alias of the above (see note on the handler)
 *
 * Two-step onboarding (no permanent customer.id until after IDV):
 * https://docs.sardine.ai/guides/integration/integration-guides/onboarding/two-step-onboarding
 *
 *   1. /onboard mints a provisional onboardingId + a per-attempt sessionKey and
 *      risk-checks via POST /v1/customers using customer.onboardingId (no
 *      customer.id yet).
 *   2. /verify-token mints the IDV token. No permanent customerId exists yet,
 *      so — per the recommended mapping for this integration, subject to
 *      Sardine confirming it for this account — the onboardingId is passed
 *      as the `customerId` field POST /v1/identity-documents/tokens expects.
 *   3. Once the document_verification.processed webhook fires, this backend
 *      mints the permanent customerId (standing in for "your system creates
 *      a customer record") and calls POST /v1/feedbacks to link it back to
 *      the original onboardingId in Sardine.
 *
 * Source: Sardine "Web SDK Integration" guide + NodeJS sample server +
 * "Two Step Onboarding with Onboarding ID" guide.
 * This is a reference implementation — not production-hardened.
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

const {
  SARDINE_CLIENT_ID,
  SARDINE_SECRET_KEY,
  SARDINE_API_URL = 'https://api.sandbox.sardine.ai',
  SARDINE_WEBHOOK_SECRET,
  PORT = 8080,
  DEMO_SESSION_KEY = 'a7e7fbf8-036a-421b-a0fd-4384403c5640',
  DEMO_ONBOARDING_ID = '6855c577-b32d-423c-b8df-7b2ceb02a883',
  INTERACTION_LOG_FILE = path.join(__dirname, 'logs', 'sardine-interactions.log'),
} = process.env;

// Risk levels the /onboard risk check is allowed to proceed past, per the
// two-step onboarding guide's guidance (block/manually-review high & very_high).
const PROCEEDABLE_RISK_LEVELS = new Set(['low', 'medium']);

/**
 * Append-only, one-JSON-object-per-line log of every Sardine customer API
 * call (/v1/customers, /v1/feedbacks) and every incoming webhook, so a full
 * interaction can be replayed/inspected after the fact. Defaults to
 * backend/logs/sardine-interactions.log — override with INTERACTION_LOG_FILE.
 * Gitignored (*.log) since real runs may contain PII (names, DOB).
 */
function logInteraction(type, data) {
  const entry = { timestamp: new Date().toISOString(), type, ...data };
  try {
    fs.mkdirSync(path.dirname(INTERACTION_LOG_FILE), { recursive: true });
    fs.appendFileSync(INTERACTION_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[log] failed to write interaction log:', err);
  }
}

const app = express();
app.use(cors());

// Capture the raw body so we can verify the webhook signature against the
// exact bytes Sardine signed. (Parsing first would change the bytes.)
app.use(
  bodyParser.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

/** Build the HTTP Basic auth header from clientId:clientSecret. */
function getAuthHeader() {
  if (!SARDINE_CLIENT_ID || !SARDINE_SECRET_KEY) {
    console.warn(
      '[warn] SARDINE_CLIENT_ID / SARDINE_SECRET_KEY are not set — calls to Sardine will 401. Copy .env.example to .env and fill them in.'
    );
  }
  const credentials = `${SARDINE_CLIENT_ID}:${SARDINE_SECRET_KEY}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

/**
 * POST /onboard  (two-step onboarding, step 1 — risk check with onboardingId)
 *
 * We don't have a permanent customer record yet — just a first + last name
 * from the onboarding screen — so per Sardine's two-step onboarding guide we
 * risk-check with a temporary `customer.onboardingId` instead of
 * `customer.id` (left blank). Mints a fresh onboardingId (kept for the whole
 * onboarding) + a sessionKey (unique per IDV attempt) and hands both back to
 * the browser, along with the risk `level` so the caller can decide whether
 * to continue to IDV (low/medium) or hold for manual review (high/very_high).
 */
app.post('/onboard', async (req, res) => {
  const { firstName, lastName } = req.body || {};

  if (!firstName || !lastName) {
    return res.status(400).json({ message: 'firstName and lastName are required' });
  }

  // onboardingId is kept for the ENTIRE onboarding (through /verify-token and
  // the webhook); sessionKey is unique to this one IDV attempt.
  // TEMP: hardcoded to a fixed test value while validating that both Sardine
  // calls use the onboardingId (not a customerId) — swap back to
  // crypto.randomUUID() once confirmed.
  const onboardingId = 'onboarding_id_test';
  const sessionKey = crypto.randomUUID();

  const payload = {
    customer: {
      onboardingId,
      createdAtMillis: Date.now(),
      firstName,
      lastName,
    },
    flow: { type: 'onboarding' },
    sessionKey,
    checkpoints: ['customer'],
  };

  console.log('[onboard] calling POST /v1/customers (risk check) for', firstName, lastName);

  try {
    const response = await fetch(`${SARDINE_API_URL}/v1/customers`, {
      method: 'POST',
      headers: {
        Authorization: getAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const json = await response.json();
    console.log('[onboard] /v1/customers response status:', response.status);
    console.log('[onboard] /v1/customers response body:', JSON.stringify(json, null, 2));
    logInteraction('customers:onboard', { request: payload, status: response.status, response: json });

    if (!response.ok) {
      return res.status(response.status).json({
        message: json.message || 'Sardine risk check failed',
        sardine: json,
      });
    }

    const level = json.level;
    const proceed = PROCEEDABLE_RISK_LEVELS.has(level);
    console.log('[onboard] risk level:', level, '| proceed to IDV:', proceed);

    // onboardingId + sessionKey now travel with this user through the rest
    // of the flow (verify-token below, and the document-verification
    // webhook, which upgrades onboardingId -> a permanent customerId).
    return res.status(200).json({
      message: proceed ? 'Risk check passed' : 'Additional review required',
      onboardingId,
      sessionKey,
      level,
      proceed,
      sardine: json,
    });
  } catch (err) {
    console.error('[onboard] error:', err);
    logInteraction('customers:onboard:error', { request: payload, error: String(err) });
    return res.status(502).json({ message: 'Failed to reach Sardine', error: String(err) });
  }
});

/**
 * POST /verify-token  (required)
 *
 * Mints the short-lived session token the Incode Web SDK needs to start.
 * sessionKey should be the same one minted by /onboard above. There's no
 * permanent customerId yet at this point in the flow (see the two-step
 * onboarding note at the top of this file) — the recommended mapping for
 * this integration is to pass the onboardingId in the `customerId` field
 * this endpoint expects, subject to confirming with your Sardine team that
 * your account is configured to accept that. Sardine echoes it back on the
 * document_verification.processed webhook, which is what lets the webhook
 * handler below associate the result with the right onboardingId.
 */
app.post('/verify-token', async (req, res) => {
  const sessionKey = req.body?.sessionKey || DEMO_SESSION_KEY;
  const customerId = req.body?.onboardingId || req.body?.customerId || DEMO_ONBOARDING_ID;

  const url = `${SARDINE_API_URL}/v1/identity-documents/tokens`;
  const payload = {
    sessionKey,
    customerId,
    provider: 'incode',
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: getAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const json = await response.json();
    // The SDK reads resp.data.access_token and resp.data.verification_id.
    return res.status(response.status).json({ message: 'Request received', data: json });
  } catch (err) {
    console.error('[verify-token] error:', err);
    return res.status(502).json({ message: 'Failed to mint token', error: String(err) });
  }
});

/**
 * GET /verify-results?id=<verification_id>  (DEBUG ONLY)
 *
 * Proxies the result-read API for in-browser debugging. Do NOT rely on this in
 * production — the document_verification.processed webhook is the source of truth.
 *
 * Test verificationIds: sardine-test-low | sardine-test-medium | sardine-test-high
 */
app.get('/verify-results', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ message: 'Missing ?id=<verification_id>' });

  const url = `${SARDINE_API_URL}/v1/identity-documents/verifications/${encodeURIComponent(id)}`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: getAuthHeader(),
        'Content-Type': 'application/json',
      },
    });
    const json = await response.json();
    return res.status(response.status).json({ message: 'Request received', data: json });
  } catch (err) {
    console.error('[verify-results] error:', err);
    return res.status(502).json({ message: 'Failed to read result', error: String(err) });
  }
});

/**
 * POST /webhooks/document-verification  (the real result path)
 * POST /webhooks/sardine                (alias — see note below)
 *
 * Sardine POSTs `document_verification.processed` here once Incode finishes.
 * Handler: verify signature -> match event -> read the result -> two-step
 * onboarding "Step 2": mint the permanent customerId (standing in for "your
 * system creates a customer record now that the user passed IDV") and call
 * POST /v1/feedbacks to link it back to the onboardingId from /onboard,
 * per https://docs.sardine.ai/guides/integration/integration-guides/onboarding/two-step-onboarding
 * -> 200 OK.
 *
 * Registered at BOTH paths: the webhook URL configured on your Sardine
 * account may still point at /webhooks/sardine (the path used elsewhere,
 * e.g. the React Native sample backend) rather than the
 * /webhooks/document-verification path this guide names. Confirm the exact
 * URL with your Sardine team / dashboard and drop whichever alias you don't
 * need once confirmed.
 */
async function handleDocumentVerificationWebhook(req, res) {
  // 1) Verify the signature so you only act on genuine Sardine events.
  //    TODO: confirm the exact header name + signing scheme with your Sardine
  //    team. The shape below (HMAC-SHA256 over the raw body) is a common
  //    pattern; adjust the header and comparison to match Sardine's docs.
  if (SARDINE_WEBHOOK_SECRET && SARDINE_WEBHOOK_SECRET !== 'your-webhook-signing-secret') {
    const signature = req.get('x-sardine-signature') || '';
    const expected = crypto
      .createHmac('sha256', SARDINE_WEBHOOK_SECRET)
      .update(req.rawBody || Buffer.from(''))
      .digest('hex');
    const ok =
      signature.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!ok) {
      console.warn('[webhook] signature mismatch — rejecting');
      return res.status(401).json({ message: 'Invalid signature' });
    }
  } else {
    console.warn('[webhook] SARDINE_WEBHOOK_SECRET not set — skipping signature check (dev only)');
  }

  // 2) Confirm the event type and read the result.
  const event = req.body || {};
  console.log('[webhook] raw payload:', JSON.stringify(event, null, 2));
  logInteraction('webhook:incoming', { path: req.path, event });

  if (event.type !== 'document_verification.processed') {
    logInteraction('webhook:ack', { path: req.path, status: 202, message: `Ignored event type: ${event.type}` });
    return res.status(202).json({ message: `Ignored event type: ${event.type}` });
  }

  const result = event.documentVerificationResult || {};
  const caseRef = event.data?.case || {};
  console.log('[webhook] document_verification.processed');
  console.log('  sessionKey :', caseRef.sessionKey);
  console.log('  customerID :', caseRef.customerID);
  console.log('  status     :', result.status);
  console.log('  riskLevel  :', result.verification?.riskLevel);
  console.log('  documentData:', JSON.stringify(result.documentData || {}, null, 2));

  // 3) Post-IDV sequence, all still keyed off the onboardingId:
  //      a) another POST /v1/customers checkpoint call — same onboardingId,
  //         now enriched with the data extracted from the verified document.
  //      b) wait 10s (test-only pacing).
  //      c) two-step onboarding "Step 2": POST /v1/feedbacks to upgrade the
  //         onboardingId to a permanent customerId.
  //    `caseRef.customerID` here holds whatever we passed as `customerId` to
  //    /v1/identity-documents/tokens — in this flow that's the onboardingId
  //    from /onboard (see the note on /verify-token above).
  //
  //    This runs in the BACKGROUND (not awaited) — we ack the webhook (step
  //    4 below) right away instead of making Sardine wait 10+ seconds for a
  //    response, since a webhook sender may retry a slow-to-ack delivery.
  const sessionKey = caseRef.sessionKey;
  const onboardingId = caseRef.customerID;
  const riskLevel = result.verification?.riskLevel;
  const doc = result.documentData || {};

  if (!sessionKey || !onboardingId) {
    console.warn('[webhook] missing sessionKey/customerID on event — skipping post-IDV calls');
  } else {
    runPostIdvSequence({ sessionKey, onboardingId, riskLevel, status: result.status, doc }).catch((err) => {
      console.error('[webhook] post-IDV sequence failed:', err);
    });
  }

  // 4) Acknowledge immediately. The post-IDV sequence above (if kicked off)
  // continues running in the background after this response is sent.
  logInteraction('webhook:ack', { path: req.path, status: 200, message: 'ok' });
  return res.status(200).json({ message: 'ok' });
}

/**
 * Runs after the webhook has already been acknowledged: a second customers
 * checkpoint call (still keyed off the onboardingId), then — after a 10s
 * test-only delay — the /v1/feedbacks call that upgrades the onboardingId to
 * a permanent customerId. Not awaited by the webhook handler.
 */
async function runPostIdvSequence({ sessionKey, onboardingId, riskLevel, status, doc }) {
  // 3a) Second customers checkpoint call — same onboardingId (NOT a
  //     customerId), now with the verified document data.
  const postIdvCustomersPayload = {
    customer: {
      onboardingId,
      firstName: doc.firstName,
      lastName: doc.lastName,
      dateOfBirth: doc.dateOfBirth,
    },
    flow: { type: 'onboarding' },
    sessionKey,
    checkpoints: ['customer'],
  };

  console.log('[webhook] calling POST /v1/customers (post-IDV) for onboardingId', onboardingId);

  try {
    const postIdvRes = await fetch(`${SARDINE_API_URL}/v1/customers`, {
      method: 'POST',
      headers: {
        Authorization: getAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(postIdvCustomersPayload),
    });
    const postIdvData = await postIdvRes.json();
    console.log('[webhook] post-IDV /v1/customers response status:', postIdvRes.status);
    console.log('[webhook] post-IDV /v1/customers response body:', JSON.stringify(postIdvData, null, 2));
    logInteraction('customers:post-idv', { request: postIdvCustomersPayload, status: postIdvRes.status, response: postIdvData });
  } catch (err) {
    console.error('[webhook] post-IDV /v1/customers call failed:', err);
    logInteraction('customers:post-idv:error', { request: postIdvCustomersPayload, error: String(err) });
  }

  // 3b) Test-only pacing — wait 10s before sending the feedback call.
  console.log('[webhook] waiting 10s before /v1/feedbacks...');
  await new Promise((resolve) => setTimeout(resolve, 10_000));

  // 3c) Stand-in for "your system creates a permanent customer record now
  // that the user passed IDV." A real integration would look this up /
  // create it in its own DB rather than using a fixed value here.
  // TEMP: hardcoded to a fixed test value while validating the /v1/feedbacks
  // call — swap back to crypto.randomUUID() (or a real customer record
  // lookup) once confirmed.
  const customerId = 'nbc_customer_id';
  const approved = status !== 'failed' && !['high', 'very_high'].includes(riskLevel);

  const feedbackPayload = {
    sessionKey,
    customer: {
      id: customerId,
      onboardingId,
    },
    kind: 'challenge', // per the guide: can be any valid value
    feedback: {
      id: crypto.randomUUID(),
      type: 'onboarding',
      status: approved ? 'approved' : 'rejected',
      reason: approved ? 'document verification passed' : `document verification risk level: ${riskLevel}`,
      processor: 'incode',
    },
  };

  console.log('[webhook] calling POST /v1/feedbacks — upgrading onboardingId', onboardingId, '-> customerId', customerId);

  try {
    const feedbackRes = await fetch(`${SARDINE_API_URL}/v1/feedbacks`, {
      method: 'POST',
      headers: {
        Authorization: getAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(feedbackPayload),
    });
    const feedbackData = await feedbackRes.json();
    console.log('[webhook] /v1/feedbacks response status:', feedbackRes.status);
    console.log('[webhook] /v1/feedbacks response body:', JSON.stringify(feedbackData, null, 2));
    logInteraction('feedbacks', { request: feedbackPayload, status: feedbackRes.status, response: feedbackData });

    // TODO: persist the onboardingId <-> customerId mapping in your DB.
    // Per the guide, all future requests/lookups should use `customerId`.
  } catch (err) {
    console.error('[webhook] /v1/feedbacks call failed:', err);
    logInteraction('feedbacks:error', { request: feedbackPayload, error: String(err) });
  }
}

app.post('/webhooks/document-verification', handleDocumentVerificationWebhook);
app.post('/webhooks/sardine', handleDocumentVerificationWebhook);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Sardine IDV backend running on http://localhost:${PORT}`);
  console.log(`  Sardine API base: ${SARDINE_API_URL}`);
});
