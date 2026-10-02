import { defineConfig, loadEnv } from 'vite';

/**
 * Dev server config tuned for testing on a real phone via ngrok (HTTPS).
 *
 * Why each piece matters:
 * - host: true            -> bind 0.0.0.0 so a tunnel / LAN device can reach it.
 * - allowedHosts          -> Vite blocks unknown Host headers by default; allow
 *                            the ngrok domain (set VITE_PUBLIC_URL to your tunnel).
 * - hmr (wss / 443)       -> over an HTTPS tunnel, hot-reload must use wss:443 or
 *                            the client can't connect.
 * - proxy                 -> the phone loads the page via the tunnel origin, so
 *                            "localhost:8080" would point at the PHONE, not your
 *                            machine. Proxy the backend routes through this same
 *                            origin so token minting works from the phone.
 *
 * Usage:
 *   1) terminal A: cd backend && npm start          (Express on :8080)
 *   2) terminal B: cd frontend && npm run dev        (Vite on :5173)
 *   3) terminal C: ngrok http 5173                   (copy the https URL)
 *   4) set VITE_PUBLIC_URL=<that https url> in frontend/.env, restart `npm run dev`
 *   5) reload desktop -> the QR now encodes the HTTPS tunnel URL -> scan on phone
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const publicUrl = env.VITE_PUBLIC_URL; // e.g. https://abc123.ngrok-free.app
  const tunnelHost = publicUrl ? new URL(publicUrl).host : undefined;
  const backendTarget = env.VITE_BACKEND_PROXY_TARGET || 'http://localhost:8080';

  return {
    server: {
      host: true, // bind to 0.0.0.0 so phone / tunnel can reach it
      port: 5173,
      strictPort: true,
      // true = allow any host (simplest for dev). Or restrict to the tunnel host.
      allowedHosts: tunnelHost ? [tunnelHost] : true,
      hmr: publicUrl ? { protocol: 'wss', host: tunnelHost, clientPort: 443 } : undefined,
      // Same-origin backend calls (frontend fetches "/verify-token", not an
      // absolute localhost URL) get forwarded to the local Express server.
      proxy: {
        '/onboard': { target: backendTarget, changeOrigin: true },
        '/verify-token': { target: backendTarget, changeOrigin: true },
        '/verify-results': { target: backendTarget, changeOrigin: true },
        '/webhooks': { target: backendTarget, changeOrigin: true },
      },
    },
  };
});
