import { expect, test } from '@playwright/test';

const expectedViewports = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
};

async function openReadyBuildManifest(page) {
  await page.goto('/');
  await expect(page.getByLabel('Loading SiteForge OS workspace')).toBeHidden();

  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = window.indexedDB.open('siteforge-os');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const now = new Date().toISOString();
    const businessId = 'business-demo-local-services';
    const brief = {
      id: 'brief-manifest-layout-check',
      businessId,
      researchPacketId: 'packet-manifest-layout-check',
      crawlRunId: 'capture-manifest-layout-check',
      status: 'approved',
      version: 1,
      sourceSelections: { pageUrls: [], assetIds: [], uncertainties: ['Confirm service area'] },
      draft: {
        strategy: 'Keep the redesign grounded in selected evidence.',
        proposedSitemap: [],
        pagePlans: [],
        assetGuidance: [],
        assumptions: [],
        openQuestions: ['Confirm service area'],
      },
      createdAt: now,
      updatedAt: now,
      approvedAt: now,
    };
    const manifest = {
      id: 'manifest-layout-check',
      businessId,
      redesignBriefId: brief.id,
      researchPacketId: brief.researchPacketId,
      crawlRunId: brief.crawlRunId,
      schemaVersion: 1,
      builderContractVersion: 'siteforge-codex-builder-v1',
      status: 'ready',
      generatedAt: now,
      createdAt: now,
      updatedAt: now,
      data: {
        source: {
          businessName: 'Demo Local Services',
          researchPacketId: brief.researchPacketId,
          crawlRunId: brief.crawlRunId,
          redesignBriefId: brief.id,
        },
        permittedFacts: [{ id: 'fact-1' }, { id: 'fact-2' }],
        selectedPages: [{ url: 'https://example.com/' }],
        selectedAssets: [{ artifactId: 'asset-1' }],
        approvedAssetGuidance: [],
        strategy: brief.draft.strategy,
        proposedSitemap: [],
        pagePlans: [],
        assumptions: [],
        openQuestions: brief.draft.openQuestions,
        uncertainties: brief.sourceSelections.uncertainties,
        builderRules: ['Use only permitted facts.', 'Keep the preview private.'],
      },
    };
    const transaction = database.transaction(['briefs', 'buildManifests'], 'readwrite');
    transaction.objectStore('briefs').put(brief);
    transaction.objectStore('buildManifests').put(manifest);
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  });

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.goto('/#/prospects/business-demo-local-services/redesign');
  await expect(page.getByRole('heading', { name: 'Build Manifest ready' })).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
}

test('uses the required viewport dimensions', async ({ page }, testInfo) => {
  const viewport = page.viewportSize();
  expect(viewport).toEqual(expectedViewports[testInfo.project.name]);
});

test('renders without unintended horizontal overflow', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#root')).not.toBeEmpty();

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
});

test('contains page content horizontally across workspace sections', async ({ page }) => {
  const sections = ['overview', 'research', 'assets', 'audit', 'brief', 'redesign', 'settings'];

  for (const section of sections) {
    await page.goto(`/#/prospects/business-demo-local-services/${section}`);
    await expect(page.getByLabel('Loading SiteForge OS workspace')).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  }
});

test('lays out asset selections as a responsive image grid', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<section class="asset-analysis-selection"><fieldset class="brief-assets">
        <label class="brief-source-option brief-source-option--asset"><input type="checkbox"><span class="brief-source-option__preview">Image</span><span class="brief-source-option__content">One</span></label>
        <label class="brief-source-option brief-source-option--asset"><input type="checkbox"><span class="brief-source-option__preview">Image</span><span class="brief-source-option__content">Two</span></label>
        <label class="brief-source-option brief-source-option--asset"><input type="checkbox"><span class="brief-source-option__preview">Image</span><span class="brief-source-option__content">Three</span></label>
      </fieldset></section>`,
    );
  });

  const items = page.locator('.asset-analysis-selection .brief-source-option');
  const [first, second] = await Promise.all([
    items.nth(0).boundingBox(),
    items.nth(1).boundingBox(),
  ]);
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();

  if (testInfo.project.name === 'mobile') {
    expect(second.y).toBeGreaterThan(first.y);
  } else {
    expect(Math.abs(second.y - first.y)).toBeLessThan(3);
  }
});

test('supports keyboard navigation', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');

  const activeTag = await page.evaluate(() => document.activeElement?.tagName);
  expect(activeTag).not.toBe('BODY');
});

test('opens prospect settings from the header and restores focus when dismissed', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByLabel('Loading SiteForge OS workspace')).toBeHidden();
  await page.goto('/#/prospects/business-demo-local-services/overview');

  const trigger = page.getByLabel('Open prospect settings');
  await expect(trigger).toBeVisible();
  await trigger.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Prospect settings' }).last()).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('transitions the workspace title from loading into navigation', async ({ page }) => {
  await page.goto('/');

  const loader = page.getByLabel('Loading SiteForge OS workspace');
  await expect(loader).toBeVisible();
  await expect(loader.locator('.workspace-loading__letters > span')).toHaveCount(12);
  await expect(loader).toHaveAttribute('data-phase', 'entering');
  await expect(loader).toBeHidden();
  await expect(page.locator('.brand--loading-hidden')).toHaveCount(0);
  await expect(page.locator('.brand').first()).toContainText('SiteForge OS');
});

test('gives the page a restrained elastic response at its scroll boundaries', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Loading SiteForge OS workspace')).toBeHidden();

  await page.evaluate(() => {
    window.scrollTo(0, 0);
    window.dispatchEvent(new WheelEvent('wheel', { cancelable: true, deltaY: -80 }));
  });
  await expect(page.locator('main')).toHaveAttribute('data-overscroll', 'top');

  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    window.dispatchEvent(new WheelEvent('wheel', { cancelable: true, deltaY: 80 }));
  });
  await expect(page.locator('main')).toHaveAttribute('data-overscroll', 'bottom');
});

test('uses a compact navigation drawer on mobile and tablet', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'This behavior is specific to compact layouts.');
  await page.goto('/');

  await expect(page.locator('.sidebar')).toBeHidden();
  const trigger = page.getByRole('button', { name: 'Open navigation menu' });
  const brand = page.locator('.mobile-header .brand');
  const [triggerBox, brandBox] = await Promise.all([trigger.boundingBox(), brand.boundingBox()]);
  expect(triggerBox).not.toBeNull();
  expect(brandBox).not.toBeNull();
  expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(brandBox.x);

  await trigger.click();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await expect(drawer).toBeVisible();
  const drawerBox = await drawer.boundingBox();
  expect(drawerBox).not.toBeNull();
  expect(drawerBox.width).toBeLessThan(353);
  const [todayBox, prospectsBox] = await Promise.all([
    drawer.getByRole('button', { name: 'Today' }).boundingBox(),
    drawer.getByRole('button', { name: 'Prospects' }).boundingBox(),
  ]);
  expect(todayBox).not.toBeNull();
  expect(prospectsBox).not.toBeNull();
  expect(Math.abs(prospectsBox.x - todayBox.x)).toBeLessThan(3);
  expect(prospectsBox.y).toBeGreaterThan(todayBox.y);

  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await drawer.getByRole('button', { name: 'Prospects' }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Prospects' })).toBeVisible();
});

test('uses a persistent desktop sidebar', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'This behavior is specific to the desktop shell.');
  await page.goto('/');

  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open navigation menu' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Today' }).first()).toBeVisible();
});

test('keeps the build manifest compact and reveals its safeguards on demand', async ({ page }) => {
  await openReadyBuildManifest(page);

  const summary = page.locator('.build-manifest-summary');
  const summaryItems = summary.locator('> div');
  await expect(summaryItems).toHaveCount(4);
  const [firstItem, secondItem] = await Promise.all([
    summaryItems.nth(0).boundingBox(),
    summaryItems.nth(1).boundingBox(),
  ]);
  expect(firstItem).not.toBeNull();
  expect(secondItem).not.toBeNull();
  expect(Math.abs(secondItem.y - firstItem.y)).toBeLessThan(3);
  await expect(page.locator('.brief-panel')).toHaveScreenshot('build-manifest-ready.png');

  const safeguards = page.locator('.build-manifest-boundaries');
  await expect(safeguards).not.toHaveAttribute('open', '');
  await safeguards.locator('summary').click();
  await expect(safeguards).toHaveAttribute('open', '');
  await expect(safeguards).toContainText('Permitted facts remain tied');

  const contract = page.locator('.build-manifest-contract');
  await expect(contract).not.toHaveAttribute('open', '');
  await contract.locator('summary').click();
  await expect(contract).toHaveAttribute('open', '');
  await expect(contract).toContainText('Keep the preview private.');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
});

test('opens the shared builder settings panel from the navigation settings page', async ({
  page,
}) => {
  await page.goto('/#/settings');

  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Builder settings' }).click();
  const panel = page.getByRole('dialog', { name: 'Builder settings' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('gpt-5.6');
  await expect(panel).toContainText('Workspace write only');

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.getByRole('button', { name: 'Builder settings' })).toBeFocused();
});

test('opens the same builder settings panel from the Redesign tab', async ({ page }) => {
  await page.goto('/#/prospects');
  await page.getByLabel('Public website URL').fill('builder-settings.example');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'View prospect' }).click();
  await page.getByRole('tab', { name: 'Redesign' }).click();

  await page.getByRole('button', { name: 'Builder settings' }).click();
  const panel = page.getByRole('dialog', { name: 'Builder settings' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Private, expiring links');
});

test('switches appearance mode from navigation and persists the selection', async ({
  page,
}, testInfo) => {
  await page.goto('/');

  const navigation =
    testInfo.project.name === 'desktop'
      ? page.locator('.sidebar')
      : await (async () => {
          await page.getByRole('button', { name: 'Open navigation menu' }).click();
          return page.getByRole('dialog', { name: 'Navigation' });
        })();
  const themeButton = navigation.getByRole('button', { name: 'Switch to dark mode' });

  await themeButton.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(navigation.getByRole('button', { name: 'Switch to light mode' })).toBeVisible();

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('renders workspace content with dark-mode surfaces', async ({ page }, testInfo) => {
  await page.goto('/#/prospects');
  await page.getByLabel('Public website URL').fill('dark-palette-check.example');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'View prospect' }).click();
  await page.getByRole('tab', { name: 'Packet' }).click();

  const navigation =
    testInfo.project.name === 'desktop'
      ? page.locator('.sidebar')
      : await (async () => {
          await page.getByRole('button', { name: 'Open navigation menu' }).click();
          return page.getByRole('dialog', { name: 'Navigation' });
        })();
  await navigation.getByRole('button', { name: 'Switch to dark mode' }).click();
  if (testInfo.project.name !== 'desktop') {
    await page.getByRole('button', { name: 'Close navigation menu' }).click();
  }

  await expect(page).toHaveScreenshot('dark-workspace.png', { fullPage: true });
});

test('creates a persistent prospect workspace from a public URL', async ({ page }) => {
  await page.goto('/#/prospects');
  await page.getByLabel('Public website URL').fill('acme-plumbing.example');
  await page.getByRole('button', { name: 'Create' }).click();

  await expect(page.getByRole('status')).toContainText('Prospect created');
  await expect(page.locator('.toast')).toBeVisible();
  await expect(page.locator('.toast')).toHaveCSS('animation-name', 'toast-in');
  const toastBox = await page.locator('.toast-region').boundingBox();
  expect(toastBox).not.toBeNull();
  expect(toastBox.x).toBeGreaterThanOrEqual(12);
  await page.getByRole('button', { name: 'View prospect' }).click();
  await expect(page.getByRole('heading', { name: 'Acme Plumbing' })).toBeVisible();
  await page.getByRole('tab', { name: 'Research' }).click();
  await expect(
    page.getByText('The website capture is queued for the protected worker'),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Assets' }).click();
  await expect(page.getByRole('heading', { name: 'Asset review' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No captured assets' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.getByRole('tab', { name: 'Research' }).click();
  await expect(page).toHaveURL(/\/research$/);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Research' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    page.getByText('The website capture is queued for the protected worker'),
  ).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Acme Plumbing' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Research' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Overview' }).click();
  const task = page.getByLabel('Verify business identity, services, and contact details.');
  await task.check({ force: true });
  await expect(task).toBeChecked();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Acme Plumbing' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(task).toBeChecked();
});

test('queues one private website capture and keeps its state after reload', async ({ page }) => {
  await page.goto('/#/prospects');
  await page.getByLabel('Public website URL').fill('capture-foundation.example');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'View prospect' }).click();
  await page.getByRole('tab', { name: 'Research' }).click();

  const capturePanel = page.locator('.research-capture');
  await expect(capturePanel).toContainText(
    'The website capture is queued for the protected worker',
  );
  await expect(
    capturePanel.getByRole('progressbar', { name: 'Website capture progress' }),
  ).toBeVisible();
  await expect(capturePanel.getByRole('button', { name: 'Capture queued' })).toBeDisabled();
  await expect(page.getByLabel('Refreshing website evidence')).toBeVisible();
  await expect(page.locator('.evidence-loading__fact')).toHaveCount(4);
  await expect(page.locator('.evidence-loading__screenshot')).toHaveCount(3);
  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(
    page.locator('.activity-row', {
      hasText:
        'Website capture requested. Discoverable public pages will remain private until a worker completes it.',
    }),
  ).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);

  await page.reload();
  await page.getByRole('tab', { name: 'Research' }).click();
  await expect(capturePanel).toContainText(
    'The website capture is queued for the protected worker',
  );
  await expect(capturePanel.getByRole('button', { name: 'Capture queued' })).toBeDisabled();
});

test('cancels a queued website capture without hiding the workspace', async ({ page }) => {
  await page.goto('/#/prospects');
  await page.getByLabel('Public website URL').fill('cancel-capture.example');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'View prospect' }).click();
  await page.getByRole('tab', { name: 'Research' }).click();

  await expect(page.getByRole('button', { name: 'Cancel capture' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel capture' }).click();

  await expect(page.getByText('Capture cancelled')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Capture website again' })).toBeEnabled();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
});

test('keeps long prospect names inside the viewport', async ({ page }, testInfo) => {
  if (testInfo.project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 568 });
  }

  const longDomain = `${'verylong'.repeat(20)}.example`;
  const longName = `Verylong${'verylong'.repeat(19)}`;
  await page.goto('/#/prospects');
  await page.getByLabel('Public website URL').fill(longDomain);
  await page.getByRole('button', { name: 'Create' }).click();

  const prospectName = page.locator('.prospect-row__identity strong', { hasText: longName });
  await expect(prospectName).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);

  await page.getByRole('button', { name: 'View prospect' }).click();
  await expect(page.getByRole('heading', { name: longName })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
});

test('keeps activity timestamps within their mobile and desktop rows', async ({ page }) => {
  await page.goto('/#/prospects');
  await page.getByLabel('Public website URL').fill('activity-date.example');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'View prospect' }).click();
  await page.getByRole('tab', { name: 'Activity' }).click();

  const row = page.locator('.activity-list .activity-row').first();
  const timestamp = row.locator('time');
  await expect(timestamp).toBeVisible();
  const [rowBox, timestampBox] = await Promise.all([row.boundingBox(), timestamp.boundingBox()]);
  expect(rowBox).not.toBeNull();
  expect(timestampBox).not.toBeNull();
  expect(timestampBox.x).toBeGreaterThanOrEqual(rowBox.x);
  expect(timestampBox.x + timestampBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
});

test('prevents duplicate prospect URLs and deletes a prospect after confirmation', async ({
  page,
}) => {
  await page.goto('/#/prospects');
  await page.getByLabel('Public website URL').fill('duplicate-check.example');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'View prospect' }).click();
  await page.getByRole('button', { name: 'Back to prospects' }).click();

  await page.getByLabel('Public website URL').fill('https://duplicate-check.example/');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('alert')).toHaveText('You already have this website as a prospect.');
  await expect(
    page.locator('.prospect-row__identity strong', { hasText: 'Duplicate Check' }),
  ).toHaveCount(1);

  await page.getByRole('button', { name: 'Duplicate Check' }).click();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Delete prospect' }).click();
  await expect(page.getByRole('dialog', { name: 'Delete this prospect?' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete prospect' }).last().click();
  await expect(page.getByRole('heading', { name: 'Prospects' })).toBeVisible();
  await expect(
    page.locator('.prospect-row__identity strong', { hasText: 'Duplicate Check' }),
  ).toHaveCount(0);

  await page.reload();
  await expect(
    page.locator('.prospect-row__identity strong', { hasText: 'Duplicate Check' }),
  ).toHaveCount(0);
});

test('matches the approved visual baseline', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Loading SiteForge OS workspace')).toBeHidden();
  await expect(page).toHaveScreenshot('siteforge-os.png', { fullPage: true });
});
