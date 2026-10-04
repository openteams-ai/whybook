/**
 * Settings that explain themselves (design iteration 1.78): JupyterLab's
 * settings editor shows the choices of a setting with a visual meaning as
 * cards, each with a picture, its title and one short line, in the manner
 * of GNOME's settings.
 *
 * - The level of detail of outputs: three cards, Full checked by default,
 *   the description once and above the cards; a click and an arrow key save
 *   a pick, which the editor marks as changed, with the default by its title.
 * - The Check-up's icon on tabs, in the Check-up's own settings: a pick saves.
 */
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

/** The settings that the editor saved for a plugin, as JSON text. */
async function savedRaw(page: Page, plugin: string): Promise<string> {
  return page.evaluate(
    async id =>
      (await (window as any).jupyterapp.serviceManager.settings.fetch(id)).raw,
    plugin
  );
}

/** Open the settings editor on the Whybook entries, and show one of them. */
async function openSettings(page: Page, entryTitle: string, group: string) {
  await page.evaluate(async () => {
    await (window as any).jupyterapp.commands.execute('settingeditor:open', {
      query: 'Whybook'
    });
  });
  const cards = page.getByRole('radiogroup', { name: group });
  // The editor lists the plugins that match; a click shows a plugin's form.
  const entry = page
    .locator('.jp-PluginList-entry')
    .filter({ hasText: new RegExp(`^${entryTitle}$`) })
    .first();
  await expect(cards.or(entry).first()).toBeVisible({ timeout: 30000 });
  if (!(await cards.isVisible())) {
    await entry.click();
  }
  await expect(cards).toBeVisible({ timeout: 30000 });
  return cards;
}

test('shows the levels of detail of outputs as cards, and saves a pick from a click and from the keys', async ({
  page
}) => {
  const group = await openSettings(
    page,
    'Whybook',
    'Level of detail of outputs'
  );
  const cards = group.getByRole('radio');
  await expect(cards).toHaveCount(3);
  const overview = group.getByRole('radio', { name: 'Overview', exact: true });
  const compact = group.getByRole('radio', { name: 'Compact', exact: true });
  const full = group.getByRole('radio', { name: 'Full', exact: true });
  // Each card has its picture, its title and one short line.
  await expect(group.locator('svg.jp-Epi-pic')).toHaveCount(3);
  await expect(compact).toHaveAccessibleDescription(
    'Tables scaled down, short texts'
  );
  await expect(full).toContainText('Small tables in full, large plots');
  // Full, the default, is checked, and alone takes Tab.
  await expect(full).toHaveAttribute('aria-checked', 'true');
  await expect(overview).toHaveAttribute('aria-checked', 'false');
  await expect(full).toHaveAttribute('tabindex', '0');
  await expect(compact).toHaveAttribute('tabindex', '-1');

  // The title and the description once each, the description above the
  // cards: the editor's own copy under the field is hidden.
  const row = page.locator('.form-group', { has: group }).last();
  await expect(
    row.getByText('Level of detail of outputs', { exact: true })
  ).toHaveCount(1);
  const description = row
    .getByText(/^How much of each output the bench shows\./)
    .filter({ visible: true });
  await expect(description).toHaveCount(1);
  const above = await description.boundingBox();
  const cardsBox = await group.boundingBox();
  expect(above!.y + above!.height).toBeLessThanOrEqual(cardsBox!.y);

  // A click saves the pick.
  await compact.click();
  await expect(compact).toHaveAttribute('aria-checked', 'true');
  await expect(full).toHaveAttribute('aria-checked', 'false');
  await expect
    .poll(() => savedRaw(page, 'whybook:plugin'))
    .toContain('"outputDetail": "compact"');
  // The row is marked as changed, and gives the default by its title.
  await expect(row.locator('.jp-Epi-choicefield-default')).toHaveText(
    'Default: Full'
  );
  await expect(row.locator('.jp-FormGroup-default')).toBeHidden();

  // The arrow keys move the pick and the focus, and save.
  await expect(compact).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(overview).toBeFocused();
  await expect(overview).toHaveAttribute('aria-checked', 'true');
  await expect
    .poll(() => savedRaw(page, 'whybook:plugin'))
    .toContain('"outputDetail": "overview"');
});

test("shows the Check-up's icon on tabs as cards in the Check-up's settings, and saves a pick", async ({
  page
}) => {
  const group = await openSettings(
    page,
    'Whybook check-up',
    "The Check-up's icon on tabs"
  );
  await expect(group.getByRole('radio')).toHaveText([
    'OffNo icon on tabs',
    'Notebooks in WhybookOn the tabs of notebooks open in Whybook',
    'Every notebookOn the tabs of every notebook'
  ]);
  const every = group.getByRole('radio', { name: 'Every notebook' });
  await expect(
    group.getByRole('radio', { name: 'Notebooks in Whybook' })
  ).toHaveAttribute('aria-checked', 'true');
  await every.click();
  await expect(every).toHaveAttribute('aria-checked', 'true');
  await expect
    .poll(() => savedRaw(page, 'whybook:checkup'))
    .toContain('"tabQuestion": "notebooks"');
});
