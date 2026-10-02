/**
 * On-screen debug panel for phones (no dev tools needed).
 * Enable by adding `?debug=1` to the page URL, e.g. https://<ngrok-host>/?debug=1
 * Shows console.log/warn/error output, uncaught errors, and a once-a-second
 * snapshot of what the verification container is actually showing (visible text,
 * buttons, size) so a stuck screen can be diagnosed from a screenshot.
 */
if (new URLSearchParams(location.search).has('debug')) {
  const panel = document.createElement('pre');
  panel.id = 'sardine-debug';
  panel.style.cssText =
    'position:fixed;top:0;left:0;right:0;max-height:38vh;overflow:auto;margin:0;padding:6px;' +
    'z-index:2147483647;background:rgba(0,0,0,.88);color:#7CFC00;font:10px/1.35 ui-monospace,Menlo,monospace;' +
    'white-space:pre-wrap;word-break:break-word;pointer-events:none;';
  const lines = [];
  const push = (kind, args) => {
    const text = args
      .map((a) => {
        try { return typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}` : JSON.stringify(a); }
        catch { return String(a); }
      })
      .join(' ');
    lines.push(`${new Date().toISOString().slice(11, 19)} ${kind} ${text}`.slice(0, 400));
    if (lines.length > 60) lines.shift();
    panel.textContent = lines.join('\n');
    panel.scrollTop = panel.scrollHeight;
  };
  for (const kind of ['log', 'warn', 'error']) {
    const orig = console[kind].bind(console);
    console[kind] = (...args) => { orig(...args); push(kind === 'log' ? 'L' : kind === 'warn' ? 'W' : 'E', args); };
  }
  window.addEventListener('error', (e) => push('E!', [e.message, e.filename ? `${e.filename}:${e.lineno}` : '']));
  window.addEventListener('unhandledrejection', (e) => push('E!', ['unhandled', e.reason]));
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(panel));
  let last = '';
  setInterval(() => {
    const c = document.querySelector('#verify-container');
    if (!c) return;
    const r = c.getBoundingClientRect();
    const btns = [...c.querySelectorAll('button')].map((b) => {
      const br = b.getBoundingClientRect();
      return `${(b.innerText || '').trim().slice(0, 18)}@y${Math.round(br.top)}-${Math.round(br.bottom)}${b.disabled ? ' (disabled)' : ''}`;
    });
    const sig = `UI vp=${innerWidth}x${innerHeight} box=${Math.round(r.width)}x${Math.round(r.height)} cls="${c.className}" ` +
      `text="${(c.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 110)}" buttons=[${btns.join(' | ')}]`;
    if (sig !== last) { last = sig; push('UI', [sig]); }
  }, 1000);
}
