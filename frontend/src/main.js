/**
 * Sardine IDV — Incode Web SDK 2.0 lifecycle (NPM integration)
 *
 * Ported from the Web SDK 1.x (`@incodetech/welcome`) version to Web SDK 2.0
 * (`@incodetech/web` + `@incodetech/core`). 2.0 is Web-Component based: each
 * step is an `<incode-*>` element you mount, set `config` / `onFinish` /
 * `onError` on, and remove when done.
 *
 * Flow: onboarding form (customer checkpoint #1, POST /onboard) -> fetch token
 *       from backend (carrying the sessionKey/customerId from onboarding) ->
 *       setup() SDK -> consent -> ID (front, back if two-sided, and ID
 *       processing are all handled inside <incode-id>) -> selfie ->
 *       getFinishStatus.
 * The IDV result — and the follow-up customer checkpoint #2 — arrive
 * asynchronously on the BACKEND via the document_verification.processed
 * webhook. That is the source of truth; this page never sees it directly.
 */

import './debug.js'; // optional on-screen debug panel (add ?debug=1 to the URL)
import { setup } from '@incodetech/web';
import { isDesktopOrEmulated } from '@incodetech/core/device';
import { getFinishStatus } from '@incodetech/core/session';
// Registers the <incode-consent>, <incode-id> and <incode-selfie> elements.
import '@incodetech/web/base.css';
// Built-in light theme tokens. Required because setup() runs with `theme: false`
// (no dashboard theme) — without it the SDK screens render unstyled.
import '@incodetech/web/themes/light.css';
import '@incodetech/web/consent';
import '@incodetech/web/consent/styles.css';
import '@incodetech/web/id';
import '@incodetech/web/id/styles.css';
import '@incodetech/web/selfie';
import '@incodetech/web/selfie/styles.css';
import QRCode from 'qrcode';

console.log('[sardine] main.js module loaded');

// Vite injects import.meta.env.VITE_* at build time.
// The API URL must end in `/0` (no trailing slash). In Web SDK 2.0 the `/0`
// suffix is what lets Incode read the API key from the session token — and the
// token here is minted by Sardine, so we never hold that key. Without `/0`
// the SDK's requests (esp. the WASM client's) are rejected with HTTP 403.
const apiUrl = `${(import.meta.env.VITE_INCODE_API_URL || 'https://demo-api.incodesmile.com')
  .replace(/\/0?\/?$/, '')}/0`;
const consentId = import.meta.env.VITE_CONSENT_ID || '{PROVIDED_BY_SARDINE}';
// Default to SAME-ORIGIN ('') so calls go to "/verify-token" and are forwarded
// by the Vite proxy (see vite.config.js) to the local Express server. This is
// what lets a phone (loading the page via the ngrok tunnel) reach the backend —
// "localhost:8080" would resolve to the phone itself. Set VITE_BACKEND_URL only
// if you deliberately host the backend at a separate absolute URL.
const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

console.log('[sardine] config', { apiUrl, backendUrl, consentId });

const incodeContainer = document.querySelector('#verify-container');

// Render a status / error message into the verify container so failures are
// visible instead of leaving a blank page.
function showMessage(html, isError = false) {
  incodeContainer.innerHTML =
    `<div class="sardine-status${isError ? ' sardine-error' : ''}">${html}</div>`;
}

function hideHeader() {
  const header = document.querySelector('.sardine-header');
  if (header) header.style.display = 'none';
}

// Surface any uncaught error or promise rejection on the page itself.
window.addEventListener('error', (e) => {
  console.error('Uncaught error:', e.error || e.message);
  showMessage(`<strong>Something went wrong initializing verification.</strong><br/>${e.message}`, true);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled rejection:', e.reason);
  showMessage(`<strong>Verification failed to start.</strong><br/>${e.reason?.message || e.reason}`, true);
});

// Mount an <incode-*> Web Component into the verify container. Each element
// takes `config`, `onFinish` and `onError` as JS properties (not attributes).
function mountModule(tag, { config, onFinish, onError }) {
  incodeContainer.innerHTML = '';
  const el = document.createElement(tag);
  el.config = config;
  // Defer the callbacks so the next step mounts AFTER the current module has
  // finished rendering/committing. Swapping the DOM synchronously from inside
  // onFinish/onError crashes Preact ("undefined is not an object (evaluating
  // 'n2.__H.__h = []')" on Safari).
  el.onFinish = (...args) => setTimeout(() => onFinish?.(...args), 0);
  el.onError = (...args) => setTimeout(() => onError?.(...args), 0);
  incodeContainer.appendChild(el);
  return el;
}

// sessionKey / onboardingId come from the onboarding step (POST /onboard)
// below and are threaded into /verify-token. There's no permanent customerId
// yet at this point — see the two-step onboarding note in backend/server.js.
async function app({ sessionKey, onboardingId } = {}) {
  console.log('[sardine] app() started', { sessionKey, onboardingId });
  const session = {};

  incodeContainer.hidden = false;
  showMessage('Initializing secure verification…');

  // 1. Get a session token from your backend.
  async function init() {
    console.log('[sardine] init() — fetching token from', `${backendUrl}/verify-token`);
    try {
      const response = await fetch(`${backendUrl}/verify-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // sessionKey + onboardingId come from the onboarding step (/onboard)
        // above — the backend uses onboardingId as the customerId this
        // endpoint expects, since no permanent customerId exists yet. Falls
        // back to demo values on the backend if omitted.
        body: JSON.stringify({ sessionKey, onboardingId }),
      });
      console.log('[sardine] /verify-token response status:', response.status);
      if (!response.ok) throw new Error(`Token request failed: ${response.status}`);
      const resp = await response.json();
      console.log('[sardine] /verify-token response body:', resp);
      session.token = resp.data.access_token;
      session.id = resp.data.verification_id;
      console.log('[sardine] Sardine token received (access_token + verification_id set)');
    } catch (error) {
      console.error('[sardine] Could not start verification:', error);
      showMessage(`<strong>Could not fetch verification token.</strong><br/>${error?.message || error}`, true);
    }
  }

  // 2. Show the data-sharing consent screen.
  const showConsent = () => {
    console.log('[sardine] showConsent() — consentId:', consentId);
    // Keep the Sardine header/logo visible during consent. The SDK's own
    // fixed full-viewport container is neutralized for this step via the
    // `#verify-container.consent-step .IncodeDefaultComponentContainer`
    // override in style.css — see that block before re-adding hideHeader().
    if (!consentId || consentId.includes('PROVIDED_BY_SARDINE')) {
      showMessage(
        `<strong>Missing consentId.</strong><br/>Set <code>VITE_CONSENT_ID</code> in ` +
          `<code>frontend/.env</code> to the value from your Sardine team, then reload.`,
        true
      );
      return;
    }
    incodeContainer.classList.add('consent-step'); // shows the Sardine logo at top (CSS ::before)
    mountModule('incode-consent', {
      config: { consentId },
      onFinish: () => {
        console.log('[sardine] consent onFinish fired');
        captureId();
      },
      onError: (err) => {
        console.error('[sardine] consent onError:', err);
        showMessage(`<strong>Consent step failed.</strong><br/>${err?.message || err || ''}`, true);
      },
    });
  };

  // Camera screens must be fullscreen (per Incode's styling guidance). Hide the
  // Sardine page chrome during capture so the camera isn't squeezed into the
  // small, flex-centered container — which is what was causing the blank screen.
  const header = document.querySelector('.sardine-header');
  const qrEl = document.getElementById('qrcode');
  const setCaptureMode = (on) => {
    if (header) header.style.display = on ? 'none' : '';
    if (qrEl) qrEl.style.display = on ? 'none' : '';
    // Web SDK 2.0's camera view is `height: 100%` with an absolutely-positioned
    // video, so its container must have a real height or it collapses to 0 and the
    // page looks blank. `capture-active` makes the container full-screen (style.css).
    incodeContainer.classList.toggle('capture-active', on);
    syncCaptureHeight();
  };

  // On iOS (Chrome/Safari) `100vh`/`100dvh` can include the area hidden behind the
  // browser's bottom toolbar, which pushes the SDK's bottom button ("Scan the back",
  // "Continue" …) out of sight. Size the full-screen container from the real visible
  // viewport instead, and keep it in sync as the toolbars show/hide or the phone rotates.
  const syncCaptureHeight = () => {
    if (incodeContainer.classList.contains('capture-active')) {
      const h = window.visualViewport?.height || window.innerHeight;
      incodeContainer.style.height = `${Math.round(h)}px`;
    } else {
      incodeContainer.style.height = '';
    }
  };
  window.addEventListener('resize', syncCaptureHeight);
  window.addEventListener('orientationchange', syncCaptureHeight);
  window.visualViewport?.addEventListener('resize', syncCaptureHeight);

  // getUserMedia only works in a secure context. On a phone over http (e.g. a
  // LAN IP) the camera silently fails -> blank. Detect and explain.
  const cameraErrorMessage = () => {
    if (!window.isSecureContext) {
      return (
        `<strong>The camera can’t start.</strong><br/>This page is served over an ` +
        `insecure connection, and phone browsers only allow the camera over HTTPS.<br/>` +
        `Expose the dev server with a tunnel (ngrok / Tailscale / Localtunnel) and ` +
        `scan the HTTPS QR, or run capture on the same machine via <code>localhost</code>.`
      );
    }
    return `<strong>The camera step failed.</strong><br/>Check camera permissions and try again.`;
  };

  // Optional: react to camera permission changes.
  const checkCameraPermission = async () => {
    try {
      const status = await navigator.permissions.query({ name: 'camera' });
      const handle = (e) => console.log('Camera permission:', e.target.state);
      status.onchange = handle;
      handle({ target: status });
    } catch (error) {
      console.error('Camera permission check failed:', error);
    }
  };

  // 3. Capture the ID. <incode-id> runs the whole sequence — front, back (when
  // the document is two-sided), quality checks and the ID processing call —
  // so the 1.x renderCamera('front'/'back') + processId() steps collapse into one.
  const captureId = () => {
    console.log('[sardine] captureId()');
    checkCameraPermission();
    incodeContainer.classList.remove('consent-step'); // hide consent logo before fullscreen camera
    setCaptureMode(true); // fullscreen capture — hide Sardine page chrome
    try {
      mountModule('incode-id', {
        // enableId/enablePassport: with `flow: false` there is no dashboard config
        // telling the module which documents to accept, so enable them here.
        config: {
          showTutorial: false,
          captureAttempts: 3,
          enableId: true,
          enablePassport: true,
          // Show the "choose how to verify" screen (ID card vs passport) before capture.
          showDocumentChooserScreen: true,
        },
        onFinish: () => {
          console.log('[sardine] ID capture + processing finished');
          captureSelfie();
        },
        onError: (error) => {
          // In 2.0 onError is a fatal module error (the SDK handles per-attempt
          // retries itself via captureAttempts). Offer a clean retry.
          console.error('[sardine] ID capture onError', error);
          setCaptureMode(false);
          showRetry(error ? `<strong>ID capture failed.</strong><br/>${error}` : cameraErrorMessage(), captureId);
        },
      });
    } catch (err) {
      console.error('[sardine] mounting incode-id threw:', err);
      setCaptureMode(false);
      showMessage(cameraErrorMessage(), true);
    }
  };

  // Error message + a button to restart the failed step.
  const showRetry = (html, retryFn) => {
    showMessage(html, true);
    const btn = document.createElement('button');
    btn.className = 'sardine-button';
    btn.type = 'button';
    btn.textContent = 'Try again';
    btn.addEventListener('click', retryFn);
    incodeContainer.appendChild(btn);
  };

  // Finish: tell Incode the session is complete. Matches the 1.x behaviour of
  // calling getFinishStatus on both success and failure of the selfie step; the
  // verification result itself still arrives via the Sardine webhook.
  const finish = async () => {
    try {
      await getFinishStatus(null);
    } catch (error) {
      console.warn('[sardine] getFinishStatus failed (continuing):', error);
    }
    showSubmitted();
  };

  // 4. Capture the selfie and finish.
  const captureSelfie = () => {
    console.log('[sardine] captureSelfie()');
    try {
      mountModule('incode-selfie', {
        config: { showTutorial: true, captureAttempts: 3 },
        onFinish: async () => {
          console.log('[sardine] selfie onFinish');
          await finish();
        },
        onError: async (error) => {
          console.error('[sardine] selfie onError', error);
          await finish();
        },
      });
    } catch (err) {
      console.error('[sardine] mounting incode-selfie threw:', err);
      setCaptureMode(false);
      showMessage(cameraErrorMessage(), true);
    }
  };

  // Simple "submitted" confirmation (Sardine-branded via style.css).
  const showSubmitted = () => {
    setCaptureMode(false); // restore Sardine page chrome
    incodeContainer.innerHTML =
      '<div class="sardine-done"><h2>Verification submitted</h2>' +
      '<p>Thanks — we’re reviewing your documents. You can close this window.</p></div>';
  };

  // Desktop has no usable camera flow — send the user to their phone via QR.
  const generateQRCode = () => {
    // Replace localhost with the LAN IP so a phone can actually reach the page.
    const publicUrl = import.meta.env.VITE_PUBLIC_URL;
    const qrUrl = publicUrl
      ? location.href.replace(/https?:\/\/[^/]+/, publicUrl)
      : location.href.replace(/localhost|127\.0\.0\.1/, '192.168.1.99');
    console.log('[sardine] generateQRCode() — URL to encode:', qrUrl);
    const el = document.getElementById('qrcode');
    el.innerHTML = '';
    incodeContainer.innerHTML = ''; // clear the loading message

    const canvas = document.createElement('canvas');
    el.appendChild(canvas);

    QRCode.toCanvas(canvas, qrUrl, { width: 228 }, (error) => {
      if (error) {
        console.error('[sardine] QR render failed, falling back to a link:', error);
        el.innerHTML = `<a href="${qrUrl}" class="sardine-link">Open this page on your phone</a>`;
      } else {
        console.log('[sardine] QR code rendered successfully');
      }
    });

    const note = document.createElement('p');
    note.className = 'sardine-tagline';
    note.textContent = 'Scan with your phone to verify your ID (camera required).';
    el.appendChild(note);
  };

  // STEP 1 (per the guide's "How it works"): mint the Sardine-issued session
  // token. This is the call to Sardine — it must happen before the SDK can
  // start, on whichever device loads the page (desktop included). The browser
  // calls our backend, which holds the clientSecret and calls Sardine.
  await init();
  if (!session.token) return; // init() already surfaced the error on screen

  // Web SDK 2.0: setup() needs the token up front (1.x called create() first,
  // then passed the token to each step).
  try {
    console.log('[sardine] calling setup() with apiURL:', apiUrl);
    await setup({
      apiURL: apiUrl,
      token: session.token,
      // The Sardine-minted token is not tied to an Incode dashboard flow, so
      // don't try to load/merge a dashboard flow or theme — modules get their
      // config from the objects below and Sardine branding comes from style.css.
      flow: false,
      theme: false,
      // Pre-warm the on-device ML (WASM) used by ID and selfie capture.
      wasm: { pipelines: ['idCapture', 'selfie'] },
    });
    console.log('[sardine] setup() succeeded');
  } catch (error) {
    console.error('SDK setup() failed:', error);
    showMessage(
      `<strong>Could not initialize the verification SDK.</strong><br/>` +
        `Check the Incode <code>apiURL</code> (it must end in <code>/0</code>) and your network.<br/>` +
        `<small>${error?.message || error}</small>`,
      true
    );
    return;
  }

  const isDesktop = isDesktopOrEmulated();
  console.log('[sardine] routing — isDesktop:', isDesktop, 'userAgent:', navigator.userAgent);
  if (isDesktop) {
    // Desktop has no usable camera — hand off to mobile to complete capture.
    generateQRCode();
  } else {
    // Mobile: token is already in hand, go straight to consent + capture.
    showConsent();
  }
}

// STEP 0: name-only onboarding — two-step onboarding risk check (POST
// /onboard on the backend, which calls Sardine POST /v1/customers with a
// provisional onboardingId — no permanent customerId exists yet). Only if
// that check says to proceed (`data.proceed`) do we hand off to the existing
// IDV flow (app()) above, which is unchanged.
function initOnboarding() {
  const form = document.querySelector('#onboarding-form');
  const errorEl = document.querySelector('#onboarding-error');
  const submitBtn = document.querySelector('#onboarding-submit');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.hidden = true;
    errorEl.classList.remove('sardine-error');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Please wait…';

    const firstName = form.firstName.value.trim();
    const lastName = form.lastName.value.trim();

    try {
      console.log('[sardine] onboarding submit — calling /onboard');
      const response = await fetch(`${backendUrl}/onboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName }),
      });
      const data = await response.json();
      console.log('[sardine] /onboard response status:', response.status, 'body:', data);

      if (!response.ok) {
        throw new Error(data.message || `Onboarding failed: ${response.status}`);
      }

      if (!data.proceed) {
        // Risk level came back high/very_high — per the two-step onboarding
        // guide, hold for manual review instead of continuing to IDV.
        errorEl.hidden = false;
        errorEl.textContent = `We need a little more time to review your information (risk level: ${data.level}). We'll follow up shortly.`;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Continue';
        return;
      }

      // Risk check passed — hide the form and start the (unchanged) IDV
      // flow, carrying the sessionKey + onboardingId Sardine just minted.
      form.hidden = true;
      await app({ sessionKey: data.sessionKey, onboardingId: data.onboardingId });
    } catch (error) {
      console.error('[sardine] onboarding failed:', error);
      errorEl.hidden = false;
      errorEl.classList.add('sardine-error');
      errorEl.textContent = error?.message || 'Something went wrong. Please try again.';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Continue';
    }
  });
}

document.addEventListener('DOMContentLoaded', initOnboarding);
