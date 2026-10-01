/**
 * The level of detail that follows the space, a trial behind the setting
 * "Level of detail follows the space" (design iteration 1.14), against the
 * built extension: the width of the view's column sets the level of the
 * bench, and the zoom of the map sets the map's. The notebook carries its
 * outputs, so no cell runs and no model is called.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import { galata } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

const KERNELSPEC = {
  display_name: 'Python 3 (ipykernel)',
  language: 'python',
  name: 'python3'
};

/** A bar chart of 600 by 300 pixels. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAlgAAAEsCAIAAACQX1rBAAAERElEQVR42u3ZsW3DMBRFUTngNNyCc3AXFtxFc3ALbqI+hd0EQRrHyo/McwYwgefi4tu34zg2AFjVhwkAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAWDqEtdZaq4kBcBECgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAECSZAGAduY+op2crLkIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAeFIyAcBr5T6inp6t2N9FCABCCABCCABCCABCCABCCABCCABCCABCCABCCIAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAsAbSiYArij3EfX0bMX+LkIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIAEEIA+FPJBMBPch9RT89W7I+LEACEEACEEACEEACEEACEEACEEACEEACEEACEEACEEACEEACEEACEEACEEACEEACEEACEEACEEAAekgkgVu4j6unZiv3BRQiAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEALABSQTsILcR9TTsxX7g4sQAIQQAIQQAIQQAIQQAIQQAIQQAIQQAIQQAIQQAIQQAIQQAIQQAIQQAIQQAIQQAIQQAIQQAIQQAH4lmYBXyX1EPT1bsT/gIgQAIQQAIQQAIQQAIQQAIQQAIQQAIQQAIQQAIQQAIQRACE0AgBACgBACgBACgBACgBACgBACgBACwNtKJriW3EfU07MV+wMuQgAQQgAQQgAQQgAQQgAQQgAQQgAQQgAQQgAQQgAQQgAQQgAQQgAQQgAQQgAQQgAQQgAQQgAQQgAIkEzwXe4j6unZiv0BXIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQA8EWKejj3EfX0bMUXD8Dd7TiOkz661rpt277vVgZg3YvwnkMAONXTd5f/CAFY2ok/jQLA/+ciBEAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAUAIAeAEnzbnMStESN9aAAAAAElFTkSuQmCC';

/** A small table as pandas writes it: 3 rows, 2 columns. */
const TABLE =
  '<table border="1" class="dataframe"><thead><tr style="text-align: right;"><th></th><th>week</th><th>pain</th></tr></thead>' +
  '<tbody><tr><th>0</th><td>1</td><td>4.2</td></tr><tr><th>1</th><td>2</td><td>3.9</td></tr><tr><th>2</th><td>3</td><td>3.5</td></tr></tbody></table>';

/**
 * A notebook of ten cells with their outputs: four printed lines, a small
 * table and a picture, as a cell leaves them after a run.
 */
function notebook(): string {
  const cells: Record<string, unknown>[] = [
    {
      cell_type: 'markdown',
      id: 'title',
      metadata: {},
      source: '# Level of detail'
    }
  ];
  for (let i = 0; i < 10; i++) {
    cells.push({
      cell_type: 'code',
      execution_count: i + 1,
      id: `cell-${i}`,
      metadata: {},
      source: `report(part_${i})`,
      outputs: [
        {
          output_type: 'stream',
          name: 'stdout',
          text: 'one\ntwo\nthree\nfour\n'
        },
        {
          output_type: 'execute_result',
          execution_count: i + 1,
          metadata: {},
          data: {
            'text/html': TABLE,
            'text/plain':
              '   week  pain\n0     1   4.2\n1     2   3.9\n2     3   3.5'
          }
        },
        {
          output_type: 'display_data',
          metadata: {},
          data: { 'image/png': PNG, 'text/plain': '<Figure size 600x300>' }
        }
      ]
    });
  }
  return JSON.stringify({
    cells,
    metadata: { kernelspec: KERNELSPEC },
    nbformat: 4,
    nbformat_minor: 5
  });
}

async function openInWhybook(
  page: IJupyterLabPageFixture,
  file: string
): Promise<void> {
  await page.contents.uploadContent(notebook(), 'text', file);
  await page.evaluate(async (file: string) => {
    await (window as any).jupyterapp.commands.execute('docmanager:open', {
      path: file,
      factory: 'Whybook'
    });
  }, file);
  await expect(page.locator('.jp-Epi-bench')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.jp-Epi-bench .jp-Epi-loading')).toHaveCount(0, {
    timeout: 30000
  });
  await expect(
    page.locator('.jp-Epi-cell[data-cell-id="cell-0"] img')
  ).toBeVisible();
}

function columnWidth(page: IJupyterLabPageFixture): Promise<number> {
  return page
    .locator('.jp-Epi-main')
    .evaluate(node => (node as HTMLElement).offsetWidth);
}

/**
 * Resize the window so that the view's column is this wide: the side
 * panels keep their widths.
 */
async function resizeColumn(
  page: IJupyterLabPageFixture,
  width: number
): Promise<void> {
  const size = page.viewportSize()!;
  const now = await columnWidth(page);
  await page.setViewportSize({
    width: size.width + width - now,
    height: size.height
  });
  await expect.poll(() => columnWidth(page)).toBe(width);
}

/** Two frames of the page: the view has drawn what a change asked for. */
async function frames(page: IJupyterLabPageFixture): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

/** The pictures that the view shows have all loaded. */
async function picturesLoaded(page: IJupyterLabPageFixture): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('.jp-Epi-main img')).every(
          img => (img as HTMLImageElement).complete
        )
      )
    )
    .toBe(true);
}

/**
 * The slider, from the menu of the view's toolbar when the toolbar has no
 * room for it.
 */
async function slider(page: IJupyterLabPageFixture) {
  const input = page.locator('.jp-Epi-detail input');
  if (!(await input.isVisible())) {
    await page
      .locator('.jp-Toolbar')
      .filter({ has: page.locator('.jp-Epi-views') })
      .locator('.jp-Toolbar-responsive-opener')
      .click();
  }
  await expect(input).toBeVisible();
  return input;
}

const card = (page: IJupyterLabPageFixture, id: string) =>
  page.locator(`.jp-Epi-cell[data-cell-id="${id}"]`);

test.describe('With "Level of detail follows the space" on', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      'whybook:plugin': { detailFollowsSpace: true }
    }
  });

  test('the width of the view sets the level of the bench, and the card being read keeps its place', async ({
    page,
    tmpPath
  }) => {
    await openInWhybook(page, `${tmpPath}/width.ipynb`);
    await resizeColumn(page, 1000);
    const read = card(page, 'cell-5');
    const value = page.locator('.jp-Epi-detail-value');
    // Wide: Full, four printed lines and the table in full.
    await expect(value).toHaveText('Full');
    await expect(read.locator('.jp-Epi-textoutput')).toHaveText(
      'one\ntwo\nthree\nfour'
    );
    await read.evaluate(node => node.scrollIntoView({ block: 'start' }));
    await picturesLoaded(page);
    const top = async () => (await read.boundingBox())!.y;
    const before = await top();
    const moved = async () => Math.abs((await top()) - before);

    // Narrower: Compact, the lines as a tile, the picture 340 px wide.
    await resizeColumn(page, 600);
    await expect(read.locator('.jp-Epi-logtile')).toContainText('4 lines');
    await expect(read.locator('.jp-Epi-plotout')).toHaveClass(/jp-mod-compact/);
    await expect(value).toHaveText('Compact');
    await picturesLoaded(page);
    await expect.poll(moved).toBeLessThan(3);

    // Narrow: Overview, every table a tile, the picture a thumbnail.
    await resizeColumn(page, 300);
    await expect(read.locator('.jp-Epi-tableoutput')).toHaveClass(
      /jp-mod-tile/
    );
    await expect(read.locator('.jp-Epi-plotout')).toHaveCount(0);
    await expect(value).toHaveText('Overview');
    await picturesLoaded(page);
    await expect.poll(moved).toBeLessThan(3);

    // Wide again: Full.
    await resizeColumn(page, 1000);
    await expect(read.locator('.jp-Epi-textoutput')).toBeVisible();
    await expect(read.locator('.jp-Epi-plotout')).toHaveClass(/jp-mod-full/);
    await picturesLoaded(page);
    await expect.poll(moved).toBeLessThan(3);
  });

  test('a level picked on the slider holds until the width reaches another level', async ({
    page,
    tmpPath
  }) => {
    await openInWhybook(page, `${tmpPath}/pick.ipynb`);
    await resizeColumn(page, 600);
    const lines = card(page, 'cell-0').locator('.jp-Epi-textoutput');
    const tile = card(page, 'cell-0').locator('.jp-Epi-logtile');
    await expect(tile).toContainText('4 lines');
    // Full, picked on the slider: the lines in full, and the tooltip says so.
    await (await slider(page)).fill('2');
    await expect(lines).toBeVisible();
    await expect(page.locator('.jp-Epi-detail')).toHaveAttribute(
      'title',
      /You picked this level\. It holds until the width reaches another level\./
    );
    await page.keyboard.press('Escape');
    // A little wider, still in Compact's range: the pick holds.
    await resizeColumn(page, 650);
    await frames(page);
    await expect(lines).toBeVisible();
    // Wide enough for Full, then back: the width sets the level again.
    await resizeColumn(page, 1000);
    await expect(page.locator('.jp-Epi-detail-value')).toHaveText('Full');
    await resizeColumn(page, 600);
    await expect(tile).toContainText('4 lines');
    await expect(page.locator('.jp-Epi-detail')).toHaveAttribute(
      'title',
      /The width of the view sets the level: Overview when narrow, Compact from 420 px, Full from 720 px\. A level you pick holds until the width reaches another level\./
    );
  });

  test('the zoom of the map sets its level, and the card at the centre of a zoom keeps its place', async ({
    page,
    tmpPath
  }) => {
    await openInWhybook(page, `${tmpPath}/zoom.ipynb`);
    await resizeColumn(page, 1000);
    await page.locator('.jp-Epi-views [data-value="map"]').click();
    const value = page.locator('.jp-Epi-detail-value');
    const tiles = page.locator('.jp-Epi-map-output');
    const zoom = page.locator('.jp-Epi-map-zoom-button.jp-mod-level');
    await expect(value).toHaveText('Minimal');
    await expect(tiles.first()).toBeVisible();
    const out = page.locator('.jp-Epi-map-zoom-button[aria-label="Zoom out"]');
    const into = page.locator('.jp-Epi-map-zoom-button[aria-label="Zoom in"]');
    // Out to 64%: the cells alone.
    await out.click();
    await expect(zoom).toHaveText('80%');
    await expect(value).toHaveText('Minimal');
    await out.click();
    await expect(zoom).toHaveText('64%');
    await expect(value).toHaveText('None');
    await expect(tiles).toHaveCount(0);
    await into.click();
    await into.click();
    await expect(zoom).toHaveText('100%');
    await expect(value).toHaveText('Minimal');
    await expect(tiles.first()).toBeVisible();

    // The node nearest the centre of the view, where the buttons zoom, and
    // where its corner is.
    const nearest = await page.evaluate(() => {
      const viewport = document.querySelector(
        '.jp-Epi-map-viewport'
      ) as HTMLElement;
      const canvas = document.querySelector(
        '.jp-Epi-map-canvas'
      ) as HTMLElement;
      const [x, y, scale] =
        /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/
          .exec(canvas.style.transform)!
          .slice(1)
          .map(Number);
      const cx = viewport.clientWidth / 2;
      const cy = viewport.clientHeight / 2;
      const px = (cx - x) / scale;
      const py = (cy - y) / scale;
      let best: { id: string; left: number; top: number } | null = null;
      let distance = Infinity;
      for (const node of Array.from(
        canvas.querySelectorAll<HTMLElement>('.jp-Epi-map-cell[data-cell-id]')
      )) {
        const left = parseFloat(node.style.left);
        const top = parseFloat(node.style.top);
        const w = parseFloat(node.style.width);
        const h = parseFloat(node.style.minHeight);
        const dx = Math.max(left - px, 0, px - left - w);
        const dy = Math.max(top - py, 0, py - top - h);
        if (dx * dx + dy * dy < distance) {
          distance = dx * dx + dy * dy;
          best = { id: node.dataset.cellId!, left, top };
        }
      }
      return {
        id: best!.id,
        centre: { x: cx, y: cy },
        corner: { x: x + best!.left * scale, y: y + best!.top * scale }
      };
    });
    const corner = () =>
      page.evaluate((id: string) => {
        const viewport = document.querySelector(
          '.jp-Epi-map-viewport'
        ) as HTMLElement;
        const node = document.querySelector(
          `.jp-Epi-map-cell[data-cell-id="${id}"]`
        ) as HTMLElement;
        const a = viewport.getBoundingClientRect();
        const b = node.getBoundingClientRect();
        return { x: b.left - a.left, y: b.top - a.top };
      }, nearest.id);
    // In to 125%: the tiles of Overview, and the card stays where the zoom
    // put it while the cards around it grow.
    await into.click();
    await expect(zoom).toHaveText('125%');
    await expect(value).toHaveText('Overview');
    await expect(page.locator('.jp-Epi-map-cell.jp-mod-overview')).toHaveCount(
      10
    );
    const { centre } = nearest;
    const expected = {
      x: centre.x - (centre.x - nearest.corner.x) * 1.25,
      y: centre.y - (centre.y - nearest.corner.y) * 1.25
    };
    await expect
      .poll(async () => {
        const now = await corner();
        return Math.max(
          Math.abs(now.x - expected.x),
          Math.abs(now.y - expected.y)
        );
      })
      .toBeLessThan(2);
  });
});

test('without the setting, the width and the zoom leave the level to the slider', async ({
  page,
  tmpPath
}) => {
  await openInWhybook(page, `${tmpPath}/off.ipynb`);
  const lines = card(page, 'cell-0').locator('.jp-Epi-textoutput');
  await resizeColumn(page, 300);
  await frames(page);
  await expect(lines).toHaveText('one\ntwo\nthree\nfour');
  await expect(card(page, 'cell-0').locator('.jp-Epi-plotout')).toHaveClass(
    /jp-mod-full/
  );
  await resizeColumn(page, 1000);
  await page.locator('.jp-Epi-views [data-value="map"]').click();
  await expect(page.locator('.jp-Epi-detail-value')).toHaveText('Minimal');
  await page.locator('.jp-Epi-map-zoom-button[aria-label="Zoom in"]').click();
  await expect(page.locator('.jp-Epi-map-zoom-button.jp-mod-level')).toHaveText(
    '125%'
  );
  await frames(page);
  await expect(page.locator('.jp-Epi-detail-value')).toHaveText('Minimal');
  await expect(page.locator('.jp-Epi-map-cell.jp-mod-overview')).toHaveCount(0);
  await expect(page.locator('.jp-Epi-detail')).not.toHaveAttribute(
    'title',
    /The zoom sets the level/
  );
});
