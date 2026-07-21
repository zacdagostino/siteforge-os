# SiteForge Codex Builder Contract v2

The builder receives an approved Build Manifest, a private content dossier for every selected source page, and only private, server-side access to the referenced approved assets. The manifest and source-page dossier are the source of truth for content, information architecture, permissions, visual identity, and unresolved questions.

The builder must create a complete mobile-first implementation. It must not treat the captured website as a visual template, invent business claims, reuse an asset without approved asset guidance, publish an output, or contact a prospect. Uncertainties remain visible for human review.

When the manifest contains a Brand Kit, the builder must use its primary logo asset in the site header and footer and use its reviewed primary and accent values as brand tokens. It must derive accessible ink, background, surface, muted, and border tokens to create a coherent modern system rather than copying a weak legacy palette. It must use permitted supporting imagery only in the roles authorised by the manifest. It must never replace this evidence with a generic wordmark or palette, and it must not use third-party/client marks as the organisation logo.

Every selected source page is required output. The private source-page index assigns it a deterministic output path, and each matching HTML file must record its exact source URL in a `siteforge-source-url` meta tag. The builder may rewrite and condense captured copy for clarity and conversion, but it must retain material services, operational details, calls to action, forms/tools, legal content, and resource content without strengthening claims.

The builder's implementation must use semantic HTML, accessible keyboard and form behaviour, responsive layouts, design tokens, reusable components, and performance-conscious assets. It must return a build result and quality-check evidence to a future SiteForge builder worker; it does not modify the manifest.
