/**
 * The names and values in a question (design iterations 1.145 and 1.146). A
 * question of a join reads as its chip and names the frame it joins, in bold
 * in the font of the sentence: "What if the merge with b were an outer
 * join?". Another decision names its value, and the view shows the name and
 * the value in the code font: "What if ALPHA were 0.01?". The title of the
 * branch that a question makes shows them the same way. No model is called:
 * the questions of a chip come from the rules, and the fixture aborts each
 * request to a model's route.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

/** Write a notebook with these code cells. */
async function newNotebook(
  page: IJupyterLabPageFixture,
  file: string,
  code: string[]
): Promise<void> {
  const notebook = {
    cells: code.map((source, index) => ({
      cell_type: 'code',
      execution_count: null,
      id: `cell-${index}`,
      metadata: {},
      outputs: [],
      source
    })),
    metadata: {
      kernelspec: {
        display_name: 'Python 3 (ipykernel)',
        language: 'python',
        name: 'python3'
      }
    },
    nbformat: 4,
    nbformat_minor: 5
  };
  await page.contents.uploadContent(JSON.stringify(notebook), 'text', file);
}

/** Open a notebook in the Whybook view, run every cell, and wait for the kernel. */
async function openAndRun(
  page: IJupyterLabPageFixture,
  file: string
): Promise<void> {
  await page.evaluate(async (file: string) => {
    await (window as any).jupyterapp.commands.execute('docmanager:open', {
      path: file,
      factory: 'Whybook'
    });
  }, file);
  await expect(page.locator('.jp-Epi-bench')).toBeVisible();
  await expect(page.locator('.jp-Epi-bench .jp-Epi-loading')).toHaveCount(0);
  await page.waitForFunction(
    () =>
      (window as any).jupyterapp.shell.currentWidget?.context?.sessionContext
        ?.session?.kernel?.status === 'idle',
    null,
    { timeout: 120000 }
  );
  await page.locator('.jp-Epi-runall').click();
}

const QUESTION = '.jp-Epi-popover .jp-Epi-option .jp-Epi-option-text';

test('names the frame of a join in bold in the font of the sentence, in the words of its chip, in the list and in the title of its branch', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/merge.ipynb`;
  await newNotebook(page, file, [
    'import pandas as pd',
    'a = pd.DataFrame({"k": [1, 2], "x": [3, 4]})\nb = pd.DataFrame({"k": [1, 3], "y": [5, 6]})',
    'both = a.merge(b, on="k", how="left")\nboth'
  ]);
  await openAndRun(page, file);
  const chip = page
    .locator('.jp-Epi-bench .jp-Epi-cell[data-cell-id="cell-2"] .jp-Epi-chip')
    .filter({ hasText: 'left join' });
  await expect(chip).toBeVisible({ timeout: 60000 });
  await chip.click();
  const text = 'What if the merge with b were an outer join?';
  const question = page.locator(QUESTION).filter({ hasText: text });
  await expect(question).toHaveText(text);
  await expect(question.locator('.jp-Epi-inlinedata')).toHaveText('b');
  await expect(question.locator('code')).toHaveCount(0);
  const styles = (node: Element) => {
    const data = getComputedStyle(node.querySelector('.jp-Epi-inlinedata')!);
    return {
      sentence: getComputedStyle(node).fontFamily,
      font: data.fontFamily,
      weight: data.fontWeight
    };
  };
  const listed = await question.evaluate(styles);
  expect(listed.font).toBe(listed.sentence);
  expect(listed.weight).toBe('600');
  await question.click();
  const title = page.locator('.jp-Epi-bench .jp-Epi-title').filter({
    hasText: text
  });
  await expect(title).toBeVisible({ timeout: 60000 });
  await expect(title.locator('.jp-Epi-inlinedata')).toHaveText('b');
  const titled = await title.evaluate(styles);
  expect(titled.font).toBe(titled.sentence);
  expect(titled.weight).toBe('700');
});

test('shows the name and the value of a decision that is not a join in the code font, in the list and in the title of its branch', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/alpha.ipynb`;
  await newNotebook(page, file, [
    'ALPHA = 0.05\np_values = [0.01, 0.04, 0.2]\nsignificant = [p for p in p_values if p < ALPHA]\nlen(significant)'
  ]);
  await openAndRun(page, file);
  const chip = page.locator('.jp-Epi-chip', { hasText: 'ALPHA 0.05' });
  await expect(chip).toBeVisible({ timeout: 60000 });
  await chip.click();
  const text = 'What if ALPHA were 0.01?';
  const question = page.locator(QUESTION).filter({ hasText: text });
  await expect(question).toHaveText(text);
  await expect(question.locator('code.jp-Epi-inlinecode')).toHaveText([
    'ALPHA',
    '0.01'
  ]);
  // The code font, not the font of the sentence.
  const fonts = await question.evaluate(node => [
    getComputedStyle(node).fontFamily,
    getComputedStyle(node.querySelector('code')!).fontFamily
  ]);
  expect(fonts[1]).not.toBe(fonts[0]);
  await question.click();
  const title = page.locator('.jp-Epi-bench .jp-Epi-title').filter({
    hasText: text
  });
  await expect(title).toBeVisible({ timeout: 60000 });
  await expect(title.locator('code.jp-Epi-inlinecode')).toHaveText([
    'ALPHA',
    '0.01'
  ]);
});
