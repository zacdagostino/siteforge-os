import { expect, test } from '@playwright/test';

const expectedViewports = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
};

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

test('supports keyboard navigation', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');

  const activeTag = await page.evaluate(() => document.activeElement?.tagName);
  expect(activeTag).not.toBe('BODY');
});

test('uses a compact mobile navigation drawer', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'This behavior is specific to the mobile shell.');
  await page.goto('/');

  await expect(page.locator('.sidebar')).toBeHidden();
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('link', { name: 'Pipeline' }).click();
  await expect(drawer).toBeHidden();
});

test('uses a persistent desktop sidebar', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'This behavior is specific to the desktop shell.');
  await page.goto('/');

  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open navigation menu' })).toBeHidden();
});

test('creates a prospect and updates its task state', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Public website URL').fill('acme-plumbing.example');
  await page.getByRole('button', { name: 'Run' }).click();

  await expect(page.getByText('Acme Plumbing', { exact: true }).first()).toBeVisible();
  const task = page.getByLabel('Verify business identity, services, and contact details.');
  await task.check();
  await expect(task).toBeChecked();
});

test('matches the approved visual baseline', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveScreenshot('siteforge-os.png', { fullPage: true });
});
