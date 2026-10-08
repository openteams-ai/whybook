/**
 * The data nodes of the map grow with the names of their frames, up to
 * 180 px, and a longer name is cut with an ellipsis inside its node, whole
 * in its title and in the button's text, which a screen reader reads
 * (design iteration 1.104). In the YRBS demo video, the name
 * yrbs2025_codebook ran past the edge of its node, 110 px wide whatever the
 * name.
 *
 * No model is called: the test runs one cell of its own.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

const LONG = 'stdint_standardized_bootstrap_result';

const SOURCE = [
  'import pandas as pd',
  '',
  'd = pd.DataFrame({"a": [1, 2]})',
  'yrbs2025_codebook = pd.DataFrame({"variable": ["sex"], "label": ["Sex"]})',
  `${LONG} = pd.DataFrame({"estimate": [1.2]})`
].join('\n');

/** Where a data node and its name are, in pixels of the page. */
interface INodeBox {
  node: { left: number; right: number; width: number };
  /** The element that holds the name, and how wide its text is. */
  holder: {
    left: number;
    right: number;
    clientWidth: number;
    scrollWidth: number;
    overflowX: string;
    textOverflow: string;
  };
  /** The text of the name, drawn or not. */
  text: { left: number; right: number };
  /** The node's width in the map's own pixels, before the zoom. */
  layoutWidth: number;
}

async function nodeBox(
  page: IJupyterLabPageFixture,
  name: string
): Promise<INodeBox> {
  return page.evaluate(name => {
    const node = document.querySelector<HTMLElement>(
      `.jp-Epi-map-frame[data-variable="${name}"]`
    )!;
    const holder =
      node.querySelector<HTMLElement>('.jp-Epi-map-frame-name') ?? node;
    const range = document.createRange();
    range.selectNodeContents(holder);
    const box = node.getBoundingClientRect();
    const held = holder.getBoundingClientRect();
    const text = range.getBoundingClientRect();
    const style = getComputedStyle(holder);
    return {
      node: { left: box.left, right: box.right, width: box.width },
      holder: {
        left: held.left,
        right: held.right,
        clientWidth: holder.clientWidth,
        scrollWidth: holder.scrollWidth,
        overflowX: style.overflowX,
        textOverflow: style.textOverflow
      },
      text: { left: text.left, right: text.right },
      layoutWidth: node.offsetWidth
    };
  }, name);
}

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    const sessions = (window as any).jupyterapp.serviceManager.sessions;
    await sessions.shutdownAll();
  });
});

test('a data node grows with a long name, and cuts a longer one inside the node with the whole name in its title', async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/names.ipynb`;
  const notebook = {
    cells: [
      {
        cell_type: 'code',
        execution_count: null,
        id: 'frames',
        metadata: { whybook: { title: 'Make three frames' } },
        outputs: [],
        source: SOURCE
      }
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
  await page.evaluate(async (file: string) => {
    await (window as any).jupyterapp.commands.execute('docmanager:open', {
      path: file,
      factory: 'Whybook'
    });
  }, file);
  await expect(page.locator('.jp-Epi-bench')).toBeVisible();
  await page.waitForFunction(
    () =>
      (window as any).jupyterapp.shell.currentWidget?.context?.sessionContext
        ?.session?.kernel?.status === 'idle',
    null,
    { timeout: 120000 }
  );
  await page.locator('.jp-Epi-runall').click();
  await expect(
    page.locator(`.jp-Epi-variable:not(.jp-mod-stale)[data-variable="${LONG}"]`)
  ).toBeVisible({ timeout: 60000 });

  await page.locator('.jp-Epi-views [data-value="map"]').click();
  await expect(page.locator('.jp-Epi-map-frame')).toHaveCount(3);
  for (const name of ['d', 'yrbs2025_codebook', LONG]) {
    await expect(
      page.locator(`.jp-Epi-map-frame[data-variable="${name}"]`)
    ).toHaveText(name);
  }
  await expect(page.locator('.jp-Epi-map-frame.jp-mod-stale')).toHaveCount(0);

  // A short name keeps the node of before.
  const short = await nodeBox(page, 'd');
  expect(short.layoutWidth).toBe(110);

  // The whole of yrbs2025_codebook is inside its node, which grew for it.
  const codebook = await nodeBox(page, 'yrbs2025_codebook');
  expect(codebook.text.left).toBeGreaterThanOrEqual(codebook.node.left);
  expect(codebook.text.right).toBeLessThanOrEqual(codebook.node.right);
  expect(codebook.holder.scrollWidth).toBeLessThanOrEqual(
    codebook.holder.clientWidth
  );
  expect(codebook.layoutWidth).toBeGreaterThan(110);
  expect(codebook.layoutWidth).toBeLessThanOrEqual(180);

  // A longer name is longer than the room: the element that holds it lies
  // inside the node and cuts it there with an ellipsis, and the node stops
  // at 180 px.
  const long = await nodeBox(page, LONG);
  expect(long.holder.overflowX).not.toBe('visible');
  expect(long.holder.textOverflow).toBe('ellipsis');
  expect(long.holder.scrollWidth).toBeGreaterThan(long.holder.clientWidth);
  expect(long.holder.left).toBeGreaterThanOrEqual(long.node.left);
  expect(long.holder.right).toBeLessThanOrEqual(long.node.right);
  expect(long.layoutWidth).toBe(180);

  // The whole name on hover, and for a screen reader, which reads the
  // button's text.
  const node = page.locator(`.jp-Epi-map-frame[data-variable="${LONG}"]`);
  await expect(node).toHaveAttribute('title', `Ask about ${LONG}`);
  await expect(
    page.locator('.jp-Epi-map').getByRole('button', { name: LONG, exact: true })
  ).toBeVisible();

  // In a row, with room between the nodes.
  const row = [short, codebook, long].sort((a, b) => a.node.left - b.node.left);
  row.slice(1).forEach((box, index) => {
    expect(box.node.left).toBeGreaterThan(row[index].node.right);
  });
});
