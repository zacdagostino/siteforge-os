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
