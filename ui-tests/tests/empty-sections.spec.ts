/**
 * A section of the bench that holds no cells, such as a heading followed at
 * once by another heading, shows its heading alone, with no "0 cells" count
 * and no expander (design iteration 1.142). The sweep of real notebooks
 * found 75 such sections in 8 notebooks; the top of chapter 12 of Python
 * Polars: The Definitive Guide has five in a row. The other sections keep
 * their count and their expander, and every section keeps its number.
 *
 * No kernel runs and no model is called: the fixture aborts each request to
 * a model's route.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

async function openInWhybook(
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
}

test('a heading followed at once by another heading shows alone, with no count and no expander', async ({
  page,
  tmpPath
}) => {
  const text = (id: string, source: string) => ({
    cell_type: 'markdown',
    id,
    metadata: {},
    source
  });
  const code = (id: string, source: string) => ({
    cell_type: 'code',
    execution_count: null,
    id,
    metadata: {},
    outputs: [],
    source
  });
  const file = `${tmpPath}/sections.ipynb`;
  const notebook = {
    cells: [
      text('title', '# Chapter 12. Working with strings'),
      code('import', 'import polars as pl'),
      text('string', '## String'),
      text('methods', '### String Methods'),
      text('conversion', '### String methods for conversion'),
      text('examples', '## String Examples'),
      code('corpus', 'corpus = pl.DataFrame({"text": ["a", "b"]})')
    ],
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
  await openInWhybook(page, file);
  const heads = page.locator('.jp-Epi-bench .jp-Epi-sectionhead');
  await expect(heads).toHaveText([
    '§0Notebook1 cell',
    '§1String',
    '§2String Methods',
    '§3String methods for conversion',
    '§4String Examples1 cell'
  ]);
  // The heads of the sections with cells fold them; the others are no
  // button and have no expander.
  await expect(
    page.locator('.jp-Epi-bench button.jp-Epi-sectionhead')
  ).toHaveText(['§0Notebook1 cell', '§4String Examples1 cell']);
  await expect(
    page.locator(
      '.jp-Epi-bench .jp-Epi-sectionhead.jp-mod-empty .jp-Epi-chevron'
    )
  ).toHaveCount(0);
  await expect(
    page.locator('.jp-Epi-bench .jp-Epi-sectionhead .jp-Epi-chevron')
  ).toHaveCount(2);
});
