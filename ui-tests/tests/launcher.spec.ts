import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

/**
 * The Whybook section of JupyterLab's launcher (design iteration 1.72): a
 * card for each kernelspec of the test server, the default first, with the
 * kernel's name and the logo that Whybook draws, and Whybook's icon in the
 * header; a card opens a notebook with its kernel in the Whybook view.
 */

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    const sessions = (window as any).jupyterapp.serviceManager.sessions;
    await sessions.shutdownAll();
  });
});

interface IKernel {
  name: string;
  display: string;
  logo: boolean;
}

/**
 * The test server's kernelspecs in the order of the cards: the default
 * first, then by name, as the launcher sorts its sections.
 */
async function kernels(page: IJupyterLabPageFixture): Promise<IKernel[]> {
  return page.evaluate(async () => {
    const manager = (window as any).jupyterapp.serviceManager.kernelspecs;
    await manager.ready;
    const specs = manager.specs;
    const all = Object.values(specs.kernelspecs).map((spec: any) => ({
      name: spec.name as string,
      display: spec.display_name as string,
      logo: !!(spec.resources['logo-svg'] || spec.resources['logo-64x64'])
    }));
    return [
      ...all.filter(kernel => kernel.name === specs.default),
      ...all
        .filter(kernel => kernel.name !== specs.default)
        .sort((a, b) => a.display.localeCompare(b.display))
    ];
  });
}

/**
 * A new launcher in front, in a folder. The file browser of this JupyterLab
 * is jupyterlab-unfold's tree, which galata's openDirectory cannot use.
 */
async function openLauncher(page: IJupyterLabPageFixture, cwd = '') {
  await page.evaluate(
    cwd =>
      (window as any).jupyterapp.commands
        .execute('launcher:create', { cwd })
        .then(() => null),
    cwd
  );
  return page.locator('.jp-Launcher:visible');
}

test('the launcher has a Whybook section with a card for each kernel, the default first', async ({
  page
}) => {
  const expected = await kernels(page);
  const launcher = await openLauncher(page);
  const cards = launcher.locator('.jp-LauncherCard[data-category="Whybook"]');
  await expect(cards.locator('.jp-LauncherCard-label')).toHaveText(
    expected.map(kernel => kernel.display)
  );
  // Right after Notebook, which keeps its kernels, and no Whybook card.
  const titles = await launcher
    .locator('.jp-Launcher-sectionTitle')
    .allTextContents();
  expect(titles.indexOf('Whybook')).toBe(titles.indexOf('Notebook') + 1);
  await expect(
    launcher.locator(
      '.jp-LauncherCard[data-category="Notebook"] .jp-LauncherCard-label'
    )
  ).toHaveText(expected.map(kernel => kernel.display));

  // Each card shows its kernel's logo, fetched from the server, or the
  // first letter of the kernel's name; Whybook's icon stays hidden there.
  for (const [index, kernel] of expected.entries()) {
    const icon = cards
      .nth(index)
      .locator(`svg[data-icon="whybook:kernel-${kernel.name}"]`);
    const face = icon.locator('.jp-Epi-launcher-logo');
    await expect(face).toBeVisible();
    if (kernel.logo) {
      await expect(face).toHaveAttribute(
        'href',
        /^data:image\/(svg\+xml|png);base64,/
      );
    } else {
      await expect(face).toHaveText(kernel.display.charAt(0).toUpperCase());
    }
    await expect(icon.locator('.jp-Epi-launcher-mark')).toBeHidden();
  }

  // The header takes the first card's icon, and shows Whybook's.
  const header = launcher
    .locator('.jp-Launcher-section')
    .filter({
      has: page.getByRole('heading', { name: 'Whybook', exact: true })
    })
    .locator('.jp-Launcher-sectionHeader');
  await expect(header.locator('.jp-Epi-launcher-mark')).toBeVisible();
  await expect(header.locator('.jp-Epi-launcher-logo')).toBeHidden();
});

test("a card opens a notebook with its kernel in the Whybook view, in the launcher's folder", async ({
  page,
  tmpPath
}) => {
  const all = await kernels(page);
  // "SAS (licence needed)", which is not the default kernel, starts in a
  // second and runs no code. Without it, the default kernel.
  const kernel = all.find(item => item.name === 'sas-licence-needed') ?? all[0];
  const launcher = await openLauncher(page, tmpPath);
  await expect(launcher.locator('.jp-Launcher-cwd')).toHaveText(tmpPath);
  await launcher
    .locator('.jp-LauncherCard[data-category="Whybook"]')
    .filter({ has: page.getByText(kernel.display, { exact: true }) })
    .click();

  // The empty notebook's view, in place of the launcher.
  await expect(page.locator('.jp-Epi-start:visible')).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const widget = (window as any).jupyterapp.shell.currentWidget;
          return {
            path: widget?.context?.path ?? null,
            view: widget?.content?.hasClass?.('jp-Epi') ?? false,
            kernel:
              widget?.context?.sessionContext?.session?.kernel?.name ?? null
          };
        }),
      { timeout: 60000 }
    )
    .toEqual({
      path: `${tmpPath}/Untitled.ipynb`,
      view: true,
      kernel: kernel.name
    });
});
