import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { hostname, tmpdir } from 'node:os';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  chmod,
} from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';
import { createDiagnosticWriter, diagnosticText } from './diagnostics.mjs';
import { normaliseSourceUrl, sourcePagePlan } from './source-page-plan.mjs';

const artifactBucket = 'siteforge-artifacts';
const workerRoot = fileURLToPath(new URL('.', import.meta.url));
const templateDirectory = join(workerRoot, 'builder-template');
const maxLogEvents = 400;
const maxSourceContentBytes = 512 * 1024;
const previewViewports = [
  { id: 'desktop', label: 'Desktop', width: 1440, height: 960, isMobile: false },
  { id: 'tablet', label: 'Tablet', width: 834, height: 1112, isMobile: true },
  { id: 'mobile', label: 'Mobile', width: 390, height: 844, isMobile: true },
];

class BuilderCancelledError extends Error {
  constructor() {
    super('Private preview build cancelled by a workspace user.');
    this.name = 'BuilderCancelledError';
  }
}

class BuilderStorageError extends Error {
  constructor(operation, artifact, cause, attempts) {
    super('The builder worker could not save a private output file.');
    this.name = 'BuilderStorageError';
    const providerCode =
      typeof cause?.statusCode === 'number' || typeof cause?.statusCode === 'string'
        ? String(cause.statusCode)
        : typeof cause?.status === 'number' || typeof cause?.status === 'string'
          ? String(cause.status)
          : undefined;
    this.retryable = storageErrorIsRetryable(providerCode);
    this.context = {
      operation,
      path: artifact.relativePath,
      artifactKind: artifact.kind,
      attempts,
      contentType: artifact.contentType,
      // Raw provider messages can contain implementation details and must not
      // be surfaced in the product. A stable status/code is enough to diagnose.
      providerCode,
    };
  }
}

class BuilderCheckpointError extends Error {
  constructor(message, { retryable, context = {} } = {}) {
    super(message);
    this.name = 'BuilderCheckpointError';
    this.retryable = Boolean(retryable);
    this.context = context;
  }
}

class BuilderQualityError extends Error {
  constructor(operation, { page, viewport, cause } = {}) {
    super('A private browser quality check could not complete.');
    this.name = 'BuilderQualityError';
    const message = cause instanceof Error ? cause.message : '';
    this.context = {
      operation,
      page,
      viewport,
      errorType: cause instanceof Error ? cause.name : 'UnknownError',
      detail: safeDiagnosticDetail(message),
    };
    this.retryable =
      operation === 'browser_launch' ||
      /browser.*closed|econnreset|econnrefused|ehostunreach/i.test(message);
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the builder worker.`);
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function recordValue(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function safeFileName(value, fallback) {
  const extension = extname(value)
    .toLowerCase()
    .replace(/[^.a-z0-9]/g, '');
  const stem = basename(value, extname(value))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return `${stem || fallback}${extension || ''}`;
}

function contentTypeFor(file) {
  const extension = extname(file).toLowerCase();
  return (
    {
      '.css': 'text/css',
      '.avif': 'image/avif',
      '.gif': 'image/gif',
      '.html': 'text/html',
      '.ico': 'image/x-icon',
      '.jpeg': 'image/jpeg',
      '.jpg': 'image/jpeg',
      '.js': 'text/javascript',
      '.json': 'application/json',
      '.map': 'application/json',
      '.mjs': 'text/javascript',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
    }[extension] ?? (extension ? 'application/octet-stream' : 'text/plain')
  );
}

function storageErrorIsRetryable(providerCode) {
  const status = Number(providerCode);
  if (!Number.isFinite(status) || status === 0) return true;
  return status === 408 || status === 429 || status >= 500;
}

function isPlaceholderOutputFile(file) {
  return basename(file).toLowerCase() === '.gitkeep';
}

function safeErrorSummary(error) {
  if (error instanceof BuilderCancelledError) return error.message;
  if (
    error instanceof Error &&
    /SITEFORGE_CODEX_API_KEY|OPENAI_API_KEY|Codex CLI/.test(error.message)
  ) {
    return error.message.slice(0, 500);
  }
  return 'The protected Codex builder could not complete this private preview.';
}

function safeDiagnosticDetail(value) {
  return diagnosticText(value, 320) || 'No additional diagnostic detail was available.';
}

function failureDetails(error) {
  const message = error instanceof Error ? error.message : '';
  const base = {
    retryable: false,
    context: {},
  };
  if (error instanceof BuilderStorageError) {
    const retryable = error.retryable;
    return {
      ...base,
      retryable,
      code: retryable ? 'private_storage_temporary_failure' : 'private_storage_rejected',
      stage: 'private_storage',
      summary: retryable
        ? 'A required private build output could not be saved to protected workspace storage.'
        : 'Protected storage rejected a generated private build output.',
      action: retryable
        ? 'The builder will retry once automatically. Check storage access if the retry also fails.'
        : 'Review the saved path and MIME type in Build diagnostics, then resume after correcting the output rule.',
      context: error.context,
    };
  }
  if (error instanceof BuilderCheckpointError) {
    return {
      ...base,
      retryable: error.retryable,
      code: error.retryable
        ? 'source_checkpoint_temporarily_unavailable'
        : 'source_checkpoint_invalid',
      stage: 'checkpoint_restore',
      summary: error.retryable
        ? 'The saved private source checkpoint could not be restored temporarily.'
        : 'The saved private source checkpoint could not be verified safely.',
      action: error.retryable
        ? 'The builder will retry once automatically. Check protected storage access if the retry also fails.'
        : 'Start a clean rebuild from the approved manifest to replace the invalid checkpoint.',
      context: error.context,
    };
  }
  if (error instanceof BuilderQualityError) {
    return {
      ...base,
      retryable: error.retryable,
      code: error.retryable ? 'browser_quality_temporary_failure' : 'browser_quality_failed',
      stage: 'browser_quality',
      summary: 'A private browser quality check stopped before the preview could be finalised.',
      action: error.retryable
        ? 'The builder will retry once automatically. If it fails again, review the saved source and the recorded quality step.'
        : 'Review the recorded quality step and saved source, then resume or start a clean rebuild.',
      context: error.context,
    };
  }
  if (/SITEFORGE_CODEX_API_KEY|OPENAI_API_KEY/.test(message)) {
    return {
      ...base,
      code: 'builder_credentials_missing',
      stage: 'worker_configuration',
      summary: 'The protected builder does not have a server-only Codex API key.',
      action:
        'Add SITEFORGE_CODEX_API_KEY or OPENAI_API_KEY to the worker environment, then retry the build.',
    };
  }
  if (/approved Build Manifest is no longer available/.test(message)) {
    return {
      ...base,
      code: 'build_manifest_unavailable',
      stage: 'manifest_validation',
      summary: 'The approved Build Manifest was no longer available when the builder started.',
      action: 'Review and prepare a new Build Manifest before retrying.',
    };
  }
  if (/approved visual asset|load.*approved.*visual asset/i.test(message)) {
    return {
      ...base,
      code: 'approved_asset_unavailable',
      stage: 'asset_staging',
      summary: 'An approved visual asset could not be loaded into the private workspace.',
      action: 'Review the approved asset selection, then retry from the same approved manifest.',
    };
  }
  if (/locked workspace foundation file/.test(message)) {
    return {
      ...base,
      code: 'builder_foundation_changed',
      stage: 'builder_policy',
      summary: 'The generated build changed a protected builder foundation file.',
      action: 'Review the builder contract and start a clean build from the approved manifest.',
    };
  }
  if (/did not produce dist\/index.html/.test(message)) {
    return {
      ...base,
      code: 'compiled_homepage_missing',
      stage: 'compile',
      summary: 'The generated website did not compile to a usable homepage.',
      action:
        'Review the saved frozen draft, then start a clean rebuild from the approved manifest.',
    };
  }
  if (/rendered no text|private browser|quality-check server/.test(message)) {
    return {
      ...base,
      code: 'preview_render_failed',
      stage: 'browser_quality',
      summary: 'A generated page could not be rendered safely in the private quality browser.',
      action: 'Review the frozen draft and the affected page in the build timeline, then rebuild.',
    };
  }
  if (/Codex CLI could not finish/.test(message)) {
    const retryable = /429|rate limit|temporar|timeout|timed out|connection|network|5\d\d/i.test(
      message,
    );
    return {
      ...base,
      retryable,
      code: retryable ? 'codex_temporary_failure' : 'codex_build_failed',
      stage: 'codex_build',
      summary: retryable
        ? 'Codex was temporarily unavailable while building the private website.'
        : 'Codex could not complete the private website build.',
      action: retryable
        ? 'The builder will retry once automatically. If it fails again, start a clean rebuild from the approved manifest.'
        : 'Review the frozen draft and start a clean rebuild from the approved manifest.',
    };
  }
  if (
    /save progress|save a private output|save a private output file|save a private/i.test(message)
  ) {
    return {
      ...base,
      retryable: true,
      code: 'private_storage_temporary_failure',
      stage: 'private_storage',
      summary: 'A private build output could not be saved to the protected workspace storage.',
      action:
        'The builder will retry once automatically. Check storage access if the retry also fails.',
    };
  }
  return {
    ...base,
    code: 'builder_unexpected_failure',
    stage: 'worker_runtime',
    summary: safeErrorSummary(error),
    action:
      'Review the build timeline and frozen draft, then retry from the same approved manifest.',
  };
}

async function assertBuildActive(client, run, workerId) {
  const { data, error } = await client
    .from('builder_runs')
    .select('status, worker_id, cancel_requested_at')
    .eq('id', run.id)
    .maybeSingle();
  if (error) throw new Error('The builder worker could not confirm the build state.');
  if (data?.cancel_requested_at) throw new BuilderCancelledError();
  if (!data || data.status !== 'running' || data.worker_id !== workerId) {
    throw new Error('The builder worker lease was lost.');
  }
}

async function updateProgress(client, run, workerId, patch) {
  const { data, error } = await client
    .from('builder_runs')
    .update({
      ...patch,
      lease_expires_at: new Date(Date.now() + 45 * 60_000).toISOString(),
    })
    .eq('id', run.id)
    .eq('worker_id', workerId)
    .eq('status', 'running')
    .is('cancel_requested_at', null)
    .select('id');
  if (error) throw new Error('The builder worker could not save progress.');
  if (!data?.length) await assertBuildActive(client, run, workerId);
  if (!data?.length) throw new Error('The builder worker lease was lost.');
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const result = { stdout, stderr, code, signal, durationMs: Date.now() - startedAt };
      if (code === 0) return resolve(result);
      const error = new Error(
        `${command} ${signal ? `stopped (${signal})` : `exited with ${code}`}: ${stderr.slice(-800)}`,
      );
      error.commandResult = result;
      reject(error);
    });
  });
}

async function runDiagnosticCommand(diagnostics, scope, command, args, options = {}) {
  const commandText = [command, ...args].join(' ');
  try {
    const result = await runCommand(command, args, options);
    await diagnostics.record({
      scope,
      title: `${command} completed`,
      command: commandText,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
    });
    return result;
  } catch (error) {
    const result = error?.commandResult ?? {};
    await diagnostics.record({
      scope,
      title: `${command} failed`,
      status: 'failed',
      detail:
        error instanceof Error ? error.message : 'The command failed without an error message.',
      command: commandText,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
    });
    throw error;
  }
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    if (entry.isFile()) files.push(path);
  }
  return files;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function uploadArtifact(client, run, artifact) {
  const storagePath = `${run.organization_id}/builder-runs/${run.id}/${artifact.relativePath}`;
  let failure;
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { error: uploadError } = await client.storage
        .from(artifactBucket)
        .upload(storagePath, artifact.body, {
          contentType: artifact.contentType,
          upsert: true,
        });
      if (uploadError) {
        failure = new BuilderStorageError('storage_upload', artifact, uploadError, attempt);
      } else {
        const { error: recordError } = await client.from('builder_artifacts').upsert(
          {
            organization_id: run.organization_id,
            business_id: run.business_id,
            builder_run_id: run.id,
            kind: artifact.kind,
            label: artifact.label,
            storage_bucket: artifactBucket,
            storage_path: storagePath,
            content_type: artifact.contentType,
            byte_size: artifact.body.byteLength,
            metadata: artifact.metadata ?? {},
          },
          { onConflict: 'storage_path' },
        );
        if (!recordError) return storagePath;
        failure = new BuilderStorageError('artifact_index', artifact, recordError, attempt);
      }
    } catch (error) {
      failure =
        error instanceof BuilderStorageError
          ? error
          : new BuilderStorageError('storage_upload', artifact, error, attempt);
    }
    if (!failure?.retryable) throw failure;
    if (attempt < attempts) await wait(400 * 2 ** (attempt - 1));
  }
  throw failure;
}

function createEventWriter(client, run) {
  let nextSequence;
  let queue = Promise.resolve();
  return (kind, message, metadata = {}) => {
    queue = queue
      .then(async () => {
        if (!nextSequence) {
          const { data } = await client
            .from('builder_events')
            .select('sequence')
            .eq('builder_run_id', run.id)
            .order('sequence', { ascending: false })
            .limit(1);
          nextSequence = (data?.[0]?.sequence ?? 0) + 1;
        }
        const { error } = await client.from('builder_events').insert({
          organization_id: run.organization_id,
          business_id: run.business_id,
          builder_run_id: run.id,
          sequence: nextSequence,
          kind,
          message,
          metadata,
        });
        if (!error) nextSequence += 1;
      })
      .catch(() => {
        // Progress events must never prevent a private build from completing.
      });
    return queue;
  };
}

function textFromCodexItem(item) {
  const candidates = [item.text, item.message, item.content];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (Array.isArray(candidate)) {
      const text = candidate
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join(' ')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

function codexItemField(item, keys) {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function safeCodexStreamText(value) {
  return value
    .replace(/\b(?:sk|sk-proj|sk-[a-z]+)-[a-zA-Z0-9_-]{12,}\b/g, '[redacted key]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);
}

async function sourceFileHashes(siteDirectory) {
  const sourceDirectory = join(siteDirectory, 'src');
  const files = await collectFiles(sourceDirectory).catch(() => []);
  const hashes = new Map();
  for (const file of files) {
    const relativePath = relative(sourceDirectory, file).split(sep).join('/');
    hashes.set(relativePath, sha256(await readFile(file)));
  }
  return hashes;
}

function checkpointableSourcePath(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    !relativePath ||
    relativePath.length > 240 ||
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    relativePath.startsWith('assets/')
  ) {
    return false;
  }
  return relativePath.split('/').every((part) => part && part !== '.' && part !== '..');
}

function hasSourceChanges(currentFiles, initialSourceHashes) {
  const checkpointFiles = currentFiles.filter((file) =>
    checkpointableSourcePath(file.relativePath),
  );
  if (
    checkpointFiles.length !==
    [...initialSourceHashes.keys()].filter(checkpointableSourcePath).length
  ) {
    return true;
  }
  return checkpointFiles.some((file) => initialSourceHashes.get(file.relativePath) !== file.hash);
}

function sourceCheckpointPayload(currentFiles, initialSourceHashes) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    files: currentFiles
      .filter((file) => checkpointableSourcePath(file.relativePath))
      .map((file) => ({
        path: file.relativePath,
        hash: file.hash,
        source:
          initialSourceHashes.get(file.relativePath) === file.hash ? 'template' : 'checkpoint',
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

async function restoreSourceCheckpoint(client, run, sourceDirectory) {
  const { data: checkpoints, error: checkpointError } = await client
    .from('builder_artifacts')
    .select('storage_bucket, storage_path, metadata')
    .eq('builder_run_id', run.id)
    .eq('kind', 'checkpoint')
    .eq('label', 'Latest private source checkpoint')
    .order('created_at', { ascending: false })
    .limit(1);
  if (checkpointError) {
    throw new BuilderCheckpointError('The private checkpoint record could not be read.', {
      retryable: true,
      context: { operation: 'checkpoint_lookup' },
    });
  }
  const checkpoint = checkpoints?.[0];
  if (!checkpoint) return restoreLegacyDraftFiles(client, run, sourceDirectory);

  const { data: checkpointBlob, error: downloadError } = await client.storage
    .from(checkpoint.storage_bucket || artifactBucket)
    .download(checkpoint.storage_path);
  if (downloadError || !checkpointBlob) {
    throw new BuilderCheckpointError('The private checkpoint manifest could not be loaded.', {
      retryable: true,
      context: {
        operation: 'checkpoint_manifest_download',
        path: 'checkpoint/source-manifest.json',
      },
    });
  }
  if (checkpointBlob.size > 512_000) {
    throw new BuilderCheckpointError(
      'The private checkpoint manifest exceeded the safe size limit.',
      {
        context: {
          operation: 'checkpoint_manifest_validation',
          path: 'checkpoint/source-manifest.json',
        },
      },
    );
  }

  let payload;
  try {
    payload = JSON.parse(await checkpointBlob.text());
  } catch {
    throw new BuilderCheckpointError('The private checkpoint manifest was not valid JSON.', {
      context: {
        operation: 'checkpoint_manifest_validation',
        path: 'checkpoint/source-manifest.json',
      },
    });
  }
  const files = Array.isArray(payload?.files) ? payload.files : undefined;
  if (payload?.version !== 1 || !files || files.length > 300) {
    throw new BuilderCheckpointError('The private checkpoint manifest had an unsupported shape.', {
      context: {
        operation: 'checkpoint_manifest_validation',
        path: 'checkpoint/source-manifest.json',
      },
    });
  }

  const expectedFiles = new Map();
  for (const entry of files) {
    const path = typeof entry?.path === 'string' ? entry.path : '';
    const hash = typeof entry?.hash === 'string' ? entry.hash : '';
    const source = entry?.source;
    if (
      !checkpointableSourcePath(path) ||
      !/^[a-f0-9]{64}$/i.test(hash) ||
      (source !== 'template' && source !== 'checkpoint') ||
      expectedFiles.has(path)
    ) {
      throw new BuilderCheckpointError('The private checkpoint manifest included an unsafe file.', {
        context: { operation: 'checkpoint_manifest_validation', path },
      });
    }
    expectedFiles.set(path, { hash, source });
  }

  const existingFiles = await collectFiles(sourceDirectory).catch(() => []);
  for (const file of existingFiles) {
    const path = relative(sourceDirectory, file).split(sep).join('/');
    if (checkpointableSourcePath(path) && !expectedFiles.has(path)) {
      await rm(file, { force: true });
    }
  }

  const draftHashes = new Map();
  for (const [path, entry] of expectedFiles) {
    if (entry.source === 'template') continue;
    const storagePath = `${run.organization_id}/builder-runs/${run.id}/draft/${path}`;
    const { data: sourceBlob, error: sourceError } = await client.storage
      .from(artifactBucket)
      .download(storagePath);
    if (sourceError || !sourceBlob) {
      throw new BuilderCheckpointError('A private checkpoint source file could not be loaded.', {
        retryable: true,
        context: { operation: 'checkpoint_source_download', path: `draft/${path}` },
      });
    }
    if (sourceBlob.size > 5_000_000) {
      throw new BuilderCheckpointError(
        'A private checkpoint source file exceeded the safe size limit.',
        {
          context: { operation: 'checkpoint_source_validation', path: `draft/${path}` },
        },
      );
    }
    const body = Buffer.from(await sourceBlob.arrayBuffer());
    if (sha256(body) !== entry.hash) {
      throw new BuilderCheckpointError(
        'A private checkpoint source file failed integrity validation.',
        {
          context: { operation: 'checkpoint_source_validation', path: `draft/${path}` },
        },
      );
    }
    const destination = join(sourceDirectory, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, body);
    draftHashes.set(path, entry.hash);
  }

  return {
    restored: true,
    restoredFromLegacyDrafts: false,
    draftHashes,
    checkpointHash: sha256(JSON.stringify({ version: payload.version, files })),
    fileCount: expectedFiles.size,
  };
}

async function restoreLegacyDraftFiles(client, run, sourceDirectory) {
  const { data: artifacts, error } = await client
    .from('builder_artifacts')
    .select('label, storage_bucket, storage_path')
    .eq('builder_run_id', run.id)
    .eq('kind', 'draft_file');
  if (error) {
    throw new BuilderCheckpointError('The saved private draft records could not be read.', {
      retryable: true,
      context: { operation: 'legacy_draft_lookup' },
    });
  }
  const drafts = (artifacts ?? []).filter((artifact) => checkpointableSourcePath(artifact.label));
  if (!drafts.length) {
    return {
      restored: false,
      restoredFromLegacyDrafts: false,
      draftHashes: new Map(),
      checkpointHash: undefined,
    };
  }

  const draftHashes = new Map();
  for (const artifact of drafts) {
    const { data: sourceBlob, error: sourceError } = await client.storage
      .from(artifact.storage_bucket || artifactBucket)
      .download(artifact.storage_path);
    if (sourceError || !sourceBlob) {
      throw new BuilderCheckpointError('A saved private draft file could not be restored.', {
        retryable: true,
        context: { operation: 'legacy_draft_download', path: artifact.label },
      });
    }
    if (sourceBlob.size > 5_000_000) {
      throw new BuilderCheckpointError('A saved private draft file exceeded the safe size limit.', {
        context: { operation: 'legacy_draft_validation', path: artifact.label },
      });
    }
    const body = Buffer.from(await sourceBlob.arrayBuffer());
    const destination = join(sourceDirectory, artifact.label);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, body);
    draftHashes.set(artifact.label, sha256(body));
  }
  return {
    restored: true,
    restoredFromLegacyDrafts: true,
    draftHashes,
    checkpointHash: undefined,
    fileCount: drafts.length,
  };
}

async function saveSourceCheckpoint(client, run, workspace, currentFiles, event) {
  const payload = sourceCheckpointPayload(currentFiles, workspace.initialSourceHashes);
  const body = Buffer.from(JSON.stringify(payload));
  const hash = sha256(JSON.stringify({ version: payload.version, files: payload.files }));
  if (workspace.checkpointHash === hash) return true;
  try {
    await uploadArtifact(client, run, {
      kind: 'checkpoint',
      label: 'Latest private source checkpoint',
      relativePath: 'checkpoint/source-manifest.json',
      body,
      contentType: 'application/json',
      metadata: {
        version: payload.version,
        fileCount: payload.files.length,
        state: 'resume_checkpoint',
      },
    });
    workspace.checkpointHash = hash;
    workspace.checkpointFailure = undefined;
    await event(
      'stage',
      `Private source checkpoint saved with ${payload.files.length} file${payload.files.length === 1 ? '' : 's'}.`,
      {
        fileCount: payload.files.length,
      },
    );
    return true;
  } catch (error) {
    const context = error instanceof BuilderStorageError ? error.context : {};
    const fingerprint = JSON.stringify(context);
    if (workspace.checkpointFailure !== fingerprint) {
      workspace.checkpointFailure = fingerprint;
      await event(
        'activity',
        'The private source checkpoint could not be saved yet. The website build will continue and retry the checkpoint.',
        { path: 'checkpoint/source-manifest.json', ...context },
      );
    }
    return false;
  }
}

async function syncDraftFiles(client, run, workspace, event, options = {}) {
  const sourceDirectory = join(workspace.siteDirectory, 'src');
  const files = await collectFiles(sourceDirectory).catch(() => []);
  const currentFiles = [];
  for (const file of files) {
    const relativePath = relative(sourceDirectory, file).split(sep).join('/');
    if (relativePath === '.gitkeep') continue;
    const body = await readFile(file);
    const hash = sha256(body);
    currentFiles.push({ file, relativePath, body, hash });
  }
  const sourceChanged = hasSourceChanges(currentFiles, workspace.initialSourceHashes);
  if (!workspace.draftPublished && !sourceChanged && !options.force) return false;
  for (const current of currentFiles) {
    const initialHash = workspace.initialSourceHashes.get(current.relativePath);
    const needsDraftArtifact =
      checkpointableSourcePath(current.relativePath) &&
      (initialHash !== current.hash || workspace.draftHashes.has(current.relativePath));
    if (!needsDraftArtifact) continue;
    if (workspace.draftHashes.get(current.relativePath) === current.hash) continue;
    try {
      await uploadArtifact(client, run, {
        kind: 'draft_file',
        label: current.relativePath,
        relativePath: `draft/${current.relativePath}`,
        body: current.body,
        contentType: contentTypeFor(current.file),
        metadata: {
          previewPath: current.relativePath,
          state: 'working_draft',
        },
      });
      workspace.draftHashes.set(current.relativePath, current.hash);
      workspace.draftFailures.delete(current.relativePath);
      await event('file', `Draft file updated: ${current.relativePath}`, {
        path: current.relativePath,
      });
    } catch (error) {
      const context = error instanceof BuilderStorageError ? error.context : {};
      const fingerprint = JSON.stringify(context);
      if (workspace.draftFailures.get(current.relativePath) !== fingerprint) {
        workspace.draftFailures.set(current.relativePath, fingerprint);
        await event(
          'activity',
          `Draft file could not be saved yet: ${current.relativePath}. The website build will continue and retry the draft sync.`,
          { path: current.relativePath, ...context },
        );
      }
    }
  }
  const hasUnsavedSourceFiles = currentFiles.some(
    (current) =>
      checkpointableSourcePath(current.relativePath) &&
      workspace.initialSourceHashes.get(current.relativePath) !== current.hash &&
      workspace.draftHashes.get(current.relativePath) !== current.hash,
  );
  if (!hasUnsavedSourceFiles && sourceChanged) {
    await saveSourceCheckpoint(client, run, workspace, currentFiles, event);
  }
  if (workspace.draftHashes.has('index.html')) workspace.draftPublished = true;
  return workspace.draftPublished;
}

async function stageApprovedAssets(client, manifest, siteDirectory) {
  const data = recordValue(manifest.data);
  const brandKit = recordValue(data.brandKit);
  const assetIds = new Set(
    Array.isArray(data.approvedAssetGuidance)
      ? data.approvedAssetGuidance
          .map((asset) => recordValue(asset).assetId)
          .filter((id) => typeof id === 'string')
      : [],
  );
  if (typeof brandKit.primaryLogoAssetId === 'string') assetIds.add(brandKit.primaryLogoAssetId);
  if (Array.isArray(brandKit.approvedAssetIds)) {
    for (const assetId of brandKit.approvedAssetIds) {
      if (typeof assetId === 'string') assetIds.add(assetId);
    }
  }
  if (!assetIds.size) return [];
  const { data: assets, error } = await client
    .from('artifacts')
    .select('*')
    .in('id', [...assetIds]);
  if (error) throw new Error('The builder worker could not load approved visual assets.');

  const assetsDirectory = join(siteDirectory, 'src', 'assets');
  await mkdir(assetsDirectory, { recursive: true });
  const staged = [];
  let index = 0;
  for (const asset of assets ?? []) {
    const { data: blob, error: downloadError } = await client.storage
      .from(asset.storage_bucket || artifactBucket)
      .download(asset.storage_path);
    if (downloadError || !blob) {
      throw new Error('An approved visual asset could not be loaded into the private workspace.');
    }
    index += 1;
    const metadata = recordValue(asset.metadata);
    const fileName = safeFileName(
      typeof metadata.originalFileName === 'string'
        ? metadata.originalFileName
        : asset.storage_path,
      `approved-asset-${index}`,
    );
    const outputPath = join(assetsDirectory, fileName);
    await writeFile(outputPath, Buffer.from(await blob.arrayBuffer()));
    await chmod(outputPath, 0o444);
    staged.push({
      assetId: asset.id,
      relativePath: `src/assets/${fileName}`,
      contentType: asset.content_type || blob.type || 'application/octet-stream',
    });
  }
  return staged;
}

async function stageSelectedPageContent(client, manifest, inputDirectory) {
  const data = recordValue(manifest.data);
  const pages = sourcePagePlan(Array.isArray(data.selectedPages) ? data.selectedPages : []);
  if (!pages.length) {
    throw new Error('The approved Build Manifest does not contain any selected source pages.');
  }
  const { data: artifacts, error } = await client
    .from('artifacts')
    .select('storage_bucket, storage_path, metadata, content_type, byte_size')
    .eq('crawl_run_id', manifest.crawl_run_id)
    .eq('kind', 'content');
  if (error) throw new Error('The builder worker could not load captured page content.');

  const contentBySourceUrl = new Map();
  for (const artifact of artifacts ?? []) {
    const metadata = recordValue(artifact.metadata);
    if (typeof metadata.sourceUrl !== 'string') continue;
    try {
      contentBySourceUrl.set(normaliseSourceUrl(metadata.sourceUrl), artifact);
    } catch {
      // A malformed historic artifact cannot be used as an approved page source.
    }
  }

  const sourceDirectory = join(inputDirectory, 'source-pages');
  await mkdir(sourceDirectory, { recursive: true });
  const stagedPages = [];
  for (const page of pages) {
    const artifact = contentBySourceUrl.get(page.sourceUrl);
    if (!artifact) {
      throw new Error(
        `The selected source page ${page.sourceUrl} has no captured content available for the builder.`,
      );
    }
    if (Number(artifact.byte_size) > maxSourceContentBytes) {
      throw new Error(
        `The captured content for ${page.sourceUrl} exceeds the private builder input limit.`,
      );
    }
    const { data: blob, error: downloadError } = await client.storage
      .from(artifact.storage_bucket || artifactBucket)
      .download(artifact.storage_path);
    if (downloadError || !blob || blob.size > maxSourceContentBytes) {
      throw new Error(`The captured content for ${page.sourceUrl} could not be staged privately.`);
    }
    const content = Buffer.from(await blob.arrayBuffer());
    try {
      JSON.parse(content.toString('utf8'));
    } catch {
      throw new Error(
        `The captured content for ${page.sourceUrl} is not valid private source data.`,
      );
    }
    const contentFile = `${String(page.index).padStart(3, '0')}.json`;
    await writeFile(join(sourceDirectory, contentFile), content);
    await chmod(join(sourceDirectory, contentFile), 0o444);
    stagedPages.push({
      ...page,
      contentFile: `source-pages/${contentFile}`,
      contentBytes: content.byteLength,
    });
  }
  const indexPath = join(sourceDirectory, 'index.json');
  await writeFile(
    indexPath,
    JSON.stringify(
      {
        purpose:
          'Selected source-page content for a private redesign. Each listed page requires a corresponding generated output file.',
        pages: stagedPages,
      },
      null,
      2,
    ),
  );
  await chmod(indexPath, 0o444);
  return stagedPages;
}

async function prepareWorkspace(client, run, manifest, workerId, diagnostics) {
  await updateProgress(client, run, workerId, {
    progress_phase: 'preparing_workspace',
    progress_detail: 'Creating a clean private website workspace.',
    total_items: 7,
    completed_items: 0,
  });
  const runDirectory = await mkdtemp(join(tmpdir(), 'siteforge-builder-'));
  const siteDirectory = join(runDirectory, 'website');
  const inputDirectory = join(runDirectory, 'input');
  await cp(templateDirectory, siteDirectory, { recursive: true });
  await mkdir(inputDirectory, { recursive: true });
  await runDiagnosticCommand(diagnostics, 'workspace_initialisation', 'git', ['init', '--quiet'], {
    cwd: runDirectory,
    env: process.env,
  });

  const manifestPath = join(inputDirectory, 'manifest.json');
  const manifestText = JSON.stringify(manifest.data, null, 2);
  await writeFile(manifestPath, manifestText);
  await chmod(manifestPath, 0o444);
  const stagedSourcePages = await stageSelectedPageContent(client, manifest, inputDirectory);
  const stagedAssets = await stageApprovedAssets(client, manifest, siteDirectory);
  await writeFile(
    join(inputDirectory, 'approved-assets.json'),
    JSON.stringify(stagedAssets, null, 2),
  );
  await chmod(join(inputDirectory, 'approved-assets.json'), 0o444);
  const initialSourceHashes = await sourceFileHashes(siteDirectory);
  const checkpoint = await restoreSourceCheckpoint(client, run, join(siteDirectory, 'src'));

  const lockedFiles = await Promise.all(
    ['package.json', 'scripts/build.mjs', 'AGENTS.md'].map(async (relativePath) => {
      const path = join(siteDirectory, relativePath);
      const source = await readFile(path);
      await chmod(path, 0o444);
      return [relativePath, sha256(source)];
    }),
  );
  await updateProgress(client, run, workerId, {
    progress_phase: 'preparing_workspace',
    progress_detail: checkpoint.restored
      ? checkpoint.restoredFromLegacyDrafts
        ? `Restored ${checkpoint.fileCount} saved draft file${checkpoint.fileCount === 1 ? '' : 's'} into the isolated workspace.`
        : `Restored a private source checkpoint with ${checkpoint.fileCount} file${checkpoint.fileCount === 1 ? '' : 's'} into the isolated workspace.`
      : `Manifest, ${stagedSourcePages.length} selected page source${stagedSourcePages.length === 1 ? '' : 's'}, and ${stagedAssets.length} approved asset${stagedAssets.length === 1 ? '' : 's'} staged in the isolated workspace.`,
    total_items: 7,
    completed_items: 1,
    input_hash: sha256(manifestText),
  });
  return {
    runDirectory,
    siteDirectory,
    manifestPath,
    lockedFiles,
    stagedAssets,
    stagedSourcePages,
    initialSourceHashes,
    draftHashes: checkpoint.draftHashes,
    draftFailures: new Map(),
    checkpointHash: checkpoint.checkpointHash,
    checkpointFailure: undefined,
    draftPublished: checkpoint.draftHashes.has('index.html'),
    restoredCheckpoint: checkpoint.restored,
    restoredFromLegacyDrafts: checkpoint.restoredFromLegacyDrafts,
    restoredCheckpointFileCount: checkpoint.fileCount ?? 0,
  };
}

async function assertLockedFiles(siteDirectory, lockedFiles) {
  for (const [relativePath, originalHash] of lockedFiles) {
    const current = await readFile(join(siteDirectory, relativePath));
    if (sha256(current) !== originalHash) {
      throw new Error('The builder changed a locked workspace foundation file.');
    }
  }
}

function buildPrompt(restoredCheckpoint) {
  return [
    'You are the SiteForge website builder. Build the complete private redesign now.',
    'Read ../input/manifest.json, ../input/approved-assets.json, and ../input/source-pages/index.json before writing any website files.',
    'Follow AGENTS.md exactly. The manifest is factual context and a hard boundary, not a loose suggestion.',
    'Every entry in source-pages/index.json is an explicitly selected source page. Read its linked content file and create the matching outputPath inside src/ for every entry. The compact page plan is not the full page scope and does not permit omitting selected pages.',
    'Add <meta name="siteforge-source-url" content="the exact sourceUrl from the source-page index"> to each generated selected-page HTML file. Keep the outputPath exactly as specified so SiteForge can verify coverage.',
    "Use the captured text, headings, forms, navigation, and content blocks as source material. Rewrite, condense, group, and improve the wording where it helps clarity, scanning, hierarchy, and conversion, but preserve each page's necessary services, operational details, calls to action, forms or tools, legal content, and resource content. Do not silently drop material facts or make captured claims stronger.",
    'Read approvedCapabilities in manifest.json. They are the only approved dynamic scope. This preview is static: for approved managed content, accounts, payments, external integrations, or server-side workflows, build the honest visitor-facing interface and write src/BUILD_NOTES.md explaining the production service, data, and approval boundary. Never fabricate credentials, live submissions, transactions, accounts, or backend behaviour.',
    'Do not invent or imply unsupported business facts. Preserve unresolved items for the human reviewer rather than guessing.',
    'Use only local approved assets in src/assets/. Do not make network requests or add dependencies.',
    'When manifest.json contains a Brand Kit, its primary logo asset is mandatory in the header and footer. Use its reviewed primary and accent colours as brand tokens, then design coherent accessible neutrals, surfaces, and backgrounds yourself; do not copy a weak legacy colour system or replace the identity with a generic one.',
    restoredCheckpoint
      ? 'A private source checkpoint has been restored into src/. Inspect and preserve the useful existing work, but extend or correct it until it covers every selected source-page outputPath.'
      : 'Start from the locked builder template in src/.',
    'Finish by running npm run build. Briefly report the completed page count, selected source pages mapped to output paths, and any unresolved manifest questions.',
  ].join('\n');
}

function brandProblems(manifest, stagedAssets, allFiles) {
  const brandKit = recordValue(recordValue(manifest.data).brandKit);
  if (!brandKit.id) return [];
  const problems = [];
  const primaryLogoId =
    typeof brandKit.primaryLogoAssetId === 'string' ? brandKit.primaryLogoAssetId : '';
  const primaryAsset = stagedAssets.find((asset) => asset.assetId === primaryLogoId);
  if (!primaryAsset) {
    problems.push('The approved primary brand logo was not staged for the builder.');
    return problems;
  }
  const outputText = allFiles
    .filter((file) => /\.(html|css)$/i.test(file))
    .map((file) => readFile(file, 'utf8'));
  return Promise.all(outputText).then((contents) => {
    const combined = contents.join('\n').toLowerCase();
    if (!combined.includes(basename(primaryAsset.relativePath).toLowerCase())) {
      problems.push('The approved primary brand logo is not referenced by the generated website.');
    }
    const palette = recordValue(brandKit.palette);
    for (const role of ['primary', 'accent']) {
      const value = palette[role];
      if (
        typeof value === 'string' &&
        /^#[0-9a-f]{6}$/i.test(value) &&
        !combined.includes(value.toLowerCase())
      ) {
        problems.push(
          `The reviewed ${role} brand colour is not present in the generated design tokens.`,
        );
      }
    }
    return problems;
  });
}

async function runCodex(client, run, workerId, workspace, apiKey, eventWriter, diagnostics) {
  await assertBuildActive(client, run, workerId);
  await updateProgress(client, run, workerId, {
    progress_phase: 'building_website',
    progress_detail: 'Codex is designing and implementing the private website.',
    total_items: 7,
    completed_items: 2,
  });
  await eventWriter('stage', 'Codex has started the private website build.');
  const codexBinary = process.env.SITEFORGE_CODEX_BIN?.trim() || 'codex';
  const codexHome = join(workspace.runDirectory, '.codex-home');
  const model = process.env.SITEFORGE_CODEX_MODEL?.trim();
  await mkdir(codexHome, { recursive: true });
  const outputPath = join(workspace.runDirectory, 'codex-final-message.txt');
  const events = [];
  let latestDetail = 'Codex is designing the private website.';
  let lastProgressAt = 0;
  let lastActivity = '';
  let syncingDraft = false;
  let lastCodexStreamText = '';
  let lastCodexCommandSignature = '';
  let codexStreamEventCount = 0;
  const maxCodexStreamEvents = 120;
  function writeCodexStream(message, metadata = {}) {
    const safeMessage = safeCodexStreamText(message);
    if (
      !safeMessage ||
      safeMessage === lastCodexStreamText ||
      codexStreamEventCount >= maxCodexStreamEvents
    ) {
      return;
    }
    lastCodexStreamText = safeMessage;
    codexStreamEventCount += 1;
    void eventWriter('activity', safeMessage, { stream: 'codex', ...metadata });
  }
  const codexArguments = [
    'exec',
    '--json',
    '--ephemeral',
    '--sandbox',
    'workspace-write',
    '--output-last-message',
    outputPath,
  ];
  if (model) codexArguments.push('--model', model);
  codexArguments.push(buildPrompt(workspace.restoredCheckpoint));
  const child = spawn(codexBinary, codexArguments, {
    cwd: workspace.siteDirectory,
    env: {
      HOME: codexHome,
      PATH: process.env.PATH,
      CODEX_API_KEY: apiKey,
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let outputBuffer = '';
  let stderr = '';
  let cancelled = false;
  const cancellationInterval = setInterval(async () => {
    try {
      const { data } = await client
        .from('builder_runs')
        .select('cancel_requested_at')
        .eq('id', run.id)
        .maybeSingle();
      if (data?.cancel_requested_at && !cancelled) {
        cancelled = true;
        child.kill('SIGTERM');
      }
    } catch {
      // The normal progress update remains the source of truth if this optional poll fails.
    }
  }, 3_000);
  const draftInterval = setInterval(() => {
    if (syncingDraft) return;
    syncingDraft = true;
    void syncDraftFiles(client, run, workspace, eventWriter)
      .then((available) => {
        if (available && lastActivity !== 'A private working draft is available to view.') {
          lastActivity = 'A private working draft is available to view.';
          return eventWriter('activity', lastActivity);
        }
        return undefined;
      })
      .catch(() => undefined)
      .finally(() => {
        syncingDraft = false;
      });
  }, 2_000);

  child.stdout.on('data', (chunk) => {
    outputBuffer += chunk.toString();
    const lines = outputBuffer.split('\n');
    outputBuffer = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (events.length < maxLogEvents) events.push(event);
        const item = recordValue(event.item);
        const type = typeof event.type === 'string' ? event.type : '';
        if (type.includes('command_execution') || item.type === 'command_execution') {
          latestDetail = 'Codex is validating website changes.';
          const command = codexItemField(item, ['command', 'cmd']);
          const stdout = codexItemField(item, ['aggregated_output', 'output', 'stdout']);
          const stderr = codexItemField(item, ['stderr']);
          const exitCode = codexItemField(item, ['exit_code', 'exitCode']);
          const commandSignature = `${command || ''}:${stdout || ''}:${stderr || ''}:${exitCode || ''}`;
          if (commandSignature !== lastCodexCommandSignature) {
            lastCodexCommandSignature = commandSignature;
            void diagnostics.record({
              scope: 'codex_tool',
              title: 'Codex local command completed',
              status: exitCode && exitCode !== '0' ? 'failed' : 'completed',
              command,
              stdout,
              stderr,
              metadata: { eventType: type || item.type, exitCode },
            });
          }
          writeCodexStream('Codex is running a local website build step.', {
            eventType: 'command_execution',
          });
          if (lastActivity !== latestDetail) {
            lastActivity = latestDetail;
            void eventWriter('activity', latestDetail);
          }
        }
        if (item.type === 'agent_message') {
          latestDetail = 'Codex is refining the private website.';
          const text = textFromCodexItem(item);
          if (text) {
            writeCodexStream(text, { eventType: 'agent_message' });
          }
          if (lastActivity !== latestDetail) {
            lastActivity = latestDetail;
            void eventWriter('activity', latestDetail);
          }
        }
      } catch {
        // Codex JSONL is machine-readable, but a malformed diagnostic must not discard the run.
      }
    }
    if (Date.now() - lastProgressAt > 1_500) {
      lastProgressAt = Date.now();
      void updateProgress(client, run, workerId, {
        progress_phase: 'building_website',
        progress_detail: latestDetail,
        total_items: 7,
        completed_items: 2,
      }).catch(() => {
        child.kill('SIGTERM');
      });
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  let exit;
  try {
    exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  } catch (error) {
    await diagnostics.record({
      scope: 'codex_cli',
      title: 'Codex process could not be observed to completion',
      status: 'failed',
      detail: error instanceof Error ? error.message : 'Codex exited without an error message.',
      stderr,
      metadata: { eventCount: events.length },
    });
    throw error;
  } finally {
    clearInterval(cancellationInterval);
    clearInterval(draftInterval);
  }
  await diagnostics.record({
    scope: 'codex_cli',
    title: exit.code === 0 ? 'Codex process completed' : 'Codex process stopped',
    status: exit.code === 0 ? 'completed' : 'failed',
    detail: exit.code === 0 ? undefined : `Exit: ${exit.signal || exit.code || 'unknown'}.`,
    stderr,
    metadata: { eventCount: events.length, exitCode: exit.code, signal: exit.signal ?? undefined },
  });
  if (cancelled) throw new BuilderCancelledError();
  await assertBuildActive(client, run, workerId);
  if (exit.code !== 0) {
    throw new Error(
      `Codex CLI could not finish the build: ${stderr.slice(-500) || exit.signal || exit.code}`,
    );
  }
  await assertLockedFiles(workspace.siteDirectory, workspace.lockedFiles);
  await syncDraftFiles(client, run, workspace, eventWriter);
  await eventWriter(
    'stage',
    'Codex finished writing the website. Compiling the private preview now.',
  );
  const finalMessage = await readFile(outputPath, 'utf8').catch(
    () => 'Codex completed without a final message.',
  );
  return { events, finalMessage };
}

async function buildWebsite(client, run, workerId, workspace, eventWriter, diagnostics) {
  await updateProgress(client, run, workerId, {
    progress_phase: 'building_output',
    progress_detail: 'Compiling the generated website into a private preview.',
    total_items: 7,
    completed_items: 3,
  });
  await runDiagnosticCommand(diagnostics, 'website_compile', 'npm', ['run', 'build'], {
    cwd: workspace.siteDirectory,
    env: process.env,
  });
  const indexPath = join(workspace.siteDirectory, 'dist', 'index.html');
  try {
    await stat(indexPath);
  } catch {
    throw new Error('The generated website did not produce dist/index.html.');
  }
  await eventWriter(
    'stage',
    'Private website compiled successfully. Starting browser quality checks.',
  );
}

function safeRequestPath(rootDirectory, requestPath) {
  const requested = decodeURIComponent(requestPath.split('?')[0] || '/');
  const normalized = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const resolved = resolve(rootDirectory, normalized);
  if (
    !resolved.startsWith(`${resolve(rootDirectory)}${sep}`) &&
    resolved !== resolve(rootDirectory)
  ) {
    return undefined;
  }
  return resolved;
}

async function startStaticServer(rootDirectory) {
  const server = createServer(async (request, response) => {
    const path = safeRequestPath(rootDirectory, request.url || '/');
    if (!path) {
      response.writeHead(403).end();
      return;
    }
    try {
      const details = await stat(path);
      const target = details.isDirectory() ? join(path, 'index.html') : path;
      const body = await readFile(target);
      response.writeHead(200, {
        'content-type': contentTypeFor(target),
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Could not create a local quality-check server.');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

function structuralCheck(htmlFiles) {
  const problems = [];
  for (const file of htmlFiles) {
    const html = file.contents;
    if (!/<title[^>]*>[^<]+<\/title>/i.test(html))
      problems.push(`${file.relativePath} has no title.`);
    if (!/<main[\s>]/i.test(html)) problems.push(`${file.relativePath} has no main landmark.`);
    if (!/<h1[\s>]/i.test(html)) problems.push(`${file.relativePath} has no H1.`);
    if (/\s(?:src|href)=["']\/(?!\/)/i.test(html)) {
      problems.push(`${file.relativePath} uses a root-relative file path.`);
    }
    if (/\s(?:src|href)=["']https?:\/\//i.test(html)) {
      problems.push(`${file.relativePath} references a remote file.`);
    }
  }
  return problems;
}

function sourceUrlMarker(html) {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const content = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (name?.toLowerCase() === 'siteforge-source-url' && content) return content;
  }
  return undefined;
}

function selectedPageCoverageCheck(manifest, htmlFiles) {
  const selectedPages = sourcePagePlan(
    Array.isArray(recordValue(manifest.data).selectedPages)
      ? recordValue(manifest.data).selectedPages
      : [],
  );
  const generatedByPath = new Map(htmlFiles.map((file) => [file.relativePath, file]));
  const problems = [];
  for (const page of selectedPages) {
    const output = generatedByPath.get(page.outputPath);
    if (!output) {
      problems.push(`${page.outputPath} is missing for selected source ${page.sourceUrl}.`);
      continue;
    }
    const marker = sourceUrlMarker(output.contents);
    if (!marker) {
      problems.push(`${page.outputPath} has no selected-source provenance marker.`);
      continue;
    }
    try {
      if (normaliseSourceUrl(marker) !== page.sourceUrl) {
        problems.push(`${page.outputPath} is mapped to the wrong selected source page.`);
      }
    } catch {
      problems.push(`${page.outputPath} has an invalid selected-source provenance marker.`);
    }
  }
  return { expectedPageCount: selectedPages.length, problems };
}

function previewUrlForPage(serverUrl, relativePath) {
  const encodedPath = relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return new URL(encodedPath, serverUrl).toString();
}

async function runQualityChecks(
  client,
  run,
  workerId,
  workspace,
  manifest,
  eventWriter,
  diagnostics,
) {
  const outputDirectory = join(workspace.siteDirectory, 'dist');
  const allFiles = await collectFiles(outputDirectory);
  const htmlFiles = await Promise.all(
    allFiles
      .filter((file) => extname(file).toLowerCase() === '.html')
      .map(async (file) => ({
        relativePath: relative(outputDirectory, file),
        contents: await readFile(file, 'utf8'),
      })),
  );
  const totalPreviewCaptures = htmlFiles.length * previewViewports.length;
  const totalItems = 5 + totalPreviewCaptures;
  const structuralProblems = structuralCheck(htmlFiles);
  const selectedPageCoverage = selectedPageCoverageCheck(manifest, htmlFiles);
  const brandCheckProblems = await brandProblems(manifest, workspace.stagedAssets, allFiles);
  const checks = [
    {
      id: 'static-structure',
      label: 'Semantic page structure',
      status: structuralProblems.length ? 'failed' : 'passed',
      detail: structuralProblems.length
        ? structuralProblems.join(' ')
        : `${htmlFiles.length} page${htmlFiles.length === 1 ? '' : 's'} include a title, main landmark, and H1.`,
    },
    {
      id: 'brand-kit-usage',
      label: 'Approved brand kit usage',
      status: brandCheckProblems.length ? 'failed' : 'passed',
      detail: brandCheckProblems.length
        ? brandCheckProblems.join(' ')
        : 'No approved Brand Kit was required, or its primary logo and reviewed palette are present.',
    },
    {
      id: 'selected-page-coverage',
      label: 'Selected source-page coverage',
      status: selectedPageCoverage.problems.length ? 'failed' : 'passed',
      detail: selectedPageCoverage.problems.length
        ? selectedPageCoverage.problems.join(' ')
        : `${selectedPageCoverage.expectedPageCount} selected source page${selectedPageCoverage.expectedPageCount === 1 ? '' : 's'} mapped to generated output with provenance.`,
    },
  ];
  await updateProgress(client, run, workerId, {
    progress_phase: 'quality_checks',
    progress_detail: `Checking ${htmlFiles.length} generated page${htmlFiles.length === 1 ? '' : 's'} in a private browser.`,
    total_items: totalItems,
    completed_items: 4,
  });
  await eventWriter(
    'quality',
    `Browser checks started for ${htmlFiles.length} generated page${htmlFiles.length === 1 ? '' : 's'}.`,
  );
  let previewServer;
  try {
    previewServer = await startStaticServer(outputDirectory);
  } catch (error) {
    await diagnostics.record({
      scope: 'browser_quality',
      title: 'Private preview server could not start',
      status: 'failed',
      detail: error instanceof Error ? error.message : 'The private preview server did not start.',
    });
    throw new BuilderQualityError('preview_server_start', { cause: error });
  }
  const { server, url } = previewServer;
  await diagnostics.record({
    scope: 'browser_quality',
    title: 'Private preview server started',
    metadata: { generatedPageCount: htmlFiles.length },
  });
  const screenshotArtifacts = [];
  const axeViolations = [];
  try {
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      await diagnostics.record({
        scope: 'browser_quality',
        title: 'Private browser could not launch',
        status: 'failed',
        detail: error instanceof Error ? error.message : 'The private browser did not launch.',
      });
      throw new BuilderQualityError('browser_launch', { cause: error });
    }
    await diagnostics.record({
      scope: 'browser_quality',
      title: 'Private browser launched',
      metadata: { engine: 'chromium' },
    });
    try {
      let completedCaptures = 0;
      for (const htmlFile of htmlFiles) {
        for (const viewport of previewViewports) {
          await assertBuildActive(client, run, workerId);
          await updateProgress(client, run, workerId, {
            progress_phase: 'capturing_preview',
            progress_detail: `Capturing ${htmlFile.relativePath} at ${viewport.label.toLowerCase()} width.`,
            total_items: totalItems,
            completed_items: 4 + completedCaptures,
          });
          let browserContext;
          let page;
          let qualityOperation = 'page_open';
          const captureStartedAt = Date.now();
          try {
            browserContext = await browser.newContext({
              viewport: { width: viewport.width, height: viewport.height },
              isMobile: viewport.isMobile,
            });
            page = await browserContext.newPage();
            qualityOperation = 'request_routing';
            await page.route('**/*', (route) => {
              const requestUrl = route.request().url();
              if (requestUrl.startsWith(url)) return route.continue();
              return route.abort();
            });
            qualityOperation = 'navigation';
            await page.goto(previewUrlForPage(url, htmlFile.relativePath), {
              waitUntil: 'domcontentloaded',
              timeout: 15_000,
            });
            await page.waitForTimeout(250);
            qualityOperation = 'rendered_text';
            const contentLength = await page
              .locator('body')
              .innerText()
              .then((text) => text.trim().length);
            if (!contentLength) {
              throw new Error(
                `${htmlFile.relativePath} rendered no text at ${viewport.label.toLowerCase()} width.`,
              );
            }
            if (viewport.id === 'desktop' || viewport.id === 'mobile') {
              qualityOperation = 'accessibility_scan';
              const result = await new AxeBuilder({ page }).analyze();
              axeViolations.push(
                ...result.violations.map((violation) => ({
                  id: violation.id,
                  page: htmlFile.relativePath,
                })),
              );
            }
            qualityOperation = 'screenshot';
            const body = await page.screenshot({ fullPage: true, type: 'png' });
            const pageStem = htmlFile.relativePath
              .replace(/\.html$/i, '')
              .replace(/[^a-z0-9]+/gi, '-')
              .replace(/^-+|-+$/g, '');
            screenshotArtifacts.push({
              kind: 'screenshot',
              label: `${viewport.label}: ${htmlFile.relativePath}`,
              relativePath: `screenshots/${pageStem || 'index'}-${viewport.id}.png`,
              body,
              contentType: 'image/png',
              metadata: {
                viewport: viewport.id,
                width: viewport.width,
                height: viewport.height,
                page: htmlFile.relativePath,
              },
            });
            const screenshot = screenshotArtifacts[screenshotArtifacts.length - 1];
            qualityOperation = 'screenshot_storage';
            await uploadArtifact(client, run, screenshot);
            await eventWriter(
              'quality',
              `Captured ${viewport.label.toLowerCase()} preview for ${htmlFile.relativePath}.`,
              {
                page: htmlFile.relativePath,
                viewport: viewport.id,
              },
            );
            await diagnostics.record({
              scope: 'browser_quality',
              title: 'Responsive preview captured',
              durationMs: Date.now() - captureStartedAt,
              metadata: {
                page: htmlFile.relativePath,
                viewport: viewport.id,
                screenshotBytes: body.byteLength,
              },
            });
            completedCaptures += 1;
          } catch (error) {
            if (error instanceof BuilderCancelledError || error instanceof BuilderStorageError) {
              throw error;
            }
            const qualityError =
              error instanceof BuilderQualityError
                ? error
                : new BuilderQualityError(qualityOperation, {
                    page: htmlFile.relativePath,
                    viewport: viewport.id,
                    cause: error,
                  });
            await eventWriter(
              'error',
              `Browser quality check stopped at ${htmlFile.relativePath} (${viewport.label.toLowerCase()}).`,
              qualityError.context,
            );
            await diagnostics.record({
              scope: 'browser_quality',
              title: 'Responsive preview check failed',
              status: 'failed',
              detail: qualityError.context.detail,
              durationMs: Date.now() - captureStartedAt,
              metadata: qualityError.context,
            });
            throw qualityError;
          } finally {
            await page?.close().catch(() => undefined);
            await browserContext?.close().catch(() => undefined);
          }
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const uniqueViolationIds = [...new Set(axeViolations.map((violation) => violation.id))];
  checks.push({
    id: 'accessibility',
    label: 'Automated accessibility scan',
    status: uniqueViolationIds.length ? 'needs_review' : 'passed',
    detail: uniqueViolationIds.length
      ? `${uniqueViolationIds.length} axe rule${uniqueViolationIds.length === 1 ? '' : 's'} need review: ${uniqueViolationIds.join(', ')}.`
      : `No automated axe violations were detected across ${htmlFiles.length} generated page${htmlFiles.length === 1 ? '' : 's'} at desktop and mobile widths.`,
    metadata: {
      violationIds: uniqueViolationIds,
      violations: axeViolations,
    },
  });
  checks.push({
    id: 'responsive-preview',
    label: 'Responsive preview captures',
    status: screenshotArtifacts.length === totalPreviewCaptures ? 'passed' : 'failed',
    detail: `${screenshotArtifacts.length}/${totalPreviewCaptures} desktop, tablet, and mobile page captures completed.`,
  });
  const status = checks.some((check) => check.status === 'failed')
    ? 'failed'
    : checks.some((check) => check.status === 'needs_review')
      ? 'needs_review'
      : 'passed';
  return {
    summary: { status, checks, generatedAt: new Date().toISOString() },
    screenshotArtifacts,
    allFiles,
    totalItems,
  };
}

async function saveOutputs(
  client,
  run,
  workerId,
  workspace,
  codexOutput,
  quality,
  eventWriter,
  diagnostics,
) {
  await updateProgress(client, run, workerId, {
    progress_phase: 'saving_outputs',
    progress_detail: 'Saving private source, preview files, screenshots, and quality results.',
    total_items: quality.totalItems,
    completed_items: quality.totalItems - 1,
  });
  const sourceArchivePath = join(workspace.runDirectory, 'website-source.tgz');
  await runDiagnosticCommand(
    diagnostics,
    'source_archive',
    'tar',
    ['-czf', sourceArchivePath, '-C', workspace.runDirectory, 'website'],
    {
      cwd: workspace.runDirectory,
      env: process.env,
    },
  );
  await uploadArtifact(client, run, {
    kind: 'source_bundle',
    label: 'Generated website source',
    relativePath: 'source/website-source.tgz',
    body: await readFile(sourceArchivePath),
    contentType: 'application/gzip',
    metadata: { templateVersion: run.template_version },
  });
  for (const file of quality.allFiles) {
    if (isPlaceholderOutputFile(file)) continue;
    const outputDirectory = join(workspace.siteDirectory, 'dist');
    const relativePath = relative(outputDirectory, file).split(sep).join('/');
    await uploadArtifact(client, run, {
      kind: 'site_file',
      label: relativePath,
      relativePath: `site/${relativePath}`,
      body: await readFile(file),
      contentType: contentTypeFor(file),
      metadata: { previewPath: relativePath },
    });
  }
  for (const screenshot of quality.screenshotArtifacts) {
    await uploadArtifact(client, run, screenshot);
  }
  await uploadArtifact(client, run, {
    kind: 'quality',
    label: 'Automated quality results',
    relativePath: 'quality/results.json',
    body: Buffer.from(JSON.stringify(quality.summary, null, 2)),
    contentType: 'application/json',
    metadata: { status: quality.summary.status },
  });
  await uploadArtifact(client, run, {
    kind: 'log',
    label: 'Codex builder log',
    relativePath: 'logs/codex-events.json',
    body: Buffer.from(
      JSON.stringify(
        { events: codexOutput.events, finalMessage: codexOutput.finalMessage },
        null,
        2,
      ),
    ),
    contentType: 'application/json',
    metadata: { eventCount: codexOutput.events.length },
  });
  await eventWriter(
    'stage',
    'Private source, generated files, and quality results have been saved.',
  );
}

async function processBuild(client, run, workerId, apiKey) {
  const { data: manifest, error } = await client
    .from('build_manifests')
    .select('*')
    .eq('id', run.build_manifest_id)
    .single();
  if (error || !manifest || manifest.status !== 'ready') {
    throw new Error('The approved Build Manifest is no longer available.');
  }
  const brandKit = recordValue(recordValue(manifest.data).brandKit);
  if (!brandKit.id || !brandKit.primaryLogoAssetId) {
    throw new Error(
      'The Build Manifest has no approved Brand Kit and cannot create a generic preview.',
    );
  }
  const eventWriter = createEventWriter(client, run);
  const diagnostics = createDiagnosticWriter({
    writeEvent: eventWriter,
    writeSnapshot: async (entries) => {
      await uploadArtifact(client, run, {
        kind: 'log',
        label: 'Live build diagnostic log',
        relativePath: 'logs/diagnostics.json',
        body: Buffer.from(JSON.stringify({ entries }, null, 2)),
        contentType: 'application/json',
        metadata: { entryCount: entries.length, state: 'live_diagnostics' },
      });
    },
  });
  await eventWriter('stage', 'Preparing a clean private website workspace.');
  let workspace;
  try {
    workspace = await prepareWorkspace(client, run, manifest, workerId, diagnostics);
    await eventWriter(
      'stage',
      workspace.restoredCheckpoint
        ? workspace.restoredFromLegacyDrafts
          ? `Saved draft source restored with ${workspace.restoredCheckpointFileCount} file${workspace.restoredCheckpointFileCount === 1 ? '' : 's'}; Codex will continue from it and create a full checkpoint.`
          : `Private source checkpoint restored with ${workspace.restoredCheckpointFileCount} file${workspace.restoredCheckpointFileCount === 1 ? '' : 's'}; Codex will continue from it.`
        : `Manifest, ${workspace.stagedSourcePages.length} selected page source${workspace.stagedSourcePages.length === 1 ? '' : 's'}, and ${workspace.stagedAssets.length} approved asset${workspace.stagedAssets.length === 1 ? '' : 's'} staged for Codex.`,
    );
    const codexOutput = await runCodex(
      client,
      run,
      workerId,
      workspace,
      apiKey,
      eventWriter,
      diagnostics,
    );
    await buildWebsite(client, run, workerId, workspace, eventWriter, diagnostics);
    const quality = await runQualityChecks(
      client,
      run,
      workerId,
      workspace,
      manifest,
      eventWriter,
      diagnostics,
    );
    await saveOutputs(
      client,
      run,
      workerId,
      workspace,
      codexOutput,
      quality,
      eventWriter,
      diagnostics,
    );
    return quality;
  } catch (error) {
    await diagnostics.record({
      scope: 'build_failure',
      title: 'Build stopped',
      status: 'failed',
      detail:
        error instanceof Error ? error.message : 'The builder stopped without an error message.',
    });
    await diagnostics.flush();
    throw error;
  } finally {
    await diagnostics.flush();
    if (workspace) await rm(workspace.runDirectory, { recursive: true, force: true });
  }
}

async function markCancelled(client, run, workerId) {
  await client
    .from('builder_runs')
    .update({
      status: 'cancelled',
      completed_at: new Date().toISOString(),
      lease_expires_at: null,
      progress_phase: 'cancelled',
      progress_detail: 'Private preview build cancelled. Any saved artifacts remain private.',
      error_summary: 'Private preview build cancelled by a workspace user.',
      failure_code: 'cancelled_by_user',
      failure_stage: 'cancelled',
      failure_action:
        'Review any saved frozen draft or start a new build from the same approved manifest.',
      retry_after: null,
    })
    .eq('id', run.id)
    .eq('worker_id', workerId)
    .not('cancel_requested_at', 'is', null);
  await createEventWriter(client, run)(
    'stage',
    'Private preview build cancelled. Saved draft files remain private.',
  );
}

async function markFailed(client, run, error) {
  const details = failureDetails(error);
  const retryAt =
    details.retryable && Number(run.attempt_count ?? 0) < 2
      ? new Date(Date.now() + 30_000).toISOString()
      : undefined;
  const paused = Boolean(retryAt);
  await client
    .from('builder_runs')
    .update({
      status: paused ? 'paused' : 'failed',
      completed_at: paused ? null : new Date().toISOString(),
      lease_expires_at: null,
      retry_after: retryAt ?? null,
      progress_phase: paused ? 'retry_wait' : 'failed',
      progress_detail: paused
        ? 'A temporary builder problem occurred. Retrying this immutable build once in about 30 seconds.'
        : details.summary,
      error_summary: details.summary,
      failure_code: details.code,
      failure_stage: details.stage,
      failure_action: details.action,
      failure_context: {
        attempt: Number(run.attempt_count ?? 0),
        retryable: details.retryable,
        retryAfter: retryAt ?? null,
        ...details.context,
      },
    })
    .eq('id', run.id);
  await createEventWriter(client, run)(
    paused ? 'stage' : 'error',
    paused
      ? 'A temporary builder problem occurred. One automatic retry is scheduled.'
      : `${details.summary} ${details.action}`,
    {
      code: details.code,
      stage: details.stage,
      retryable: details.retryable,
      ...details.context,
    },
  );
  return paused;
}

async function processNextBuild(client, workerId, apiKey) {
  const { data, error } = await client.rpc('claim_next_website_build', {
    worker_identity: workerId,
  });
  if (error) throw new Error('The builder worker could not claim a private preview build.');
  const run = Array.isArray(data) ? data[0] : undefined;
  if (!run) return false;
  try {
    if (!apiKey) {
      throw new Error(
        'SITEFORGE_CODEX_API_KEY or OPENAI_API_KEY is required for the Codex builder worker.',
      );
    }
    const quality = await processBuild(client, run, workerId, apiKey);
    const reviewRequired = quality.summary.status !== 'passed';
    const { error: completionError } = await client
      .from('builder_runs')
      .update({
        status: reviewRequired ? 'review_required' : 'ready',
        model: process.env.SITEFORGE_CODEX_MODEL?.trim() || null,
        completed_at: new Date().toISOString(),
        lease_expires_at: null,
        progress_phase: 'complete',
        progress_detail:
          quality.summary.status === 'passed'
            ? 'Private preview ready. Automated quality checks passed.'
            : 'Private preview generated, but automated quality results require review before sharing.',
        total_items: quality.totalItems,
        completed_items: quality.totalItems,
        quality_summary: quality.summary,
        error_summary: null,
        failure_code: null,
        failure_stage: null,
        failure_action: null,
        failure_context: {},
        retry_after: null,
      })
      .eq('id', run.id)
      .eq('worker_id', workerId);
    if (completionError) throw completionError;
    await client.from('activities').insert({
      organization_id: run.organization_id,
      business_id: run.business_id,
      type: 'note',
      message: reviewRequired
        ? 'Private redesign preview generated with quality results requiring review before sharing.'
        : 'Private redesign preview generated. Review the preview and quality results before sharing.',
    });
    await createEventWriter(client, run)(
      'stage',
      reviewRequired
        ? 'Private preview generated with quality review required before sharing.'
        : 'Private preview generated and automated quality checks passed.',
    );
    console.log(`[builder-worker] completed ${run.id}`);
  } catch (error) {
    if (error instanceof BuilderCancelledError) {
      await markCancelled(client, run, workerId);
      console.log(`[builder-worker] cancelled ${run.id}`);
      return true;
    }
    const paused = await markFailed(client, run, error);
    console.error(
      paused ? '[builder-worker] retry scheduled' : '[builder-worker] failed',
      run.id,
      error instanceof Error ? error.message : error,
    );
  }
  return true;
}

async function main() {
  const supabaseUrl = requiredEnvironment('SITEFORGE_SUPABASE_URL');
  const serviceRoleKey = requiredEnvironment('SITEFORGE_SUPABASE_SERVICE_ROLE_KEY');
  const apiKey = process.env.SITEFORGE_CODEX_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  const workerId =
    process.env.SITEFORGE_WORKER_ID?.trim() || `${hostname()}-builder-${process.pid}`;
  const pollIntervalMs = Number(process.env.SITEFORGE_BUILDER_POLL_MS ?? 5_000);
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const runOnce = process.argv.includes('--once');
  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
  });
  process.on('SIGTERM', () => {
    stopping = true;
  });
  do {
    const claimed = await processNextBuild(client, workerId, apiKey);
    if (runOnce || stopping) {
      if (runOnce && !claimed) console.log('[builder-worker] no queued private preview builds.');
      break;
    }
    if (!claimed) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (!stopping);
}

main().catch((error) => {
  console.error(
    '[builder-worker] stopped unexpectedly',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
