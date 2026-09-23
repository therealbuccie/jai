import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { JaiSupportWidget } from './JaiSupportWidget';

declare const __JAI_WIDGET_CSS__: string;

// Capture synchronously: currentScript is null inside DOMContentLoaded callbacks.
const script = document.currentScript;
const appId = script?.getAttribute('data-app-id')?.trim();
const productName = script?.getAttribute('data-product-name')?.trim() || 'Support';
const nonce = script instanceof HTMLScriptElement ? script.nonce : '';
if (!appId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId)) {
  console.error('JAI widget: a valid data-app-id is required.');
} else {
  const mount = () => {
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
      supabaseUrl: 'https://ahsxnoqfbqpacbrygdxh.supabase.co',
    }));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}
