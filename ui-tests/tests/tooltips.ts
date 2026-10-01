import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

import { expect } from './fixtures';

/**
 * The lines of the tooltip that a chip shows (design iteration 1.86): the
 * value as code, then the call. The tooltip comes after the pointer has
 * rested on the chip for a moment, so the helper waits for it, reads it, and
 * moves the pointer off the chip, which hides it.
 */
export async function tooltipLines(
  page: IJupyterLabPageFixture,
  chip: Locator
): Promise<string[]> {
  await chip.hover();
  const lines = page.locator('.jp-Epi-tooltip div');
  await expect(lines.first()).toBeVisible();
  const text = await lines.allTextContents();
  await page.mouse.move(2, 2);
  await expect(page.locator('.jp-Epi-tooltip')).toHaveCount(0);
  return text;
}
