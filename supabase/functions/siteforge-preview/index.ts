import { createClient } from 'npm:@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for private previews.');
}

const client = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function response(status: number, body = 'Not found') {
  return new Response(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

async function tokenHash(token: string) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseRequest(request: Request) {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean);
  const functionIndex = parts.indexOf('siteforge-preview');
  if (functionIndex === -1) return undefined;
  const runId = parts[functionIndex + 1];
  const token = parts[functionIndex + 2];
  const requestedPath = parts.slice(functionIndex + 3);
  const previewMode = requestedPath[0] === '__draft__' ? 'draft' : 'ready';
  const filePath =
    (previewMode === 'draft' ? requestedPath.slice(1) : requestedPath).join('/') || 'index.html';
  if (!runId || !token || !/^[a-f0-9]{64}$/i.test(token)) return undefined;
  if (filePath.includes('..') || filePath.startsWith('/') || !/^[a-zA-Z0-9._/-]+$/.test(filePath)) {
    return undefined;
  }
  return { runId, token, filePath, previewMode };
}

function previewCsp() {
  return [
    "default-src 'self' data: blob:",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'self'",
  ].join('; ');
}

const previewNavigationScript = `
  (() => {
    window.__siteforgePreviewNavigator = true;
    const base = new URL(document.baseURI);
    const root = base.pathname.endsWith('/') ? base.pathname : base.pathname + '/';
    document.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!target || target.target || target.hasAttribute('download')) return;
      const next = new URL(target.href, document.baseURI);
      if (next.origin !== base.origin || !next.pathname.startsWith(root)) return;
      event.preventDefault();
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'siteforge-preview:navigate', href: next.href }, '*');
        return;
      }
      window.location.assign(next.href);
    }, true);
  })();
`;

// Artifact metadata is user-worker supplied and may be absent or stale for an
// existing frozen draft. The path is the authoritative source for the browser
// MIME type, otherwise a valid HTML document can be served as plain text.
function contentTypeFor(filePath: string) {
  const extension = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return (
    {
      '.css': 'text/css; charset=utf-8',
      '.gif': 'image/gif',
      '.html': 'text/html; charset=utf-8',
      '.ico': 'image/x-icon',
      '.jpeg': 'image/jpeg',
      '.jpg': 'image/jpeg',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
    }[extension] || 'application/octet-stream'
  );
}

Deno.serve(async (request) => {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return response(405, 'Method not allowed');
  const parsed = parseRequest(request);
  if (!parsed) return response(404);

  const hash = await tokenHash(parsed.token);
  const { data: access, error: accessError } = await client
    .from('builder_preview_access')
    .select('expires_at, revoked_at, builder_run_id, preview_mode')
    .eq('builder_run_id', parsed.runId)
    .eq('token_hash', hash)
    .is('revoked_at', null)
    .maybeSingle();
  if (
    accessError ||
    !access ||
    access.preview_mode !== parsed.previewMode ||
    new Date(access.expires_at).getTime() <= Date.now()
  )
    return response(404);

  const { data: run, error: runError } = await client
    .from('builder_runs')
    .select('organization_id, status')
    .eq('id', parsed.runId)
    .maybeSingle();
  if (
    runError ||
    !run ||
    (parsed.previewMode === 'ready' &&
      run.status !== 'ready' &&
      run.status !== 'review_required') ||
    (parsed.previewMode === 'draft' &&
      run.status !== 'running' &&
      run.status !== 'paused' &&
      run.status !== 'failed' &&
      run.status !== 'cancelled')
  ) {
    return response(404);
  }

  if (parsed.filePath === '__siteforge_preview_navigation__.js') {
    return new Response(previewNavigationScript, {
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'no-store, private',
        'content-type': 'text/javascript; charset=utf-8',
        'content-security-policy': previewCsp(),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      },
    });
  }

  const artifactKind = parsed.previewMode === 'draft' ? 'draft_file' : 'site_file';
  const artifactPrefix = parsed.previewMode === 'draft' ? 'draft' : 'site';
  const storagePath = `${run.organization_id}/builder-runs/${parsed.runId}/${artifactPrefix}/${parsed.filePath}`;
  const { data: artifact, error: artifactError } = await client
    .from('builder_artifacts')
    .select('content_type')
    .eq('builder_run_id', parsed.runId)
    .eq('kind', artifactKind)
    .eq('storage_path', storagePath)
    .maybeSingle();
  if (artifactError || !artifact) return response(404);

  const { data: file, error: downloadError } = await client.storage
    .from('siteforge-artifacts')
    .download(storagePath);
  if (downloadError || !file) return response(404);

  const headers = new Headers({
    'access-control-allow-origin': '*',
    'cache-control': 'no-store, private',
    'content-security-policy': previewCsp(),
    'content-type': contentTypeFor(parsed.filePath),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  if (request.method === 'HEAD') return new Response(null, { headers });

  if (parsed.filePath.toLowerCase().endsWith('.html')) {
    const draftPrefix = parsed.previewMode === 'draft' ? '__draft__/' : '';
    const base = `${supabaseUrl}/functions/v1/siteforge-preview/${parsed.runId}/${parsed.token}/${draftPrefix}`;
    const navigationScript = `<script src="${base}__siteforge_preview_navigation__.js" defer></script>`;
    const source = await file.text();
    const htmlWithHead = source.replace(
      /<head(\s[^>]*)?>/i,
      (match) => `${match}<base href="${base}">${navigationScript}`,
    );
    const html = htmlWithHead === source ? `${navigationScript}${source}` : htmlWithHead;
    headers.set('content-type', 'text/html; charset=utf-8');
    return new Response(html, { headers });
  }
  return new Response(file.stream(), { headers });
});
