import {
  ArrowLeft,
  ArrowUpRight,
  Ban,
  Check,
  CheckCheck,
  CircleAlert,
  ClipboardCheck,
  Clock3,
  ExternalLink,
  FilePenLine,
  FileText,
  Globe2,
  ListChecks,
  Play,
  RotateCcw,
  Save,
  Search,
  SearchCheck,
  Settings,
  ShieldAlert,
  Sparkles,
  SlidersHorizontal,
  Trash2,
  UsersRound,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type RefObject,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import * as Dialog from '@radix-ui/react-dialog';
import { AppShell, type AppPage } from './components/AppShell';
import {
  Button,
  Card,
  ConfirmationDialog,
  Eyebrow,
  StatusBadge,
  ToastRegion,
  type ToastNotice,
} from './components/ui';
import {
  isOpenTask,
  stageLabels,
  type Audit,
  type Business,
  type AuditFinding,
  type AssetAnnotation,
  type BrandKit,
  type CapabilityDecision,
  type BriefSourceSelections,
  type BuilderPreviewMode,
  type BuilderRun,
  type BuilderEvent,
  type CapturedPage,
  type ProspectStage,
  type ProspectWorkspace,
  type RedesignBrief,
  type RedesignBriefDraft,
  type ResearchArtifact,
  type Task,
} from './lib/domain';
import { SupabaseWorkspaceRepository } from './lib/cloud-repository';
import { manifestSourceMatchesBrief } from './lib/build-manifest';
import { brandColourEvidenceSummary, rankBrandColourEvidence } from './lib/brand-colours';
import { detectCapabilities } from './lib/capability-inventory';
import { siteforgeRepository, type WorkspaceRepository } from './lib/repository';
import { getSupabaseClient, isSupabaseConfigured, usesLocalStorage } from './lib/supabase';

type WorkspaceTab =
  | 'overview'
  | 'research'
  | 'packet'
  | 'assets'
  | 'brief'
  | 'audit'
  | 'redesign'
  | 'report'
  | 'activity';
type Route =
  | { page: 'today' }
  | { page: 'settings' }
  | { page: 'prospects'; businessId?: string; tab?: WorkspaceTab };

const lastRouteStorageKey = 'siteforge-os.last-route';

const workspaceTabs: Array<{ id: WorkspaceTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'research', label: 'Research' },
  { id: 'packet', label: 'Packet' },
  { id: 'assets', label: 'Assets' },
  { id: 'brief', label: 'Brief' },
  { id: 'redesign', label: 'Redesign' },
  { id: 'audit', label: 'Audit' },
  { id: 'report', label: 'Report' },
  { id: 'activity', label: 'Activity' },
];

function isWorkspaceTab(value: string | undefined): value is WorkspaceTab {
  return workspaceTabs.some((tab) => tab.id === value);
}

function routeFromHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'prospects') {
    return {
      page: 'prospects',
      businessId: parts[1],
      tab: isWorkspaceTab(parts[2]) ? parts[2] : undefined,
    };
  }
  if (parts[0] === 'settings') return { page: 'settings' };
  return { page: 'today' };
}

function hrefForRoute(route: Route) {
  if (route.page === 'today') return '#/today';
  if (route.page === 'settings') return '#/settings';
  return `#/prospects${route.businessId ? `/${route.businessId}${route.tab ? `/${route.tab}` : ''}` : ''}`;
}

function storedRouteHash() {
  try {
    return window.localStorage.getItem(lastRouteStorageKey);
  } catch {
    return null;
  }
}

function persistRouteHash(hash: string) {
  try {
    window.localStorage.setItem(lastRouteStorageKey, hash);
  } catch {
    // Route persistence is a convenience; navigation must still work when storage is unavailable.
  }
}

function initialRoute() {
  const hash = window.location.hash || storedRouteHash() || '#/today';
  persistRouteHash(hash);
  if (!window.location.hash && hash) window.history.replaceState(null, '', hash);
  return routeFromHash(hash);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function stageTone(stage: ProspectStage) {
  if (stage === 'lost' || stage === 'paused') return 'danger' as const;
  if (stage === 'outreach_pending' || stage === 'responded' || stage === 'proposal') {
    return 'success' as const;
  }
  if (stage === 'audit_ready' || stage === 'concept_ready' || stage === 'awaiting_approval') {
    return 'warning' as const;
  }
  return 'neutral' as const;
}

function StatusPill({ stage }: { stage: ProspectStage }) {
  return <StatusBadge tone={stageTone(stage)}>{stageLabels[stage]}</StatusBadge>;
}

function businessInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function businessLogo(workspace: ProspectWorkspace) {
  const logos = workspace.artifacts.filter(
    (artifact) => artifact.kind === 'asset' && artifact.metadata.assetType === 'logo',
  );
  return logos.find((artifact) => artifact.metadata.preferredOrganisationLogo === true) ?? logos[0];
}

function BusinessIdentity({
  workspace,
  title = false,
  websiteUrl,
  websiteDomain,
}: {
  workspace: ProspectWorkspace;
  title?: boolean;
  websiteUrl?: string;
  websiteDomain?: string;
}) {
  const logo = businessLogo(workspace);
  const sourceUrl =
    typeof logo?.metadata.sourceUrl === 'string' ? logo.metadata.sourceUrl : undefined;
  const name = workspace.business.name;
  return (
    <span className={title ? 'business-identity business-identity--title' : 'business-identity'}>
      {sourceUrl ? (
        title ? (
          <ExpandableImage
            alt={`${name} logo`}
            className="business-identity__logo-button"
            label={`${name} logo`}
            src={sourceUrl}
          >
            <img alt="" className="business-identity__logo" src={sourceUrl} />
          </ExpandableImage>
        ) : (
          <img alt="" className="business-identity__logo" src={sourceUrl} />
        )
      ) : (
        <span aria-hidden="true" className="business-identity__fallback">
          {businessInitials(name)}
        </span>
      )}
      {title ? (
        <span className="business-identity__title-content">
          <h1>{name}</h1>
          {websiteUrl && websiteDomain ? (
            <a
              aria-label={`Open ${websiteDomain}`}
              className="business-identity__website-link"
              href={websiteUrl}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink aria-hidden="true" size={17} />
            </a>
          ) : null}
        </span>
      ) : (
        <strong title={name}>{name}</strong>
      )}
    </span>
  );
}

function EmptyState({
  icon: Icon,
  title,
  detail,
  action,
}: {
  icon: typeof ClipboardCheck;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <Icon aria-hidden="true" size={22} />
      <div>
        <h3>{title}</h3>
        <p>{detail}</p>
        {action}
      </div>
    </div>
  );
}

function PageHeader({
  eyebrow,
  title,
  detail,
  action,
}: {
  eyebrow: string;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1>{title}</h1>
        <p>{detail}</p>
      </div>
      {action ? <div className="page-header__action">{action}</div> : null}
    </header>
  );
}

function Metric({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <article className="metric metric--operational">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function TodayPage({
  businesses,
  workspaces,
  openWorkspace,
}: {
  businesses: Business[];
  workspaces: ProspectWorkspace[];
  openWorkspace: (businessId: string) => void;
}) {
  const openTasks = workspaces.flatMap((workspace) =>
    workspace.tasks.filter(isOpenTask).map((task) => ({ task, business: workspace.business })),
  );
  const waitingReview = businesses.filter((business) => business.reviewState === 'needs_review');
  const nextActions = [...openTasks]
    .sort((left, right) => right.business.updatedAt.localeCompare(left.business.updatedAt))
    .slice(0, 5);

  return (
    <>
      <PageHeader
        detail="A focused view of the work that needs your judgment today."
        eyebrow="Operations"
        title="Today"
      />

      <section aria-label="Today metrics" className="metric-grid metric-grid--operational">
        <Metric detail="potential clients" label="Prospects" value={businesses.length} />
        <Metric detail="need human review" label="Review queue" value={waitingReview.length} />
        <Metric detail="across all records" label="Open tasks" value={openTasks.length} />
        <Metric
          detail="ready for outreach"
          label="Approved"
          value={businesses.filter((business) => business.stage === 'outreach_pending').length}
        />
      </section>

      <div className="today-grid">
        <section aria-labelledby="next-actions-title" className="work-panel">
          <div className="section-heading">
            <div>
              <Eyebrow>Next actions</Eyebrow>
              <h2 id="next-actions-title">Work requiring attention</h2>
            </div>
            <ListChecks aria-hidden="true" size={19} />
          </div>
          {nextActions.length ? (
            <div className="action-list">
              {nextActions.map(({ task, business }) => (
                <button
                  className="action-row"
                  key={task.id}
                  onClick={() => openWorkspace(business.id)}
                  type="button"
                >
                  <span className="action-row__icon">
                    <CircleAlert aria-hidden="true" size={17} />
                  </span>
                  <span>
                    <strong>{task.body}</strong>
                    <small>
                      {business.name} · {stageLabels[business.stage]}
                    </small>
                  </span>
                  <ArrowUpRight aria-hidden="true" size={17} />
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              detail="Create a prospect to generate its first review tasks."
              icon={ListChecks}
              title="No open actions"
            />
          )}
        </section>

        <section aria-labelledby="recent-title" className="work-panel">
          <div className="section-heading">
            <div>
              <Eyebrow>Recent activity</Eyebrow>
              <h2 id="recent-title">Pipeline movement</h2>
            </div>
            <Clock3 aria-hidden="true" size={19} />
          </div>
          <div className="activity-list activity-list--compact">
            {workspaces
              .flatMap((workspace) =>
                workspace.activity
                  .slice(0, 1)
                  .map((activity) => ({ activity, business: workspace.business })),
              )
              .sort((left, right) =>
                right.activity.createdAt.localeCompare(left.activity.createdAt),
              )
              .slice(0, 5)
              .map(({ activity, business }) => (
                <button
                  className="activity-row"
                  key={activity.id}
                  onClick={() => openWorkspace(business.id)}
                  type="button"
                >
                  <span>
                    <strong>{business.name}</strong>
                    <small>{activity.message}</small>
                  </span>
                  <time dateTime={activity.createdAt}>{formatDate(activity.createdAt)}</time>
                </button>
              ))}
          </div>
        </section>
      </div>
    </>
  );
}

function IntakeForm({
  createProspect,
  onCreated,
}: {
  createProspect: (url: string) => Promise<ProspectWorkspace | undefined>;
  onCreated: (workspace: ProspectWorkspace) => void;
}) {
  const [url, setUrl] = useState('');
  const [state, setState] = useState<'idle' | 'running' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!url.trim()) return;
    setState('running');
    setMessage('Creating a prospect workspace and research queue...');
    try {
      const workspace = await createProspect(url.trim());
      if (!workspace) throw new Error('The prospect workspace could not be created.');
      setUrl('');
      setState('idle');
      setMessage('');
      onCreated(workspace);
    } catch (error) {
      setState('error');
      setMessage(
        error instanceof Error && error.message === 'You already have this website as a prospect.'
          ? error.message
          : 'Enter a valid public website URL to create a prospect.',
      );
    }
  }

  return (
    <Card aria-labelledby="new-prospect-title" className="intake-panel">
      <div>
        <Eyebrow>New prospect</Eyebrow>
        <h2 id="new-prospect-title">Start from the public website</h2>
        <p>
          Creates a private prospect workspace and a review queue. It does not crawl or contact the
          business.
        </p>
      </div>
      <form className="url-form" onSubmit={submit}>
        <label htmlFor="websiteUrl">Public website URL</label>
        <div className="input-row">
          <Globe2 aria-hidden="true" size={18} />
          <input
            autoComplete="url"
            id="websiteUrl"
            name="websiteUrl"
            onChange={(event) => setUrl(event.target.value)}
            placeholder="example-business.com"
            value={url}
          />
          <Button disabled={state === 'running' || !url.trim()} type="submit">
            {state === 'running' ? (
              <Sparkles aria-hidden="true" className="spin" size={17} />
            ) : (
              <Play aria-hidden="true" size={17} />
            )}
            {state === 'running' ? 'Creating' : 'Create'}
          </Button>
        </div>
        {message ? (
          <p
            className={state === 'error' ? 'form-message form-message--error' : 'form-message'}
            role={state === 'error' ? 'alert' : 'status'}
          >
            {message}
          </p>
        ) : null}
      </form>
    </Card>
  );
}

function ProspectsPage({
  businesses,
  workspaces,
  createProspect,
  createWorkspace,
  openWorkspace,
}: {
  businesses: Business[];
  workspaces: ProspectWorkspace[];
  createProspect: (url: string) => Promise<ProspectWorkspace | undefined>;
  createWorkspace: (workspace: ProspectWorkspace) => void;
  openWorkspace: (businessId: string) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'active' | 'outreach'>('all');
  const visibleBusinesses = businesses.filter((business) => {
    if (filter === 'active')
      return !['outreach_pending', 'lost', 'paused'].includes(business.stage);
    if (filter === 'outreach') return business.stage === 'outreach_pending';
    return true;
  });

  return (
    <>
      <PageHeader
        detail="Businesses before they become clients. Keep research, decisions, and outreach approval in one place."
        eyebrow="Pipeline"
        title="Prospects"
      />
      <IntakeForm createProspect={createProspect} onCreated={createWorkspace} />

      <section aria-labelledby="prospect-list-title" className="prospect-section">
        <div className="section-heading section-heading--controls">
          <div>
            <Eyebrow>Pipeline</Eyebrow>
            <h2 id="prospect-list-title">Potential clients</h2>
          </div>
          <label className="filter-control">
            <span>Show</span>
            <select
              onChange={(event) => setFilter(event.target.value as typeof filter)}
              value={filter}
            >
              <option value="all">All prospects</option>
              <option value="active">Research and review</option>
              <option value="outreach">Approved for outreach</option>
            </select>
          </label>
        </div>

        {visibleBusinesses.length ? (
          <div className="prospect-table" role="list">
            {visibleBusinesses.map((business) => {
              const workspace = workspaces.find((item) => item.business.id === business.id);
              return (
                <button
                  className="prospect-row"
                  key={business.id}
                  onClick={() => openWorkspace(business.id)}
                  type="button"
                >
                  <span className="prospect-row__identity">
                    {workspace ? (
                      <BusinessIdentity workspace={workspace} />
                    ) : (
                      <strong title={business.name}>{business.name}</strong>
                    )}
                    <small>{business.kind === 'prospect' ? 'Prospect' : 'Client'}</small>
                  </span>
                  <StatusPill stage={business.stage} />
                  <span className="prospect-row__updated">
                    Updated {formatDate(business.updatedAt)}
                  </span>
                  <ArrowUpRight aria-hidden="true" size={18} />
                </button>
              );
            })}
          </div>
        ) : (
          <EmptyState
            detail="Change the filter or create a prospect from a public website URL."
            icon={UsersRound}
            title="No prospects in this view"
          />
        )}
      </section>
    </>
  );
}

function WorkspaceHeader({
  workspace,
  onBack,
  onApprove,
  onOpenSettings,
  settingsButtonRef,
}: {
  workspace: ProspectWorkspace;
  onBack: () => void;
  onApprove: () => void;
  onOpenSettings: () => void;
  settingsButtonRef: RefObject<HTMLButtonElement>;
}) {
  const { business, website } = workspace;
  const isApproved = business.reviewState === 'approved';
  const canApprove = workspace.audit?.status === 'ready' && workspace.concept?.status === 'ready';
  return (
    <>
      <Button className="back-button" onClick={onBack} variant="quiet">
        <ArrowLeft aria-hidden="true" size={16} /> All prospects
      </Button>
      <header className="workspace-header">
        <div>
          <div className="workspace-header__identity-row">
            <BusinessIdentity
              title
              websiteDomain={website?.domain}
              websiteUrl={website?.url}
              workspace={workspace}
            />
            <div className="workspace-header__identity-actions">
              <StatusPill stage={business.stage} />
              <Button
                aria-label="Open prospect settings"
                className="workspace-header__settings-button"
                onClick={onOpenSettings}
                ref={settingsButtonRef}
                size="compact"
                variant="quiet"
              >
                <Settings aria-hidden="true" size={18} />
              </Button>
            </div>
          </div>
        </div>
        {canApprove && !isApproved ? (
          <div className="workspace-header__actions">
            <Button onClick={onApprove} variant="primary">
              <Check aria-hidden="true" size={16} /> Approve for outreach
            </Button>
          </div>
        ) : null}
      </header>
      {(isApproved || canApprove) && (
        <div className="approval-note" role="status">
          <ShieldAlert aria-hidden="true" size={17} />
          <span>
            {isApproved
              ? 'Approved for a human-controlled outreach step. Publishing remains blocked.'
              : 'A human review is required before outreach can begin. Publishing remains blocked.'}
          </span>
        </div>
      )}
    </>
  );
}

function WorkspaceSettingsDialog({
  workspace,
  onDelete,
  open,
  onOpenChange,
}: {
  workspace: ProspectWorkspace;
  onDelete: () => Promise<void>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="workspace-settings-overlay" />
        <Dialog.Content className="workspace-settings-dialog">
          <Dialog.Title className="sr-only">Prospect settings</Dialog.Title>
          <Dialog.Close asChild>
            <Button aria-label="Close prospect settings" size="compact" variant="quiet">
              <X aria-hidden="true" size={18} />
            </Button>
          </Dialog.Close>
          <ProspectSettingsPanel onDelete={onDelete} workspace={workspace} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const loadingTitle = 'SiteForge OS'.split('');

function WorkspaceLoadingOverlay({
  loading,
  onComplete,
}: {
  loading: boolean;
  onComplete: () => void;
}) {
  const [phase, setPhase] = useState<'entering' | 'departing'>('entering');

  useEffect(() => {
    if (loading) return;
    const departure = window.setTimeout(() => setPhase('departing'), 650);
    const complete = window.setTimeout(onComplete, 1_750);
    return () => {
      window.clearTimeout(departure);
      window.clearTimeout(complete);
    };
  }, [loading, onComplete]);

  return (
    <div
      aria-label="Loading SiteForge OS workspace"
      aria-live="polite"
      className="workspace-loading"
      data-phase={phase}
      role="status"
    >
      <span aria-label="SiteForge OS" className="workspace-loading__letters">
        {loadingTitle.map((letter, index) => (
          <span
            aria-hidden="true"
            key={`${letter}-${index}`}
            style={{ '--letter-index': index } as CSSProperties}
          >
            {letter === ' ' ? '\u00a0' : letter}
          </span>
        ))}
      </span>
      <span aria-hidden="true" className="workspace-loading__title-motion">
        SiteForge OS
      </span>
      <p>{phase === 'entering' ? 'Preparing your workspace' : 'Workspace ready'}</p>
    </div>
  );
}

function WorkspaceErrorOverlay({
  message,
  onSignOut,
}: {
  message: string;
  onSignOut?: () => Promise<void>;
}) {
  return (
    <div aria-live="assertive" className="workspace-loading workspace-loading--error" role="alert">
      <span aria-label="SiteForge OS" className="workspace-loading__letters">
        {loadingTitle.map((letter, index) => (
          <span
            aria-hidden="true"
            key={`${letter}-${index}`}
            style={{ '--letter-index': index } as CSSProperties}
          >
            {letter === ' ' ? '\u00a0' : letter}
          </span>
        ))}
      </span>
      <p>{message}</p>
      <div className="workspace-loading__error-actions">
        <Button onClick={() => window.location.reload()} variant="secondary">
          Try again
        </Button>
        {onSignOut ? (
          <Button onClick={() => void onSignOut()} variant="quiet">
            Sign out
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ProspectSettingsPanel({
  workspace,
  onDelete,
}: {
  workspace: ProspectWorkspace;
  onDelete: () => Promise<void>;
}) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  async function confirmDeletion() {
    setIsDeleting(true);
    setDeleteError('');
    try {
      await onDelete();
      setDeleteDialogOpen(false);
    } catch {
      setDeleteError('The prospect could not be deleted. Check your connection and try again.');
    } finally {
      setIsDeleting(false);
    }
  }

  if (workspace.business.kind !== 'prospect') {
    return (
      <Card className="workspace-panel">
        <Eyebrow>Settings</Eyebrow>
        <h2>Client settings</h2>
        <p className="muted-copy">No client-level settings are available yet.</p>
      </Card>
    );
  }

  return (
    <>
      <Card className="workspace-panel">
        <Eyebrow>Settings</Eyebrow>
        <h2>Prospect settings</h2>
        <p className="muted-copy">Manage irreversible actions separately from day-to-day work.</p>
        <section aria-labelledby="danger-zone-title" className="danger-zone">
          <div>
            <h3 id="danger-zone-title">Delete prospect</h3>
            <p>
              Permanently remove {workspace.business.name} and its research, tasks, and generated
              records.
            </p>
          </div>
          <Button onClick={() => setDeleteDialogOpen(true)} variant="danger">
            <Trash2 aria-hidden="true" size={16} /> Delete prospect
          </Button>
        </section>
      </Card>
      <ConfirmationDialog
        confirmLabel="Delete prospect"
        detail={`Delete ${workspace.business.name} and all of its research, tasks, and generated records? This cannot be undone.`}
        error={deleteError}
        isConfirming={isDeleting}
        onConfirm={() => void confirmDeletion()}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open);
          if (!open) setDeleteError('');
        }}
        open={deleteDialogOpen}
        title="Delete this prospect?"
      />
    </>
  );
}

function TaskList({ tasks, onToggle }: { tasks: Task[]; onToggle: (task: Task) => Promise<void> }) {
  const [optimisticStates, setOptimisticStates] = useState<Record<string, Task['state']>>({});

  async function toggle(task: Task) {
    const nextState = task.state === 'done' ? 'open' : 'done';
    setOptimisticStates((current) => ({ ...current, [task.id]: nextState }));
    await onToggle(task);
    setOptimisticStates((current) => {
      const remaining = { ...current };
      delete remaining[task.id];
      return remaining;
    });
  }

  return (
    <div className="task-list">
      {tasks.map((task) => (
        <label className="task-row" key={task.id}>
          <input
            checked={(optimisticStates[task.id] ?? task.state) === 'done'}
            onChange={() => void toggle(task)}
            type="checkbox"
          />
          <span>{task.body}</span>
        </label>
      ))}
    </div>
  );
}

function captureTone(
  status: NonNullable<ProspectWorkspace['latestCapture']>['status'] | undefined,
) {
  if (status === 'ready') return 'success' as const;
  if (status === 'failed') return 'danger' as const;
  if (status === 'cancelled') return 'warning' as const;
  if (status === 'queued' || status === 'running') return 'warning' as const;
  return 'neutral' as const;
}

function captureLabel(
  status: NonNullable<ProspectWorkspace['latestCapture']>['status'] | undefined,
) {
  if (status === 'queued') return 'Capture queued';
  if (status === 'running') return 'Capture running';
  if (status === 'ready') return 'Capture complete';
  if (status === 'failed') return 'Capture failed';
  if (status === 'cancelled') return 'Capture cancelled';
  return 'Not requested';
}

function captureIsActive(capture: ProspectWorkspace['latestCapture']) {
  return (
    capture?.status === 'queued' ||
    capture?.status === 'running' ||
    (Boolean(capture?.cancelRequestedAt) && !capture?.completedAt)
  );
}

function captureProgressLabel(capture: NonNullable<ProspectWorkspace['latestCapture']>) {
  if (capture.progressDetail) return capture.progressDetail;
  return capture.status === 'queued'
    ? 'Waiting for the protected worker to begin.'
    : 'Discovering public pages and saving private responsive evidence.';
}

function captureFailureStage(phase?: string) {
  if (phase === 'saving_page') return 'Saving page evidence';
  if (phase === 'saving_asset') return 'Saving visual asset';
  if (phase === 'capturing_assets') return 'Collecting visual assets';
  if (phase === 'finalizing') return 'Preparing Research Packet';
  if (phase === 'discovering') return 'Discovering public pages';
  return 'Capturing public page';
}

function evidenceStateLabel(state: ProspectWorkspace['facts'][number]['verificationState']) {
  if (state === 'captured' || state === 'not_collected') return 'Captured from website';
  if (state === 'inferred') return 'Uncertain';
  if (state === 'verified') return 'Confirmed';
  return 'Rejected';
}

function evidenceStateTone(state: ProspectWorkspace['facts'][number]['verificationState']) {
  if (state === 'verified') return 'success' as const;
  if (state === 'inferred' || state === 'rejected') return 'warning' as const;
  return 'neutral' as const;
}

function ResearchCapturePanel({
  workspace,
  onRequestCapture,
  onContinueCapture,
  onCancelCapture,
  onRequestAssetRefresh,
}: {
  workspace: ProspectWorkspace;
  onRequestCapture: () => Promise<void>;
  onContinueCapture: () => Promise<void>;
  onCancelCapture: () => Promise<void>;
  onRequestAssetRefresh: () => Promise<void>;
}) {
  const [state, setState] = useState<'idle' | 'requesting' | 'error'>('idle');
  const [continuing, setContinuing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [message, setMessage] = useState('');
  const [refreshingAssets, setRefreshingAssets] = useState(false);
  const capture = workspace.latestCapture;
  const isActive = captureIsActive(capture);

  async function requestCapture() {
    setState('requesting');
    setMessage('');
    try {
      await onRequestCapture();
      setState('idle');
    } catch {
      setState('error');
      setMessage('The website capture could not be queued. Check the connection and try again.');
    }
  }

  async function cancelCapture() {
    setCancelling(true);
    setMessage('');
    try {
      await onCancelCapture();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'The website capture could not be cancelled.',
      );
    } finally {
      setCancelling(false);
    }
  }

  async function continueCapture() {
    setContinuing(true);
    setMessage('');
    try {
      await onContinueCapture();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'The website capture could not be continued.',
      );
    } finally {
      setContinuing(false);
    }
  }

  async function refreshImages() {
    setRefreshingAssets(true);
    setMessage('');
    try {
      await onRequestAssetRefresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'The image-only refresh could not be queued.',
      );
    } finally {
      setRefreshingAssets(false);
    }
  }

  return (
    <section aria-labelledby="website-capture-title" className="research-capture">
      <div className="research-capture__header">
        <div>
          <Eyebrow>Private capture</Eyebrow>
          <h2 id="website-capture-title">Website capture</h2>
          <p>
            Discover and save crawlable public-page structure, content, forms, metadata, and
            original assets as private evidence. Visual screenshots are deferred to pitch and report
            work. It does not publish, contact the business, or treat extracted text as fact.
          </p>
        </div>
        <div className="research-capture__actions">
          <StatusBadge tone={captureTone(capture?.status)}>
            {captureLabel(capture?.status)}
          </StatusBadge>
          <Button
            disabled={state === 'requesting' || isActive || !workspace.website}
            onClick={() => void requestCapture()}
            type="button"
          >
            <Play aria-hidden="true" size={16} />
            {state === 'requesting'
              ? 'Queueing capture'
              : isActive
                ? capture?.status === 'running'
                  ? 'Capture running'
                  : 'Capture queued'
                : capture
                  ? 'Capture website again'
                  : 'Start website capture'}
          </Button>
          {capture?.status === 'failed' && !capture.cancelRequestedAt ? (
            <Button
              disabled={continuing}
              onClick={() => void continueCapture()}
              type="button"
              variant="secondary"
            >
              <RotateCcw aria-hidden="true" size={16} />
              {continuing ? 'Continuing scrape' : 'Continue scraping'}
            </Button>
          ) : null}
          {isActive ? (
            <Button
              disabled={cancelling || Boolean(capture?.cancelRequestedAt)}
              onClick={() => void cancelCapture()}
              type="button"
              variant="secondary"
            >
              <Ban aria-hidden="true" size={16} />
              {cancelling || capture?.cancelRequestedAt ? 'Stopping capture' : 'Cancel capture'}
            </Button>
          ) : null}
        </div>
      </div>
      {workspace.latestCapture?.status === 'ready' ? (
        <details className="asset-refresh-control">
          <summary>Advanced image refresh</summary>
          <p className="muted-copy">
            Rescan the already captured public pages for images only. Existing source URLs are
            skipped; pages, facts, and asset analysis are unchanged.
          </p>
          <Button
            disabled={
              refreshingAssets ||
              workspace.assetRefresh?.status === 'queued' ||
              workspace.assetRefresh?.status === 'running'
            }
            onClick={() => void refreshImages()}
            type="button"
            variant="secondary"
          >
            <RotateCcw aria-hidden="true" size={16} />
            {refreshingAssets ||
            workspace.assetRefresh?.status === 'queued' ||
            workspace.assetRefresh?.status === 'running'
              ? 'Image refresh running'
              : 'Refresh images only'}
          </Button>
          {workspace.assetRefresh ? (
            <p className="muted-copy" role="status">
              {workspace.assetRefresh.progressDetail || workspace.assetRefresh.status}
            </p>
          ) : null}
        </details>
      ) : null}

      {capture ? (
        <>
          <dl className="research-capture__details">
            <div>
              <dt>Scope</dt>
              <dd>
                {capture.scope === 'all_pages'
                  ? 'Discoverable public pages'
                  : capture.scope === 'key_pages'
                    ? 'Key public pages'
                    : 'Homepage only'}
              </dd>
            </div>
            <div>
              <dt>Requested</dt>
              <dd>
                <time dateTime={capture.requestedAt}>{formatDateTime(capture.requestedAt)}</time>
              </dd>
            </div>
            <div>
              <dt>Pages captured</dt>
              <dd>{capture.capturedPageCount}</dd>
            </div>
            <div>
              <dt>Artifacts saved</dt>
              <dd>{workspace.artifacts.length}</dd>
            </div>
            <div>
              <dt>Visual evidence</dt>
              <dd>Deferred</dd>
            </div>
            {capture.currentUrl ? (
              <div className="research-capture__current-url">
                <dt>{capture.status === 'failed' ? 'Stopped at' : 'Working on'}</dt>
                <dd title={capture.currentUrl}>{capture.currentUrl}</dd>
              </div>
            ) : null}
          </dl>
          {isActive ? (
            <div className={`capture-progress capture-progress--${capture.status}`}>
              <div
                aria-label="Website capture progress"
                aria-valuetext={captureProgressLabel(capture)}
                className="capture-progress__track"
                role="progressbar"
              >
                <span className="capture-progress__bar" />
              </div>
              <span>{captureProgressLabel(capture)}</span>
            </div>
          ) : null}
          <p className="research-capture__status" role="status">
            {capture.status === 'queued'
              ? 'The website capture is queued for the protected worker. No website data has been stored yet.'
              : capture.status === 'running'
                ? 'The protected worker is discovering and capturing public pages. Results will appear here when it completes.'
                : capture.status === 'cancelled'
                  ? 'Cancellation has been requested. The worker will stop after its current safe capture step; any saved evidence below is partial and remains private.'
                  : capture.status === 'ready'
                    ? 'The capture is complete. Captured source material is ready for research; only uncertain information and external decisions need approval.'
                    : capture.errorSummary ||
                      'The last capture failed. Review the website URL, then request another website capture.'}
          </p>
          {capture.status === 'failed' ? (
            <dl className="research-capture__failure" aria-label="Capture failure details">
              <div>
                <dt>Stopped during</dt>
                <dd>{captureFailureStage(capture.failurePhase)}</dd>
              </div>
              <div>
                <dt>Recovery</dt>
                <dd>
                  Continue scraping retries this step first, then continues with saved pending
                  pages.
                </dd>
              </div>
              {capture.failureDetail ? (
                <div>
                  <dt>Worker detail</dt>
                  <dd>{capture.failureDetail}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          {capture.status === 'ready' ? (
            <AutomatedChecks artifacts={workspace.artifacts} pages={workspace.capturedPages} />
          ) : null}
        </>
      ) : (
        <p className="research-capture__status" role="status">
          No capture has been requested. Start with a public key-page capture before creating an
          audit or redesign brief.
        </p>
      )}
      {message ? (
        <p className="form-message form-message--error" role="alert">
          {message}
        </p>
      ) : null}
    </section>
  );
}

function EvidenceFactList({
  facts,
  pages = [],
}: {
  facts: ProspectWorkspace['facts'];
  pages?: CapturedPage[];
}) {
  const contacts = facts.filter(
    (fact) => fact.label === 'Contact email' || fact.label === 'Contact phone',
  );
  const contentFacts = facts.filter((fact) =>
    ['Page title', 'Primary heading', 'Meta description'].includes(fact.label),
  );
  const technicalFacts = facts.filter(
    (fact) => !contacts.includes(fact) && !contentFacts.includes(fact),
  );
  const uniqueContacts = [
    ...new Map(
      contacts.map((fact) => [`${fact.label}:${fact.value.toLowerCase()}`, fact]),
    ).values(),
  ];
  const factsByPage = new Map<string, ProspectWorkspace['facts']>();
  contentFacts.forEach((fact) => {
    const source = fact.sourceUrl ?? 'captured-source';
    factsByPage.set(source, [...(factsByPage.get(source) ?? []), fact]);
  });
  const pageGroups = [...factsByPage.entries()];
  const visiblePageGroups = pageGroups.slice(0, 4);
  const remainingPageGroups = pageGroups.slice(4);

  return (
    <div className="evidence-facts">
      {uniqueContacts.length ? (
        <section aria-labelledby="business-details-title" className="evidence-facts__contacts">
          <h4 id="business-details-title">Business details</h4>
          <div>
            {uniqueContacts.map((fact) => {
              const isEmail = fact.label === 'Contact email';
              return (
                <a href={`${isEmail ? 'mailto' : 'tel'}:${fact.value}`} key={fact.id}>
                  <small>{isEmail ? 'Email' : 'Phone'}</small>
                  <strong>{fact.value}</strong>
                </a>
              );
            })}
          </div>
        </section>
      ) : null}
      {pageGroups.length ? (
        <section aria-labelledby="page-content-title" className="evidence-facts__pages">
          <div>
            <Eyebrow>Page content</Eyebrow>
            <h4 id="page-content-title">Captured messaging by page</h4>
          </div>
          <div className="evidence-facts__page-list">
            {visiblePageGroups.map(([source, pageFacts], index) => (
              <EvidencePageFacts
                facts={pageFacts}
                key={source}
                open={index === 0}
                pages={pages}
                source={source}
              />
            ))}
          </div>
          {remainingPageGroups.length ? (
            <ListOverflow label="page records" remainingCount={remainingPageGroups.length}>
              <div className="evidence-facts__page-list">
                {remainingPageGroups.map(([source, pageFacts]) => (
                  <EvidencePageFacts facts={pageFacts} key={source} pages={pages} source={source} />
                ))}
              </div>
            </ListOverflow>
          ) : null}
        </section>
      ) : null}
      {technicalFacts.length ? (
        <details className="evidence-facts__technical">
          <summary>
            <span>
              <strong>Technical evidence</strong>
              <small>{technicalFacts.length} captured records</small>
            </span>
          </summary>
          <div>
            {technicalFacts.map((fact) => (
              <EvidenceFactRow fact={fact} key={fact.id} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function EvidencePageFacts({
  source,
  facts,
  pages,
  open = false,
}: {
  source: string;
  facts: ProspectWorkspace['facts'];
  pages: CapturedPage[];
  open?: boolean;
}) {
  const page = pages.find((candidate) => candidate.url === source);
  const title = page?.title || facts.find((fact) => fact.label === 'Page title')?.value || source;
  const path = source === 'captured-source' ? 'Captured source' : new URL(source).pathname || '/';
  return (
    <details className="evidence-facts__page" open={open}>
      <summary>
        <span>
          <strong>{title}</strong>
          <small>{path}</small>
        </span>
        <b>{facts.length} facts</b>
      </summary>
      <div>
        {facts.map((fact) => (
          <EvidenceFactRow fact={fact} key={fact.id} />
        ))}
      </div>
    </details>
  );
}

function EvidenceFactRow({ fact }: { fact: ProspectWorkspace['facts'][number] }) {
  return (
    <div className="fact-row">
      <span>
        <strong>{fact.label}</strong>
        <b>{fact.value}</b>
        <small>{fact.evidence}</small>
      </span>
      <StatusBadge tone={evidenceStateTone(fact.verificationState)}>
        {evidenceStateLabel(fact.verificationState)}
      </StatusBadge>
    </div>
  );
}

function ListOverflow({
  remainingCount,
  label,
  children,
}: {
  remainingCount: number;
  label: string;
  children: ReactNode;
}) {
  return (
    <details className="list-overflow">
      <summary>
        View {remainingCount} more {label}
      </summary>
      <div className="list-overflow__content">{children}</div>
    </details>
  );
}

function ExpandableImage({
  src,
  alt,
  label,
  className,
  style,
  children,
}: {
  src: string;
  alt: string;
  label: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        aria-label={`Expand ${label}`}
        className={className}
        onClick={() => setOpen(true)}
        style={style}
        type="button"
      >
        {children}
      </button>
      <Dialog.Root onOpenChange={setOpen} open={open}>
        <Dialog.Portal>
          <Dialog.Overlay className="image-lightbox-overlay" />
          <Dialog.Content aria-describedby={undefined} className="image-lightbox">
            <Dialog.Title className="sr-only">{label}</Dialog.Title>
            <img alt={alt} src={src} />
            <Dialog.Close asChild>
              <Button aria-label={`Close ${label}`} size="compact" variant="quiet">
                <X aria-hidden="true" size={18} />
              </Button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function EvidenceLoadingState() {
  return (
    <section aria-busy="true" aria-label="Refreshing website evidence" className="evidence-loading">
      <p className="sr-only" role="status">
        Capturing the next page. New evidence appears here as soon as it is safely stored.
      </p>
      <div aria-hidden="true" className="fact-box evidence-loading__facts">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="fact-row evidence-loading__fact" key={index}>
            <span>
              <i className="evidence-skeleton evidence-skeleton--label" />
              <i className="evidence-skeleton evidence-skeleton--value" />
              <i className="evidence-skeleton evidence-skeleton--detail" />
            </span>
            <i className="evidence-skeleton evidence-skeleton--badge" />
          </div>
        ))}
      </div>
      <div
        aria-hidden="true"
        className="capture-evidence__screenshots evidence-loading__screenshots"
      >
        {Array.from({ length: 3 }, (_, index) => (
          <div className="evidence-loading__screenshot" key={index}>
            <i className="evidence-skeleton" />
            <i className="evidence-skeleton evidence-skeleton--caption" />
          </div>
        ))}
      </div>
    </section>
  );
}

function PageInventory({ pages, assets }: { pages: CapturedPage[]; assets: ResearchArtifact[] }) {
  const [query, setQuery] = useState('');
  const [previewAsset, setPreviewAsset] = useState<ResearchArtifact>();
  const { urls, loadError } = usePrivateArtifactUrls(
    assets,
    'Private page images could not be loaded. Refresh and check storage access.',
  );
  if (!pages.length) return null;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingPages = normalizedQuery
    ? pages.filter((page) =>
        [page.title, page.url, page.pageType]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      )
    : pages;
  const visiblePages = normalizedQuery ? matchingPages : matchingPages.slice(0, 4);
  const remainingPages = normalizedQuery ? [] : matchingPages.slice(4);
  return (
    <section aria-labelledby="page-inventory-title" className="page-inventory">
      <div>
        <Eyebrow>Page inventory</Eyebrow>
        <h3 id="page-inventory-title">Captured public pages</h3>
      </div>
      <details className="page-inventory__disclosure">
        <summary>
          Browse {pages.length} captured page{pages.length === 1 ? '' : 's'}
        </summary>
        <label className="input-row page-inventory__search">
          <Search aria-hidden="true" size={16} />
          <span className="sr-only">Search captured public pages</span>
          <input
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search pages by title, URL, or type"
            type="search"
            value={query}
          />
        </label>
        {normalizedQuery ? (
          <p aria-live="polite" className="muted-copy">
            {matchingPages.length
              ? `${matchingPages.length} ${matchingPages.length === 1 ? 'page' : 'pages'} found.`
              : 'No captured pages match this search.'}
          </p>
        ) : null}
        {visiblePages.length ? (
          <div className="page-inventory__list">
            {visiblePages.map((page) => (
              <PageInventoryItem
                assets={assets}
                key={page.id}
                onPreview={setPreviewAsset}
                page={page}
                urls={urls}
              />
            ))}
          </div>
        ) : null}
        {remainingPages.length ? (
          <ListOverflow label="captured pages" remainingCount={remainingPages.length}>
            <div className="page-inventory__list page-inventory__list--overflow">
              {remainingPages.map((page) => (
                <PageInventoryItem
                  assets={assets}
                  key={page.id}
                  onPreview={setPreviewAsset}
                  page={page}
                  urls={urls}
                />
              ))}
            </div>
          </ListOverflow>
        ) : null}
      </details>
      {loadError ? <p className="form-message form-message--error">{loadError}</p> : null}
      <Dialog.Root
        onOpenChange={(open) => !open && setPreviewAsset(undefined)}
        open={Boolean(previewAsset)}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="image-preview-overlay" />
          <Dialog.Content className="image-preview-dialog">
            <div className="image-preview-dialog__header">
              <div>
                <Dialog.Title>{previewAsset?.label || 'Captured image'}</Dialog.Title>
                <Dialog.Description>
                  {previewAsset ? recordValue(previewAsset.metadata, 'pageUrl') : ''}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button aria-label="Close image preview" size="compact" variant="quiet">
                  <X aria-hidden="true" size={18} />
                </Button>
              </Dialog.Close>
            </div>
            {previewAsset && urls[previewAsset.id] ? (
              <img alt="" src={urls[previewAsset.id]} />
            ) : (
              <div className="image-preview-dialog__loading">Loading image...</div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}

function PageInventoryItem({
  page,
  assets,
  urls,
  onPreview,
}: {
  page: CapturedPage;
  assets: ResearchArtifact[];
  urls: Record<string, string>;
  onPreview: (asset: ResearchArtifact) => void;
}) {
  const [imagesOpen, setImagesOpen] = useState(false);
  const pageKeys = new Set(
    [page.url, page.canonicalUrl].filter((url): url is string => Boolean(url)).map(pageUrlKey),
  );
  const pageAssets = assets.filter((asset) =>
    [recordValue(asset.metadata, 'pageUrl'), ...recordList(asset.metadata, 'pageUrls')]
      .filter((url): url is string => typeof url === 'string')
      .some((url) => pageKeys.has(pageUrlKey(url))),
  );
  const imageCount = metadataNumber(page.metadata, 'imageCount');
  const hasImageInventory = Boolean(pageAssets.length || imageCount);
  return (
    <article className="page-inventory__item">
      <div className="page-inventory__page-header">
        <button
          aria-controls={`page-images-${page.id}`}
          aria-expanded={imagesOpen}
          className="page-inventory__page-toggle"
          disabled={!hasImageInventory}
          onClick={() => setImagesOpen((open) => !open)}
          type="button"
        >
          <span>
            <strong>{page.title || page.url}</strong>
            <small>{new URL(page.url).pathname || '/'}</small>
          </span>
          <span className="page-inventory__meta">
            <b>{page.pageType ?? 'page'}</b>
            <small>{page.statusCode ?? 'No'} response</small>
            <small>{pageSummary(page)}</small>
            {hasImageInventory ? (
              <small>
                {imageCount || pageAssets.length} {imageCount === 1 ? 'image' : 'images'}
              </small>
            ) : null}
          </span>
        </button>
        <a
          aria-label={`Open captured page: ${page.title || page.url}`}
          className="button button--quiet button--compact page-inventory__external"
          href={page.url}
          rel="noreferrer"
          target="_blank"
        >
          <ArrowUpRight aria-hidden="true" size={17} />
        </a>
      </div>
      {hasImageInventory ? (
        <div className="page-inventory__images" hidden={!imagesOpen} id={`page-images-${page.id}`}>
          <div>
            {pageAssets.length ? (
              pageAssets.map((asset) => (
                <button
                  aria-label={`Preview ${asset.label || 'captured image'}`}
                  key={asset.id}
                  onClick={() => onPreview(asset)}
                  type="button"
                >
                  {urls[asset.id] ? (
                    <img alt="" src={urls[asset.id]} />
                  ) : (
                    <span>Loading image</span>
                  )}
                </button>
              ))
            ) : (
              <p className="muted-copy">
                No private image files were saved for this page in this capture. Run a new capture
                to collect them.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function pageUrlKey(value: string) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return value.replace(/\/+$/, '');
  }
}

function pageSummary(page: CapturedPage) {
  const formCount = metadataNumber(page.metadata, 'formCount');
  const missingAlt = metadataNumber(page.metadata, 'imagesWithoutAlt');
  const signals = [];
  if (formCount) signals.push(`${formCount} ${formCount === 1 ? 'form' : 'forms'}`);
  if (missingAlt) signals.push(`${missingAlt} images without alt text`);
  return signals.join(' · ') || 'Page captured';
}

function metadataNumber(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function screenshotViewport(artifact: ResearchArtifact) {
  const viewport = artifact.metadata.viewport;
  if (
    typeof viewport === 'object' &&
    viewport !== null &&
    typeof (viewport as Record<string, unknown>).width === 'number' &&
    typeof (viewport as Record<string, unknown>).height === 'number'
  ) {
    return viewport as { width: number; height: number };
  }
  return undefined;
}

function artifactSourceUrl(artifact: ResearchArtifact) {
  return typeof artifact.metadata.sourceUrl === 'string' ? artifact.metadata.sourceUrl : undefined;
}

function artifactPageTitle(artifact: ResearchArtifact) {
  return typeof artifact.metadata.title === 'string' && artifact.metadata.title.trim()
    ? artifact.metadata.title
    : (artifactSourceUrl(artifact) ?? artifact.label ?? 'Captured page');
}

function previewWidth(viewport?: { width: number; height: number }) {
  if (!viewport || viewport.width >= 1200) return '100%';
  if (viewport.width >= 600) return '68%';
  return '42%';
}

function groupScreenshotsByPage(artifacts: ResearchArtifact[]) {
  const pages = new Map<string, ResearchArtifact[]>();
  artifacts.forEach((artifact) => {
    const sourceUrl = artifactSourceUrl(artifact) ?? artifact.id;
    pages.set(sourceUrl, [...(pages.get(sourceUrl) ?? []), artifact]);
  });
  return [...pages.entries()];
}

function AutomatedChecks({
  artifacts,
  pages,
}: {
  artifacts: ResearchArtifact[];
  pages: CapturedPage[];
}) {
  const pageCount = pages.length;
  const successfulPages = pages.filter(
    (page) => page.statusCode !== undefined && page.statusCode >= 200 && page.statusCode < 400,
  ).length;
  const forms = pages.reduce(
    (total, page) => total + metadataNumber(page.metadata, 'formCount'),
    0,
  );
  const imagesWithoutAlt = pages.reduce(
    (total, page) => total + metadataNumber(page.metadata, 'imagesWithoutAlt'),
    0,
  );
  const accessibilityViolations = artifacts
    .filter((artifact) => artifact.kind === 'accessibility')
    .reduce((total, artifact) => total + metadataNumber(artifact.metadata, 'violationCount'), 0);
  const titledPages = pages.filter((page) => Boolean(page.title)).length;
  const canonicalPages = pages.filter((page) => Boolean(page.canonicalUrl)).length;
  const checks: Array<{ label: string; detail: string; tone: 'success' | 'warning' | 'neutral' }> =
    [
      {
        label: 'Page responses',
        detail: `${successfulPages} of ${pageCount} captured pages returned a successful response.`,
        tone: successfulPages === pageCount ? 'success' : 'warning',
      },
      {
        label: 'Document titles',
        detail: `${titledPages} of ${pageCount} captured pages have a document title.`,
        tone: titledPages === pageCount ? 'success' : 'warning',
      },
      {
        label: 'Canonical URLs',
        detail: `${canonicalPages} of ${pageCount} captured pages provide a canonical URL.`,
        tone: canonicalPages === pageCount ? 'success' : 'warning',
      },
      {
        label: 'Forms discovered',
        detail: `${forms} ${forms === 1 ? 'form was' : 'forms were'} found across the captured pages.`,
        tone: 'neutral',
      },
      {
        label: 'Image alt text',
        detail:
          imagesWithoutAlt === 0
            ? 'No images without alt text were found in the captured page markup.'
            : `${imagesWithoutAlt} images do not have alt text in the captured page markup.`,
        tone: imagesWithoutAlt === 0 ? 'success' : 'warning',
      },
      {
        label: 'Automated accessibility rules',
        detail:
          accessibilityViolations === 0
            ? 'No configured automated rule violations were found. This is not a complete accessibility audit.'
            : `${accessibilityViolations} automated rule violations were found. Review them in the source files before drawing conclusions.`,
        tone: accessibilityViolations === 0 ? 'success' : 'warning',
      },
    ];

  return (
    <section
      aria-labelledby="automated-checks-title"
      className="research-section research-section--checks"
    >
      <div>
        <Eyebrow>Automated observations</Eyebrow>
        <h3 id="automated-checks-title">Checks from this capture</h3>
        <p className="muted-copy">
          These are measured signals from the saved pages, not final audit findings or compliance
          conclusions.
        </p>
      </div>
      <ul className="automated-checks">
        {checks.map((check) => (
          <li key={check.label}>
            <span>
              <strong>{check.label}</strong>
              <small>{check.detail}</small>
            </span>
            <StatusBadge tone={check.tone}>
              {check.tone === 'success' ? 'Observed' : 'Check'}
            </StatusBadge>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CaptureArtifacts({
  artifacts,
  eyebrow = 'Responsive views',
  title = 'Screenshots by captured page',
  titleId = 'capture-evidence-title',
}: {
  artifacts: ResearchArtifact[];
  eyebrow?: string;
  title?: string;
  titleId?: string;
}) {
  const { urls, loadError } = usePrivateArtifactUrls(
    artifacts,
    'Private previews could not be loaded. Refresh and check storage access.',
  );
  const screenshots = artifacts.filter((artifact) => artifact.kind === 'screenshot');
  const documents = artifacts.filter((artifact) => artifact.kind !== 'screenshot');
  const screenshotPages = groupScreenshotsByPage(screenshots);

  if (!artifacts.length) return null;

  return (
    <section aria-labelledby={titleId} className="capture-evidence">
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h3 id={titleId}>{title}</h3>
      </div>
      {screenshots.length ? (
        <div className="capture-evidence__pages">
          {screenshotPages.map(([sourceUrl, pageScreenshots], index) => (
            <details className="capture-evidence__page" key={sourceUrl} open={index === 0}>
              <summary>
                <span>
                  <strong>{artifactPageTitle(pageScreenshots[0])}</strong>
                  <small>{sourceUrl ? new URL(sourceUrl).pathname || '/' : 'Captured page'}</small>
                </span>
                <b>{pageScreenshots.length} views</b>
              </summary>
              <div className="capture-evidence__screenshots">
                {pageScreenshots.map((artifact) => {
                  const viewport = screenshotViewport(artifact);
                  return (
                    <ExpandableImage
                      alt={`${artifact.label ?? 'Page'} captured preview`}
                      className="capture-evidence__screenshot"
                      key={artifact.id}
                      label={artifact.label ?? 'screenshot'}
                      src={urls[artifact.id] ?? ''}
                      style={{ '--capture-preview-width': previewWidth(viewport) } as CSSProperties}
                    >
                      <span className="capture-evidence__device">
                        {urls[artifact.id] ? (
                          <img
                            alt={`${artifact.label ?? 'Page'} captured preview`}
                            src={urls[artifact.id]}
                          />
                        ) : (
                          <span>Loading preview...</span>
                        )}
                      </span>
                      <strong>{artifact.label ?? 'Screenshot'}</strong>
                      {viewport ? (
                        <small>
                          {viewport.width} x {viewport.height}
                        </small>
                      ) : null}
                    </ExpandableImage>
                  );
                })}
              </div>
            </details>
          ))}
        </div>
      ) : null}
      {documents.length ? (
        <details className="technical-evidence">
          <summary>
            <span>Technical source files</span>
            <small>{documents.length} saved files</small>
          </summary>
          <p className="muted-copy">
            Raw HTML, extracted text, timing data, and automated-check output for detailed analysis.
          </p>
          <div className="capture-evidence__documents">
            {documents.map((artifact) => (
              <a href={urls[artifact.id]} key={artifact.id} rel="noreferrer" target="_blank">
                {artifact.label ?? 'Capture file'}
              </a>
            ))}
          </div>
        </details>
      ) : null}
      {loadError ? <p className="form-message form-message--error">{loadError}</p> : null}
    </section>
  );
}

function recordValue(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function recordList(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

type PrivateArtifactReference = Pick<ResearchArtifact, 'id' | 'storageBucket' | 'storagePath'>;

function usePrivateArtifactUrls(artifacts: PrivateArtifactReference[], errorMessage: string) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState('');
  const client = getSupabaseClient();
  const artifactKey = artifacts
    .map((artifact) => `${artifact.id}:${artifact.storageBucket}:${artifact.storagePath}`)
    .join('|');
  const stableArtifacts = useMemo(() => artifacts, [artifactKey]);

  useEffect(() => {
    if (!client || stableArtifacts.length === 0) {
      setUrls({});
      return;
    }
    let active = true;
    setLoadError('');
    void Promise.allSettled(
      stableArtifacts.map(async (artifact) => {
        const { data, error } = await client.storage
          .from(artifact.storageBucket)
          .createSignedUrl(artifact.storagePath, 60 * 30);
        if (error || !data?.signedUrl) throw new Error('Could not load a private artifact.');
        return [artifact.id, data.signedUrl] as const;
      }),
    ).then((results) => {
      if (!active) return;
      const entries = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      setUrls(Object.fromEntries(entries));
      if (entries.length !== stableArtifacts.length) setLoadError(errorMessage);
    });
    return () => {
      active = false;
    };
  }, [client, errorMessage, stableArtifacts]);

  return { urls, loadError };
}

function VisualAssetCatalog({ assets }: { assets: ResearchArtifact[] }) {
  const { urls, loadError } = usePrivateArtifactUrls(
    assets,
    'Private visual assets could not be loaded. Refresh and check storage access.',
  );

  if (!assets.length) return null;
  return (
    <details className="asset-catalog">
      <summary>
        <span>
          <span className="asset-catalog__eyebrow">Captured source material</span>
          <strong>Browse all {assets.length} visual assets</strong>
        </span>
      </summary>
      <div className="asset-catalog__content">
        <p className="muted-copy">
          Private source material with its originating page. It can inform a concept, but requires
          human approval before any external use.
        </p>
        <div className="packet-assets__grid">
          {assets.map((asset) => {
            const type = asset.metadata.vectorSuggestion
              ? 'derived vector suggestion'
              : recordValue(asset.metadata, 'assetType') || 'image';
            const pageUrl = recordValue(asset.metadata, 'pageUrl');
            const width = recordValue(asset.metadata, 'width');
            const height = recordValue(asset.metadata, 'height');
            return (
              <ExpandableImage
                alt={`Captured ${type} asset`}
                className="packet-assets__item"
                key={asset.id}
                label={asset.label ?? `captured ${type} asset`}
                src={urls[asset.id] ?? ''}
              >
                {urls[asset.id] ? (
                  <img alt="" src={urls[asset.id]} />
                ) : (
                  <span>Loading asset...</span>
                )}
                <strong>{type}</strong>
                <small>
                  {pageUrl ? new URL(pageUrl).pathname || '/' : 'Captured website asset'}
                </small>
                {width && height ? <small>{`${width} x ${height}`}</small> : null}
              </ExpandableImage>
            );
          })}
        </div>
      </div>
      {loadError ? <p className="form-message form-message--error">{loadError}</p> : null}
    </details>
  );
}

function ResearchPacketPanel({ workspace }: { workspace: ProspectWorkspace }) {
  const packet = workspace.researchPacket;
  if (!packet) {
    return (
      <Card className="workspace-panel">
        <Eyebrow>Research packet</Eyebrow>
        <h2>Awaiting an asset-aware capture</h2>
        <EmptyState
          detail="Run another website capture to create a private packet containing page structure, factual context, and the captured logo and website-image catalogue."
          icon={Sparkles}
          title="No research packet yet"
        />
      </Card>
    );
  }
  const packetData = packet.data;
  const capture =
    typeof packetData.sourceCapture === 'object' && packetData.sourceCapture !== null
      ? (packetData.sourceCapture as Record<string, unknown>)
      : {};
  const business =
    typeof packetData.business === 'object' && packetData.business !== null
      ? (packetData.business as Record<string, unknown>)
      : {};
  const pages = recordList(packetData, 'pages').filter(
    (page): page is Record<string, unknown> => typeof page === 'object' && page !== null,
  );
  const notes =
    typeof packetData.sourceManifest === 'object' && packetData.sourceManifest !== null
      ? recordList(packetData.sourceManifest as Record<string, unknown>, 'notes')
      : [];
  const assets = useMemo(
    () => workspace.artifacts.filter((artifact) => artifact.kind === 'asset'),
    [workspace.artifacts],
  );
  const visiblePages = pages.slice(0, 4);
  const remainingPages = pages.slice(4);

  return (
    <Card className="workspace-panel">
      <div className="packet-header">
        <div>
          <Eyebrow>Research packet</Eyebrow>
          <h2>Strategy context, grounded in the captured website</h2>
          <p className="muted-copy">
            This is the bounded handoff for the future strategist and builder agents. Full page
            text, HTML, and assets remain private source material they can load on demand.
          </p>
        </div>
        <StatusBadge tone="success">Packet v{packet.schemaVersion}</StatusBadge>
      </div>
      <dl className="packet-metrics">
        <div>
          <dt>Business</dt>
          <dd>{recordValue(business, 'name') || workspace.business.name}</dd>
        </div>
        <div>
          <dt>Captured pages</dt>
          <dd>{recordValue(capture, 'pageCount') || workspace.capturedPages.length}</dd>
        </div>
        <div>
          <dt>Visual assets</dt>
          <dd>{assets.length}</dd>
        </div>
        <div>
          <dt>Generated</dt>
          <dd>{formatDateTime(packet.generatedAt)}</dd>
        </div>
      </dl>
      <section aria-labelledby="packet-pages-title" className="packet-pages">
        <div>
          <Eyebrow>Page context</Eyebrow>
          <h3 id="packet-pages-title">Structure supplied to agents</h3>
        </div>
        <details className="page-inventory__disclosure">
          <summary>
            View {pages.length} captured page context{pages.length === 1 ? '' : 's'}
          </summary>
          <div className="packet-pages__list">
            {visiblePages.map((page) => (
              <PacketPageItem key={recordValue(page, 'url')} page={page} />
            ))}
          </div>
          {remainingPages.length ? (
            <ListOverflow label="page contexts" remainingCount={remainingPages.length}>
              <div className="packet-pages__list packet-pages__list--overflow">
                {remainingPages.map((page) => (
                  <PacketPageItem key={recordValue(page, 'url')} page={page} />
                ))}
              </div>
            </ListOverflow>
          ) : null}
        </details>
      </section>
      <VisualAssetCatalog assets={assets} />
      <section aria-labelledby="packet-boundaries-title" className="packet-boundaries">
        <Eyebrow>Agent boundaries</Eyebrow>
        <h3 id="packet-boundaries-title">What stays under human control</h3>
        <ul>
          {notes.map((note) => (
            <li key={String(note)}>{String(note)}</li>
          ))}
        </ul>
      </section>
    </Card>
  );
}

function PacketPageItem({ page }: { page: Record<string, unknown> }) {
  return (
    <article>
      <strong>{recordValue(page, 'title') || recordValue(page, 'url')}</strong>
      <small>{recordValue(page, 'pageType') || 'page'}</small>
      {recordValue(page, 'primaryHeading') ? <p>{recordValue(page, 'primaryHeading')}</p> : null}
    </article>
  );
}

function briefStatusLabel(status: RedesignBrief['status']) {
  return status === 'approved' ? 'Brief approved' : 'Draft brief';
}

function briefStatusTone(status: RedesignBrief['status']) {
  return status === 'approved' ? ('success' as const) : ('warning' as const);
}

function normaliseBriefSourceSelections(
  selections?: Partial<BriefSourceSelections>,
): BriefSourceSelections {
  return {
    pageUrls: Array.isArray(selections?.pageUrls) ? selections.pageUrls : [],
    assetIds: Array.isArray(selections?.assetIds) ? selections.assetIds : [],
    autoSelectedAssetIds: Array.isArray(selections?.autoSelectedAssetIds)
      ? selections.autoSelectedAssetIds
      : [],
    uncertainties: Array.isArray(selections?.uncertainties) ? selections.uncertainties : [],
  };
}

function normaliseBriefDraft(draft?: Partial<RedesignBriefDraft>): RedesignBriefDraft {
  const brandKit = draft?.brandKit;
  return {
    strategy: typeof draft?.strategy === 'string' ? draft.strategy : '',
    proposedSitemap: Array.isArray(draft?.proposedSitemap) ? draft.proposedSitemap : [],
    pagePlans: Array.isArray(draft?.pagePlans) ? draft.pagePlans : [],
    assetGuidance: Array.isArray(draft?.assetGuidance) ? draft.assetGuidance : [],
    assumptions: Array.isArray(draft?.assumptions) ? draft.assumptions : [],
    openQuestions: Array.isArray(draft?.openQuestions) ? draft.openQuestions : [],
    capabilityInventory: Array.isArray(draft?.capabilityInventory) ? draft.capabilityInventory : [],
    brandKit:
      brandKit &&
      typeof brandKit.id === 'string' &&
      typeof brandKit.version === 'number' &&
      typeof brandKit.primaryLogoAssetId === 'string'
        ? {
            id: brandKit.id,
            version: brandKit.version,
            primaryLogoAssetId: brandKit.primaryLogoAssetId,
            approvedAssetIds: Array.isArray(brandKit.approvedAssetIds)
              ? brandKit.approvedAssetIds.filter(
                  (assetId): assetId is string => typeof assetId === 'string',
                )
              : [],
            palette: {
              primary:
                typeof brandKit.palette?.primary === 'string'
                  ? brandKit.palette.primary
                  : undefined,
              accent:
                typeof brandKit.palette?.accent === 'string' ? brandKit.palette.accent : undefined,
            },
          }
        : undefined,
  };
}

function sourceUrlLabel(url: string, fallback: string) {
  try {
    return new URL(url).pathname || fallback;
  } catch {
    return fallback;
  }
}

function assetAnalysisLabel(status: NonNullable<ProspectWorkspace['assetAnalysis']>['status']) {
  if (status === 'queued') return 'Analysis queued';
  if (status === 'running') return 'Analysis running';
  if (status === 'ready') return 'Suggestions ready';
  if (status === 'failed') return 'Analysis failed';
  if (status === 'cancelled') return 'Analysis cancelled';
  return 'Not analysed';
}

function AssetAnnotationEditor({
  annotation,
  asset,
  assetUrl,
  onUpdate,
}: {
  annotation: AssetAnnotation;
  asset?: ResearchArtifact;
  assetUrl?: string;
  onUpdate: (
    annotation: AssetAnnotation,
    patch: Pick<
      AssetAnnotation,
      'suggestedRole' | 'businessAssociation' | 'reviewState' | 'humanNotes'
    >,
  ) => Promise<void>;
}) {
  const [draft, setDraft] = useState({
    suggestedRole: annotation.suggestedRole,
    businessAssociation: annotation.businessAssociation,
    reviewState: annotation.reviewState,
    humanNotes: annotation.humanNotes,
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    setDraft({
      suggestedRole: annotation.suggestedRole,
      businessAssociation: annotation.businessAssociation,
      reviewState: annotation.reviewState,
      humanNotes: annotation.humanNotes,
    });
  }, [annotation]);

  async function save() {
    setSaving(true);
    setMessage('');
    try {
      await onUpdate(annotation, draft);
      setMessage('Review saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The asset review could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="audit-finding asset-suggestion">
      <div className="audit-finding__header">
        <div>
          <Eyebrow>
            {asset?.metadata.assetType ? String(asset.metadata.assetType) : 'Asset'}
          </Eyebrow>
          <h4>{asset?.label || 'Captured visual asset'}</h4>
        </div>
        <StatusBadge
          tone={
            annotation.reviewState === 'approved'
              ? 'success'
              : annotation.reviewState === 'blocked'
                ? 'danger'
                : 'warning'
          }
        >
          {annotation.reviewState === 'approved'
            ? 'Approved'
            : annotation.reviewState === 'blocked'
              ? 'Excluded'
              : 'Needs review'}
        </StatusBadge>
      </div>
      {assetUrl ? (
        <ExpandableImage
          alt={asset?.label || 'Captured visual asset'}
          className="asset-suggestion__image"
          label={asset?.label || 'captured visual asset'}
          src={assetUrl}
        >
          <img alt="" src={assetUrl} />
        </ExpandableImage>
      ) : asset ? (
        <div aria-label="Loading captured visual asset" className="asset-suggestion__image">
          <span>Loading asset...</span>
        </div>
      ) : null}
      <details className="asset-suggestion__evidence">
        <summary>View evidence and reuse guidance</summary>
        <div>
          <p>{annotation.observedDescription}</p>
          {annotation.visibleText.length ? (
            <div className="audit-finding__recommendation">
              <strong>Visible text</strong>
              <p>{annotation.visibleText.join(' · ')}</p>
            </div>
          ) : null}
          <div className="audit-finding__recommendation">
            <strong>Safe reuse guidance</strong>
            <p>{annotation.safeReuseNote}</p>
          </div>
          {annotation.cautions.length ? <p>Review: {annotation.cautions.join(' ')}</p> : null}
        </div>
      </details>
      <details className="audit-finding__edit">
        <summary>Review asset context</summary>
        <div className="asset-review-form">
          <label>
            Suggested role
            <select
              onChange={(event) =>
                setDraft({
                  ...draft,
                  suggestedRole: event.target.value as typeof draft.suggestedRole,
                })
              }
              value={draft.suggestedRole}
            >
              {[
                'primary_logo',
                'secondary_mark',
                'worksite_photo',
                'team_photo',
                'project_photo',
                'partner_logo',
                'supplier_logo',
                'decorative',
                'unknown',
                'exclude',
              ].map((role) => (
                <option key={role} value={role}>
                  {role.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          <label>
            Business association
            <select
              onChange={(event) =>
                setDraft({
                  ...draft,
                  businessAssociation: event.target.value as typeof draft.businessAssociation,
                })
              }
              value={draft.businessAssociation}
            >
              <option value="target_business">Target business</option>
              <option value="third_party">Third party</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
          <label>
            Reuse decision
            <select
              onChange={(event) =>
                setDraft({ ...draft, reviewState: event.target.value as typeof draft.reviewState })
              }
              value={draft.reviewState}
            >
              <option value="needs_review">Needs review</option>
              <option value="approved">Approved for reuse</option>
              <option value="blocked">Exclude from reuse</option>
            </select>
          </label>
          <label>
            Human notes
            <textarea
              onChange={(event) => setDraft({ ...draft, humanNotes: event.target.value })}
              value={draft.humanNotes}
            />
          </label>
          <Button disabled={saving} onClick={() => void save()} type="button">
            <Save aria-hidden="true" size={16} />
            {saving ? 'Saving' : 'Save review'}
          </Button>
          {message ? (
            <p
              className={
                message === 'Review saved.'
                  ? 'form-message form-message--success'
                  : 'form-message form-message--error'
              }
              role="status"
            >
              {message}
            </p>
          ) : null}
        </div>
      </details>
    </article>
  );
}

function AssetReviewPanel({
  workspace,
  onRequestAnalysis,
  onCancelAnalysis,
  onSetAssetAnalysisSelected,
  onUpdateAnnotation,
}: {
  workspace: ProspectWorkspace;
  onRequestAnalysis: () => Promise<void>;
  onCancelAnalysis: () => Promise<void>;
  onSetAssetAnalysisSelected: (asset: ResearchArtifact, selected: boolean) => Promise<void>;
  onUpdateAnnotation: (
    annotation: AssetAnnotation,
    patch: Pick<
      AssetAnnotation,
      'suggestedRole' | 'businessAssociation' | 'reviewState' | 'humanNotes'
    >,
  ) => Promise<void>;
}) {
  const [requesting, setRequesting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [selectionOverrides, setSelectionOverrides] = useState<Record<string, boolean>>({});
  const [pendingSelectionUpdates, setPendingSelectionUpdates] = useState(0);
  const [message, setMessage] = useState('');
  const selectionQueuesRef = useRef<Record<string, Promise<void>>>({});
  const job = workspace.assetAnalysis;
  const assets = workspace.artifacts.filter((artifact) => artifact.kind === 'asset');
  const { urls, loadError } = usePrivateArtifactUrls(
    assets,
    'Private suggestion images could not be loaded. Refresh and check storage access.',
  );
  const active = job?.status === 'queued' || job?.status === 'running';
  const reviewAnnotations = active
    ? workspace.assetAnnotations.filter((annotation) => annotation.analysisJobId === job?.id)
    : workspace.assetAnnotations;
  const pendingAnnotations = reviewAnnotations.filter(
    (annotation) => annotation.reviewState === 'needs_review',
  );
  const reviewedAnnotations = reviewAnnotations.filter(
    (annotation) => annotation.reviewState !== 'needs_review',
  );
  const approvedCount = reviewAnnotations.filter(
    (annotation) => annotation.reviewState === 'approved',
  ).length;
  const analysedAssetIds = new Set(
    workspace.assetAnnotations.map((annotation) => annotation.assetId),
  );
  const analyzableAssets = assets.filter(
    (asset) => asset.metadata.vectorSuggestion !== true && !analysedAssetIds.has(asset.id),
  );
  const isAssetSelected = (asset: ResearchArtifact) =>
    selectionOverrides[asset.id] ?? asset.metadata.analysisSelected !== false;
  const selectedAssets = analyzableAssets.filter(isAssetSelected);
  const selectedAssetCount = selectedAssets.length;
  const visiblePendingAnnotations = pendingAnnotations.slice(0, 2);
  const hiddenPendingAnnotations = pendingAnnotations.slice(2);
  const reviewLoaderCount = active
    ? Math.max(0, Math.min(Math.max(job?.totalItems || 2, 1), 2) - visiblePendingAnnotations.length)
    : 0;

  useEffect(() => {
    setSelectionOverrides((current) => {
      let changed = false;
      const next = { ...current };
      for (const asset of analyzableAssets) {
        const persisted = asset.metadata.analysisSelected !== false;
        if (next[asset.id] === persisted) {
          delete next[asset.id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [analyzableAssets]);

  function setAssetAnalysisSelected(asset: ResearchArtifact, selected: boolean) {
    const persisted = asset.metadata.analysisSelected !== false;
    setSelectionOverrides((current) => ({ ...current, [asset.id]: selected }));
    setPendingSelectionUpdates((count) => count + 1);
    setMessage('');
    const previous = selectionQueuesRef.current[asset.id] ?? Promise.resolve();
    const update = previous
      .catch(() => undefined)
      .then(() => onSetAssetAnalysisSelected(asset, selected));
    selectionQueuesRef.current[asset.id] = update;
    void update
      .catch((error) => {
        setSelectionOverrides((current) =>
          current[asset.id] === selected ? { ...current, [asset.id]: persisted } : current,
        );
        setMessage(
          error instanceof Error ? error.message : 'The asset selection could not be saved.',
        );
      })
      .finally(() => {
        setPendingSelectionUpdates((count) => Math.max(0, count - 1));
        if (selectionQueuesRef.current[asset.id] === update) {
          delete selectionQueuesRef.current[asset.id];
        }
      });
  }

  async function requestAnalysis() {
    setRequesting(true);
    setMessage('');
    try {
      await onRequestAnalysis();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Asset analysis could not be queued.');
    } finally {
      setRequesting(false);
    }
  }

  async function cancelAnalysis() {
    setCancelling(true);
    setMessage('');
    try {
      await onCancelAnalysis();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Asset analysis could not be cancelled.');
    } finally {
      setCancelling(false);
    }
  }

  const assetSelectionGrid = (
    <fieldset className="brief-assets" disabled={active || requesting || cancelling}>
      <legend className="sr-only">Assets selected for private AI analysis</legend>
      {analyzableAssets.map((asset) => {
        const type = recordValue(asset.metadata, 'assetType') || 'image';
        const pageUrl = recordValue(asset.metadata, 'pageUrl');
        return (
          <label className="brief-source-option brief-source-option--asset" key={asset.id}>
            <input
              checked={isAssetSelected(asset)}
              onChange={(event) =>
                void setAssetAnalysisSelected(asset, event.currentTarget.checked)
              }
              type="checkbox"
            />
            {urls[asset.id] ? (
              <img alt="" className="brief-source-option__preview" src={urls[asset.id]} />
            ) : (
              <span className="brief-source-option__preview" aria-hidden="true">
                Loading image
              </span>
            )}
            <span className="brief-source-option__content">
              <strong>{type}</strong>
              <small>{pageUrl ? new URL(pageUrl).pathname || '/' : 'Captured asset'}</small>
            </span>
          </label>
        );
      })}
    </fieldset>
  );

  return (
    <Card className="workspace-panel">
      <div className="brief-panel__header">
        <div>
          <Eyebrow>Private asset enrichment</Eyebrow>
          <h2>Asset review</h2>
          <p className="muted-copy">
            AI suggestions describe visible imagery. The same job also collects reviewable logo and
            interface colour evidence. Neither output verifies business claims, ownership,
            partnerships, or qualifications.
          </p>
        </div>
        <div className="brief-panel__actions">
          <StatusBadge
            tone={
              job?.status === 'ready' ? 'success' : job?.status === 'failed' ? 'danger' : 'warning'
            }
          >
            {assetAnalysisLabel(job?.status ?? 'not_started')}
          </StatusBadge>
          <Button
            disabled={!selectedAssets.length || active || requesting || pendingSelectionUpdates > 0}
            onClick={() => void requestAnalysis()}
            type="button"
          >
            <Sparkles aria-hidden="true" size={16} />
            {requesting
              ? 'Queueing analysis'
              : active
                ? 'Analysis in progress'
                : 'Analyse selected assets'}
          </Button>
          {active ? (
            <Button
              disabled={cancelling || Boolean(job?.cancelRequestedAt)}
              onClick={() => void cancelAnalysis()}
              type="button"
              variant="secondary"
            >
              <Ban aria-hidden="true" size={16} />
              {cancelling || job?.cancelRequestedAt ? 'Stopping analysis' : 'Cancel analysis'}
            </Button>
          ) : null}
        </div>
      </div>
      {!assets.length ? (
        <EmptyState
          detail="Run an asset-aware website capture before analysing visual material."
          icon={Sparkles}
          title="No captured assets"
        />
      ) : null}
      {job?.status === 'failed' ? (
        <p className="form-message form-message--error">
          {job.errorSummary ||
            'Asset analysis failed. Confirm the server-only model key, then try again.'}
        </p>
      ) : null}
      {assets.length && !analyzableAssets.length && !active ? (
        <p className="form-message form-message--success" role="status">
          All captured images have been analysed. New images will appear here after an image
          refresh.
        </p>
      ) : null}
      {active ? (
        <div className="capture-progress capture-progress--running">
          <div
            aria-label="Visual asset analysis progress"
            aria-valuetext={job?.progressDetail || 'Preparing private visual-asset suggestions.'}
            className="capture-progress__track"
            role="progressbar"
          >
            <span className="capture-progress__bar" />
          </div>
          <span>
            {job?.progressDetail || 'Preparing private visual-asset suggestions.'}
            {job?.totalItems ? ` ${job.completedItems} of ${job.totalItems} assets complete.` : ''}
          </span>
        </div>
      ) : null}
      {analyzableAssets.length ? (
        <section
          className="asset-analysis-selection"
          aria-labelledby="asset-analysis-selection-title"
        >
          <div className="brief-panel__header">
            <div>
              <h3 id="asset-analysis-selection-title">Assets to analyse</h3>
            </div>
            <span className="muted-copy">
              {selectedAssetCount} of {analyzableAssets.length} selected
            </span>
          </div>
          <details className="asset-selection-disclosure">
            <summary>
              Browse {analyzableAssets.length} captured image
              {analyzableAssets.length === 1 ? '' : 's'} for analysis
            </summary>
            {assetSelectionGrid}
          </details>
        </section>
      ) : null}
      {active || workspace.assetAnnotations.length ? (
        <section className="asset-review-queue" aria-labelledby="asset-suggestions-title">
          <div>
            <Eyebrow>AI suggestions</Eyebrow>
            <h3 id="asset-suggestions-title">Review before brief use</h3>
          </div>
          {active ? (
            <div className="asset-review-loader">
              <p aria-live="polite" role="status">
                {job?.progressDetail ||
                  'Preparing the next private review cards. Earlier suggestions are hidden while this analysis runs.'}
              </p>
              {visiblePendingAnnotations.length ? (
                <div className="asset-review-queue__grid">
                  {visiblePendingAnnotations.map((annotation) => (
                    <AssetAnnotationEditor
                      annotation={annotation}
                      asset={assets.find((asset) => asset.id === annotation.assetId)}
                      assetUrl={urls[annotation.assetId]}
                      key={annotation.id}
                      onUpdate={onUpdateAnnotation}
                    />
                  ))}
                </div>
              ) : null}
              {hiddenPendingAnnotations.length ? (
                <details className="asset-review-overflow">
                  <summary>
                    View {hiddenPendingAnnotations.length} more asset review
                    {hiddenPendingAnnotations.length === 1 ? '' : 's'}
                  </summary>
                  <div className="asset-review-queue__grid">
                    {hiddenPendingAnnotations.map((annotation) => (
                      <AssetAnnotationEditor
                        annotation={annotation}
                        asset={assets.find((asset) => asset.id === annotation.assetId)}
                        assetUrl={urls[annotation.assetId]}
                        key={annotation.id}
                        onUpdate={onUpdateAnnotation}
                      />
                    ))}
                  </div>
                </details>
              ) : null}
              {reviewLoaderCount ? (
                <div aria-hidden="true" className="asset-review-queue__grid">
                  {Array.from({ length: reviewLoaderCount }, (_, index) => (
                    <article className="asset-review-loader__card" key={index}>
                      <span className="asset-review-loader__image evidence-skeleton" />
                      <span className="evidence-skeleton evidence-skeleton--value" />
                      <span className="evidence-skeleton evidence-skeleton--detail" />
                    </article>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <dl className="asset-review-summary" aria-label="Asset review progress">
                <div>
                  <dt>Needs review</dt>
                  <dd>{pendingAnnotations.length}</dd>
                </div>
                <div>
                  <dt>Approved</dt>
                  <dd>{approvedCount}</dd>
                </div>
                <div>
                  <dt>Excluded</dt>
                  <dd>{reviewedAnnotations.length - approvedCount}</dd>
                </div>
              </dl>
              {pendingAnnotations.length ? (
                <div className="asset-review-queue__grid">
                  {visiblePendingAnnotations.map((annotation) => (
                    <AssetAnnotationEditor
                      annotation={annotation}
                      asset={assets.find((asset) => asset.id === annotation.assetId)}
                      assetUrl={urls[annotation.assetId]}
                      key={annotation.id}
                      onUpdate={onUpdateAnnotation}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState
                  detail="All analysed assets now have a reuse decision. Use the reviewed history below to revisit one."
                  icon={CheckCheck}
                  title="Review queue clear"
                />
              )}
              {hiddenPendingAnnotations.length ? (
                <details className="asset-review-overflow">
                  <summary>
                    View {hiddenPendingAnnotations.length} more asset review
                    {hiddenPendingAnnotations.length === 1 ? '' : 's'}
                  </summary>
                  <div className="asset-review-queue__grid">
                    {hiddenPendingAnnotations.map((annotation) => (
                      <AssetAnnotationEditor
                        annotation={annotation}
                        asset={assets.find((asset) => asset.id === annotation.assetId)}
                        assetUrl={urls[annotation.assetId]}
                        key={annotation.id}
                        onUpdate={onUpdateAnnotation}
                      />
                    ))}
                  </div>
                </details>
              ) : null}
              {reviewedAnnotations.length ? (
                <details className="asset-reviewed-history">
                  <summary>
                    View {reviewedAnnotations.length} reviewed asset decision
                    {reviewedAnnotations.length === 1 ? '' : 's'}
                  </summary>
                  <div className="asset-review-queue__grid">
                    {reviewedAnnotations.map((annotation) => (
                      <AssetAnnotationEditor
                        annotation={annotation}
                        asset={assets.find((asset) => asset.id === annotation.assetId)}
                        assetUrl={urls[annotation.assetId]}
                        key={annotation.id}
                        onUpdate={onUpdateAnnotation}
                      />
                    ))}
                  </div>
                </details>
              ) : null}
            </>
          )}
        </section>
      ) : null}
      {assets.length ? <VisualAssetCatalog assets={assets} /> : null}
      {message ? (
        <p className="form-message form-message--error" role="alert">
          {message}
        </p>
      ) : null}
      {loadError ? <p className="form-message form-message--error">{loadError}</p> : null}
    </Card>
  );
}

function isHexColour(value?: string) {
  return /^#[0-9a-f]{6}$/i.test(value ?? '');
}

function BrandKitPanel({
  workspace,
  onSave,
  onCreateRevision,
}: {
  workspace: ProspectWorkspace;
  onSave: (
    draft: Pick<BrandKit, 'primaryLogoAssetId' | 'approvedAssetIds' | 'palette' | 'notes'>,
    approve?: boolean,
    silent?: boolean,
  ) => Promise<void>;
  onCreateRevision: () => Promise<void>;
}) {
  const existing = workspace.brandKit;
  const assets = workspace.artifacts.filter((artifact) => artifact.kind === 'asset');
  const annotationsByAsset = new Map(
    workspace.assetAnnotations.map((annotation) => [annotation.assetId, annotation]),
  );
  const logoAssets = assets.filter(
    (asset) =>
      asset.metadata.assetType === 'logo' ||
      ['primary_logo', 'secondary_mark'].includes(
        annotationsByAsset.get(asset.id)?.suggestedRole ?? '',
      ),
  );
  const supportingAssets = assets.filter(
    (asset) =>
      asset.metadata.assetType === 'image' ||
      ['worksite_photo', 'team_photo', 'project_photo'].includes(
        annotationsByAsset.get(asset.id)?.suggestedRole ?? '',
      ),
  );
  const visibleAssets = [
    ...new Map([...logoAssets, ...supportingAssets].map((asset) => [asset.id, asset])).values(),
  ];
  const { urls, loadError } = usePrivateArtifactUrls(
    visibleAssets,
    'Private brand assets could not be loaded. Refresh and check storage access.',
  );
  const colourSuggestions = useMemo(
    () => rankBrandColourEvidence(workspace.brandColourEvidence),
    [workspace.brandColourEvidence],
  );
  const [draft, setDraft] = useState({
    primaryLogoAssetId: existing?.primaryLogoAssetId ?? '',
    approvedAssetIds: existing?.approvedAssetIds ?? [],
    palette: existing?.palette ?? {},
    notes: existing?.notes ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [autosaving, setAutosaving] = useState(false);
  const [message, setMessage] = useState('');
  const draftRef = useRef(draft);
  const autosaveQueueRef = useRef(Promise.resolve());
  const pendingAutosavesRef = useRef(0);
  const locked = existing?.status === 'approved';

  useEffect(() => {
    if (pendingAutosavesRef.current) return;
    const nextDraft = {
      primaryLogoAssetId: existing?.primaryLogoAssetId ?? '',
      approvedAssetIds: existing?.approvedAssetIds ?? [],
      palette: existing?.palette ?? {},
      notes: existing?.notes ?? '',
    };
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  }, [existing?.id, existing?.updatedAt]);

  useEffect(() => {
    if (locked || !colourSuggestions.primary) return;
    const current = draftRef.current;
    const palette = {
      ...current.palette,
      ...(current.palette.primary ? {} : { primary: colourSuggestions.primary?.colour }),
      ...(current.palette.accent || !colourSuggestions.accent
        ? {}
        : { accent: colourSuggestions.accent.colour }),
    };
    if (palette.primary === current.palette.primary && palette.accent === current.palette.accent) {
      return;
    }
    const nextDraft = { ...current, palette };
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  }, [colourSuggestions.accent?.colour, colourSuggestions.primary?.colour, locked]);

  function toggleAsset(assetId: string) {
    updateDraft({
      ...draftRef.current,
      approvedAssetIds: draftRef.current.approvedAssetIds.includes(assetId)
        ? draftRef.current.approvedAssetIds.filter((candidate) => candidate !== assetId)
        : [...draftRef.current.approvedAssetIds, assetId],
    });
  }

  function normalisedDraft(nextDraft: typeof draft) {
    return {
      ...nextDraft,
      approvedAssetIds: [
        ...new Set([...nextDraft.approvedAssetIds, nextDraft.primaryLogoAssetId]),
      ].filter(Boolean),
    };
  }

  function updateDraft(nextDraft: typeof draft) {
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    if (locked) return;
    setAutosaving(true);
    pendingAutosavesRef.current += 1;
    const snapshot = normalisedDraft(nextDraft);
    autosaveQueueRef.current = autosaveQueueRef.current
      .catch(() => undefined)
      .then(() => onSave(snapshot, false, true))
      .catch((error) => {
        setMessage(
          error instanceof Error ? error.message : 'The Brand Kit draft could not be saved.',
        );
      })
      .finally(() => {
        pendingAutosavesRef.current -= 1;
        if (draftRef.current === nextDraft) setAutosaving(false);
      });
  }

  function applySuggestedColours() {
    if (!colourSuggestions.primary) {
      setMessage('Run asset analysis to collect enough brand-colour evidence first.');
      return;
    }
    updateDraft({
      ...draftRef.current,
      palette: {
        ...draftRef.current.palette,
        primary: colourSuggestions.primary?.colour,
        accent: colourSuggestions.accent?.colour ?? draftRef.current.palette.accent,
      },
    });
    setMessage(
      'Evidence-backed primary and accent suggestions applied. Review them before approval.',
    );
  }

  async function save(approve = false) {
    setSaving(true);
    setMessage('');
    try {
      await autosaveQueueRef.current;
      await onSave(
        {
          ...normalisedDraft(draftRef.current),
        },
        approve,
      );
      if (approve) {
        await onCreateRevision();
        setMessage(
          'Brand Kit approved. A new draft Brief now carries its permitted assets; review and approve that Brief before building.',
        );
      } else {
        setMessage('Brand Kit saved.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The Brand Kit could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function createBrandKitRevision() {
    if (!existing) return;
    setSaving(true);
    setMessage('');
    try {
      const selectedAssetIds = assets
        .filter((asset) => asset.metadata.analysisSelected !== false)
        .map((asset) => asset.id);
      const suggestedAssetIds = workspace.assetAnnotations
        .filter(
          (annotation) =>
            annotation.suggestedRole !== 'exclude' &&
            annotation.businessAssociation !== 'third_party',
        )
        .map((annotation) => annotation.assetId);
      await onSave(
        {
          primaryLogoAssetId: existing.primaryLogoAssetId,
          approvedAssetIds: [
            ...new Set([...existing.approvedAssetIds, ...selectedAssetIds, ...suggestedAssetIds]),
          ],
          palette: existing.palette,
          notes: existing.notes,
        },
        false,
      );
      setMessage(
        'Editable Brand Kit revision created with selected and AI-suggested asset candidates. Review it before approval.',
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'The Brand Kit revision could not be created.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="workspace-panel brand-kit">
      <div className="brief-panel__header">
        <div>
          <Eyebrow>Brand control</Eyebrow>
          <h2>Brand Kit</h2>
          <p className="muted-copy">
            Approve the organisation logo, permitted captured visual assets, and reviewed colour
            tokens before they can guide a private redesign.
          </p>
        </div>
        <StatusBadge tone={locked ? 'success' : 'warning'}>
          {locked ? `Approved v${existing?.version}` : 'Needs approval'}
        </StatusBadge>
      </div>
      {locked ? (
        <div className="brand-kit__approved">
          <p>
            This kit locks the visual identity used by future build revisions. The existing preview
            remains unchanged as a historical record.
          </p>
          {colourSuggestions.primary ? (
            <section className="brand-kit__evidence" aria-labelledby="brand-evidence-current-title">
              <div>
                <Eyebrow>Current capture evidence</Eyebrow>
                <h3 id="brand-evidence-current-title">Suggested brand colours</h3>
              </div>
              <div className="brand-kit__evidence-colours">
                {[
                  { label: 'Primary', suggestion: colourSuggestions.primary },
                  { label: 'Accent', suggestion: colourSuggestions.accent },
                ].map(({ label, suggestion }) =>
                  suggestion ? (
                    <div key={label}>
                      <span
                        aria-hidden="true"
                        className="brand-kit__colour-swatch"
                        style={{ background: suggestion.colour }}
                      />
                      <strong>{label}</strong>
                      <code>{suggestion.colour}</code>
                      <small>{brandColourEvidenceSummary(suggestion.evidence)}</small>
                    </div>
                  ) : null,
                )}
              </div>
              <p>
                These observations belong to the latest capture. They do not change the approved
                Brand Kit until you create and approve a deliberate revision.
              </p>
            </section>
          ) : null}
          <div className="button-row">
            <Button disabled={saving} onClick={() => void createBrandKitRevision()} type="button">
              <RotateCcw aria-hidden="true" size={16} />
              {saving ? 'Creating revision' : 'Create editable Brand Kit revision'}
            </Button>
            <Button
              disabled={saving}
              onClick={() => void onCreateRevision()}
              type="button"
              variant="secondary"
            >
              <FilePenLine aria-hidden="true" size={16} />
              Update Brief from this Brand Kit
            </Button>
          </div>
        </div>
      ) : (
        <>
          {!logoAssets.length ? (
            <EmptyState
              detail="No logo candidates are available yet. Run asset analysis, then classify the organisation logo before approving a Brand Kit."
              icon={ShieldAlert}
              title="Logo evidence required"
            />
          ) : (
            <fieldset className="brand-kit__logos" disabled={saving}>
              <legend>Organisation logo</legend>
              {logoAssets.map((asset) => (
                <label className="brand-kit__asset" key={asset.id}>
                  <input
                    checked={draft.primaryLogoAssetId === asset.id}
                    name="primary-logo"
                    onChange={() =>
                      updateDraft({
                        ...draftRef.current,
                        primaryLogoAssetId: asset.id,
                        approvedAssetIds: [
                          ...new Set([...draftRef.current.approvedAssetIds, asset.id]),
                        ],
                      })
                    }
                    type="radio"
                  />
                  {urls[asset.id] ? <img alt="" src={urls[asset.id]} /> : <span>Loading logo</span>}
                  <span>
                    {asset.label || 'Logo candidate'}
                    {asset.metadata.vectorSuggestion ? (
                      <small>Derived vector suggestion — review before selecting</small>
                    ) : null}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {supportingAssets.length ? (
            <details className="brand-kit__asset-disclosure">
              <summary>Permitted supporting imagery ({supportingAssets.length})</summary>
              <fieldset className="brand-kit__assets" disabled={saving}>
                <legend className="sr-only">Permitted supporting imagery</legend>
                {supportingAssets.map((asset) => (
                  <label className="brand-kit__asset" key={asset.id}>
                    <input
                      checked={draft.approvedAssetIds.includes(asset.id)}
                      onChange={() => toggleAsset(asset.id)}
                      type="checkbox"
                    />
                    {urls[asset.id] ? (
                      <img alt="" src={urls[asset.id]} />
                    ) : (
                      <span>Loading image</span>
                    )}
                    <span>{asset.label || 'Captured image'}</span>
                  </label>
                ))}
              </fieldset>
            </details>
          ) : null}
          {colourSuggestions.primary ? (
            <section className="brand-kit__evidence" aria-labelledby="brand-evidence-title">
              <div>
                <Eyebrow>Automatic evidence</Eyebrow>
                <h3 id="brand-evidence-title">Suggested brand colours</h3>
              </div>
              <div className="brand-kit__evidence-colours">
                {[
                  { label: 'Primary', suggestion: colourSuggestions.primary },
                  { label: 'Accent', suggestion: colourSuggestions.accent },
                ].map(({ label, suggestion }) =>
                  suggestion ? (
                    <div key={label}>
                      <span
                        aria-hidden="true"
                        className="brand-kit__colour-swatch"
                        style={{ background: suggestion.colour }}
                      />
                      <strong>{label}</strong>
                      <code>{suggestion.colour}</code>
                      <small>{brandColourEvidenceSummary(suggestion.evidence)}</small>
                    </div>
                  ) : null,
                )}
              </div>
              <p>
                These are private suggestions from captured logo and interface evidence. They are
                not approved brand facts.
              </p>
              <Button onClick={applySuggestedColours} type="button" variant="secondary">
                <Sparkles aria-hidden="true" size={15} />
                Use suggested colours
              </Button>
            </section>
          ) : null}
          <div className="brand-kit__palette" aria-label="Reviewed brand colours">
            {(['primary', 'accent'] as const).map((role) => (
              <label key={role}>
                {role}
                <span className="brand-kit__colour-input">
                  <input
                    aria-label={`${role} colour`}
                    onChange={(event) =>
                      updateDraft({
                        ...draftRef.current,
                        palette: {
                          ...draftRef.current.palette,
                          [role]: event.target.value.trim(),
                        },
                      })
                    }
                    placeholder="#112233"
                    spellCheck="false"
                    value={draft.palette[role] ?? ''}
                  />
                  <span
                    aria-hidden="true"
                    className="brand-kit__colour-swatch"
                    style={
                      isHexColour(draft.palette[role])
                        ? ({ background: draft.palette[role] } as CSSProperties)
                        : undefined
                    }
                  />
                </span>
              </label>
            ))}
          </div>
          <label className="brand-kit__notes">
            Brand review notes
            <textarea
              onChange={(event) => updateDraft({ ...draftRef.current, notes: event.target.value })}
              placeholder="Record what this logo and palette are verified to represent."
              value={draft.notes}
            />
          </label>
          <div className="brief-panel__actions">
            <Button
              disabled={saving}
              onClick={() => void save(false)}
              type="button"
              variant="secondary"
            >
              <Save aria-hidden="true" size={16} />
              {saving ? 'Saving' : 'Save Brand Kit'}
            </Button>
            <Button
              disabled={saving || !draft.primaryLogoAssetId}
              onClick={() => void save(true)}
              type="button"
            >
              <Check aria-hidden="true" size={16} /> Approve Brand Kit
            </Button>
          </div>
          {autosaving ? (
            <p className="form-message form-message--success" role="status">
              Saving Brand Kit draft
            </p>
          ) : null}
        </>
      )}
      {message ? (
        <p
          className={
            message.endsWith('.') && !message.includes('could not')
              ? 'form-message form-message--success'
              : 'form-message form-message--error'
          }
          role="status"
        >
          {message}
        </p>
      ) : null}
      {loadError ? <p className="form-message form-message--error">{loadError}</p> : null}
    </Card>
  );
}

function BriefAssetChoices({
  assets,
  selectedAssetIds,
  disabled,
  onToggle,
}: {
  assets: ResearchArtifact[];
  selectedAssetIds: string[];
  disabled: boolean;
  onToggle: (assetId: string) => void;
}) {
  const { urls, loadError } = usePrivateArtifactUrls(
    assets,
    'Private asset previews could not be loaded. Refresh and check storage access.',
  );

  return (
    <>
      <details className="asset-selection-disclosure">
        <summary>
          Browse {assets.length} visual asset{assets.length === 1 ? '' : 's'} (
          {selectedAssetIds.length} selected)
        </summary>
        <fieldset className="brief-assets" disabled={disabled}>
          <legend className="sr-only">Approved visual source assets</legend>
          {assets.map((asset) => (
            <label className="brief-source-option brief-source-option--asset" key={asset.id}>
              <input
                checked={selectedAssetIds.includes(asset.id)}
                onChange={() => onToggle(asset.id)}
                type="checkbox"
              />
              {urls[asset.id] ? (
                <img alt="" className="brief-source-option__preview" src={urls[asset.id]} />
              ) : (
                <span className="brief-source-option__preview" aria-hidden="true">
                  Loading image
                </span>
              )}
              <span className="brief-source-option__content">
                <strong>
                  {asset.metadata.assetType ? String(asset.metadata.assetType) : 'Image'}
                </strong>
                <small>{asset.label || 'Captured visual asset'}</small>
              </span>
            </label>
          ))}
        </fieldset>
      </details>
      {loadError ? <p className="form-message form-message--error">{loadError}</p> : null}
    </>
  );
}

function BriefPanel({
  workspace,
  onCreate,
  onRefreshArchitecture,
  onUpdate,
  onApprove,
}: {
  workspace: ProspectWorkspace;
  onCreate: () => Promise<void>;
  onRefreshArchitecture: (brief: RedesignBrief) => Promise<void>;
  onUpdate: (
    brief: RedesignBrief,
    patch: Pick<RedesignBrief, 'sourceSelections' | 'draft'>,
  ) => Promise<void>;
  onApprove: (brief: RedesignBrief) => Promise<void>;
}) {
  const packet = workspace.researchPacket;
  const brief = workspace.redesignBrief;
  const assets = useMemo(
    () => workspace.artifacts.filter((artifact) => artifact.kind === 'asset'),
    [workspace.artifacts],
  );
  const capturedAssetIds = useMemo(() => assets.map((asset) => asset.id), [assets]);
  const [sourceSelections, setSourceSelections] = useState<BriefSourceSelections>(
    normaliseBriefSourceSelections(brief?.sourceSelections),
  );
  const [draft, setDraft] = useState<RedesignBriefDraft>(normaliseBriefDraft(brief?.draft));
  const [isCreating, setIsCreating] = useState(false);
  const [isRefreshingArchitecture, setIsRefreshingArchitecture] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [message, setMessage] = useState('');
  const hasCapabilityInventory = Array.isArray(brief?.draft.capabilityInventory);
  const unresolvedCapabilities = (draft.capabilityInventory ?? []).filter(
    (capability) => capability.decision === 'needs_review',
  );
  const capturedCapabilities = packet ? detectCapabilities(packet, workspace.capturedPages) : [];
  const guidedAssets = workspace.artifacts.filter(
    (artifact) =>
      artifact.kind === 'asset' && draft.assetGuidance.some((item) => item.assetId === artifact.id),
  );
  const guidedAssetsById = new Map(guidedAssets.map((asset) => [asset.id, asset]));
  const { urls: guidedAssetUrls } = usePrivateArtifactUrls(
    guidedAssets,
    'Approved asset previews could not be loaded. Refresh and check storage access.',
  );

  useEffect(() => {
    if (!brief) return;
    const saved = normaliseBriefSourceSelections(brief.sourceSelections);
    if (brief.status !== 'draft') {
      setSourceSelections(saved);
      setDraft(normaliseBriefDraft(brief.draft));
      return;
    }
    const knownAutoSelections = new Set(saved.autoSelectedAssetIds);
    const newlyCapturedAssetIds = capturedAssetIds.filter(
      (assetId) => !knownAutoSelections.has(assetId),
    );
    setSourceSelections({
      ...saved,
      assetIds: [...new Set([...saved.assetIds, ...newlyCapturedAssetIds])],
      autoSelectedAssetIds: [...new Set([...saved.autoSelectedAssetIds, ...capturedAssetIds])],
    });
    setDraft(normaliseBriefDraft(brief.draft));
  }, [brief?.id, brief?.updatedAt, capturedAssetIds]);

  async function createBrief() {
    setIsCreating(true);
    setMessage('');
    try {
      await onCreate();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'The redesign brief could not be created.',
      );
    } finally {
      setIsCreating(false);
    }
  }

  async function refreshArchitecture() {
    if (!brief) return;
    setIsRefreshingArchitecture(true);
    setMessage('');
    try {
      await onRefreshArchitecture(brief);
      setMessage(
        'Architecture regenerated from the selected captured pages. Review the updated navigation groups and page plans before approval.',
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'The proposed architecture could not be regenerated.',
      );
    } finally {
      setIsRefreshingArchitecture(false);
    }
  }

  function toggleSelection(key: 'pageUrls' | 'assetIds', value: string) {
    setSourceSelections((current) => ({
      ...current,
      [key]: current[key].includes(value)
        ? current[key].filter((item) => item !== value)
        : [...current[key], value],
    }));
  }

  function setCapabilityDecision(id: string, decision: CapabilityDecision) {
    setDraft((current) => ({
      ...current,
      capabilityInventory: (current.capabilityInventory ?? []).map((capability) =>
        capability.id === id ? { ...capability, decision } : capability,
      ),
    }));
  }

  async function saveBrief() {
    if (!brief) return;
    setIsSaving(true);
    setMessage('');
    try {
      await onUpdate(brief, { sourceSelections, draft });
      setMessage('Brief saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The brief could not be saved.');
    } finally {
      setIsSaving(false);
    }
  }

  async function approveBrief() {
    if (!brief) return;
    if (!hasCapabilityInventory) {
      setMessage('Generate the capability inventory from this saved capture before approving.');
      return;
    }
    if (unresolvedCapabilities.length) {
      setMessage(
        `Review ${unresolvedCapabilities.length} detected ${unresolvedCapabilities.length === 1 ? 'capability' : 'capabilities'} before approving the brief.`,
      );
      return;
    }
    setIsApproving(true);
    setMessage('');
    const pendingBrief = { ...brief, sourceSelections, draft };
    try {
      await onUpdate(brief, { sourceSelections, draft });
      await onApprove(pendingBrief);
      setMessage('Brief approved. The redesign builder can now use this strategy.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The brief could not be approved.');
    } finally {
      setIsApproving(false);
    }
  }

  if (!packet) {
    return (
      <Card className="workspace-panel">
        <Eyebrow>Redesign brief</Eyebrow>
        <h2>Research Packet required</h2>
        <EmptyState
          detail="Complete a private website capture first. The brief is grounded in captured structure, content, verified business context, and selected original assets."
          icon={FileText}
          title="No Research Packet yet"
        />
      </Card>
    );
  }

  if (!brief) {
    return (
      <Card className="workspace-panel brief-empty-state">
        <Eyebrow>Strategy handoff</Eyebrow>
        <h2>Turn research into a redesign brief</h2>
        <p className="muted-copy">
          Create a private draft from this Research Packet. It preserves the source capture and
          holds your visual selections, uncertainties, sitemap, and page plan before build work.
        </p>
        {capturedCapabilities.length ? (
          <section aria-labelledby="captured-capabilities-title" className="brief-capabilities">
            <div>
              <Eyebrow>Capability scope</Eyebrow>
              <h3 id="captured-capabilities-title">
                {capturedCapabilities.length} detected capability{' '}
                {capturedCapabilities.length === 1 ? 'needs' : 'need'} a decision
              </h3>
              <p className="muted-copy">
                These candidates were generated automatically when the saved website capture
                completed. Creating the brief lets you include or exclude each one.
              </p>
            </div>
            <ul className="brief-capabilities__preview">
              {capturedCapabilities.map((capability) => (
                <li key={capability.id}>
                  <strong>{capability.title}</strong>
                  <span>{capability.description}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <Button disabled={isCreating} onClick={() => void createBrief()} type="button">
          <FileText aria-hidden="true" size={16} />
          {isCreating ? 'Creating brief' : 'Create redesign brief'}
        </Button>
        {message ? (
          <p className="form-message form-message--error" role="alert">
            {message}
          </p>
        ) : null}
      </Card>
    );
  }

  const editable = brief.status === 'draft';
  const sourceChanged =
    brief.status === 'approved' && !manifestSourceMatchesBrief(workspace, brief);

  return (
    <Card className="workspace-panel brief-panel">
      <div className="brief-panel__header">
        <div>
          <Eyebrow>Strategy handoff</Eyebrow>
          <h2>Redesign brief</h2>
          <p className="muted-copy">
            This is a private, source-bound instruction set for the future builder. It is not a
            client-facing report and does not create new business claims.
          </p>
        </div>
        <div className="brief-panel__actions">
          <StatusBadge tone={briefStatusTone(brief.status)}>
            {briefStatusLabel(brief.status)}
          </StatusBadge>
          {editable ? (
            <>
              {!hasCapabilityInventory ? (
                <Button
                  disabled={isCreating}
                  onClick={() => void createBrief()}
                  type="button"
                  variant="secondary"
                >
                  <ListChecks aria-hidden="true" size={16} />
                  {isCreating ? 'Reading saved evidence' : 'Generate capability inventory'}
                </Button>
              ) : null}
              <Button
                disabled={isSaving || isApproving || isRefreshingArchitecture}
                onClick={() => void saveBrief()}
                type="button"
                variant="secondary"
              >
                <Save aria-hidden="true" size={16} />
                {isSaving ? 'Saving brief' : 'Save brief'}
              </Button>
              <Button
                disabled={isSaving || isApproving || isRefreshingArchitecture}
                onClick={() => void refreshArchitecture()}
                type="button"
                variant="secondary"
              >
                <RotateCcw aria-hidden="true" size={16} />
                {isRefreshingArchitecture ? 'Regenerating architecture' : 'Regenerate architecture'}
              </Button>
              <Button
                disabled={
                  isSaving ||
                  isApproving ||
                  isRefreshingArchitecture ||
                  !hasCapabilityInventory ||
                  Boolean(unresolvedCapabilities.length)
                }
                onClick={() => void approveBrief()}
                type="button"
              >
                <Check aria-hidden="true" size={16} />
                {isApproving ? 'Approving brief' : 'Approve brief'}
              </Button>
            </>
          ) : null}
          {!editable && !hasCapabilityInventory ? (
            <Button
              disabled={isCreating}
              onClick={() => void createBrief()}
              type="button"
              variant="secondary"
            >
              <ListChecks aria-hidden="true" size={16} />
              {isCreating ? 'Reading saved evidence' : 'Create capability review version'}
            </Button>
          ) : null}
          {sourceChanged ? (
            <Button disabled={isCreating} onClick={() => void createBrief()} type="button">
              <FileText aria-hidden="true" size={16} />
              {isCreating ? 'Creating brief' : 'Create new brief version'}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="brief-panel__source-summary">
        <span>{sourceSelections.pageUrls.length} page sources selected</span>
        <span>{sourceSelections.assetIds.length} visual assets selected</span>
        <span>
          {hasCapabilityInventory
            ? `${unresolvedCapabilities.length} capability decisions pending`
            : 'Capability inventory not generated'}
        </span>
        <span>{sourceSelections.uncertainties.length} uncertainties flagged</span>
      </div>

      {draft.assetGuidance.length ? (
        <section className="brief-asset-guidance" aria-labelledby="brief-asset-guidance-title">
          <div>
            <Eyebrow>Approved asset context</Eyebrow>
            <h3 id="brief-asset-guidance-title">Visual guidance for the builder</h3>
            <p className="muted-copy">
              These are the specific captured images approved for use. Each card states what it is
              and how it may be used.
            </p>
          </div>
          <details className="brief-asset-guidance__disclosure">
            <summary>
              View {draft.assetGuidance.length} approved visual guide
              {draft.assetGuidance.length === 1 ? '' : 's'}
            </summary>
            <ul>
              {draft.assetGuidance.map((guidance) => {
                const asset = guidedAssetsById.get(guidance.assetId);
                const pageUrl = asset ? recordValue(asset.metadata, 'pageUrl') : '';
                return (
                  <li key={guidance.assetId}>
                    {asset && guidedAssetUrls[asset.id] ? (
                      <img alt="" src={guidedAssetUrls[asset.id]} />
                    ) : (
                      <span className="brief-asset-guidance__preview">Preview unavailable</span>
                    )}
                    <span className="brief-asset-guidance__content">
                      <strong>{guidance.role.replaceAll('_', ' ')}</strong>
                      <b>{asset?.label || 'Approved captured image'}</b>
                      {pageUrl ? (
                        <small>Captured from {sourceUrlLabel(pageUrl, 'source page')}</small>
                      ) : null}
                      <span>{guidance.observedDescription}</span>
                      <small>{guidance.safeReuseNote}</small>
                    </span>
                  </li>
                );
              })}
            </ul>
          </details>
        </section>
      ) : null}

      <section className="brief-generated-context" aria-labelledby="brief-generated-context-title">
        <Eyebrow>Generated context</Eyebrow>
        <h3 id="brief-generated-context-title">Builder boundaries and unresolved evidence</h3>
        <p>{draft.strategy}</p>
        <div>
          <h4>Open questions</h4>
          {draft.openQuestions.length ? (
            <ul>
              {draft.openQuestions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          ) : (
            <p className="muted-copy">No generated open questions.</p>
          )}
        </div>
        <div>
          <h4>Uncertainties kept out of the build</h4>
          {sourceSelections.uncertainties.length ? (
            <ul>
              {sourceSelections.uncertainties.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="muted-copy">No uncertainties are currently flagged.</p>
          )}
        </div>
      </section>

      {hasCapabilityInventory ? (
        <section aria-labelledby="brief-capabilities-title" className="brief-capabilities">
          <div>
            <Eyebrow>Capability scope</Eyebrow>
            <h3 id="brief-capabilities-title">Detected website capabilities</h3>
            <p className="muted-copy">
              These are evidence-led candidates from the saved capture, not claims about hidden
              systems. Decide what the replacement should include before the builder starts.
            </p>
          </div>
          {(draft.capabilityInventory ?? []).length ? (
            <div className="brief-capabilities__list">
              {(draft.capabilityInventory ?? []).map((capability) => (
                <article className="brief-capability" key={capability.id}>
                  <div className="brief-capability__header">
                    <div>
                      <h4>{capability.title}</h4>
                      <p>{capability.description}</p>
                    </div>
                    <StatusBadge
                      tone={
                        capability.decision === 'include'
                          ? 'success'
                          : capability.decision === 'exclude'
                            ? 'neutral'
                            : 'warning'
                      }
                    >
                      {capability.decision.replaceAll('_', ' ')}
                    </StatusBadge>
                  </div>
                  <dl className="brief-capability__details">
                    <div>
                      <dt>Proposed delivery</dt>
                      <dd>{capability.delivery.replaceAll('_', ' ')}</dd>
                    </div>
                    <div>
                      <dt>Evidence confidence</dt>
                      <dd>{capability.confidence}</dd>
                    </div>
                  </dl>
                  <p className="brief-capability__question">{capability.decisionQuestion}</p>
                  <ul className="brief-capability__evidence">
                    {capability.evidence.map((item) => (
                      <li key={`${capability.id}-${item.sourceUrl}`}>
                        <strong>{sourceUrlLabel(item.sourceUrl, 'Captured page')}</strong>
                        <span>{item.detail}</span>
                      </li>
                    ))}
                  </ul>
                  <label className="brief-capability__decision">
                    <span>Replacement decision</span>
                    <select
                      disabled={!editable}
                      onChange={(event) =>
                        setCapabilityDecision(
                          capability.id,
                          event.target.value as CapabilityDecision,
                        )
                      }
                      value={capability.decision}
                    >
                      <option value="needs_review">Needs review</option>
                      <option value="include">Include in replacement</option>
                      <option value="exclude">Do not include</option>
                    </select>
                  </label>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              detail="No dynamic or workflow capability signals were found in the saved capture. Selected pages remain part of the replacement scope."
              icon={ListChecks}
              title="No additional capability decisions"
            />
          )}
        </section>
      ) : null}

      <section aria-labelledby="brief-pages-title" className="brief-sources">
        <div>
          <Eyebrow>Source selection</Eyebrow>
          <h3 id="brief-pages-title">Captured pages to use</h3>
          <p className="muted-copy">Only selected sources should guide the future builder.</p>
        </div>
        <details className="asset-selection-disclosure">
          <summary>
            Browse {workspace.capturedPages.length} captured page
            {workspace.capturedPages.length === 1 ? '' : 's'} ({sourceSelections.pageUrls.length}{' '}
            selected)
          </summary>
          <fieldset disabled={!editable}>
            <legend className="sr-only">Captured pages to include</legend>
            {workspace.capturedPages.map((page) => (
              <label className="brief-source-option" key={page.id}>
                <input
                  checked={sourceSelections.pageUrls.includes(page.url)}
                  onChange={() => toggleSelection('pageUrls', page.url)}
                  type="checkbox"
                />
                <span>
                  <strong>{page.title || sourceUrlLabel(page.url, 'Captured page')}</strong>
                  <small>{sourceUrlLabel(page.url, '/')}</small>
                </span>
              </label>
            ))}
          </fieldset>
        </details>
      </section>

      <section aria-labelledby="brief-assets-title" className="brief-sources">
        <div>
          <Eyebrow>Visual selection</Eyebrow>
          <h3 id="brief-assets-title">Captured source assets</h3>
          <p className="muted-copy">
            Selected assets provide source context. Only approved asset guidance may direct reuse.
          </p>
        </div>
        {assets.length ? (
          <BriefAssetChoices
            assets={assets}
            disabled={!editable}
            onToggle={(assetId) => toggleSelection('assetIds', assetId)}
            selectedAssetIds={sourceSelections.assetIds}
          />
        ) : (
          <p className="muted-copy">No visual assets were available in this capture.</p>
        )}
      </section>

      <section aria-labelledby="brief-sitemap-title" className="brief-architecture">
        <Eyebrow>Proposed architecture</Eyebrow>
        <h3 id="brief-sitemap-title">Sitemap and page plan</h3>
        <p className="muted-copy">
          The sitemap models the primary information hierarchy. The page plan preserves the full
          selected-page scope, including articles, tools, and utility routes that do not belong in
          primary navigation.
        </p>
        <div className="brief-architecture__grid">
          <div>
            <h4>Suggested sitemap</h4>
            <ol>
              {draft.proposedSitemap.map((entry) => (
                <li key={`${entry.label}-${entry.sourceUrl}`}>
                  <strong>{entry.label}</strong>
                  <span>{entry.purpose}</span>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <h4>Page structures</h4>
            <details className="brief-architecture__plans">
              <summary>
                View {draft.pagePlans.length} selected page plan
                {draft.pagePlans.length === 1 ? '' : 's'}
              </summary>
              <ul>
                {draft.pagePlans.map((plan) => (
                  <li key={`${plan.title}-${plan.sourceUrl}`}>
                    <strong>{plan.title}</strong>
                    <span>{plan.structure.join(' · ')}</span>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </div>
      </section>

      <section aria-labelledby="brief-assumptions-title" className="brief-assumptions">
        <Eyebrow>Boundaries</Eyebrow>
        <h3 id="brief-assumptions-title">Builder constraints</h3>
        <ul>
          {draft.assumptions.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
      </section>
      {message ? (
        <p className="form-message" role="status">
          {message}
        </p>
      ) : null}
    </Card>
  );
}

function builderRunTone(status: BuilderRun['status']) {
  if (status === 'ready') return 'success' as const;
  if (status === 'failed') return 'danger' as const;
  if (
    status === 'review_required' ||
    status === 'cancelled' ||
    status === 'queued' ||
    status === 'running' ||
    status === 'paused'
  )
    return 'warning' as const;
  return 'neutral' as const;
}

function builderRunLabel(status: BuilderRun['status']) {
  if (status === 'queued') return 'Preview queued';
  if (status === 'running') return 'Building preview';
  if (status === 'paused') return 'Automatic retry queued';
  if (status === 'ready') return 'Preview ready';
  if (status === 'review_required') return 'Quality review required';
  if (status === 'failed') return 'Build failed';
  return 'Build cancelled';
}

function builderEventContext(event: BuilderEvent) {
  const context = [`Recorded as step ${event.sequence}.`];
  const page = typeof event.metadata.page === 'string' ? event.metadata.page : undefined;
  const viewport =
    typeof event.metadata.viewport === 'string' ? event.metadata.viewport : undefined;
  const stage = typeof event.metadata.stage === 'string' ? event.metadata.stage : undefined;
  const code = typeof event.metadata.code === 'string' ? event.metadata.code : undefined;

  if (page) context.push(`Page: ${page}`);
  if (viewport) context.push(`Viewport: ${viewport.replaceAll('_', ' ')}`);
  if (stage) context.push(`Worker stage: ${stage.replaceAll('_', ' ')}`);
  if (code) context.push(`Failure code: ${code.replaceAll('_', ' ')}`);

  return context;
}

function isCodexStreamEvent(event: BuilderEvent) {
  return event.metadata.stream === 'codex';
}

function diagnosticMetadata(event: BuilderEvent, key: string) {
  const value = event.metadata[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function diagnosticTone(event: BuilderEvent) {
  const status = diagnosticMetadata(event, 'status');
  if (status === 'failed') return 'danger' as const;
  if (status === 'warning') return 'warning' as const;
  return 'neutral' as const;
}

function BuilderTimelineItem({ event }: { event: BuilderEvent }) {
  const expandable = event.kind !== 'activity';
  const tone = event.kind === 'error' ? 'danger' : event.kind === 'quality' ? 'success' : 'neutral';

  if (!expandable) {
    return (
      <li className="builder-timeline__activity">
        <StatusBadge tone="neutral">live update</StatusBadge>
        <span>{event.message}</span>
        <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
      </li>
    );
  }

  return (
    <li>
      <details className="builder-timeline__step">
        <summary>
          <StatusBadge tone={tone}>{event.kind}</StatusBadge>
          <span className="builder-timeline__step-copy">
            <strong>{event.message}</strong>
            <small>Completed {formatDate(event.createdAt)}</small>
          </span>
        </summary>
        <div className="builder-timeline__context">
          <p>Step context</p>
          <ul>
            {builderEventContext(event).map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        </div>
      </details>
    </li>
  );
}

function BuilderRunPanel({
  workspace,
  onRequestBuild,
  onCancelBuild,
  onOpenPreview,
}: {
  workspace: ProspectWorkspace;
  onRequestBuild: () => Promise<void>;
  onCancelBuild: () => Promise<void>;
  onOpenPreview: (builderRunId: string, mode?: BuilderPreviewMode) => Promise<string>;
}) {
  const run = workspace.latestBuilderRun;
  const [isRequesting, setIsRequesting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isOpeningPreview, setIsOpeningPreview] = useState(false);
  const [message, setMessage] = useState('');
  const screenshots = workspace.builderArtifacts.filter(
    (artifact) => artifact.kind === 'screenshot',
  );
  const { urls: screenshotUrls, loadError } = usePrivateArtifactUrls(
    screenshots,
    'Private preview screenshots could not be loaded. Refresh and check storage access.',
  );
  const active = run?.status === 'queued' || run?.status === 'running' || run?.status === 'paused';
  const frozenDraft =
    run?.status === 'paused' || run?.status === 'failed' || run?.status === 'cancelled';
  const draftAvailable = workspace.builderArtifacts.some(
    (artifact) => artifact.kind === 'draft_file' && artifact.label === 'index.html',
  );
  const checkpointAvailable = workspace.builderArtifacts.some(
    (artifact) =>
      artifact.kind === 'checkpoint' && artifact.label === 'Latest private source checkpoint',
  );
  const savedSourceAvailable =
    checkpointAvailable ||
    workspace.builderArtifacts.some((artifact) => artifact.kind === 'draft_file');
  const codexStreamEvents = workspace.builderEvents.filter(isCodexStreamEvent);
  const diagnosticEvents = workspace.builderEvents.filter((event) => event.kind === 'diagnostic');
  const timelineEvents = workspace.builderEvents.filter(
    (event) => !isCodexStreamEvent(event) && event.kind !== 'diagnostic',
  );
  const failedOutputPath =
    typeof run?.failureContext.path === 'string' ? run.failureContext.path : undefined;
  const failedStorageOperation =
    typeof run?.failureContext.operation === 'string'
      ? run.failureContext.operation.replaceAll('_', ' ')
      : undefined;
  const failedQualityPage =
    typeof run?.failureContext.page === 'string' ? run.failureContext.page : undefined;
  const failedQualityViewport =
    typeof run?.failureContext.viewport === 'string'
      ? run.failureContext.viewport.replaceAll('_', ' ')
      : undefined;
  const failedDiagnostic =
    typeof run?.failureContext.detail === 'string' ? run.failureContext.detail : undefined;

  async function requestBuild() {
    setIsRequesting(true);
    setMessage('');
    try {
      await onRequestBuild();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'The private preview could not be queued.',
      );
    } finally {
      setIsRequesting(false);
    }
  }

  async function cancelBuild() {
    setIsCancelling(true);
    setMessage('');
    try {
      await onCancelBuild();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'The private preview could not be cancelled.',
      );
    } finally {
      setIsCancelling(false);
    }
  }

  async function openPreview(mode: BuilderPreviewMode) {
    if (!run) return;
    const previewTab = window.open('about:blank', '_blank');
    if (previewTab) previewTab.opener = null;
    setIsOpeningPreview(true);
    setMessage('');
    try {
      const previewUrl = await onOpenPreview(run.id, mode);
      if (previewTab && !previewTab.closed) {
        previewTab.location.replace(previewUrl);
      } else {
        window.open(previewUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (error) {
      previewTab?.close();
      setMessage(
        error instanceof Error ? error.message : 'The private preview could not be opened.',
      );
    } finally {
      setIsOpeningPreview(false);
    }
  }

  return (
    <section className="builder-run" aria-labelledby="builder-run-title">
      <div className="brief-panel__header">
        <div>
          <Eyebrow>Private preview</Eyebrow>
          <h3 id="builder-run-title">Codex website builder</h3>
          <p className="muted-copy">
            Builds an isolated website from this approved manifest, then saves source, responsive
            captures, and automated checks for your review. It does not publish or contact anyone.
          </p>
        </div>
        {run ? (
          <StatusBadge tone={builderRunTone(run.status)}>{builderRunLabel(run.status)}</StatusBadge>
        ) : null}
      </div>

      {run ? (
        <>
          {run.status === 'failed' ? (
            <dl className="builder-failure-summary" aria-label="Build failure summary">
              <div>
                <dt>Stopped during</dt>
                <dd>{run.progressPhase.replaceAll('_', ' ')}</dd>
              </div>
              <div>
                <dt>Progress saved</dt>
                <dd>
                  {run.completedItems} of {run.totalItems || 7} steps
                </dd>
              </div>
            </dl>
          ) : (
            <dl className="builder-run-summary" aria-label="Private preview build progress">
              <div>
                <dt>Build stage</dt>
                <dd>{run.progressPhase.replaceAll('_', ' ')}</dd>
              </div>
              <div>
                <dt>Completed steps</dt>
                <dd>
                  {run.completedItems}/{run.totalItems || 7}
                </dd>
              </div>
              <div>
                <dt>Quality status</dt>
                <dd>{run.qualitySummary.status.replaceAll('_', ' ')}</dd>
              </div>
              <div>
                <dt>Preview files</dt>
                <dd>
                  {
                    workspace.builderArtifacts.filter((artifact) => artifact.kind === 'site_file')
                      .length
                  }
                </dd>
              </div>
            </dl>
          )}
          <p className="builder-run__detail" role={active ? 'status' : undefined}>
            {run.progressDetail || 'Waiting for the builder worker.'}
          </p>
          {active || codexStreamEvents.length ? (
            <section className="builder-codex-stream" aria-labelledby="builder-codex-stream-title">
              <div className="builder-codex-stream__header">
                <div>
                  <Eyebrow>Codex activity</Eyebrow>
                  <h4 id="builder-codex-stream-title">Live build stream</h4>
                </div>
                {active ? <StatusBadge tone="warning">Live</StatusBadge> : null}
              </div>
              {codexStreamEvents.length ? (
                <ol aria-live="polite" aria-relevant="additions text" role="log">
                  {codexStreamEvents
                    .slice(0, 24)
                    .reverse()
                    .map((event) => (
                      <li key={event.id}>
                        <strong>Codex</strong>
                        <span>{event.message}</span>
                        <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
                      </li>
                    ))}
                </ol>
              ) : (
                <p className="muted-copy">
                  Waiting for Codex&apos;s first visible build update. The working preview will
                  appear once it saves a homepage draft.
                </p>
              )}
            </section>
          ) : null}
          {
            <section className="builder-diagnostics" aria-labelledby="builder-diagnostics-title">
              <div className="builder-diagnostics__header">
                <div>
                  <Eyebrow>Build diagnostics</Eyebrow>
                  <h4 id="builder-diagnostics-title">Worker, terminal, and browser output</h4>
                </div>
                <StatusBadge tone="neutral">Private</StatusBadge>
              </div>
              {diagnosticEvents.length ? (
                <ol aria-live={active ? 'polite' : 'off'}>
                  {diagnosticEvents
                    .slice(0, 32)
                    .reverse()
                    .map((event) => {
                      const scope = diagnosticMetadata(event, 'scope');
                      const detail = diagnosticMetadata(event, 'detail');
                      const command = diagnosticMetadata(event, 'command');
                      const stdout = diagnosticMetadata(event, 'stdout');
                      const stderr = diagnosticMetadata(event, 'stderr');
                      const duration = diagnosticMetadata(event, 'durationMs');
                      return (
                        <li key={event.id}>
                          <details>
                            <summary>
                              <StatusBadge tone={diagnosticTone(event)}>
                                {diagnosticMetadata(event, 'status') || 'completed'}
                              </StatusBadge>
                              <span>
                                <strong>{event.message}</strong>
                                <small>
                                  {[scope, duration ? `${duration} ms` : undefined]
                                    .filter(Boolean)
                                    .join(' - ')}
                                </small>
                              </span>
                              <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
                            </summary>
                            {detail || command || stdout || stderr ? (
                              <div className="builder-diagnostics__body">
                                {detail ? <p>{detail}</p> : null}
                                {command ? <code>{command}</code> : null}
                                {stdout ? (
                                  <details>
                                    <summary>Standard output</summary>
                                    <pre>{stdout}</pre>
                                  </details>
                                ) : null}
                                {stderr ? (
                                  <details>
                                    <summary>Standard error</summary>
                                    <pre>{stderr}</pre>
                                  </details>
                                ) : null}
                              </div>
                            ) : null}
                          </details>
                        </li>
                      );
                    })}
                </ol>
              ) : (
                <p className="muted-copy">
                  {active
                    ? 'Waiting for the worker to record its first diagnostic.'
                    : 'This older build has no diagnostic entries. Resume or start a build to create a private command and browser record here.'}
                </p>
              )}
            </section>
          }
          {timelineEvents.length ? (
            <section className="builder-timeline" aria-labelledby="builder-timeline-title">
              <Eyebrow>Live build timeline</Eyebrow>
              <h4 id="builder-timeline-title">What the builder has completed</h4>
              <ol>
                {timelineEvents
                  .slice(-16)
                  .reverse()
                  .map((event) => (
                    <BuilderTimelineItem event={event} key={event.id} />
                  ))}
              </ol>
            </section>
          ) : null}
          {run.errorSummary ? (
            <p className="form-message form-message--error" role="alert">
              {run.errorSummary}
            </p>
          ) : null}
          {run.failureCode ? (
            <section className="builder-recovery" aria-labelledby="builder-recovery-title">
              <Eyebrow>Build recovery</Eyebrow>
              <h4 id="builder-recovery-title">What needs attention</h4>
              <dl>
                <div>
                  <dt>Failed stage</dt>
                  <dd>{run.failureStage?.replaceAll('_', ' ') || 'builder runtime'}</dd>
                </div>
                <div>
                  <dt>Failure code</dt>
                  <dd>{run.failureCode.replaceAll('_', ' ')}</dd>
                </div>
                <div>
                  <dt>Saved output</dt>
                  <dd>
                    {draftAvailable
                      ? 'A private draft was preserved.'
                      : checkpointAvailable
                        ? 'A private source checkpoint was preserved for resume.'
                        : savedSourceAvailable
                          ? 'Saved private source files were preserved for resume.'
                          : 'No viewable draft was saved before the build stopped.'}
                  </dd>
                </div>
                <div>
                  <dt>Attempts</dt>
                  <dd>
                    {typeof run.failureContext.attempt === 'number'
                      ? run.failureContext.attempt
                      : 'Not recorded'}
                  </dd>
                </div>
                {failedOutputPath ? (
                  <div>
                    <dt>Affected output</dt>
                    <dd>
                      {failedOutputPath}
                      {failedStorageOperation ? ` (${failedStorageOperation})` : ''}
                    </dd>
                  </div>
                ) : null}
                {!failedOutputPath && failedStorageOperation ? (
                  <div>
                    <dt>Failed operation</dt>
                    <dd>{failedStorageOperation}</dd>
                  </div>
                ) : null}
                {failedQualityPage ? (
                  <div>
                    <dt>Quality target</dt>
                    <dd>
                      {failedQualityPage}
                      {failedQualityViewport ? ` (${failedQualityViewport})` : ''}
                      {failedStorageOperation ? ` - ${failedStorageOperation}` : ''}
                    </dd>
                  </div>
                ) : null}
                {failedDiagnostic ? (
                  <div>
                    <dt>Diagnostic</dt>
                    <dd>{failedDiagnostic}</dd>
                  </div>
                ) : null}
              </dl>
              <p>{run.failureAction || 'Review the timeline, then start a clean build.'}</p>
              {run.retryAfter ? (
                <p className="muted-copy">
                  One automatic retry is scheduled for {formatDate(run.retryAfter)}.
                </p>
              ) : null}
            </section>
          ) : null}

          {run.qualitySummary.checks.length ? (
            <section className="builder-quality" aria-labelledby="builder-quality-title">
              <Eyebrow>Quality checks</Eyebrow>
              <h4 id="builder-quality-title">Generated preview review</h4>
              <ul>
                {run.qualitySummary.checks.map((check) => (
                  <li key={check.id}>
                    <strong>{check.label}</strong>
                    <span>{check.detail}</span>
                    <StatusBadge
                      tone={
                        check.status === 'passed'
                          ? 'success'
                          : check.status === 'failed'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {check.status.replaceAll('_', ' ')}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {screenshots.length ? (
            <section className="builder-screenshots" aria-labelledby="builder-screenshots-title">
              <Eyebrow>Responsive captures</Eyebrow>
              <h4 id="builder-screenshots-title">Generated website</h4>
              {loadError ? (
                <p className="form-message form-message--error" role="alert">
                  {loadError}
                </p>
              ) : null}
              <div>
                {screenshots.map((screenshot) =>
                  screenshotUrls[screenshot.id] ? (
                    <ExpandableImage
                      alt={`${screenshot.label} of the generated private preview`}
                      className="builder-screenshots__image"
                      key={screenshot.id}
                      label={screenshot.label}
                      src={screenshotUrls[screenshot.id]}
                    >
                      <img
                        alt={`${screenshot.label} of the generated private preview`}
                        src={screenshotUrls[screenshot.id]}
                      />
                      <span>{screenshot.label}</span>
                    </ExpandableImage>
                  ) : null,
                )}
              </div>
            </section>
          ) : null}
        </>
      ) : (
        <p className="muted-copy">No website has been generated from this manifest yet.</p>
      )}

      <div className="brief-panel__actions">
        {run?.status === 'ready' || run?.status === 'review_required' ? (
          <Button
            disabled={isOpeningPreview}
            onClick={() => void openPreview('ready')}
            type="button"
          >
            <ArrowUpRight aria-hidden="true" size={16} />
            {isOpeningPreview ? 'Opening preview' : 'Open private preview'}
          </Button>
        ) : null}
        {(run?.status === 'running' || frozenDraft) && draftAvailable ? (
          <Button
            disabled={isOpeningPreview}
            onClick={() => void openPreview('draft')}
            type="button"
            variant="secondary"
          >
            <ArrowUpRight aria-hidden="true" size={16} />
            {isOpeningPreview
              ? 'Opening draft'
              : frozenDraft
                ? 'Open frozen draft'
                : 'View working draft'}
          </Button>
        ) : null}
        {active ? (
          <Button
            disabled={isCancelling || Boolean(run?.cancelRequestedAt)}
            onClick={() => void cancelBuild()}
            type="button"
            variant="secondary"
          >
            <Ban aria-hidden="true" size={16} />
            {isCancelling ? 'Cancelling build' : 'Cancel build'}
          </Button>
        ) : (
          <Button disabled={isRequesting} onClick={() => void requestBuild()} type="button">
            <Play aria-hidden="true" size={16} />
            {isRequesting
              ? 'Queueing builder'
              : run?.status === 'failed' || run?.status === 'cancelled'
                ? checkpointAvailable
                  ? 'Resume from checkpoint'
                  : savedSourceAvailable
                    ? 'Resume saved source'
                    : 'Start clean rebuild'
                : run
                  ? 'Generate another preview'
                  : 'Generate private preview'}
          </Button>
        )}
      </div>
      {message ? (
        <p className="form-message form-message--error" role="alert">
          {message}
        </p>
      ) : null}
    </section>
  );
}

function BuilderSettingsControl({ compact = false }: { compact?: boolean }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <Button size={compact ? 'compact' : 'default'} type="button" variant="secondary">
          <SlidersHorizontal aria-hidden="true" size={16} /> Builder settings
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="builder-settings-overlay" />
        <Dialog.Content
          aria-describedby="builder-settings-description"
          className="builder-settings-panel"
        >
          <div className="builder-settings-panel__header">
            <div>
              <Eyebrow>Protected runtime</Eyebrow>
              <Dialog.Title>Builder settings</Dialog.Title>
            </div>
            <Dialog.Close asChild>
              <Button aria-label="Close builder settings" size="compact" variant="quiet">
                <X aria-hidden="true" size={20} />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="muted-copy" id="builder-settings-description">
            These settings describe the protected environment used for every private website build.
            They are managed on the worker, not in the browser.
          </Dialog.Description>
          <dl className="builder-settings-list">
            <div>
              <dt>Codex model</dt>
              <dd>gpt-5.6</dd>
            </div>
            <div>
              <dt>Workspace access</dt>
              <dd>Workspace write only</dd>
            </div>
            <div>
              <dt>Preview access</dt>
              <dd>Private, expiring links</dd>
            </div>
            <div>
              <dt>Quality checks</dt>
              <dd>Build, responsive capture, and axe</dd>
            </div>
          </dl>
          <section
            className="builder-settings-panel__notice"
            aria-label="Runtime configuration notice"
          >
            <ShieldAlert aria-hidden="true" size={18} />
            <p>
              To change the model, update <code>SITEFORGE_CODEX_MODEL</code> in the builder worker
              environment, then restart the worker. That prevents a workspace member from changing a
              protected runtime setting for other builds.
            </p>
          </section>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function BuilderSettingsPage() {
  return (
    <section className="settings-page" aria-labelledby="settings-page-title">
      <Eyebrow>Workspace settings</Eyebrow>
      <h1 id="settings-page-title">Settings</h1>
      <Card className="workspace-panel settings-page__card">
        <div>
          <Eyebrow>Website builder</Eyebrow>
          <h2>Protected builder runtime</h2>
          <p className="muted-copy">
            Review the Codex model, access boundary, and checks used for private website previews.
          </p>
        </div>
        <BuilderSettingsControl />
      </Card>
    </section>
  );
}

function BuildManifestPanel({
  workspace,
  onCreate,
  onRequestBuild,
  onCancelBuild,
  onOpenPreview,
}: {
  workspace: ProspectWorkspace;
  onCreate: () => Promise<void>;
  onRequestBuild: () => Promise<void>;
  onCancelBuild: () => Promise<void>;
  onOpenPreview: (builderRunId: string, mode?: BuilderPreviewMode) => Promise<string>;
}) {
  const [isPreparing, setIsPreparing] = useState(false);
  const [message, setMessage] = useState('');
  const brief = workspace.redesignBrief;
  const manifest = workspace.buildManifest;

  async function prepareManifest() {
    setIsPreparing(true);
    setMessage('');
    try {
      await onCreate();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'The Build Manifest could not be prepared.',
      );
    } finally {
      setIsPreparing(false);
    }
  }

  if (!brief || brief.status !== 'approved') {
    return (
      <Card className="workspace-panel brief-empty-state">
        <Eyebrow>Builder handoff</Eyebrow>
        <h2>Approve the redesign brief first</h2>
        <EmptyState
          detail="The Build Manifest is created only from an approved brief, so a future Codex builder receives a stable, human-reviewed strategy and source selection."
          icon={ClipboardCheck}
          title="Builder handoff locked"
        />
      </Card>
    );
  }

  if (!manifest || manifest.redesignBriefId !== brief.id) {
    return (
      <Card className="workspace-panel brief-empty-state">
        <Eyebrow>Builder handoff</Eyebrow>
        <h2>
          {manifest ? 'Prepare the brand-aware Build Manifest' : 'Prepare the Build Manifest'}
        </h2>
        <p className="muted-copy">
          This creates an immutable, private handoff for the future Codex builder. It includes the
          approved brief, selected research, permitted facts, approved asset guidance, open
          questions, and non-negotiable quality rules.
        </p>
        <Button disabled={isPreparing} onClick={() => void prepareManifest()} type="button">
          <Sparkles aria-hidden="true" size={16} />
          {isPreparing
            ? 'Preparing manifest'
            : manifest
              ? 'Prepare replacement manifest'
              : 'Prepare Build Manifest'}
        </Button>
        {message ? (
          <p className="form-message form-message--error" role="alert">
            {message}
          </p>
        ) : null}
      </Card>
    );
  }

  const data = manifest.data;
  const permittedFactCount = Array.isArray(data.permittedFacts) ? data.permittedFacts.length : 0;
  const selectedPageCount = Array.isArray(data.selectedPages) ? data.selectedPages.length : 0;
  const selectedAssetCount = Array.isArray(data.selectedAssets) ? data.selectedAssets.length : 0;
  const approvedAssetCount = Array.isArray(data.approvedAssetGuidance)
    ? data.approvedAssetGuidance.length
    : 0;
  const openQuestionCount = Array.isArray(data.openQuestions) ? data.openQuestions.length : 0;
  const uncertaintyCount = Array.isArray(data.uncertainties) ? data.uncertainties.length : 0;

  return (
    <Card className="workspace-panel brief-panel">
      <div className="brief-panel__header">
        <div>
          <Eyebrow>Builder handoff</Eyebrow>
          <h2>Build Manifest ready</h2>
          <p className="muted-copy">
            Versioned private input for the future Codex website builder. No website has been
            generated, published, or sent to the prospect.
          </p>
        </div>
        <StatusBadge tone="success">Ready for builder</StatusBadge>
      </div>

      <dl className="build-manifest-summary" aria-label="Build Manifest contents">
        <div>
          <dt>Permitted facts</dt>
          <dd>{permittedFactCount}</dd>
        </div>
        <div>
          <dt>Selected pages</dt>
          <dd>{selectedPageCount}</dd>
        </div>
        <div>
          <dt>Source assets</dt>
          <dd>{selectedAssetCount}</dd>
        </div>
        <div>
          <dt>Approved reuse assets</dt>
          <dd>{approvedAssetCount}</dd>
        </div>
      </dl>

      <details className="build-manifest-disclosure build-manifest-boundaries">
        <summary>
          <span className="build-manifest-disclosure__copy">
            <span className="build-manifest-disclosure__eyebrow">Boundaries</span>
            <span className="build-manifest-disclosure__title">What the builder may use</span>
          </span>
          <span className="build-manifest-disclosure__action">View safeguards</span>
        </summary>
        <ul>
          <li>Permitted facts remain tied to their original captured evidence.</li>
          <li>Selected pages and assets are research context, not visual instructions to copy.</li>
          <li>
            Only the {approvedAssetCount} human-approved asset guidance record
            {approvedAssetCount === 1 ? '' : 's'} authorise visual reuse.
          </li>
          <li>
            {openQuestionCount + uncertaintyCount} open question
            {openQuestionCount + uncertaintyCount === 1 ? '' : 's'} or uncertaint
            {openQuestionCount + uncertaintyCount === 1 ? 'y' : 'ies'} remain for human review.
          </li>
        </ul>
      </details>

      <details className="build-manifest-disclosure build-manifest-contract">
        <summary>
          <span className="build-manifest-disclosure__copy">
            <span className="build-manifest-disclosure__eyebrow">Builder contract</span>
            <span className="build-manifest-disclosure__title">Private preview rules</span>
          </span>
          <span className="build-manifest-disclosure__action">View contract</span>
        </summary>
        <div className="build-manifest-contract__content">
          <p>
            Contract {manifest.builderContractVersion}. The builder can generate a private preview
            when ready, but sharing still requires further approval.
          </p>
          <ul>
            {Array.isArray(data.builderRules)
              ? data.builderRules.map((rule) => <li key={rule}>{rule}</li>)
              : null}
          </ul>
        </div>
      </details>
      <BuilderRunPanel
        onCancelBuild={onCancelBuild}
        onOpenPreview={onOpenPreview}
        onRequestBuild={onRequestBuild}
        workspace={workspace}
      />
    </Card>
  );
}

function auditStatusLabel(status: Audit['status']) {
  if (status === 'research_pending') return 'Audit queued';
  if (status === 'running') return 'Audit running';
  if (status === 'ready') return 'Audit ready';
  if (status === 'failed') return 'Audit failed';
  if (status === 'cancelled') return 'Audit cancelled';
  return 'Not started';
}

function auditStatusTone(status: Audit['status']) {
  if (status === 'ready') return 'success' as const;
  if (status === 'failed') return 'danger' as const;
  if (status === 'cancelled') return 'warning' as const;
  if (status === 'research_pending' || status === 'running') return 'warning' as const;
  return 'neutral' as const;
}

function findingReviewLabel(state: AuditFinding['reviewState']) {
  if (state === 'approved') return 'Approved';
  if (state === 'blocked') return 'Blocked';
  return 'Needs review';
}

function findingReviewTone(state: AuditFinding['reviewState']) {
  if (state === 'approved') return 'success' as const;
  if (state === 'blocked') return 'danger' as const;
  return 'warning' as const;
}

function FindingEditor({
  finding,
  onUpdate,
}: {
  finding: AuditFinding;
  onUpdate: (
    finding: AuditFinding,
    patch: Pick<AuditFinding, 'title' | 'finding' | 'recommendation' | 'severity' | 'reviewState'>,
  ) => Promise<void>;
}) {
  const [draft, setDraft] = useState({
    title: finding.title,
    finding: finding.finding,
    recommendation: finding.recommendation,
    severity: finding.severity,
    reviewState: finding.reviewState || 'needs_review',
  });
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState('');

  async function save(patch = draft) {
    setIsSaving(true);
    setMessage('');
    try {
      await onUpdate(finding, patch);
      setMessage('Finding saved.');
    } catch {
      setMessage('The finding could not be saved. Try again.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <article className="audit-finding">
      <div className="audit-finding__header">
        <div>
          <Eyebrow>{finding.area}</Eyebrow>
          <h4>{finding.title}</h4>
        </div>
        <div className="audit-finding__badges">
          <StatusBadge tone={finding.severity === 'high' ? 'danger' : 'warning'}>
            {finding.severity}
          </StatusBadge>
          <StatusBadge tone={findingReviewTone(finding.reviewState || 'needs_review')}>
            {findingReviewLabel(finding.reviewState || 'needs_review')}
          </StatusBadge>
        </div>
      </div>
      <p>{finding.finding}</p>
      <div className="audit-finding__recommendation">
        <strong>Recommended change</strong>
        <p>{finding.recommendation}</p>
      </div>
      {finding.sourceUrls.length ? (
        <div className="audit-finding__sources">
          <strong>Captured sources</strong>
          {finding.sourceUrls.map((url) => (
            <a href={url} key={url} rel="noreferrer" target="_blank">
              {new URL(url).pathname || '/'}
            </a>
          ))}
        </div>
      ) : null}
      <div className="audit-finding__actions">
        <Button
          disabled={isSaving || finding.reviewState === 'approved'}
          onClick={() => void save({ ...draft, reviewState: 'approved' })}
          type="button"
          variant="secondary"
        >
          <Check aria-hidden="true" size={16} />
          Approve finding
        </Button>
        <Button
          disabled={isSaving || finding.reviewState === 'blocked'}
          onClick={() => void save({ ...draft, reviewState: 'blocked' })}
          type="button"
          variant="quiet"
        >
          <Ban aria-hidden="true" size={16} />
          Block finding
        </Button>
      </div>
      <details className="audit-finding__edit">
        <summary>Edit finding</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label>
            Title
            <input
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              required
              value={draft.title}
            />
          </label>
          <label>
            Severity
            <select
              onChange={(event) =>
                setDraft({
                  ...draft,
                  severity: event.target.value as AuditFinding['severity'],
                })
              }
              value={draft.severity}
            >
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
          <label>
            Finding
            <textarea
              onChange={(event) => setDraft({ ...draft, finding: event.target.value })}
              required
              value={draft.finding}
            />
          </label>
          <label>
            Recommended change
            <textarea
              onChange={(event) => setDraft({ ...draft, recommendation: event.target.value })}
              required
              value={draft.recommendation}
            />
          </label>
          <label>
            Review state
            <select
              onChange={(event) =>
                setDraft({
                  ...draft,
                  reviewState: event.target.value as AuditFinding['reviewState'],
                })
              }
              value={draft.reviewState}
            >
              <option value="needs_review">Needs review</option>
              <option value="approved">Approved</option>
              <option value="blocked">Blocked</option>
            </select>
          </label>
          <Button disabled={isSaving} type="submit">
            <Save aria-hidden="true" size={16} />
            {isSaving ? 'Saving changes' : 'Save changes'}
          </Button>
        </form>
      </details>
      {message ? (
        <p className="audit-finding__message" role="status">
          {message}
        </p>
      ) : null}
    </article>
  );
}

function AuditPanel({
  workspace,
  onRequestAudit,
  onCancelAudit,
  onApproveAllFindings,
  onUpdateFinding,
}: {
  workspace: ProspectWorkspace;
  onRequestAudit: () => Promise<void>;
  onCancelAudit: () => Promise<void>;
  onApproveAllFindings: () => Promise<void>;
  onUpdateFinding: (
    finding: AuditFinding,
    patch: Pick<AuditFinding, 'title' | 'finding' | 'recommendation' | 'severity' | 'reviewState'>,
  ) => Promise<void>;
}) {
  const [isRequesting, setIsRequesting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isApprovingAll, setIsApprovingAll] = useState(false);
  const [message, setMessage] = useState('');
  const audit = workspace.audit;
  const captureReady = workspace.latestCapture?.status === 'ready';
  const isActive =
    Boolean(audit?.crawlRunId) &&
    (audit?.status === 'research_pending' || audit?.status === 'running');
  const displayedStatus =
    isActive ||
    audit?.status === 'ready' ||
    audit?.status === 'failed' ||
    audit?.status === 'cancelled'
      ? (audit?.status ?? 'not_started')
      : 'not_started';
  const findings = audit?.findings ?? [];
  const approvedCount = findings.filter((finding) => finding.reviewState === 'approved').length;
  const pendingFindings = findings.filter((finding) => finding.reviewState === 'needs_review');

  async function requestAudit() {
    setIsRequesting(true);
    setMessage('');
    try {
      await onRequestAudit();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'The audit could not be queued. Confirm that the website capture is complete.',
      );
    } finally {
      setIsRequesting(false);
    }
  }

  async function cancelAudit() {
    setIsCancelling(true);
    setMessage('');
    try {
      await onCancelAudit();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The audit could not be cancelled.');
    } finally {
      setIsCancelling(false);
    }
  }

  async function approveAllFindings() {
    setIsApprovingAll(true);
    setMessage('');
    try {
      await onApproveAllFindings();
      setMessage(`${pendingFindings.length} findings approved.`);
    } catch {
      setMessage('The findings could not all be approved. Try again.');
    } finally {
      setIsApprovingAll(false);
    }
  }

  return (
    <>
      <div className="audit-panel__header">
        <div>
          <Eyebrow>Website audit</Eyebrow>
          <h2>Evidence-led audit</h2>
          <p className="muted-copy">
            The private worker analyses the latest saved capture. Findings stay internal and need
            your judgment before they guide a redesign or a client-facing report.
          </p>
        </div>
        <div className="audit-panel__actions">
          <StatusBadge tone={auditStatusTone(displayedStatus)}>
            {auditStatusLabel(displayedStatus)}
          </StatusBadge>
          <Button
            disabled={!captureReady || isActive || isRequesting}
            onClick={() => void requestAudit()}
            type="button"
          >
            <ClipboardCheck aria-hidden="true" size={16} />
            {isRequesting
              ? 'Queueing audit'
              : isActive
                ? audit?.status === 'running'
                  ? 'Audit running'
                  : 'Audit queued'
                : displayedStatus === 'ready'
                  ? 'Generate audit again'
                  : 'Generate audit'}
          </Button>
          {isActive ? (
            <Button
              disabled={isCancelling || Boolean(audit?.cancelRequestedAt)}
              onClick={() => void cancelAudit()}
              type="button"
              variant="secondary"
            >
              <Ban aria-hidden="true" size={16} />
              {isCancelling || audit?.cancelRequestedAt ? 'Stopping audit' : 'Cancel audit'}
            </Button>
          ) : null}
        </div>
      </div>
      {!captureReady ? (
        <EmptyState
          detail="Complete a website capture before generating an evidence-led audit."
          icon={ClipboardCheck}
          title="Capture required"
        />
      ) : null}
      {isActive ? (
        <div className="capture-progress capture-progress--running">
          <div
            aria-label="Website audit progress"
            aria-valuetext={
              audit?.progressDetail || 'Reading private capture evidence and preparing findings.'
            }
            className="capture-progress__track"
            role="progressbar"
          >
            <span className="capture-progress__bar" />
          </div>
          <span>
            {audit?.progressDetail || 'Reading private capture evidence and preparing findings.'}
            {audit?.totalItems
              ? ` ${audit.completedItems} of ${audit.totalItems} items complete.`
              : ''}
          </span>
        </div>
      ) : null}
      {displayedStatus === 'failed' ? (
        <p className="form-message form-message--error" role="alert">
          The audit could not complete. Confirm the saved capture is available, then generate it
          again.
        </p>
      ) : null}
      {isActive || displayedStatus === 'ready' || displayedStatus === 'cancelled' ? (
        <>
          <dl className="audit-panel__metrics">
            <div>
              <dt>Findings generated</dt>
              <dd>{findings.length}</dd>
            </div>
            <div>
              <dt>Approved findings</dt>
              <dd>{approvedCount}</dd>
            </div>
            <div>
              <dt>Source capture</dt>
              <dd>{workspace.latestCapture?.capturedPageCount ?? 0} pages</dd>
            </div>
          </dl>
          {findings.length ? (
            <section aria-labelledby="audit-findings-title" className="audit-findings">
              <div className="audit-findings__heading">
                <div>
                  <Eyebrow>Generated findings</Eyebrow>
                  <h3 id="audit-findings-title">Review before redesign</h3>
                </div>
                {pendingFindings.length ? (
                  <Button
                    disabled={isApprovingAll}
                    onClick={() => void approveAllFindings()}
                    title="Approves every finding still awaiting review. Blocked findings are unchanged."
                    type="button"
                    variant="secondary"
                  >
                    <CheckCheck aria-hidden="true" size={16} />
                    {isApprovingAll
                      ? 'Approving findings'
                      : `Approve all findings (${pendingFindings.length})`}
                  </Button>
                ) : null}
              </div>
              {findings.map((finding) => (
                <FindingEditor finding={finding} key={finding.id} onUpdate={onUpdateFinding} />
              ))}
            </section>
          ) : (
            <EmptyState
              detail="The current automated checks did not produce findings. This does not replace a visual or manual review."
              icon={SearchCheck}
              title="No automated findings"
            />
          )}
        </>
      ) : null}
      {message ? (
        <p className="form-message form-message--error" role="alert">
          {message}
        </p>
      ) : null}
    </>
  );
}

function WorkspaceContent({
  tab,
  workspace,
  toggleTask,
  requestResearchCapture,
  requestAssetRefresh,
  continueResearchCapture,
  cancelResearchCapture,
  requestWebsiteAudit,
  cancelWebsiteAudit,
  requestAssetAnalysis,
  cancelAssetAnalysis,
  setAssetAnalysisSelected,
  updateAssetAnnotation,
  saveBrandKit,
  createBrandAwareBriefRevision,
  createRedesignBrief,
  refreshRedesignBriefArchitecture,
  updateRedesignBrief,
  approveRedesignBrief,
  createBuildManifest,
  requestWebsiteBuild,
  cancelWebsiteBuild,
  createBuilderPreviewUrl,
  approveAllAuditFindings,
  updateAuditFinding,
}: {
  tab: WorkspaceTab;
  workspace: ProspectWorkspace;
  toggleTask: (task: Task) => Promise<void>;
  requestResearchCapture: () => Promise<void>;
  requestAssetRefresh: () => Promise<void>;
  continueResearchCapture: () => Promise<void>;
  cancelResearchCapture: () => Promise<void>;
  requestWebsiteAudit: () => Promise<void>;
  cancelWebsiteAudit: () => Promise<void>;
  requestAssetAnalysis: () => Promise<void>;
  cancelAssetAnalysis: () => Promise<void>;
  setAssetAnalysisSelected: (asset: ResearchArtifact, selected: boolean) => Promise<void>;
  updateAssetAnnotation: (
    annotation: AssetAnnotation,
    patch: Pick<
      AssetAnnotation,
      'suggestedRole' | 'businessAssociation' | 'reviewState' | 'humanNotes'
    >,
  ) => Promise<void>;
  saveBrandKit: (
    draft: Pick<BrandKit, 'primaryLogoAssetId' | 'approvedAssetIds' | 'palette' | 'notes'>,
    approve?: boolean,
    silent?: boolean,
  ) => Promise<void>;
  createBrandAwareBriefRevision: () => Promise<void>;
  createRedesignBrief: () => Promise<void>;
  refreshRedesignBriefArchitecture: (brief: RedesignBrief) => Promise<void>;
  updateRedesignBrief: (
    brief: RedesignBrief,
    patch: Pick<RedesignBrief, 'sourceSelections' | 'draft'>,
  ) => Promise<void>;
  approveRedesignBrief: (brief: RedesignBrief) => Promise<void>;
  createBuildManifest: () => Promise<void>;
  requestWebsiteBuild: () => Promise<void>;
  cancelWebsiteBuild: () => Promise<void>;
  createBuilderPreviewUrl: (builderRunId: string, mode?: BuilderPreviewMode) => Promise<string>;
  approveAllAuditFindings: () => Promise<void>;
  updateAuditFinding: (
    finding: AuditFinding,
    patch: Pick<AuditFinding, 'title' | 'finding' | 'recommendation' | 'severity' | 'reviewState'>,
  ) => Promise<void>;
}) {
  if (tab === 'overview') {
    return (
      <div className="workspace-content-grid">
        <Card>
          <Eyebrow>Current state</Eyebrow>
          <h2>Research first, then decisions</h2>
          <p className="muted-copy">
            This workspace holds the business, website, evidence, audit, redesign and report as
            separate, versionable records.
          </p>
          <dl className="detail-list">
            <div>
              <dt>Website</dt>
              <dd>{workspace.website?.domain ?? 'Not recorded'}</dd>
            </div>
            <div>
              <dt>Research</dt>
              <dd>{captureLabel(workspace.latestCapture?.status)}</dd>
            </div>
            <div>
              <dt>Evidence facts</dt>
              <dd>{workspace.facts.length}</dd>
            </div>
          </dl>
        </Card>
        <Card>
          <Eyebrow>Tasks</Eyebrow>
          <h2>Next internal actions</h2>
          <TaskList onToggle={toggleTask} tasks={workspace.tasks} />
        </Card>
      </div>
    );
  }

  if (tab === 'research') {
    const isCaptureActive = captureIsActive(workspace.latestCapture);
    const captureFailed =
      workspace.latestCapture?.status === 'failed' ||
      workspace.latestCapture?.status === 'cancelled';
    return (
      <Card className="workspace-panel">
        <Eyebrow>Website research</Eyebrow>
        <h2>Captured website dossier</h2>
        <p className="muted-copy">
          Direct observations are saved with their page and capture time. Only uncertain information
          and decisions that leave this workspace need human approval.
        </p>
        <ResearchCapturePanel
          onCancelCapture={cancelResearchCapture}
          onContinueCapture={continueResearchCapture}
          onRequestCapture={requestResearchCapture}
          onRequestAssetRefresh={requestAssetRefresh}
          workspace={workspace}
        />
        <PageInventory
          assets={workspace.artifacts.filter((artifact) => artifact.kind === 'asset')}
          pages={workspace.capturedPages}
        />
        {workspace.artifacts.length ? <CaptureArtifacts artifacts={workspace.artifacts} /> : null}
        {workspace.facts.length ? (
          <section aria-labelledby="captured-facts-title" className="research-section">
            <div>
              <Eyebrow>Website facts</Eyebrow>
              <h3 id="captured-facts-title">Captured directly from the site</h3>
              <p className="muted-copy">
                Titles, headings, metadata, and public contact details tied to their original page.
              </p>
            </div>
            <EvidenceFactList facts={workspace.facts} pages={workspace.capturedPages} />
          </section>
        ) : isCaptureActive ? (
          <EvidenceLoadingState />
        ) : (
          <EmptyState
            detail={
              captureFailed
                ? 'This capture did not complete, so no current evidence is available.'
                : 'No website facts were found in this capture.'
            }
            icon={SearchCheck}
            title={captureFailed ? 'Current capture unavailable' : 'No website facts captured'}
          />
        )}
        {isCaptureActive && workspace.artifacts.length ? <EvidenceLoadingState /> : null}
        {captureFailed && workspace.previousCapture ? (
          <section aria-labelledby="previous-capture-title" className="previous-capture">
            <Eyebrow>Previous capture</Eyebrow>
            <h3 id="previous-capture-title">Last successful evidence</h3>
            <p className="muted-copy">
              Captured{' '}
              {formatDateTime(
                workspace.previousCapture.completedAt ?? workspace.previousCapture.requestedAt,
              )}
              . This evidence is retained for reference and is not part of the failed refresh.
            </p>
            {workspace.previousFacts.length ? (
              <EvidenceFactList facts={workspace.previousFacts} />
            ) : null}
            <CaptureArtifacts
              artifacts={workspace.previousArtifacts}
              eyebrow="Previous files"
              title="Previous screenshots and source files"
              titleId="previous-capture-evidence-title"
            />
          </section>
        ) : null}
      </Card>
    );
  }

  if (tab === 'packet') {
    return <ResearchPacketPanel workspace={workspace} />;
  }

  if (tab === 'assets') {
    return (
      <div className="workspace-content-stack">
        <AssetReviewPanel
          onCancelAnalysis={cancelAssetAnalysis}
          onRequestAnalysis={requestAssetAnalysis}
          onSetAssetAnalysisSelected={setAssetAnalysisSelected}
          onUpdateAnnotation={updateAssetAnnotation}
          workspace={workspace}
        />
        <BrandKitPanel
          onCreateRevision={createBrandAwareBriefRevision}
          onSave={saveBrandKit}
          workspace={workspace}
        />
      </div>
    );
  }

  if (tab === 'brief') {
    return (
      <BriefPanel
        onApprove={approveRedesignBrief}
        onCreate={createRedesignBrief}
        onRefreshArchitecture={refreshRedesignBriefArchitecture}
        onUpdate={updateRedesignBrief}
        workspace={workspace}
      />
    );
  }

  if (tab === 'audit') {
    return (
      <Card className="workspace-panel">
        <AuditPanel
          onCancelAudit={cancelWebsiteAudit}
          onApproveAllFindings={approveAllAuditFindings}
          onRequestAudit={requestWebsiteAudit}
          onUpdateFinding={updateAuditFinding}
          workspace={workspace}
        />
      </Card>
    );
  }

  if (tab === 'redesign') {
    return (
      <div className="workspace-content-stack">
        <section className="builder-settings-entry" aria-labelledby="builder-settings-entry-title">
          <div>
            <Eyebrow>Website builder</Eyebrow>
            <h2 id="builder-settings-entry-title">Builder settings</h2>
            <p className="muted-copy">
              Review the protected Codex runtime before requesting a private preview.
            </p>
          </div>
          <BuilderSettingsControl />
        </section>
        <BuildManifestPanel
          onCancelBuild={cancelWebsiteBuild}
          onCreate={createBuildManifest}
          onOpenPreview={createBuilderPreviewUrl}
          onRequestBuild={requestWebsiteBuild}
          workspace={workspace}
        />
      </div>
    );
  }

  if (tab === 'report') {
    return (
      <Card className="workspace-panel">
        <Eyebrow>Decision report</Eyebrow>
        <h2>Nothing client-facing has been produced</h2>
        <p className="muted-copy">{workspace.report?.summary}</p>
        <EmptyState
          detail="A report will be generated only from reviewed findings and an approved redesign concept."
          icon={FileText}
          title="Report not started"
        />
      </Card>
    );
  }

  return (
    <Card className="workspace-panel">
      <Eyebrow>Timeline</Eyebrow>
      <h2>Record activity</h2>
      <div className="activity-list">
        {workspace.activity.slice(0, 6).map((activity) => (
          <article className="activity-row" key={activity.id}>
            <span>
              <strong>{activity.message}</strong>
              <small>{activity.type.replaceAll('_', ' ')}</small>
            </span>
            <time dateTime={activity.createdAt}>{formatDateTime(activity.createdAt)}</time>
          </article>
        ))}
      </div>
      {workspace.activity.length > 6 ? (
        <ListOverflow label="activity entries" remainingCount={workspace.activity.length - 6}>
          <div className="activity-list">
            {workspace.activity.slice(6).map((activity) => (
              <article className="activity-row" key={activity.id}>
                <span>
                  <strong>{activity.message}</strong>
                  <small>{activity.type.replaceAll('_', ' ')}</small>
                </span>
                <time dateTime={activity.createdAt}>{formatDateTime(activity.createdAt)}</time>
              </article>
            ))}
          </div>
        </ListOverflow>
      ) : null}
    </Card>
  );
}

function WorkspacePage({
  workspace,
  onBack,
  onApprove,
  onDelete,
  onToggleTask,
  onRequestResearchCapture,
  onRequestAssetRefresh,
  onContinueResearchCapture,
  onCancelResearchCapture,
  onRequestWebsiteAudit,
  onCancelWebsiteAudit,
  onRequestAssetAnalysis,
  onCancelAssetAnalysis,
  onSetAssetAnalysisSelected,
  onUpdateAssetAnnotation,
  onSaveBrandKit,
  onCreateBrandAwareBriefRevision,
  onCreateRedesignBrief,
  onRefreshRedesignBriefArchitecture,
  onUpdateRedesignBrief,
  onApproveRedesignBrief,
  onCreateBuildManifest,
  onRequestWebsiteBuild,
  onCancelWebsiteBuild,
  onCreateBuilderPreviewUrl,
  onApproveAllAuditFindings,
  onUpdateAuditFinding,
  tab,
  onTabChange,
}: {
  workspace: ProspectWorkspace;
  onBack: () => void;
  onApprove: () => void;
  onDelete: () => Promise<void>;
  onToggleTask: (task: Task) => Promise<void>;
  onRequestResearchCapture: () => Promise<void>;
  onRequestAssetRefresh: () => Promise<void>;
  onContinueResearchCapture: () => Promise<void>;
  onCancelResearchCapture: () => Promise<void>;
  onRequestWebsiteAudit: () => Promise<void>;
  onCancelWebsiteAudit: () => Promise<void>;
  onRequestAssetAnalysis: () => Promise<void>;
  onCancelAssetAnalysis: () => Promise<void>;
  onSetAssetAnalysisSelected: (asset: ResearchArtifact, selected: boolean) => Promise<void>;
  onUpdateAssetAnnotation: (
    annotation: AssetAnnotation,
    patch: Pick<
      AssetAnnotation,
      'suggestedRole' | 'businessAssociation' | 'reviewState' | 'humanNotes'
    >,
  ) => Promise<void>;
  onSaveBrandKit: (
    draft: Pick<BrandKit, 'primaryLogoAssetId' | 'approvedAssetIds' | 'palette' | 'notes'>,
    approve?: boolean,
    silent?: boolean,
  ) => Promise<void>;
  onCreateBrandAwareBriefRevision: () => Promise<void>;
  onCreateRedesignBrief: () => Promise<void>;
  onRefreshRedesignBriefArchitecture: (brief: RedesignBrief) => Promise<void>;
  onUpdateRedesignBrief: (
    brief: RedesignBrief,
    patch: Pick<RedesignBrief, 'sourceSelections' | 'draft'>,
  ) => Promise<void>;
  onApproveRedesignBrief: (brief: RedesignBrief) => Promise<void>;
  onCreateBuildManifest: () => Promise<void>;
  onRequestWebsiteBuild: () => Promise<void>;
  onCancelWebsiteBuild: () => Promise<void>;
  onCreateBuilderPreviewUrl: (builderRunId: string) => Promise<string>;
  onApproveAllAuditFindings: () => Promise<void>;
  onUpdateAuditFinding: (
    finding: AuditFinding,
    patch: Pick<AuditFinding, 'title' | 'finding' | 'recommendation' | 'severity' | 'reviewState'>,
  ) => Promise<void>;
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  function handleSettingsOpenChange(open: boolean) {
    setSettingsOpen(open);
    if (!open) window.requestAnimationFrame(() => settingsButtonRef.current?.focus());
  }

  return (
    <>
      <WorkspaceHeader
        onApprove={onApprove}
        onBack={onBack}
        onOpenSettings={() => setSettingsOpen(true)}
        settingsButtonRef={settingsButtonRef}
        workspace={workspace}
      />
      <div aria-label="Prospect workspace sections" className="workspace-tabs" role="tablist">
        {workspaceTabs.map((item) => (
          <button
            aria-controls={`workspace-${item.id}`}
            aria-selected={tab === item.id}
            className={
              tab === item.id
                ? 'workspace-tabs__tab workspace-tabs__tab--active'
                : 'workspace-tabs__tab'
            }
            id={`workspace-tab-${item.id}`}
            key={item.id}
            onClick={() => onTabChange(item.id)}
            role="tab"
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
      <section
        aria-labelledby={`workspace-tab-${tab}`}
        className="workspace-tab-panel"
        id={`workspace-${tab}`}
        key={tab}
        role="tabpanel"
      >
        <WorkspaceContent
          approveAllAuditFindings={onApproveAllAuditFindings}
          approveRedesignBrief={onApproveRedesignBrief}
          createRedesignBrief={onCreateRedesignBrief}
          refreshRedesignBriefArchitecture={onRefreshRedesignBriefArchitecture}
          createBuildManifest={onCreateBuildManifest}
          requestWebsiteBuild={onRequestWebsiteBuild}
          cancelWebsiteBuild={onCancelWebsiteBuild}
          createBuilderPreviewUrl={onCreateBuilderPreviewUrl}
          requestAssetAnalysis={onRequestAssetAnalysis}
          cancelAssetAnalysis={onCancelAssetAnalysis}
          setAssetAnalysisSelected={onSetAssetAnalysisSelected}
          cancelResearchCapture={onCancelResearchCapture}
          continueResearchCapture={onContinueResearchCapture}
          requestResearchCapture={onRequestResearchCapture}
          requestAssetRefresh={onRequestAssetRefresh}
          requestWebsiteAudit={onRequestWebsiteAudit}
          cancelWebsiteAudit={onCancelWebsiteAudit}
          tab={tab}
          toggleTask={onToggleTask}
          updateAuditFinding={onUpdateAuditFinding}
          updateAssetAnnotation={onUpdateAssetAnnotation}
          saveBrandKit={onSaveBrandKit}
          createBrandAwareBriefRevision={onCreateBrandAwareBriefRevision}
          updateRedesignBrief={onUpdateRedesignBrief}
          workspace={workspace}
        />
      </section>
      <WorkspaceSettingsDialog
        onDelete={onDelete}
        onOpenChange={handleSettingsOpenChange}
        open={settingsOpen}
        workspace={workspace}
      />
    </>
  );
}

function WorkspaceApp({
  repository,
  userEmail,
  onSignOut,
}: {
  repository: WorkspaceRepository;
  userEmail?: string;
  onSignOut?: () => Promise<void>;
}) {
  const [route, setRoute] = useState<Route>(initialRoute);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [workspaces, setWorkspaces] = useState<ProspectWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingPresentation, setLoadingPresentation] = useState(true);
  const [storageError, setStorageError] = useState('');
  const [notice, setNotice] = useState<ToastNotice>();
  const dataFingerprintRef = useRef('');
  const lastBackgroundRefreshAtRef = useRef(0);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(undefined), 10000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const refreshData = useCallback(
    async ({ announce = false }: { announce?: boolean } = {}) => {
      const [nextBusinesses, nextWorkspaces] = await Promise.all([
        repository.listBusinesses(),
        repository.listWorkspaces(),
      ]);
      const nextFingerprint = JSON.stringify({
        businesses: nextBusinesses.map((business) => [business.id, business.updatedAt]),
        captures: nextWorkspaces.map((workspace) => [
          workspace.business.id,
          workspace.latestCapture?.id,
          workspace.latestCapture?.status,
          workspace.latestCapture?.completedAt,
          workspace.latestCapture?.progressPhase,
          workspace.latestCapture?.progressDetail,
          workspace.latestCapture?.currentUrl,
          workspace.latestCapture?.cancelRequestedAt,
          workspace.artifacts.length,
          workspace.facts.length,
          workspace.audit?.id,
          workspace.audit?.status,
          workspace.audit?.updatedAt,
          workspace.audit?.findings.length,
          workspace.audit?.progressPhase,
          workspace.audit?.progressDetail,
          workspace.audit?.completedItems,
          workspace.audit?.cancelRequestedAt,
          workspace.latestBuilderRun?.id,
          workspace.latestBuilderRun?.status,
          workspace.latestBuilderRun?.updatedAt,
          workspace.latestBuilderRun?.progressPhase,
          workspace.latestBuilderRun?.progressDetail,
          workspace.latestBuilderRun?.completedItems,
          workspace.builderArtifacts.length,
          workspace.builderEvents.length,
        ]),
      });
      const changed = Boolean(
        dataFingerprintRef.current && dataFingerprintRef.current !== nextFingerprint,
      );
      dataFingerprintRef.current = nextFingerprint;
      setBusinesses(nextBusinesses);
      setWorkspaces(nextWorkspaces);
      if (announce && changed) {
        setNotice({
          id: crypto.randomUUID(),
          title: 'Workspace updated',
          detail: 'New saved data is now visible in your current view.',
          tone: 'info',
        });
      }
      return changed;
    },
    [repository],
  );

  useEffect(() => {
    function updateRoute() {
      const hash = window.location.hash || '#/today';
      persistRouteHash(hash);
      setRoute(routeFromHash(hash));
    }
    window.addEventListener('hashchange', updateRoute);
    return () => window.removeEventListener('hashchange', updateRoute);
  }, []);

  useEffect(() => {
    let active = true;
    async function initialise() {
      try {
        await repository.bootstrap();
        const [nextBusinesses, nextWorkspaces] = await Promise.all([
          repository.listBusinesses(),
          repository.listWorkspaces(),
        ]);
        if (!active) return;
        setBusinesses(nextBusinesses);
        setWorkspaces(nextWorkspaces);
        dataFingerprintRef.current = JSON.stringify({
          businesses: nextBusinesses.map((business) => [business.id, business.updatedAt]),
          captures: nextWorkspaces.map((workspace) => [
            workspace.business.id,
            workspace.latestCapture?.id,
            workspace.latestCapture?.status,
            workspace.latestCapture?.completedAt,
            workspace.latestCapture?.progressPhase,
            workspace.latestCapture?.progressDetail,
            workspace.latestCapture?.currentUrl,
            workspace.latestCapture?.cancelRequestedAt,
            workspace.artifacts.length,
            workspace.facts.length,
            workspace.audit?.id,
            workspace.audit?.status,
            workspace.audit?.updatedAt,
            workspace.audit?.findings.length,
            workspace.audit?.progressPhase,
            workspace.audit?.progressDetail,
            workspace.audit?.completedItems,
            workspace.audit?.cancelRequestedAt,
            workspace.assetAnalysis?.id,
            workspace.assetAnalysis?.status,
            workspace.assetAnalysis?.updatedAt,
            workspace.assetAnalysis?.progressPhase,
            workspace.assetAnalysis?.progressDetail,
            workspace.assetAnalysis?.completedItems,
            workspace.assetAnalysis?.cancelRequestedAt,
            workspace.assetAnnotations.length,
            workspace.latestBuilderRun?.id,
            workspace.latestBuilderRun?.status,
            workspace.latestBuilderRun?.updatedAt,
            workspace.latestBuilderRun?.progressPhase,
            workspace.latestBuilderRun?.progressDetail,
            workspace.latestBuilderRun?.completedItems,
            workspace.builderArtifacts.length,
            workspace.builderEvents.length,
          ]),
        });
      } catch (error) {
        console.error('SiteForge workspace load failed.', error);
        if (active)
          setStorageError(
            'SiteForge could not load workspace data. Check your connection and organization access, then try again.',
          );
      } finally {
        if (active) setLoading(false);
      }
    }
    void initialise();
    return () => {
      active = false;
    };
  }, [repository]);

  useEffect(() => {
    if (loading) return;
    function refreshInBackground() {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastBackgroundRefreshAtRef.current < 20_000) return;
      lastBackgroundRefreshAtRef.current = now;
      void refreshData({ announce: true }).catch(() => undefined);
    }
    window.addEventListener('focus', refreshInBackground);
    document.addEventListener('visibilitychange', refreshInBackground);
    return () => {
      window.removeEventListener('focus', refreshInBackground);
      document.removeEventListener('visibilitychange', refreshInBackground);
    };
  }, [loading, refreshData]);

  const workspace =
    route.page === 'prospects' && route.businessId
      ? workspaces.find((candidate) => candidate.business.id === route.businessId)
      : undefined;

  const activeCapture = captureIsActive(workspace?.latestCapture);
  const activeAudit =
    Boolean(workspace?.audit?.crawlRunId) &&
    (workspace?.audit?.status === 'research_pending' || workspace?.audit?.status === 'running');
  const activeAssetAnalysis =
    workspace?.assetAnalysis?.status === 'queued' || workspace?.assetAnalysis?.status === 'running';
  const activeAssetRefresh =
    workspace?.assetRefresh?.status === 'queued' || workspace?.assetRefresh?.status === 'running';
  const activeBuilder =
    workspace?.latestBuilderRun?.status === 'queued' ||
    workspace?.latestBuilderRun?.status === 'running' ||
    workspace?.latestBuilderRun?.status === 'paused';
  const awaitingPreferredLogo =
    Boolean(workspace?.website) &&
    !workspace?.artifacts.some(
      (artifact) =>
        artifact.kind === 'asset' && artifact.metadata.preferredOrganisationLogo === true,
    );

  useEffect(() => {
    if (
      !activeCapture &&
      !activeAudit &&
      !activeAssetAnalysis &&
      !activeAssetRefresh &&
      !activeBuilder &&
      !awaitingPreferredLogo
    )
      return;
    const interval = window.setInterval(() => {
      void refreshData();
    }, 3_000);
    return () => window.clearInterval(interval);
  }, [
    activeAssetAnalysis,
    activeAssetRefresh,
    activeAudit,
    activeBuilder,
    activeCapture,
    awaitingPreferredLogo,
    refreshData,
    workspace?.assetAnalysis?.id,
    workspace?.assetRefresh?.id,
    workspace?.audit?.id,
    workspace?.latestBuilderRun?.id,
    workspace?.latestCapture?.id,
  ]);

  function navigate(nextRoute: Route) {
    const nextHref = hrefForRoute(nextRoute);
    persistRouteHash(nextHref);
    if (window.location.hash === nextHref) setRoute(nextRoute);
    else window.location.hash = nextHref;
  }

  function openWorkspace(businessId: string) {
    navigate({ page: 'prospects', businessId });
  }

  async function handleWorkspaceCreated(nextWorkspace: ProspectWorkspace) {
    await refreshData();
    setNotice({
      id: crypto.randomUUID(),
      title: 'Prospect created',
      detail: 'The workspace is ready for research review.',
      tone: 'success',
      action: {
        label: 'View prospect',
        onClick: () => openWorkspace(nextWorkspace.business.id),
      },
    });
  }

  async function toggleTask(task: Task) {
    await repository.setTaskState(task, task.state === 'done' ? 'open' : 'done');
    await refreshData();
  }

  async function requestResearchCapture() {
    if (!workspace) return;
    const capture = await repository.requestResearchCapture(workspace.business.id);
    if (!capture) throw new Error('The website capture could not be queued.');
    await refreshData();
    setNotice({
      id: crypto.randomUUID(),
      title: 'Website capture queued',
      detail:
        'The private worker will discover and save public-site evidence here when the capture completes.',
      tone: 'warning',
    });
  }

  async function requestAssetRefresh() {
    if (!workspace) return;
    const job = await repository.requestAssetRefresh(workspace.business.id);
    if (!job) throw new Error('The image-only refresh could not be queued.');
    await refreshData();
    setNotice({
      id: crypto.randomUUID(),
      title: 'Image refresh queued',
      detail: 'Only new image assets will be added to this capture.',
      tone: 'warning',
    });
  }

  async function cancelResearchCapture() {
    if (!workspace) return;
    await repository.cancelResearchCapture(workspace.business.id);
    await refreshData();
    setNotice({
      id: crypto.randomUUID(),
      title: 'Capture cancellation requested',
      detail: 'The worker will stop after its current safe step. Saved evidence remains private.',
      tone: 'warning',
    });
  }

  async function continueResearchCapture() {
    if (!workspace) return;
    const capture = await repository.continueResearchCapture(workspace.business.id);
    if (!capture) throw new Error('The website capture could not be continued.');
    await refreshData();
    setNotice({
      id: crypto.randomUUID(),
      title: 'Website capture continuing',
      detail: 'The worker will retry the incomplete step and preserve evidence already saved.',
      tone: 'warning',
    });
  }

  async function requestWebsiteAudit() {
    if (!workspace) return;
    const audit = await repository.requestWebsiteAudit(workspace.business.id);
    if (!audit) throw new Error('The website audit could not be queued.');
    await refreshData();
    setNotice({
      id: crypto.randomUUID(),
      title: 'Website audit queued',
      detail:
        'The private worker will analyse the latest completed capture and save editable findings.',
      tone: 'warning',
    });
  }

  async function cancelWebsiteAudit() {
    if (!workspace) return;
    await repository.cancelWebsiteAudit(workspace.business.id);
    await refreshData();
    setNotice({
      id: crypto.randomUUID(),
      title: 'Audit cancellation requested',
      detail: 'The worker will stop after its current safe step. Saved findings remain private.',
      tone: 'warning',
    });
  }

  async function updateAuditFinding(
    finding: AuditFinding,
    patch: Pick<AuditFinding, 'title' | 'finding' | 'recommendation' | 'severity' | 'reviewState'>,
  ) {
    await repository.updateAuditFinding(finding, patch);
    await refreshData();
  }

  async function requestAssetAnalysis() {
    if (!workspace) return;
    const job = await repository.requestAssetAnalysis(workspace.business.id);
    if (!job) throw new Error('The visual-asset analysis could not be queued.');
    await refreshData();
    setNotice({
      id: crypto.randomUUID(),
      title: 'Asset analysis queued',
      detail: 'The private worker will save editable visual descriptions for human review.',
      tone: 'warning',
    });
  }

  async function cancelAssetAnalysis() {
    if (!workspace) return;
    await repository.cancelAssetAnalysis(workspace.business.id);
    await refreshData();
    setNotice({
      id: crypto.randomUUID(),
      title: 'Asset analysis cancellation requested',
      detail: 'The worker will stop after its current image. Saved suggestions remain private.',
      tone: 'warning',
    });
  }

  async function setAssetAnalysisSelected(asset: ResearchArtifact, selected: boolean) {
    await repository.setAssetAnalysisSelected(asset, selected);
    void refreshData();
  }

  async function updateAssetAnnotation(
    annotation: AssetAnnotation,
    patch: Pick<
      AssetAnnotation,
      'suggestedRole' | 'businessAssociation' | 'reviewState' | 'humanNotes'
    >,
  ) {
    await repository.updateAssetAnnotation(annotation, patch);
    await refreshData();
  }

  async function saveBrandKit(
    draft: Pick<BrandKit, 'primaryLogoAssetId' | 'approvedAssetIds' | 'palette' | 'notes'>,
    approve = false,
    silent = false,
  ) {
    if (!workspace) return;
    const brandKit = await repository.saveBrandKit(workspace.business.id, draft, approve, !silent);
    if (!brandKit) throw new Error('The Brand Kit could not be saved.');
    if (silent) {
      setWorkspaces((current) =>
        current.map((candidate) =>
          candidate.business.id === workspace.business.id ? { ...candidate, brandKit } : candidate,
        ),
      );
      return;
    }
    await refreshData();
    setNotice({
      id: crypto.randomUUID(),
      title: approve ? 'Brand Kit approved' : 'Brand Kit saved',
      detail: approve
        ? 'Future redesign revisions will use this reviewed logo, visual assets, and colour system.'
        : 'The private Brand Kit remains editable until approval.',
      tone: 'success',
    });
  }

  async function createBrandAwareBriefRevision() {
    if (!workspace) return;
    const brief = await repository.createBrandAwareBriefRevision(workspace.business.id);
    if (!brief) throw new Error('The brand-aware brief revision could not be created.');
    await refreshData();
    navigate({ page: 'prospects', businessId: workspace.business.id, tab: 'brief' });
    setNotice({
      id: crypto.randomUUID(),
      title: 'Brand-aware brief ready',
      detail: 'Review and approve this new brief before generating a replacement private preview.',
      tone: 'success',
    });
  }

  async function createRedesignBrief() {
    if (!workspace) return;
    const brief = await repository.createRedesignBrief(workspace.business.id);
    await refreshData();
    if (!brief) {
      setNotice({
        id: crypto.randomUUID(),
        title: 'AI capability analysis queued',
        detail: 'The saved capture is being interpreted. No new website scrape is needed.',
        tone: 'success',
      });
      return;
    }
    setNotice({
      id: crypto.randomUUID(),
      title: 'Redesign brief created',
      detail: 'Review source selections and open questions before approving the builder handoff.',
      tone: 'success',
    });
  }

  async function refreshRedesignBriefArchitecture(brief: RedesignBrief) {
    const refreshed = await repository.refreshRedesignBriefArchitecture(brief);
    if (!refreshed) throw new Error('The proposed architecture could not be regenerated.');
    await refreshData();
    setNotice({
      id: crypto.randomUUID(),
      title: 'Architecture regenerated',
      detail:
        'The draft now groups selected pages into conversion, content, tool, and utility routes without a new website capture.',
      tone: 'success',
    });
  }

  async function updateRedesignBrief(
    brief: RedesignBrief,
    patch: Pick<RedesignBrief, 'sourceSelections' | 'draft'>,
  ) {
    await repository.updateRedesignBrief(brief, patch);
    await refreshData();
  }

  async function approveRedesignBrief(brief: RedesignBrief) {
    await repository.approveRedesignBrief(brief);
    await refreshData();
    setNotice({
      id: crypto.randomUUID(),
      title: 'Redesign brief approved',
      detail: 'The future builder can now use this reviewed strategy and source selection.',
      tone: 'success',
    });
  }

  async function createBuildManifest() {
    if (!workspace) return;
    const manifest = await repository.createBuildManifest(workspace.business.id);
    if (!manifest) throw new Error('The Build Manifest could not be prepared.');
    await refreshData();
    setNotice({
      id: crypto.randomUUID(),
      title: 'Build Manifest ready',
      detail:
        'The approved brief is now a private, versioned handoff for the future Codex builder.',
      tone: 'success',
    });
  }

  async function requestWebsiteBuild() {
    if (!workspace) return;
    const resumeRun =
      (workspace.latestBuilderRun?.status === 'failed' ||
        workspace.latestBuilderRun?.status === 'cancelled') &&
      workspace.builderArtifacts.some(
        (artifact) =>
          (artifact.kind === 'checkpoint' &&
            artifact.label === 'Latest private source checkpoint') ||
          artifact.kind === 'draft_file',
      )
        ? workspace.latestBuilderRun
        : undefined;
    const run = resumeRun
      ? await repository.resumeWebsiteBuild(resumeRun.id)
      : await repository.requestWebsiteBuild(workspace.business.id);
    if (!run) throw new Error('The private preview could not be queued.');
    await refreshData();
    setNotice({
      id: crypto.randomUUID(),
      title: resumeRun ? 'Private preview resuming' : 'Private preview queued',
      detail: resumeRun
        ? 'The protected builder will restore the saved source, then Codex will continue the website build.'
        : 'The protected Codex builder will create a website from the approved Build Manifest.',
      tone: 'success',
    });
  }

  async function cancelWebsiteBuild() {
    if (!workspace) return;
    await repository.cancelWebsiteBuild(workspace.business.id);
    await refreshData();
    setNotice({
      id: crypto.randomUUID(),
      title: 'Preview cancellation requested',
      detail: 'The builder will stop at its next safe step. Any saved output remains private.',
      tone: 'warning',
    });
  }

  async function createBuilderPreviewUrl(builderRunId: string, mode?: BuilderPreviewMode) {
    return repository.createBuilderPreviewUrl(builderRunId, mode);
  }

  async function approveAllAuditFindings() {
    const pendingFindings = workspace?.audit?.findings.filter(
      (finding) => finding.reviewState === 'needs_review',
    );
    if (!pendingFindings?.length) return;
    await Promise.all(
      pendingFindings.map((finding) =>
        repository.updateAuditFinding(finding, {
          title: finding.title,
          finding: finding.finding,
          recommendation: finding.recommendation,
          severity: finding.severity,
          reviewState: 'approved',
        }),
      ),
    );
    await refreshData();
  }

  async function approveWorkspace() {
    if (!workspace) return;
    await repository.approveForOutreach(workspace.business.id);
    await refreshData();
  }

  async function deleteWorkspace() {
    if (!workspace) return;
    const deleted = await repository.deleteProspect(workspace.business.id);
    if (!deleted) throw new Error('The prospect could not be deleted.');
    await refreshData();
    setNotice({
      id: crypto.randomUUID(),
      title: 'Prospect deleted',
      detail: 'The prospect workspace records were removed.',
      tone: 'danger',
    });
    navigate({ page: 'prospects' });
  }

  const activePage: AppPage = route.page === 'prospects' ? 'prospects' : route.page;

  if (!loadingPresentation && storageError) {
    return <WorkspaceErrorOverlay message={storageError} onSignOut={onSignOut} />;
  }

  return (
    <>
      <AppShell
        activePage={activePage}
        contentKey={
          route.page === 'prospects' && route.businessId
            ? `#/prospects/${route.businessId}`
            : hrefForRoute(route)
        }
        isLoading={loadingPresentation}
        onNavigate={(page) =>
          navigate(
            page === 'today'
              ? { page: 'today' }
              : page === 'settings'
                ? { page: 'settings' }
                : { page: 'prospects' },
          )
        }
        onSignOut={onSignOut}
        userEmail={userEmail}
      >
        {loadingPresentation ? null : route.page === 'today' ? (
          <TodayPage
            businesses={businesses}
            openWorkspace={openWorkspace}
            workspaces={workspaces}
          />
        ) : route.page === 'settings' ? (
          <BuilderSettingsPage />
        ) : route.businessId && workspace ? (
          <WorkspacePage
            onApprove={approveWorkspace}
            onBack={() => navigate({ page: 'prospects' })}
            onDelete={deleteWorkspace}
            onApproveAllAuditFindings={approveAllAuditFindings}
            onApproveRedesignBrief={approveRedesignBrief}
            onCreateBuildManifest={createBuildManifest}
            onRequestWebsiteBuild={requestWebsiteBuild}
            onCancelWebsiteBuild={cancelWebsiteBuild}
            onCreateBuilderPreviewUrl={createBuilderPreviewUrl}
            onCreateRedesignBrief={createRedesignBrief}
            onRefreshRedesignBriefArchitecture={refreshRedesignBriefArchitecture}
            onRequestAssetAnalysis={requestAssetAnalysis}
            onCancelAssetAnalysis={cancelAssetAnalysis}
            onSetAssetAnalysisSelected={setAssetAnalysisSelected}
            onCancelResearchCapture={cancelResearchCapture}
            onContinueResearchCapture={continueResearchCapture}
            onRequestResearchCapture={requestResearchCapture}
            onRequestAssetRefresh={requestAssetRefresh}
            onRequestWebsiteAudit={requestWebsiteAudit}
            onCancelWebsiteAudit={cancelWebsiteAudit}
            onToggleTask={toggleTask}
            onTabChange={(tab) =>
              navigate({ page: 'prospects', businessId: workspace.business.id, tab })
            }
            tab={route.tab ?? 'overview'}
            onUpdateAuditFinding={updateAuditFinding}
            onUpdateAssetAnnotation={updateAssetAnnotation}
            onSaveBrandKit={saveBrandKit}
            onCreateBrandAwareBriefRevision={createBrandAwareBriefRevision}
            onUpdateRedesignBrief={updateRedesignBrief}
            workspace={workspace}
          />
        ) : (
          <ProspectsPage
            businesses={businesses}
            createProspect={(url) => repository.createProspect(url)}
            createWorkspace={handleWorkspaceCreated}
            openWorkspace={openWorkspace}
            workspaces={workspaces}
          />
        )}
      </AppShell>
      {loadingPresentation ? (
        <WorkspaceLoadingOverlay
          loading={loading}
          onComplete={() => setLoadingPresentation(false)}
        />
      ) : null}
      <ToastRegion notice={notice} onDismiss={() => setNotice(undefined)} />
    </>
  );
}

function SignInScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [state, setState] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const client = getSupabaseClient();
    if (!client || !email.trim() || !password) return;
    setState('submitting');
    setMessage('');
    const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      setState('error');
      setMessage('We could not sign you in. Check your email address and password.');
      return;
    }
    onSignedIn();
  }

  return (
    <main className="auth-shell">
      <Card aria-labelledby="sign-in-title" className="auth-panel">
        <Eyebrow>SiteForge OS</Eyebrow>
        <h1 id="sign-in-title">Sign in to your workspace</h1>
        <p>Use the account created in Supabase. Your prospect records stay organization-scoped.</p>
        <form className="auth-form" onSubmit={submit}>
          <label htmlFor="signInEmail">Email address</label>
          <input
            autoComplete="email"
            id="signInEmail"
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            value={email}
          />
          <label htmlFor="signInPassword">Password</label>
          <input
            autoComplete="current-password"
            id="signInPassword"
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
          <Button disabled={state === 'submitting' || !email.trim() || !password} type="submit">
            {state === 'submitting' ? 'Signing in' : 'Sign in'}
          </Button>
          {message ? (
            <p className="form-message form-message--error" role="alert">
              {message}
            </p>
          ) : null}
        </form>
      </Card>
    </main>
  );
}

function OrganizationSetup({ onCreated }: { onCreated: (organizationId: string) => void }) {
  const [name, setName] = useState('SiteForge Studio');
  const [state, setState] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const client = getSupabaseClient();
    if (!client || !name.trim()) return;
    setState('submitting');
    setMessage('');
    const { data, error } = await client.rpc('create_organization', {
      organization_name: name.trim(),
    });
    if (error || typeof data !== 'string') {
      setState('error');
      setMessage('We could not create the organization. Please try again.');
      return;
    }
    onCreated(data);
  }

  return (
    <main className="auth-shell">
      <Card aria-labelledby="organization-title" className="auth-panel">
        <Eyebrow>First-time setup</Eyebrow>
        <h1 id="organization-title">Name your organization</h1>
        <p>
          This creates the private boundary that separates your prospects, clients, files and team
          access.
        </p>
        <form className="auth-form" onSubmit={submit}>
          <label htmlFor="organizationName">Organization name</label>
          <input
            autoComplete="organization"
            id="organizationName"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
          <Button disabled={state === 'submitting' || !name.trim()} type="submit">
            {state === 'submitting' ? 'Creating organization' : 'Create organization'}
          </Button>
          {message ? (
            <p className="form-message form-message--error" role="alert">
              {message}
            </p>
          ) : null}
        </form>
      </Card>
    </main>
  );
}

function SupabaseApp() {
  const client = getSupabaseClient();
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [organizationId, setOrganizationId] = useState<string>();
  const [organizationLoading, setOrganizationLoading] = useState(false);
  const [organizationError, setOrganizationError] = useState('');

  useEffect(() => {
    if (!client) return;
    let active = true;
    void client.auth.getSession().then(({ data }) => {
      if (active) {
        setSession(data.session);
        setAuthLoading(false);
      }
    });
    const { data: listener } = client.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthLoading(false);
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [client]);

  useEffect(() => {
    if (!client || !session) {
      setOrganizationId(undefined);
      setOrganizationError('');
      setOrganizationLoading(false);
      return;
    }
    let active = true;
    setOrganizationLoading(true);
    setOrganizationError('');
    void client
      .from('organizations')
      .select('id')
      .order('created_at')
      .limit(1)
      .then(({ data, error }) => {
        if (!active) return;
        if (error) setOrganizationError('We could not load your organization access.');
        else setOrganizationId(typeof data?.[0]?.id === 'string' ? data[0].id : undefined);
        setOrganizationLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, session?.user.id]);

  const repository = useMemo(
    () =>
      client && organizationId
        ? new SupabaseWorkspaceRepository(client, organizationId)
        : undefined,
    [client, organizationId],
  );

  if (!client) return <WorkspaceApp repository={siteforgeRepository} />;
  if (authLoading) {
    return (
      <main className="auth-shell">
        <Card className="loading-panel" role="status">
          Loading account...
        </Card>
      </main>
    );
  }
  if (!session) return <SignInScreen onSignedIn={() => undefined} />;
  if (organizationLoading) {
    return (
      <main className="auth-shell">
        <Card className="loading-panel" role="status">
          Loading organization...
        </Card>
      </main>
    );
  }
  if (organizationError) {
    return (
      <main className="auth-shell">
        <Card className="error-panel" role="alert">
          <ShieldAlert aria-hidden="true" size={20} />
          <div>
            <h1>Organization unavailable</h1>
            <p>{organizationError}</p>
          </div>
        </Card>
      </main>
    );
  }
  if (!organizationId) return <OrganizationSetup onCreated={setOrganizationId} />;
  if (!repository) return null;
  return (
    <WorkspaceApp
      onSignOut={() =>
        client.auth.signOut().then(({ error }) => {
          if (error) throw error;
        })
      }
      repository={repository}
      userEmail={session.user.email ?? 'Signed-in user'}
    />
  );
}

export function App() {
  if (!isSupabaseConfigured || usesLocalStorage)
    return <WorkspaceApp repository={siteforgeRepository} />;
  return <SupabaseApp />;
}
