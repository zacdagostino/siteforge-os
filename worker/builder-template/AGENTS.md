# SiteForge Preview Builder

Build a complete, high-quality static business website in `src/` from `../input/manifest.json`.

- The manifest is the source of truth. Do not edit it or invent claims, reviews, credentials, prices, guarantees, locations, contact details, services, or testimonials.
- `../input/source-pages/index.json` lists every selected source page. Build every listed `outputPath`; for each one, read its linked content file and add a `siteforge-source-url` meta tag containing that entry's exact `sourceUrl`.
- Treat captured paragraphs, headings, lists, forms, navigation, tools, legal content, and calls to action as content to improve, not disposable filler. Rewrite and shorten it when that makes the page clearer, but retain necessary information and do not strengthen or add claims.
- `approvedCapabilities` in the manifest is the only approved dynamic scope. For managed content, authentication, payments, external integrations, or server-side workflows, make an honest front-end preview of the approved visitor flow and add `src/BUILD_NOTES.md` describing the required production service, data, and approval boundary. Never invent credentials, live submissions, transactions, account data, or a working backend.
- Assets in `src/assets/` are the only approved visual assets that may be reused. Do not fetch remote images, fonts, scripts, stylesheets, or libraries.
- Create all required pages as static HTML files in `src/` and use relative links and paths only. The private preview host serves this directory beneath a protected path.
- Build mobile-first, then provide intentional tablet and desktop layouts. Do not merely shrink a desktop layout.
- Use semantic landmarks, one logical H1 per page, labelled forms, visible focus styles, accessible contrast, keyboard-friendly navigation, and reduced-motion behaviour.
- Keep the locked `src/main.js` file and reference it with a local `<script src="main.js"></script>` on every generated page. It provides SiteForge's built-in progressive viewport motion for headings and containers. When captured content presents a factual number as a metric, use `data-counter` when it improves scanning; never invent a metric, add a motion dependency, a remote script, or motion that hides essential content.
- Use a distinctive, restrained design appropriate to the business. Avoid generic AI visual clutter, fake badges, decorative gradients, unsupported trust claims, and stock-like placeholders.
- Keep source HTML, CSS, and JavaScript maintainable. Use custom properties as design tokens and reusable component classes where repetition exists.
- Do not edit `package.json`, `scripts/`, or files outside `src/`. Run `npm run build` before finishing.
