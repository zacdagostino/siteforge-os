import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  FileText,
  Mail,
  Play,
  ShieldAlert,
  Sparkles,
  Target,
  TriangleAlert,
} from 'lucide-react';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { AppShell } from './components/AppShell';
import { Button, Card, Eyebrow, StatusBadge } from './components/ui';

type Stage = 'identified' | 'audited' | 'preview_ready' | 'outreach_pending';
type Severity = 'high' | 'medium' | 'low';

type Issue = {
  area: string;
  severity: Severity;
  title: string;
  finding: string;
  recommendation: string;
};

type Fact = {
  label: string;
  value: string;
  source: string;
  evidence: string;
  needsReview?: boolean;
};

type Task = {
  id: string;
  body: string;
  done: boolean;
};

type ProspectRecord = {
  id: string;
  businessName: string;
  domain: string;
  websiteUrl: string;
  stage: Stage;
  status: 'needs_review' | 'approved';
  score: number;
  updatedAt: string;
  issues: Issue[];
  facts: Fact[];
  tasks: Task[];
};

const stageLabels: { [Key in Stage]: string } = {
  identified: 'Identified',
  audited: 'Audited',
  preview_ready: 'Preview ready',
  outreach_pending: 'Outreach pending',
};

const stages: Stage[] = ['identified', 'audited', 'preview_ready', 'outreach_pending'];
const storageKey = 'siteforge-os.records.v2';

const initialRecord: ProspectRecord = {
  id: 'demo-local-services',
  businessName: 'Demo Local Services',
  domain: 'demo-local-services.example',
  websiteUrl: 'https://demo-local-services.example',
  stage: 'audited',
  status: 'needs_review',
  score: 61,
  updatedAt: '2026-07-14T12:30:00.000Z',
  issues: [
    {
      area: 'Mobile',
      severity: 'high',
      title: 'Mobile enquiry path needs review',
      finding: 'The current mobile path is assumed to need validation in the demo record.',
      recommendation:
        'Use a mobile-first contact path with labelled form fields and persistent primary action.',
    },
    {
      area: 'Trust',
      severity: 'medium',
      title: 'Proof content requires verification',
      finding: 'Testimonials and credentials are not confirmed.',
      recommendation: 'Collect approved proof assets before publishing trust modules.',
    },
  ],
  facts: [
    { label: 'Website URL', value: 'Demo seed', source: 'Demo seed', evidence: 'Verified' },
    {
      label: 'Business name',
      value: 'Demo seed',
      source: 'Demo seed',
      evidence: 'Inferred',
      needsReview: true,
    },
  ],
  tasks: [
    { id: 'replace-demo', body: 'Replace demo record with a real prospect URL.', done: false },
  ],
};

function readRecords() {
  try {
    const stored = window.localStorage.getItem(storageKey);
    return stored ? (JSON.parse(stored) as ProspectRecord[]) : [initialRecord];
  } catch {
    return [initialRecord];
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function domainFromUrl(value: string) {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return new URL(withProtocol).hostname.replace(/^www\./, '');
}

function displayName(domain: string) {
  return domain
    .split('.')[0]
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function createRecord(rawUrl: string): ProspectRecord {
  const domain = domainFromUrl(rawUrl);
  const now = new Date().toISOString();
  const businessName = displayName(domain) || domain;

  return {
    id: `${domain}-${Date.now()}`,
    businessName,
    domain,
    websiteUrl: /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`,
    stage: 'preview_ready',
    status: 'needs_review',
    score: 74,
    updatedAt: now,
    issues: [
      {
        area: 'Facts',
        severity: 'high',
        title: 'Business details need verification',
        finding:
          'The intake record was created from a public URL and has not been crawled or reviewed.',
        recommendation:
          'Verify ownership, services, contact details, and claims before outreach or publishing.',
      },
      {
        area: 'Mobile',
        severity: 'medium',
        title: 'Mobile workflow needs validation',
        finding:
          'The generated concept should be reviewed with realistic content and a real mobile user flow.',
        recommendation:
          'Test the approved preview at mobile, tablet, and desktop sizes before release.',
      },
    ],
    facts: [
      { label: 'Website URL', value: domain, source: 'Submitted URL', evidence: 'Verified' },
      {
        label: 'Business name',
        value: businessName,
        source: 'Domain inference',
        evidence: 'Inferred',
        needsReview: true,
      },
    ],
    tasks: [
      {
        id: `${domain}-identity`,
        body: 'Verify business identity, services, and contact details.',
        done: false,
      },
      {
        id: `${domain}-mobile`,
        body: 'Run manual accessibility and mobile checks on the approved preview.',
        done: false,
      },
      {
        id: `${domain}-approval`,
        body: 'Review preview copy and quality checks before publishing or contacting.',
        done: false,
      },
    ],
  };
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <article className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function SectionHeading({
  eyebrow,
  title,
  timestamp,
}: {
  eyebrow: string;
  title: string;
  timestamp?: string;
}) {
  return (
    <div className="section-heading">
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2>{title}</h2>
      </div>
      {timestamp ? <span className="timestamp">Updated {formatDate(timestamp)}</span> : null}
    </div>
  );
}

function Preview({ record }: { record: ProspectRecord }) {
  return (
    <div className="concept-preview">
      <p className="concept-preview__notice">Static concept preview</p>
      <header>
        <strong>{record.businessName}</strong>
        <span className="preview-action">Contact</span>
      </header>
      <section>
        <Eyebrow>Clear local service</Eyebrow>
        <h3>A clearer path from first visit to confident enquiry.</h3>
        <p>
          Explain what matters, prove it with verified evidence, and make the next step easy on
          every screen size.
        </p>
        <div className="preview-actions" aria-label="Static preview actions">
          <span className="preview-action">Request a review</span>
          <span className="preview-action preview-action--secondary">View services</span>
        </div>
      </section>
      <div className="preview-cards">
        <article>
          <small>Services</small>
          <strong>Plain-language choices</strong>
          <p>Visitors can self-select quickly.</p>
        </article>
        <article>
          <small>Trust</small>
          <strong>Verified proof only</strong>
          <p>Claims stay reviewable and accountable.</p>
        </article>
        <article>
          <small>Contact</small>
          <strong>One clear next step</strong>
          <p>Enquiry is easy to complete on mobile.</p>
        </article>
      </div>
    </div>
  );
}

export function App() {
  const [records, setRecords] = useState<ProspectRecord[]>(readRecords);
  const [selectedId, setSelectedId] = useState(records[0]?.id ?? '');
  const [url, setUrl] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [notice, setNotice] = useState(
    'Approval gates are active: publish, outreach, and uncertain facts stay blocked.',
  );

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify(records));
  }, [records]);

  const selected = records.find((record) => record.id === selectedId) ?? records[0];
  const metrics = useMemo(
    () => ({
      records: records.length,
      previews: records.filter((record) => record.stage === 'preview_ready').length,
      reviewItems: records.reduce(
        (total, record) => total + record.facts.filter((fact) => fact.needsReview).length,
        0,
      ),
      blockedOutreach: records.filter((record) => record.status !== 'approved').length,
    }),
    [records],
  );

  async function handleIntake(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!url.trim()) return;

    setIsRunning(true);
    setNotice('Running intake, audit, redesign concept, report, and quality checks...');
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      const record = createRecord(url.trim());
      setRecords((current) => [record, ...current]);
      setSelectedId(record.id);
      setUrl('');
      setNotice(
        `Generated ${record.domain}. Review gates were created before any outreach can begin.`,
      );
    } catch {
      setNotice('Enter a valid public website URL to create a prospect record.');
    } finally {
      setIsRunning(false);
    }
  }

  function updateSelected(update: (record: ProspectRecord) => ProspectRecord) {
    if (!selected) return;
    setRecords((current) =>
      current.map((record) => (record.id === selected.id ? update(record) : record)),
    );
  }

  function approveRecord() {
    updateSelected((record) => ({
      ...record,
      status: 'approved',
      stage: 'outreach_pending',
      updatedAt: new Date().toISOString(),
    }));
    setNotice(
      'Record approved for the next human-controlled outreach step. Publishing remains blocked.',
    );
  }

  function toggleTask(taskId: string) {
    updateSelected((record) => ({
      ...record,
      tasks: record.tasks.map((task) =>
        task.id === taskId ? { ...task, done: !task.done } : task,
      ),
      updatedAt: new Date().toISOString(),
    }));
  }

  if (!selected) {
    return (
      <AppShell>
        <Card>Create a prospect to begin.</Card>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <header className="topbar">
        <div>
          <Eyebrow>Internal operating system</Eyebrow>
          <h1>Prospect-to-preview workflow</h1>
        </div>
        <div className="notice" role="status">
          <TriangleAlert aria-hidden="true" size={16} />
          <span>{notice}</span>
        </div>
      </header>

      <Card aria-labelledby="command-title" className="command-band" id="command">
        <div>
          <Eyebrow>Automated redesign agent</Eyebrow>
          <h2 id="command-title">Create an audit, redesign concept, and report from a URL</h2>
          <p>
            The MVP stores a conservative record immediately and flags facts that need human review.
            A crawler adapter can later enrich this workflow with screenshots, Lighthouse, axe, and
            verified site content.
          </p>
        </div>
        <form className="url-form" onSubmit={handleIntake}>
          <label htmlFor="websiteUrl">Public website URL</label>
          <div className="input-row">
            <Target aria-hidden="true" size={18} />
            <input
              autoComplete="url"
              id="websiteUrl"
              name="websiteUrl"
              onChange={(event) => setUrl(event.target.value)}
              placeholder="example-business.com"
              value={url}
            />
            <Button disabled={isRunning || !url.trim()} type="submit">
              {isRunning ? (
                <Sparkles aria-hidden="true" className="spin" size={17} />
              ) : (
                <Play aria-hidden="true" size={17} />
              )}
              {isRunning ? 'Running' : 'Run'}
            </Button>
          </div>
        </form>
      </Card>

      <section aria-label="Workspace metrics" className="metric-grid">
        <Metric label="Records" value={metrics.records} />
        <Metric label="Previews" value={metrics.previews} />
        <Metric label="Review items" value={metrics.reviewItems} />
        <Metric label="Blocked outreach" value={metrics.blockedOutreach} />
      </section>

      <div className="workspace-grid">
        <Card aria-labelledby="pipeline-title" className="prospect-list" id="pipeline">
          <SectionHeading eyebrow="Pipeline" title="Prospects and clients" />
          <div aria-label="Pipeline stages" className="stage-rail">
            {stages.map((stage) => (
              <div key={stage}>
                <span>{stageLabels[stage]}</span>
                <strong>{records.filter((record) => record.stage === stage).length}</strong>
              </div>
            ))}
          </div>
          <div className="record-stack">
            {records.map((record) => (
              <Button
                aria-pressed={record.id === selected.id}
                className={
                  record.id === selected.id ? 'record-card record-card--selected' : 'record-card'
                }
                key={record.id}
                onClick={() => setSelectedId(record.id)}
                variant="quiet"
              >
                <span>
                  <strong>{record.businessName}</strong>
                  <small>{record.domain}</small>
                </span>
                <span className="record-meta">
                  {stageLabels[record.stage]}
                  <ArrowUpRight aria-hidden="true" size={16} />
                </span>
              </Button>
            ))}
          </div>
        </Card>

        <div aria-label="Selected record" className="detail-column">
          <section className="record-hero">
            <div>
              <Eyebrow>Selected record</Eyebrow>
              <h2>{selected.businessName}</h2>
              <a href={selected.websiteUrl} rel="noreferrer" target="_blank">
                {selected.domain} <ExternalLink aria-hidden="true" size={14} />
              </a>
            </div>
            <div aria-label={`Opportunity score ${selected.score}`} className="score-dial">
              <strong>{selected.score}</strong>
              <span>fit score</span>
            </div>
          </section>

          <section className="approval-strip">
            <CheckCircle2 aria-hidden="true" size={18} />
            <span>
              Status:{' '}
              {selected.status === 'approved' ? 'Approved for next step' : 'Needs human review'}
            </span>
            <Button disabled={selected.status === 'approved'} onClick={approveRecord}>
              <Check aria-hidden="true" size={16} /> Approve
            </Button>
          </section>

          <Card aria-labelledby="audit-title" id="audit">
            <SectionHeading
              eyebrow="Audit"
              timestamp={selected.updatedAt}
              title="Issues and verified facts"
            />
            <div className="audit-grid">
              <div className="issue-stack">
                {selected.issues.map((issue) => (
                  <article className="issue-item" key={`${issue.area}-${issue.title}`}>
                    <div>
                      <StatusBadge
                        tone={
                          issue.severity === 'high'
                            ? 'danger'
                            : issue.severity === 'medium'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {issue.severity}
                      </StatusBadge>
                      <StatusBadge>{issue.area}</StatusBadge>
                    </div>
                    <h3>{issue.title}</h3>
                    <p>{issue.finding}</p>
                    <strong>{issue.recommendation}</strong>
                  </article>
                ))}
              </div>
              <div className="fact-box">
                <h3>Fact evidence</h3>
                {selected.facts.map((fact) => (
                  <div className="fact-row" key={fact.label}>
                    <span>
                      <strong>{fact.label}</strong>
                      <small>{fact.source}</small>
                    </span>
                    <StatusBadge tone={fact.needsReview ? 'warning' : 'success'}>
                      {fact.evidence}
                    </StatusBadge>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          <section aria-labelledby="preview-title" className="preview-grid" id="preview">
            <Card>
              <SectionHeading eyebrow="Redesign preview" title="Mobile-first concept" />
              <Preview record={selected} />
            </Card>
            <Card>
              <SectionHeading eyebrow="Responsive layouts" title="Desktop, tablet, mobile" />
              <div className="layout-plans">
                {[
                  'Desktop: persistent sidebar and two-column work area',
                  'Tablet: stacked workspace with compact navigation',
                  'Mobile: menu drawer and one-column tasks',
                ].map((plan) => (
                  <span key={plan}>{plan}</span>
                ))}
              </div>
            </Card>
          </section>

          <Card aria-labelledby="report-title" id="report">
            <SectionHeading eyebrow="Report" title="Before-and-after decision brief" />
            <p className="report-copy">
              Improve usability, search relevance, lead quality, and accountable content decisions
              without publishing unverified claims.
            </p>
          </Card>

          <section aria-label="Commercial operations" className="operations-grid" id="commercial">
            <Card>
              <h2>
                <Mail aria-hidden="true" size={18} /> Outreach
              </h2>
              <p className="muted-copy">
                No outreach is sent until the record is approved by a human.
              </p>
            </Card>
            <Card>
              <h2>
                <FileText aria-hidden="true" size={18} /> Proposal and billing
              </h2>
              <p className="muted-copy">Estimate: requires human pricing review.</p>
              <p className="muted-copy">Invoice: draft</p>
            </Card>
            <Card>
              <h2>
                <ClipboardCheck aria-hidden="true" size={18} /> Tasks and notes
              </h2>
              <div className="task-list">
                {selected.tasks.map((task) => (
                  <label className="task-row" key={task.id}>
                    <input
                      checked={task.done}
                      onChange={() => toggleTask(task.id)}
                      type="checkbox"
                    />
                    <span>{task.body}</span>
                  </label>
                ))}
              </div>
            </Card>
            <Card>
              <h2>
                <ShieldAlert aria-hidden="true" size={18} /> Quality checks
              </h2>
              <div className="check check--warning">
                <strong>Factual claims</strong>
                <span>Demo data contains unverified placeholders.</span>
              </div>
              <div className="check check--danger">
                <strong>Outreach approval</strong>
                <span>Human approval required before contact.</span>
              </div>
            </Card>
          </section>
        </div>
      </div>
    </AppShell>
  );
}
