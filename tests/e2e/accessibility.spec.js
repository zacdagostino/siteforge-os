import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('has no automatically detectable accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(page.getByLabel('Loading SiteForge OS workspace')).toBeHidden();

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
