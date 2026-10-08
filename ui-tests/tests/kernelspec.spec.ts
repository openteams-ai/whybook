import { expect, test } from './fixtures';

/**
 * A notebook made in Whybook names its kernel in the file (src/model/kernelspec.ts).
 * It was saved with the empty kernelspec of a new notebook model, so it asked
 * which kernel to start when it opened again, and nbconvert could not tell.
 */

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    const sessions = (window as any).jupyterapp.serviceManager.sessions;
    await sessions.shutdownAll();
  });
});

test('a notebook made from the Whybook launcher saves the kernel it runs', async ({
  page,
  tmpPath
}) => {
  const kernel = await page.evaluate(async () => {
    const manager = (window as any).jupyterapp.serviceManager.kernelspecs;
    await manager.ready;
    const name = manager.specs.default as string;
    const spec = manager.specs.kernelspecs[name];
    return {
      name,
      display: spec.display_name as string,
      language: spec.language as string
    };
  });
  await page.evaluate(
    cwd =>
      (window as any).jupyterapp.commands
        .execute('launcher:create', { cwd })
        .then(() => null),
    tmpPath
  );
  await page
    .locator('.jp-Launcher:visible .jp-LauncherCard[data-category="Whybook"]')
    .filter({ has: page.getByText(kernel.display, { exact: true }) })
    .click();
  await expect(page.locator('.jp-Epi-start:visible')).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as any).jupyterapp.shell.currentWidget?.context
              ?.sessionContext?.session?.kernel?.name ?? null
        ),
      { timeout: 60000 }
    )
    .toBe(kernel.name);

  // The view writes the kernelspec once the kernel's spec is read, and the
  // language once the kernel's info reply comes; then the file is saved.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const model = (window as any).jupyterapp.shell.currentWidget?.context
            ?.model;
          return [
            model?.getMetadata('kernelspec')?.name ?? null,
            model?.getMetadata('language_info')?.name ?? null
          ];
        }),
      { timeout: 30000 }
    )
    .toEqual([kernel.name, kernel.language.toLowerCase()]);
  await page.evaluate(() =>
    (window as any).jupyterapp.commands
      .execute('docmanager:save')
      .then(() => null)
  );
  const saved = await page.evaluate(async path => {
    const file = await (window as any).jupyterapp.serviceManager.contents.get(
      path,
      { content: true }
    );
    return {
      kernelspec: file.content.metadata.kernelspec,
      language: file.content.metadata.language_info?.name ?? null
    };
  }, `${tmpPath}/Untitled.ipynb`);
  expect(saved.kernelspec).toEqual({
    name: kernel.name,
    display_name: kernel.display,
    language: kernel.language
  });
  expect(saved.language).toBe(kernel.language.toLowerCase());
});
