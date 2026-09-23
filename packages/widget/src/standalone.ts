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
  const mount = async () => {
    let productName = 'JAI';
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
    createRoot(container).render(createElement(JaiSupportWidget, {
      appId,
      productName,
      // Public JAI endpoint, not a credential or customer-specific configuration.
      supabaseUrl: backendUrl,
    }));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void mount(); }, { once: true });
  else void mount();
}
