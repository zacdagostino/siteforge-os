import { useEffect, useState } from 'react';

function previewSourceUrl() {
  const query = window.location.hash.slice('#/preview?'.length);
  const source = new URLSearchParams(query).get('source');
  if (!source) return undefined;
  try {
    const url = new URL(source);
    if (
      url.protocol !== 'https:' ||
      !url.hostname.endsWith('.supabase.co') ||
      !url.pathname.startsWith('/functions/v1/siteforge-preview/')
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

export function PreviewFrame() {
  const [source, setSource] = useState(previewSourceUrl);
  const [documentHtml, setDocumentHtml] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!source) {
      setError('This private preview link is invalid. Return to SiteForge and open it again.');
      return;
    }
    const controller = new AbortController();
    void fetch(source, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('The private preview is unavailable or has expired.');
        return response.text();
      })
      .then(setDocumentHtml)
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
        setError(
          reason instanceof Error ? reason.message : 'The private preview could not be loaded.',
        );
      });
    return () => controller.abort();
  }, [source]);

  useEffect(() => {
    if (!source) return;
    const root = source.pathname.slice(0, source.pathname.lastIndexOf('/') + 1);
    const navigate = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'object' || event.data === null) return;
      const message = event.data as { type?: unknown; href?: unknown };
      if (message.type !== 'siteforge-preview:navigate' || typeof message.href !== 'string') return;
      try {
        const next = new URL(message.href);
        if (next.origin !== source.origin || !next.pathname.startsWith(root)) return;
        next.hash = '';
        window.history.replaceState(null, '', `#/preview?source=${encodeURIComponent(next.href)}`);
        setDocumentHtml(undefined);
        setError(undefined);
        setSource(next);
      } catch {
        // Ignore malformed messages from the sandboxed preview document.
      }
    };
    window.addEventListener('message', navigate);
    return () => window.removeEventListener('message', navigate);
  }, [source]);

  const csp = source
    ? `default-src 'none'; img-src data: blob: ${source.origin}; style-src 'unsafe-inline' ${source.origin}; script-src 'unsafe-inline' ${source.origin}; font-src data: ${source.origin}; connect-src 'none'; form-action 'none'; base-uri ${source.origin}`
    : '';
  const sandboxedHtml =
    documentHtml && source ? preparePreviewDocument(documentHtml, csp) : undefined;

  if (error)
    return (
      <main className="preview-message">
        <h1>Preview unavailable</h1>
        <p>{error}</p>
      </main>
    );
  if (!documentHtml)
    return (
      <main className="preview-message" aria-live="polite">
        <p>Loading private preview…</p>
      </main>
    );
  return (
    <iframe
      className="private-preview-frame"
      sandbox="allow-scripts allow-top-navigation-by-user-activation"
      srcDoc={sandboxedHtml}
      title="Private website preview"
    />
  );
}

function preparePreviewDocument(documentHtml: string, csp: string) {
  const document = new DOMParser().parseFromString(documentHtml, 'text/html');
  const cspMeta = document.createElement('meta');
  cspMeta.httpEquiv = 'Content-Security-Policy';
  cspMeta.content = csp;
  document.head.prepend(cspMeta);
  const navigationBridge = document.createElement('script');
  navigationBridge.text = `
    (() => {
      const base = new URL(document.baseURI);
      const root = base.pathname.endsWith('/') ? base.pathname : base.pathname + '/';
      document.addEventListener('click', (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
        if (!link || link.target || link.hasAttribute('download')) return;
        const next = new URL(link.href, document.baseURI);
        if (next.origin !== base.origin || !next.pathname.startsWith(root)) return;
        event.preventDefault();
        parent.postMessage({ type: 'siteforge-preview:navigate', href: next.href }, '*');
      }, true);
    })();
  `;
  document.head.append(navigationBridge);
  return `<!doctype html>${document.documentElement.outerHTML}`;
}
