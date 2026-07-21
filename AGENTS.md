# SiteForge OS Engineering Standards

## Scope and safety

- Preserve user changes and generated output unless the task explicitly requires modifying them.
- Do not edit `dist/` directly. Treat it as build output; make changes in source files and rebuild.
- Ask before adding dependencies, changing build tooling, changing deployment configuration, or making a visual redesign outside the requested scope.

## UI quality is a release requirement

Every user-facing change must be designed and verified at these viewport sizes:

| Form factor | Viewport   |
| ----------- | ---------- |
| Mobile      | 375 x 812  |
| Tablet      | 768 x 1024 |
| Desktop     | 1440 x 900 |

- Do not consider a UI task complete until each viewport has been checked in a real browser or automated screenshot.
- Check for overflow, clipped text, overlapping content, inaccessible controls, unreadable contrast, broken focus states, and awkward empty space.
- Test key interactions with mouse and keyboard. Interactive elements require visible hover, focus, disabled, and loading/error states where relevant.
- Use responsive layout primitives (`grid`, `flex`, container widths, `minmax`, `clamp` for spacing only) rather than separate device-specific pages or brittle absolute positioning.
- Start mobile-first. Content must reflow instead of being merely scaled down; horizontal scrolling is allowed only for intentionally scrollable content such as a data table.
- Touch targets must be at least 44 x 44 CSS pixels unless a denser, clearly justified control group is required.

## Mobile navigation contract

- At mobile breakpoints, the menu trigger must appear at the leading edge of the header unless the product's established navigation pattern explicitly requires otherwise.
- Treat an opened mobile menu as a dialog or disclosure with a deliberate, single-column navigation layout. Do not allow desktop or tablet navigation grids to leak into the mobile drawer.
- A mobile drawer must have a clear close control, an accessible name, a readable maximum width that leaves page context visible, and secondary content that does not compete with primary routes.
- Support mouse, touch, and keyboard interaction: the trigger communicates its expanded state, Escape and the close control dismiss the drawer, focus moves into it when opened, and returns to the trigger when dismissed. A route selection also closes the drawer.
- Scope drawer styles to the drawer component. Shared navigation styles may provide base appearance, but breakpoint-specific layout rules must be explicitly overridden where the navigation is rendered in a different context.
- Use only restrained open/close motion and disable it for `prefers-reduced-motion`.
- For every mobile-navigation change, verify both closed and open states at 320 x 568 and 375 x 812, plus the required tablet and desktop viewports. Check no overflow, clipped controls, obscured content, or excessive unused drawer space.
- Add or update automated coverage for trigger position, drawer width, vertical route stacking, link dismissal, Escape dismissal, focus restoration, and visual snapshots for the closed and open states.

## Workspace navigation state

- Persist a user-selected workspace section in the route so a refresh, browser restore, or direct link returns to the same prospect and section.
- Treat browser storage only as a fallback for reopening the application from its base URL. A valid URL route remains the source of truth and must take precedence over stored state.

## Layout and spacing

- Build page structure with named layout primitives: page shell, content container, stack, cluster, sidebar, and grid. Do not use one-off margin chains to create layout.
- Use `gap` for spacing between items in a layout. Reserve margins for the external spacing of a component or for unavoidable document-flow cases.
- Apply the spacing scale consistently. New arbitrary spacing values require a clear visual reason; do not nudge elements with magic pixel values.
- Constrain readable content with a maximum inline size. Use fluid container padding and avoid full-width text blocks on large screens.
- Define stable dimensions or aspect ratios for controls, thumbnails, tables, and media so content changes cannot cause layout shift.
- Keep related controls aligned to a shared grid. Do not use absolute positioning for normal layout, and do not rely on fixed heights for text-bearing containers.
- At each breakpoint, intentionally choose whether a group wraps, stacks, scrolls, collapses, or becomes a menu. Never leave that behavior accidental.

## Design system

- Reuse existing components, tokens, icons, and patterns before creating new ones.
- Use semantic design tokens for color, spacing, type, borders, elevation, radius, and motion. Do not scatter raw magic values through components.
- Prefer a small spacing scale (for example 4, 8, 12, 16, 24, 32, 48) and a consistent type scale.
- Define component variants with explicit semantic names such as `primary`, `secondary`, `danger`, `compact`, and `loading`; do not encode behavior in a growing list of unrelated boolean props.
- Components must own their internal layout and expose a small, documented API. Avoid components that depend on parent CSS selectors, hidden spacing assumptions, or a particular page location.
- Use one shared implementation for repeated controls such as buttons, inputs, selects, alerts, empty states, tables, and dialogs. Do not duplicate component markup and styling between screens.
- Use Lucide icons where an icon is appropriate; pair unfamiliar icon-only controls with accessible labels and tooltips.
- Keep page layouts unframed. Use cards only for repeated items, dialogs, or genuinely bounded tools; do not nest cards.
- Avoid decorative gradients, visual clutter, and oversized marketing-style type in product workflows.
- All text, controls, error messages, and empty states must communicate a clear next action.

## Forms and application states

- Design every workflow for default, hover, focus, active, disabled, loading, success, empty, validation-error, and system-error states when applicable.
- Keep labels visible, place validation feedback next to the relevant field, preserve entered values after validation errors, and do not disable submission without explaining why.
- Use buttons for actions and links for navigation. Destructive actions require clear confirmation when the action cannot be undone.
- Ensure asynchronous actions prevent accidental duplicate submissions and announce meaningful status changes to assistive technology.
- Use realistic long labels, empty values, error copy, and large data sets when reviewing layouts. Do not validate only against ideal placeholder content.
- For text sourced from prospects or websites, test both natural-language labels and unbroken values such as long domains. At 320px, 375px, tablet, and desktop, names, URLs, task text, toast copy, and headings must wrap or truncate deliberately without creating horizontal page overflow.

## Async evidence replacement contract

- For an asynchronous operation that replaces factual, generated, or customer-visible data, never display results from an earlier run as though they belong to the active run.
- Scope rendered results to the active run identifier. While a replacement run is queued or running, do not dim, relabel, or retain stale values in place. If the backend emits incremental evidence, render only the newly saved records from the active run as they arrive and keep geometry-matched skeletons for the next unavailable items; otherwise replace the result surface with skeletons and an accessible status announcement.
- Skeletons must preserve the final layout's row, card, and media dimensions to prevent layout shift. Use restrained motion only, and provide a static `prefers-reduced-motion` variant.
- Do not invent progress percentages when the backend does not supply measurable progress. Communicate only verified lifecycle states such as queued, running, complete, or failed.
- On success, render only the new run's evidence. On failure, keep the earlier completed run as explicitly labelled history, never as the current result.
- Build repeated async states from shared loading, error, and history components rather than duplicating page-specific placeholder markup.

## Live capture progress and cancellation

- Treat progress as a sequence of persisted, observable checkpoints, not a fabricated percentage. Store a concise phase, a specific current URL or asset source, and discovered/captured/failed page counts with the active capture run.
- Persist a page only after its captured page record, source artifacts, and extracted evidence are ready; then render that active-run evidence immediately in the workspace. Persist selected visual assets individually and surface them as each is saved. Responsive screenshots belong to an explicit visual-evidence capture, not the default research capture.
- Cancellation is cooperative: acknowledge it in the workspace immediately, prevent another worker from claiming the run, and make the worker stop at the next safe checkpoint. Never present a cancellation as an immediate network abort when a page or image request may still be completing.
- Retain partial evidence from a cancelled run as private, clearly labelled source material. It cannot be treated as a completed Research Packet or used to create downstream deliverables without a new completed capture.

## Worker job contract

- Every long-running internal worker job, including capture, asset analysis, audit generation, future preview builds, report generation, and integrations, must expose the same persisted lifecycle: queued, running, per-step phase/detail, item totals where knowable, completed-item count, failure summary, and cooperative cancellation request.
- Save independent outputs incrementally and render only the current job's saved outputs as they arrive. A worker must check for cancellation before starting each independent item and before marking its job complete.
- Cancellation does not mean a request is instantly abortable. Acknowledge it immediately, prevent a replacement worker from claiming the job, stop at the next safe checkpoint, and preserve any completed private output without treating it as a finished deliverable.

## Public website capture

- Capture public pages as immutable evidence records with source URL, capture run, timestamp, and artifact metadata. Keep raw evidence separate from derived observations and audit findings.
- Use a bounded, prioritized internal-page crawl. Start from the homepage, prefer contact, quote, booking, service, about, location, trust, and FAQ pages, and do not treat a public URL as permission to mirror an entire site.
- Discover public URLs from `robots.txt` sitemap declarations and `sitemap.xml` before relying on page links, then schedule independent page tasks from a durable capture queue. Default to three concurrent raw-HTML tasks per domain; serialize rendered-browser fallbacks and reduce concurrency after rate-limit responses, timeouts, or access denials.
- Keep active and pending page URLs resumable. A failed page task must not discard other discovered pages or cause already saved evidence to be fetched again.
- Respect `robots.txt`, block private network targets, avoid authenticated content, and never submit forms, make bookings, trigger payments, or send messages during capture.
- Do not use the flawed source website's screenshots as redesign direction. The default research capture collects structure, content, provenance, and original assets only. Run visual evidence separately for before-and-after reporting or explicit human review; when it is requested, render desktop, tablet, and mobile screenshots in independent browser contexts rather than resizing an already-loaded desktop page.
- Store extracted business information, form structure, media metadata, and readable text with page-level provenance. Defer runtime accessibility and performance checks to their dedicated audit job so they do not delay the research packet. Never invent a missing fact or convert unverified evidence into a claim.

## AI asset enrichment

- Treat visual-model output as a private, editable suggestion, never as evidence or a verified business fact. Save the source asset, source page URL, image URL, alt/detail text, nearby caption or heading context, model output, model name, and analysis time separately from the human review.
- Send only the captured public image and its minimal provenance to a server-only model worker. Do not expose model credentials or raw private artifact paths to browser code; set `store: false` where the provider supports it.
- Prompt the model to describe directly observable content and visible text only. Nearby page context may orient the description but cannot prove ownership, service delivery, a project, client relationship, qualification, location, testimonial, endorsement, guarantee, or commercial claim.
- Require explicit human review before any asset description, role, association, or reuse guidance is included in a redesign brief. Human approval can be changed to exclusion at any time and must be preserved as an auditable state.
- Keep roles and associations structured. Use `unknown` or `third_party` whenever the business relationship is not directly established; do not force a guess to make the brief more complete.

## Brand-colour evidence

- Generate colour suggestions from deterministic source evidence: SVG fills and strokes, selected logo-image pixels, captured stylesheet variables, and repeated rendered interface controls. Do not sample photographs, screenshots, gradients, or marketing artwork as palette truth.
- Store every candidate with its source type, URL or asset, label, count, confidence, and capture run. A suggested colour is never an approved brand fact and must remain reviewable in the Brand Kit.
- Prefer direct organisation-logo evidence when its ownership is supported. When a logo is monochrome or has no usable chromatic signal, rank repeated captured website-CSS and rendered-UI evidence instead. Do not infer a colour solely from a third-party, supplier, client, or unknown mark.
- Preserve only reviewed primary and accent colours in the approved Brand Kit. The builder derives accessible neutral, surface, background, muted, and border colours rather than copying an outdated website palette.

## Build Manifest and Codex builder

- Generate a Build Manifest only from an approved, immutable redesign brief. It is a versioned private handoff, not a client-facing proposal or a generated redesign preview.
- A Brand Kit is a separate, versioned approval record for a captured organisation logo, permitted visual assets, and reviewed primary and accent colours. Never infer brand ownership from a filename, a model description, or an automatically selected asset. Third-party, client, supplier, and unknown marks remain excluded unless a human explicitly approves their use and context.
- Do not create a website build without an approved Brand Kit that names a primary organisation logo and reviewed primary and accent colours. A Brand Kit change requires a new brief revision and a new immutable manifest; never modify an earlier preview or manifest in place.
- When a Brand Kit is present, stage its primary logo and approved assets for the builder, require the generated header and footer to use that logo, require CSS design tokens to include its reviewed primary and accent colours, and check those facts automatically before a preview is marked ready. The builder may derive accessible ink, background, surface, muted, and border colours; it must not copy a weak legacy palette or substitute a generic identity.
- Include selected source pages and assets as research context, page-level permitted facts with provenance, approved asset guidance, sitemap and page plans, assumptions, open questions, uncertainties, and the versioned builder contract. Stage a private content dossier for every selected source page, including captured text, headings, content blocks, forms, navigation, and component inventory where available.
- Treat selection as context, not permission to copy or reuse. Only explicitly human-approved asset guidance authorises an asset's visual reuse. Never expose signed URLs, model credentials, or raw private storage access in a browser-side manifest.
- The builder must create a complete mobile-first implementation from the manifest rather than imitate the flawed captured site. It must preserve the unresolved-question boundary, never invent business claims, and never publish, contact a prospect, or make a compliance guarantee.
- Every selected source page is a required coverage item, not merely optional inspiration. Map each one to a deterministic generated output path and verify it after build; fail quality review when a selected page is missing, mapped incorrectly, or lacks its source-provenance marker. The builder may rewrite, shorten, group, and improve captured copy, but must retain material services, operations, actions, forms/tools, legal content, and resource content unless a human explicitly excludes it.
- Keep manifests immutable. A changed strategy or completed recapture requires a new brief version and a new manifest; downstream builder and quality-check output must reference the manifest ID and builder-contract version used.
- Never mix a newer capture or Research Packet into an earlier approved brief. Manifest generation must verify the exact capture and packet IDs referenced by the brief; require a new reviewed brief when source evidence changes.
- Treat every website build as a durable, cancellable private worker run. Create a disposable Git workspace from the locked builder foundation, stage only its immutable manifest and approved assets, run Codex with the least workspace-write permission, and persist source, built files, responsive screenshots, logs, and quality results against the run.
- A generated preview is not a publication. Serve it only through expiring private access created for an authenticated workspace member. Preview CSP must block remote connections and form submission; external prospect sharing remains a separate human-approved workflow.
- Persist a concise, ordered builder-event timeline from queue through output saving. It may report concrete stages, changed file paths, browser checks, and safe failures; never expose prompts, raw model reasoning, secrets, or unredacted command output.
- A running build may expose a strictly private working draft only after a generated `index.html` has replaced the locked starter page. Store changed draft files incrementally and serve them through a separate short-lived draft capability. When a run stops without a finished preview, keep that capability as an explicitly labelled frozen diagnostic draft; finished previews remain a distinct, quality-reviewed capability.
- Classify a stopped build with a stable failure code, stage, retryability, plain-language explanation, recommended human action, attempt count, and redacted context. Preserve viewable partial work as a frozen draft for authenticated workspace members. A temporary model, network, or storage fault may retry once with a bounded delay; deterministic input, policy, compile, or render failures require an explicit clean rebuild from the immutable manifest.
- Do not treat a generated website with failed or review-needed automated checks as fully ready. Mark it as requiring quality review, allow internal preview, and keep any external sharing or publishing workflow blocked.

## Accessibility

- Meet WCAG 2.2 AA color contrast requirements.
- Use a visible focus indicator with at least 3:1 contrast against adjacent colors. Do not remove browser focus without a tested replacement.
- Use semantic HTML first. Every form field needs a programmatic label; every icon-only button needs an accessible name.
- Ensure keyboard navigation, logical focus order, visible focus indicators, and correct dialog focus management.
- Never convey required information by color alone. Respect `prefers-reduced-motion`.
- Provide text alternatives for meaningful images and ensure status messages, validation feedback, and dynamically updated content are announced appropriately.

## Implementation and verification

- Keep ESLint, Prettier, Playwright, and axe-core installed and configured. Do not remove or bypass their checks to make a change pass.
- Run Playwright's responsive and accessibility suites before handing off UI work. Update visual snapshots only after reviewing the new mobile, tablet, and desktop rendering.
- Treat visual snapshots as a change detector, not proof of design quality. Review the screenshots for hierarchy, spacing rhythm, alignment, state clarity, and responsive intent before accepting a snapshot update.
- Use TypeScript without `any` unless an exception is documented locally.
- Add or update focused tests for behavior changes. For UI work, add visual or end-to-end coverage when the workflow is important or likely to regress.
- Before handing off work, run the relevant formatter, type check, tests, and production build. Report any command that cannot be run.
- Do not claim a UI is responsive without recording which mobile, tablet, and desktop viewports were checked.
