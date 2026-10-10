/**
 * The rows of Variables and their note (critique 5, the app, A18 and A9).
 *
 * - A18: a long class name ran past the right edge of the panel with no
 *   ellipsis, and the size beside it shrank to one character: "5" of
 *   "5,837 × 7". Now the size shows whole, and the type ends in an
 *   ellipsis, or does not show where fewer than about three letters fit
 *   (style/base.css). jsdom lays out nothing, so this test measures the
 *   rows in the browser, at the default width of the panel, 250 px.
 * - A9: during Run all, the note read "17 from the last run, not in the
 *   kernel. Run all", and offered a run that had already started. It now
 *   reads "Running all cells" until the names are listed, and does not
 *   offer Run all again in between.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures';

/** Write a notebook with these code cells and this `whybook` metadata. */
async function newNotebook(
  page: IJupyterLabPageFixture,
  file: string,
  code: string[],
  whybook: Record<string, unknown> = {}
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
      },
      whybook
    },
    nbformat: 4,
    nbformat_minor: 5
  };
  await page.contents.uploadContent(JSON.stringify(notebook), 'text', file);
}

/** Open a notebook in Whybook, and wait for its kernel. */
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
  await page.waitForFunction(
    () =>
      (window as any).jupyterapp.shell.currentWidget?.context?.sessionContext
        ?.session?.kernel?.status === 'idle',
    null,
    { timeout: 120000 }
  );
}

function row(page: IJupyterLabPageFixture, name: string): Locator {
  return page.locator(
    `.jp-Epi-variables .jp-Epi-variable[data-variable="${name}"]`
  );
}

/**
 * How a row lays out: whether the name and the size show whole, whether
 * the type's word shows and is cut, the room that the word has, and the
 * space after the word or its ellipsis.
 */
async function layout(target: Locator) {
  return target.evaluate(node => {
    const box = (element: Element) => element.getBoundingClientRect();
    const whole = (element: Element) =>
      element.scrollWidth <= element.clientWidth;
    const name = node.querySelector('.jp-Epi-item-name')!;
    const type = node.querySelector('.jp-Epi-item-type')!;
    const word = type.querySelector('span')!;
    const size = node.querySelector('.jp-Epi-item-shape');
    const style = getComputedStyle(word);
    const em = parseFloat(style.fontSize);
    // The word wraps onto a second line of the type's box, out of sight,
    // where it does not fit.
    const shown = box(word).width > 0 && box(word).top < box(type).bottom - 1;
    // The word's own box clips it; a constant's type is a line of text in
    // the type's box.
    const clip = style.display === 'inline' ? type : word;
    const cut = shown && !whole(clip);
    // Where the ellipsis ends: after the longest start of the word that
    // fits with it, as the browser places it.
    const canvas = document.createElement('canvas').getContext('2d')!;
    canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const width = (text: string) => canvas.measureText(text).width;
    const text = word.textContent ?? '';
    let end = box(word).left + width(text);
    let next = text[0] ?? '';
    if (cut) {
      let fit = 0;
      while (
        fit < text.length &&
        width(text.slice(0, fit + 1)) + width('…') <= box(word).width
      ) {
        fit++;
      }
      end = box(word).left + width(text.slice(0, fit)) + width('…');
      next = text[fit];
    }
    const rowStyle = getComputedStyle(node);
    const after = size
      ? box(size).left
      : box(node).right -
        parseFloat(rowStyle.paddingRight) -
        parseFloat(rowStyle.borderRightWidth);
    return {
      nameWhole: whole(name),
      sizeWhole: size ? whole(size) : null,
      size: size?.textContent ?? null,
      shown,
      cut,
      // The room that the word has, in ems of its font.
      room: box(word).width / em,
      // A part runs past the edge of the row.
      overflows: node.scrollWidth > node.clientWidth,
      // The space after the word or its ellipsis, up to the gap before the
      // size, or else up to the row's padding; and the width of the letter
      // in the place of which the ellipsis stands.
      spaceAfter: after - end - (size ? parseFloat(rowStyle.columnGap) : 0),
      letter: width(next)
    };
  });
}

test('shows the size whole, cuts a long type with an ellipsis, and leaves out a type that has no room', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/rows.ipynb`;
  await newNotebook(page, file, [
    [
      'import numpy as np',
      'import pandas as pd',
      '',
      '',
      'class MixedLMResultsWrapper:',
      '    """A long class name, as statsmodels gives a fit, and no size."""',
      '',
      '',
      'class MixedLMResultsWrapperList(list):',
      '    """A long class name with a size: its items."""',
      '',
      '',
      'model_data_by_age = pd.DataFrame(np.zeros((5837, 7)))',
      'lmm_fit_by_age = MixedLMResultsWrapper()',
      'fits = MixedLMResultsWrapperList(range(12))',
      'REPORT_TITLE = "Knee pain study, weekly visits, both arms"'
    ].join('\n')
  ]);
  await openInWhybook(page, file);
  await page.locator('.jp-Epi-runall').click();
  await expect(row(page, 'REPORT_TITLE')).toBeVisible({ timeout: 60000 });
  // The default width of JupyterLab's left panel, padding included.
  await page.locator('.jp-Epi-variables').evaluate(node => {
    (node as HTMLElement).style.boxSizing = 'border-box';
    (node as HTMLElement).style.width = '250px';
  });

  // The name and the size take the row: the room left holds "D" of
  // DataFrame, and the type does not show.
  const frame = await layout(row(page, 'model_data_by_age'));
  expect(frame).toMatchObject({
    nameWhole: true,
    size: '5,837 × 7',
    sizeWhole: true,
    shown: false,
    overflows: false
  });
  expect(frame.room).toBeLessThan(2.5);

  // A long type ends in an ellipsis inside the row, with no size after it.
  const fit = await layout(row(page, 'lmm_fit_by_age'));
  expect(fit).toMatchObject({
    nameWhole: true,
    size: null,
    shown: true,
    cut: true,
    overflows: false
  });
  // The space after the ellipsis is less than one more letter: the row's
  // padding, as wide as the gap between two parts, follows it.
  expect(fit.spaceAfter).toBeLessThan(fit.letter);
  await expect(row(page, 'lmm_fit_by_age')).toHaveAttribute(
    'title',
    '__main__.MixedLMResultsWrapper'
  );

  // A long type before a size: the type ends in an ellipsis, then the gap,
  // then the size, whole.
  const fits = await layout(row(page, 'fits'));
  expect(fits).toMatchObject({
    nameWhole: true,
    size: '12 items',
    sizeWhole: true,
    shown: true,
    cut: true,
    overflows: false
  });
  expect(fits.room).toBeGreaterThanOrEqual(2.5);
  expect(fits.spaceAfter).toBeLessThan(fits.letter);

  // A constant's value can be long: it is cut, and its type shows whole.
  const constant = row(page, 'REPORT_TITLE');
  await expect(constant.locator('.jp-Epi-item-type')).toHaveText('str');
  const value = await layout(constant);
  expect(value).toMatchObject({
    nameWhole: true,
    sizeWhole: false,
    shown: true,
    cut: false,
    overflows: false
  });
});

test('reads "Running all cells" in the note of Variables during Run all, and does not offer Run all again before the names are listed', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/kept.ipynb`;
  // The notebook kept diary from its last run; its one cell makes it in 3 s.
  await newNotebook(
    page,
    file,
    ['import time\n\ntime.sleep(3)\ndiary = [1, 2, 3]'],
    {
      variables: [
        {
          name: 'diary',
          label: 'diary',
          kind: 'other',
          type: 'builtins.list',
          length: 3,
          cell: 'cell-0'
        }
      ]
    }
  );
  await openInWhybook(page, file);
  const note = page.locator('.jp-Epi-variables .jp-Epi-stale-note');
  await expect(note).toHaveText(
    '1 from the last run, not in the kernel. Run all'
  );
  // Every text that the note shows from now on, and null once it goes.
  await page.evaluate(() => {
    const section = document.querySelector('.jp-Epi-variables')!;
    const text = () =>
      section.querySelector('.jp-Epi-stale-note')?.textContent ?? null;
    const seen = [text()];
    (window as any).epiNotes = seen;
    new MutationObserver(() => {
      if (seen[seen.length - 1] !== text()) {
        seen.push(text());
      }
    }).observe(section, {
      subtree: true,
      childList: true,
      characterData: true
    });
  });
  await note.getByRole('button', { name: 'Run all' }).click();
  await expect(note).toHaveText('Running all cells...');
  await expect(note.getByRole('button')).toHaveCount(0);
  await expect(row(page, 'diary')).not.toHaveClass(/jp-mod-stale/, {
    timeout: 60000
  });
  await expect(note).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).epiNotes)).toEqual([
    '1 from the last run, not in the kernel. Run all',
    'Running all cells...',
    null
  ]);
});
