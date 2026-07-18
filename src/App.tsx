import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  CircleAlert,
  ClipboardCheck,
  Clock3,
  ExternalLink,
  FileText,
  Globe2,
  ListChecks,
  Play,
  RefreshCw,
  SearchCheck,
  ShieldAlert,
  Sparkles,
  Trash2,
  UsersRound,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
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
  type Business,
  type ProspectStage,
  type ProspectWorkspace,
  type Task,
} from './lib/domain';
import { SupabaseWorkspaceRepository } from './lib/cloud-repository';
import { siteforgeRepository, type WorkspaceRepository } from './lib/repository';
import { getSupabaseClient, isSupabaseConfigured, usesLocalStorage } from './lib/supabase';

type Route = { page: 'today' } | { page: 'prospects'; businessId?: string };
type WorkspaceTab = 'overview' | 'research' | 'audit' | 'redesign' | 'report' | 'activity';

const workspaceTabs: Array<{ id: WorkspaceTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'research', label: 'Research' },
  { id: 'audit', label: 'Audit' },
  { id: 'redesign', label: 'Redesign' },
  { id: 'report', label: 'Report' },
  { id: 'activity', label: 'Activity' },
];

function routeFromHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'prospects') return { page: 'prospects', businessId: parts[1] };
  return { page: 'today' };
}

function hrefForRoute(route: Route) {
  return route.page === 'today'
    ? '#/today'
    : `#/prospects${route.businessId ? `/${route.businessId}` : ''}`;
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
  createProspect,
  createWorkspace,
  openWorkspace,
}: {
  businesses: Business[];
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
            {visibleBusinesses.map((business) => (
              <button
                className="prospect-row"
                key={business.id}
                onClick={() => openWorkspace(business.id)}
                type="button"
              >
                <span className="prospect-row__identity">
                  <strong title={business.name}>{business.name}</strong>
                  <small>{business.kind === 'prospect' ? 'Prospect' : 'Client'}</small>
                </span>
                <StatusPill stage={business.stage} />
                <span className="prospect-row__updated">
                  Updated {formatDate(business.updatedAt)}
                </span>
                <ArrowUpRight aria-hidden="true" size={18} />
              </button>
            ))}
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
  onDelete,
}: {
  workspace: ProspectWorkspace;
  onBack: () => void;
  onApprove: () => void;
  onDelete: () => Promise<void>;
}) {
  const { business, website } = workspace;
  const isApproved = business.reviewState === 'approved';
  const canApprove = workspace.audit?.status === 'ready' && workspace.concept?.status === 'ready';
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

  return (
    <>
      <Button className="back-button" onClick={onBack} variant="quiet">
        <ArrowLeft aria-hidden="true" size={17} /> Back to prospects
      </Button>
      <header className="workspace-header">
        <div>
          <Eyebrow>
            {business.kind === 'prospect' ? 'Prospect workspace' : 'Client workspace'}
          </Eyebrow>
          <h1>{business.name}</h1>
          {website ? (
            <a href={website.url} rel="noreferrer" target="_blank">
              {website.domain} <ExternalLink aria-hidden="true" size={14} />
            </a>
          ) : null}
        </div>
        <div className="workspace-header__actions">
          <StatusPill stage={business.stage} />
          <Button
            disabled={isApproved || !canApprove}
            onClick={onApprove}
            variant={isApproved || canApprove ? 'primary' : 'secondary'}
          >
            <Check aria-hidden="true" size={16} />{' '}
            {isApproved ? 'Approved' : canApprove ? 'Approve for outreach' : 'Awaiting review'}
          </Button>
          {business.kind === 'prospect' ? (
            <Button onClick={() => setDeleteDialogOpen(true)} variant="danger">
              <Trash2 aria-hidden="true" size={16} /> Delete prospect
            </Button>
          ) : null}
        </div>
      </header>
      <div className="approval-note" role="status">
        <ShieldAlert aria-hidden="true" size={17} />
        <span>
          {isApproved
            ? 'Approved for a human-controlled outreach step. Publishing remains blocked.'
            : canApprove
              ? 'A human review is required before outreach can begin. Publishing remains blocked.'
              : 'Outreach and publishing remain blocked until research, audit and redesign review are complete.'}
        </span>
      </div>
      <ConfirmationDialog
        confirmLabel="Delete prospect"
        detail={`Delete ${business.name} and all of its research, tasks, and generated records? This cannot be undone.`}
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
  return 'Not requested';
}

function ResearchCapturePanel({
  workspace,
  onRequestCapture,
}: {
  workspace: ProspectWorkspace;
  onRequestCapture: () => Promise<void>;
}) {
  const [state, setState] = useState<'idle' | 'requesting' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const capture = workspace.latestCapture;
  const isActive = capture?.status === 'queued' || capture?.status === 'running';

  async function requestCapture() {
    setState('requesting');
    setMessage('');
    try {
      await onRequestCapture();
      setState('idle');
    } catch {
      setState('error');
      setMessage('The homepage capture could not be queued. Check the connection and try again.');
    }
  }

  return (
    <section aria-labelledby="homepage-capture-title" className="research-capture">
      <div className="research-capture__header">
        <div>
          <Eyebrow>Private capture</Eyebrow>
          <h2 id="homepage-capture-title">Homepage capture</h2>
          <p>
            Save the public homepage structure, metadata, and responsive screenshots as private
            evidence. It does not publish, contact the business, or treat extracted text as fact.
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
                  ? 'Capture homepage again'
                  : 'Start homepage capture'}
          </Button>
        </div>
      </div>

      {capture ? (
        <>
          <dl className="research-capture__details">
            <div>
              <dt>Scope</dt>
              <dd>Homepage only</dd>
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
          </dl>
          <p className="research-capture__status" role="status">
            {capture.status === 'queued'
              ? 'The capture request is queued for the protected worker. No website data has been stored yet.'
              : capture.status === 'running'
                ? 'The protected worker is capturing the public homepage. Results will appear here when it completes.'
                : capture.status === 'ready'
                  ? 'The capture is complete. Review evidence before using any information in an audit or outreach.'
                  : capture.errorSummary ||
                    'The last capture failed. Review the website URL, then request another homepage capture.'}
          </p>
        </>
      ) : (
        <p className="research-capture__status" role="status">
          No capture has been requested. Start with a homepage-only capture before creating an audit
          or redesign brief.
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

function WorkspaceContent({
  tab,
  workspace,
  toggleTask,
  requestResearchCapture,
}: {
  tab: WorkspaceTab;
  workspace: ProspectWorkspace;
  toggleTask: (task: Task) => Promise<void>;
  requestResearchCapture: () => Promise<void>;
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
    return (
      <Card className="workspace-panel">
        <Eyebrow>Evidence ledger</Eyebrow>
        <h2>Capture first, then verify</h2>
        <p className="muted-copy">
          Every source is tied to a capture run. Extracted content is evidence, not an approved
          claim, until a person reviews it.
        </p>
        <ResearchCapturePanel onRequestCapture={requestResearchCapture} workspace={workspace} />
        {workspace.facts.length ? (
          <div className="fact-box">
            {workspace.facts.map((fact) => (
              <div className="fact-row" key={fact.id}>
                <span>
                  <strong>{fact.label}</strong>
                  <small>{fact.evidence}</small>
                </span>
                <StatusBadge tone={fact.verificationState === 'verified' ? 'success' : 'warning'}>
                  {fact.verificationState}
                </StatusBadge>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            detail="No factual claims have been extracted or verified yet."
            icon={SearchCheck}
            title="No evidence captured"
          />
        )}
      </Card>
    );
  }

  if (tab === 'audit') {
    return (
      <Card className="workspace-panel">
        <Eyebrow>Website audit</Eyebrow>
        <h2>Audit findings are evidence-led</h2>
        <p className="muted-copy">
          No audit has been generated for this record. A future audit job will add UI, UX, mobile,
          accessibility, SEO, performance, content, trust and conversion findings with linked
          evidence.
        </p>
        <EmptyState
          detail="Run and review research before creating an audit."
          icon={ClipboardCheck}
          title="Audit not started"
        />
      </Card>
    );
  }

  if (tab === 'redesign') {
    return (
      <Card className="workspace-panel">
        <Eyebrow>Redesign concept</Eyebrow>
        <h2>Awaiting approved evidence</h2>
        <p className="muted-copy">{workspace.concept?.summary}</p>
        <EmptyState
          detail="A concept will include a sitemap, information hierarchy, reusable components, and desktop, tablet and mobile previews."
          icon={Sparkles}
          title="No concept draft"
        />
      </Card>
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
        {workspace.activity.map((activity) => (
          <article className="activity-row" key={activity.id}>
            <span>
              <strong>{activity.message}</strong>
              <small>{activity.type.replaceAll('_', ' ')}</small>
            </span>
            <time dateTime={activity.createdAt}>{formatDateTime(activity.createdAt)}</time>
          </article>
        ))}
      </div>
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
}: {
  workspace: ProspectWorkspace;
  onBack: () => void;
  onApprove: () => void;
  onDelete: () => Promise<void>;
  onToggleTask: (task: Task) => Promise<void>;
  onRequestResearchCapture: () => Promise<void>;
}) {
  const [tab, setTab] = useState<WorkspaceTab>('overview');

  return (
    <>
      <WorkspaceHeader
        onApprove={onApprove}
        onBack={onBack}
        onDelete={onDelete}
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
            onClick={() => setTab(item.id)}
            role="tab"
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
      <section aria-labelledby={`workspace-tab-${tab}`} id={`workspace-${tab}`} role="tabpanel">
        <WorkspaceContent
          requestResearchCapture={onRequestResearchCapture}
          tab={tab}
          toggleTask={onToggleTask}
          workspace={workspace}
        />
      </section>
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
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [workspaces, setWorkspaces] = useState<ProspectWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [storageError, setStorageError] = useState('');
  const [notice, setNotice] = useState<ToastNotice>();

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(undefined), 10000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  async function refreshData() {
    const [nextBusinesses, nextWorkspaces] = await Promise.all([
      repository.listBusinesses(),
      repository.listWorkspaces(),
    ]);
    setBusinesses(nextBusinesses);
    setWorkspaces(nextWorkspaces);
  }

  useEffect(() => {
    function updateRoute() {
      setRoute(routeFromHash(window.location.hash));
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
      } catch {
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

  const workspace =
    route.page === 'prospects' && route.businessId
      ? workspaces.find((candidate) => candidate.business.id === route.businessId)
      : undefined;

  function navigate(nextRoute: Route) {
    const nextHref = hrefForRoute(nextRoute);
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
    if (!capture) throw new Error('The homepage capture could not be queued.');
    await refreshData();
    setNotice({
      id: crypto.randomUUID(),
      title: 'Homepage capture queued',
      detail: 'The private worker will save evidence here when the capture completes.',
    });
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
    });
    navigate({ page: 'prospects' });
  }

  const activePage: AppPage = route.page === 'today' ? 'today' : 'prospects';

  return (
    <>
      <AppShell
        activePage={activePage}
        onNavigate={(page) =>
          navigate(page === 'today' ? { page: 'today' } : { page: 'prospects' })
        }
      >
        {onSignOut ? (
          <div className="session-control">
            <span>{userEmail}</span>
            <Button onClick={() => void onSignOut()} size="compact" variant="quiet">
              Sign out
            </Button>
          </div>
        ) : null}
        {loading ? (
          <Card className="loading-panel" role="status">
            <RefreshCw aria-hidden="true" className="spin" size={20} /> Loading workspace data...
          </Card>
        ) : storageError ? (
          <Card className="error-panel" role="alert">
            <ShieldAlert aria-hidden="true" size={20} />
            <div>
              <h2>Storage unavailable</h2>
              <p>{storageError}</p>
            </div>
          </Card>
        ) : route.page === 'today' ? (
          <TodayPage
            businesses={businesses}
            openWorkspace={openWorkspace}
            workspaces={workspaces}
          />
        ) : route.businessId && workspace ? (
          <WorkspacePage
            onApprove={approveWorkspace}
            onBack={() => navigate({ page: 'prospects' })}
            onDelete={deleteWorkspace}
            onRequestResearchCapture={requestResearchCapture}
            onToggleTask={toggleTask}
            workspace={workspace}
          />
        ) : (
          <ProspectsPage
            businesses={businesses}
            createProspect={(url) => repository.createProspect(url)}
            createWorkspace={handleWorkspaceCreated}
            openWorkspace={openWorkspace}
          />
        )}
      </AppShell>
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
  }, [client, session]);

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
