import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { JaiSupportWidget } from './JaiSupportWidget';

declare const __JAI_WIDGET_CSS__: string;

// Capture synchronously: currentScript is null inside DOMContentLoaded callbacks.
const script = document.currentScript;
const appId = script?.getAttribute('data-app-id')?.trim();
const nonce = script instanceof HTMLScriptElement ? script.nonce : '';
if (!appId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId)) {
  console.error('JAI widget: a valid data-app-id is required.');
} else {
  const backendUrl = 'https://ahsxnoqfbqpacbrygdxh.supabase.co';
  let root: ReturnType<typeof createRoot> | undefined;
  let productName = 'JAI';
  let verifiedSessionToken: string | undefined;
  let identityVersion = 0;
  const render = () => root?.render(createElement(JaiSupportWidget, {
    key: identityVersion,
    appId,
    productName,
    verifiedSessionToken,
    // Public JAI endpoint, not a credential or customer-specific configuration.
    supabaseUrl: backendUrl,
  }));
  // A site backend signs the assertion. Browser values are never identity proof.
  (window as Window & { JAIConnect?: {
    identify: (assertion: string) => Promise<void>;
    clear: () => void;
  } }).JAIConnect = {
    async identify(assertion) {
      if (typeof assertion !== 'string' || !assertion || assertion.length > 4096) throw new Error('Invalid JAI identity assertion.');
      const version = ++identityVersion;
      const response = await fetch(`${backendUrl}/functions/v1/widget-connect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, assertion }), redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('JAI identity verification failed.'); }
      const session: unknown = await response.json();
      if (typeof session !== 'object' || session === null || !('sessionToken' in session) ||
        typeof session.sessionToken !== 'string' || !/^[0-9a-f]{64}$/i.test(session.sessionToken) ||
        !('expiresAt' in session) || typeof session.expiresAt !== 'string' ||
        Date.parse(session.expiresAt) <= Date.now() ||
        !('identityLevel' in session) || session.identityLevel !== 'product_verified') {
        throw new Error('JAI identity verification failed.');
      }
      if (version !== identityVersion) return; // A newer identity or logout won.
      verifiedSessionToken = session.sessionToken; // Never persist verified sessions in browser storage.
      render();
    },
    clear() {
      identityVersion++;
      verifiedSessionToken = undefined;
      render();
    },
  };
  const mount = async () => {
    try {
      const response = await fetch(`${backendUrl}/functions/v1/widget-session?appId=${encodeURIComponent(appId)}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        const app: unknown = await response.json();
        if (typeof app === 'object' && app !== null && 'name' in app &&
          typeof app.name === 'string' && app.name.trim()) productName = app.name.trim();
      } else await response.body?.cancel();
    } catch { /* The widget remains usable if the name lookup is temporarily unavailable. */ }
    const hostId = `jai-widget-${appId.toLowerCase()}`;
    if (document.getElementById(hostId)) return;
    const host = document.createElement('div');
    host.id = hostId;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    if (nonce) style.nonce = nonce;
    style.textContent = ':host { all: initial; }\n' + __JAI_WIDGET_CSS__;
    const container = document.createElement('div');
    shadow.append(style, container);
    document.body.append(host);
    root = createRoot(container);
    render();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void mount(); }, { once: true });
  else void mount();
}
