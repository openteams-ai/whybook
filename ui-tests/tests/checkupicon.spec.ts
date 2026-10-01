/**
 * The icon of the Check-up and its outline (design iteration 1.68, A3 and
 * D), in the plugin `whybook:checkup`, against the built extension.
 *
 * - While the pointer is on a notebook's tab, the tab's icon turns into the
 *   icon of the Check-up, the one beside the name in the Check-up's head,
 *   and the tab's label stays where it was.
 * - A click on that icon brings the Check-up into sight and outlines it for
 *   a moment, from the Whybook view and from JupyterLab's notebook view.
 * - With the reduced motion of the system, the outline shows with no fade.
 *
 * No model is called: the fixture aborts the model's routes.
 */
import type { IJupyterLabPageFixture } from '@jupyterlab/galata';
import { galata } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures';

const KERNELSPEC = {
  display_name: 'Python 3 (ipykernel)',
  language: 'python',
  name: 'python3'
};

/** A notebook of these code cells, with ids `cell-0` and on. */
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
    metadata: { kernelspec: KERNELSPEC },
    nbformat: 4,
    nbformat_minor: 5
  };
  await page.contents.uploadContent(JSON.stringify(notebook), 'text', file);
}

/** Open a notebook in a view: the Whybook view, or JupyterLab's notebook view. */
async function open(
  page: IJupyterLabPageFixture,
  file: string,
  factory = 'Whybook'
): Promise<void> {
  await page.evaluate(
    async ([file, factory]) => {
      await (window as any).jupyterapp.commands.execute('docmanager:open', {
        path: file,
        factory
      });
    },
    [file, factory]
  );
  if (factory === 'Whybook') {
    await expect(page.locator('.jp-Epi-bench').first()).toBeVisible();
    await expect(page.locator('.jp-Epi-bench .jp-Epi-loading')).toHaveCount(0);
  }
  await page.waitForFunction(
    () =>
      (window as any).jupyterapp.shell.currentWidget?.context?.sessionContext
        ?.session?.kernel?.status === 'idle',
    null,
    { timeout: 120000 }
  );
}

/** The tab of the main area with this label. */
function tab(page: IJupyterLabPageFixture, label: string): Locator {
  return page.locator(
    '#jp-main-dock-panel .lm-DockPanel-tabBar .lm-TabBar-tab',
    {
      has: page.locator('.lm-TabBar-tabLabel', { hasText: label })
    }
  );
}

function checkup(page: IJupyterLabPageFixture): Locator {
  return page.locator('.jp-Epi-exploration .jp-Epi-checkup');
}

/** The opacity of the Check-up's icon over a tab's icon, as drawn now. */
function iconOpacity(icon: Locator): Promise<string> {
  return icon.evaluate(node => getComputedStyle(node, '::after').opacity);
}

/**
 * Note each time that the Check-up takes the class of the outline, and
 * pause the outline's animation there, so that the test can read it at any
 * moment of its 1.6 s: `window.checkupFlash`.
 */
async function watchFlash(page: IJupyterLabPageFixture): Promise<void> {
  await page.evaluate(() => {
    const seen = {
      count: 0,
      animation: null as Animation | null,
      outlined: new Set<Element>()
    };
    (window as any).checkupFlash = seen;
    new MutationObserver(records => {
      for (const target of new Set(records.map(record => record.target))) {
        const element = target as Element;
        if (!element.matches('.jp-Epi-checkup')) {
          continue;
        }
        if (!element.classList.contains('jp-mod-flash')) {
          seen.outlined.delete(element);
        } else if (!seen.outlined.has(element)) {
          seen.outlined.add(element);
          seen.count += 1;
          seen.animation =
            element
              .getAnimations()
              .find(
                item => (item as CSSAnimation).animationName === 'jp-epi-flash'
              ) ?? null;
          seen.animation?.pause();
        }
      }
    }).observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
  });
}

/** How many times the Check-up was outlined. */
function flashes(page: IJupyterLabPageFixture): Promise<number> {
  return page.evaluate(() => (window as any).checkupFlash.count);
}

/**
 * The colour of the outline at this moment of its animation, and the
 * brand colour that it starts from, as the page computes them.
 */
function outlineAt(
  page: IJupyterLabPageFixture,
  ms: number
): Promise<{ outline: string; brand: string }> {
  return page.evaluate((ms: number) => {
    const animation: Animation = (window as any).checkupFlash.animation;
    animation.currentTime = ms;
    const section = document.querySelector(
      '.jp-Epi-exploration .jp-Epi-checkup'
    )!;
    const probe = document.createElement('div');
    probe.style.color = 'var(--jp-brand-color1)';
    document.body.appendChild(probe);
    const brand = getComputedStyle(probe).color;
    probe.remove();
    return { outline: getComputedStyle(section).outlineColor, brand };
  }, ms);
}

/** The alpha of a colour as the browser writes it: rgb(...) or rgba(...). */
function alpha(color: string): number {
  const parts = /rgba?\(([^)]+)\)/.exec(color)![1].split(',');
  return parts.length === 4 ? Number(parts[3]) : 1;
}

/** Press the icon of a tab, where the Check-up's icon shows. */
async function pressIcon(
  page: IJupyterLabPageFixture,
  view: Locator
): Promise<void> {
  await view.hover();
  const icon = view.locator('.lm-TabBar-tabIcon');
  await expect.poll(() => iconOpacity(icon)).toBe('1');
  const box = (await icon.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

// The Check-up is off by default ("Questions about the notebook"): the
// tests of this file turn it on.
test.use({
  mockSettings: {
    ...galata.DEFAULT_SETTINGS,
    'whybook:checkup': { enabled: true }
  }
});

test("turns the tab's icon into the icon of the Check-up's head while the pointer is on the tab, with the label still", async ({
  page,
  tmpPath
}) => {
  const file = `${tmpPath}/icon.ipynb`;
  await newNotebook(page, file, ['x = 1']);
  await open(page, file);
  const view = tab(page, 'icon.ipynb');
  await expect(view).toHaveAttribute('data-whybook-ask', 'true');
  const icon = view.locator('.lm-TabBar-tabIcon');
  await expect.poll(() => iconOpacity(icon)).toBe('0');
  const label = view.locator('.lm-TabBar-tabLabel');
  const before = await label.boundingBox();
  await view.hover();
  await expect.poll(() => iconOpacity(icon)).toBe('1');
  expect(await label.boundingBox()).toEqual(before);
  // The tab draws the icon that the head of the Check-up shows: the same
  // lines and circle, from the same source.
  const head = checkup(page).locator('.jp-Epi-checkup-head');
  await expect(head.locator('.jp-Epi-checkup-icon svg')).toHaveCount(1);
  const shapes = await head
    .locator('.jp-Epi-checkup-icon svg')
    .evaluate(svg =>
      Array.from(svg.querySelectorAll('path, circle')).map(shape =>
        shape.tagName === 'path'
          ? `d="${shape.getAttribute('d')}"`
          : `cx="${shape.getAttribute('cx')}" cy="${shape.getAttribute('cy')}" r="${shape.getAttribute('r')}"`
      )
    );
  expect(shapes.length).toBeGreaterThan(0);
  const drawn = await icon.evaluate(node =>
    decodeURIComponent(getComputedStyle(node, '::after').maskImage)
  );
  expect(drawn).toContain('data:image/svg+xml,');
  for (const shape of shapes) {
    expect(drawn).toContain(shape);
  }
  // The icon's box is the tab's icon's own: 14 px, in the same place.
  const [iconBox, drawnBox] = await icon.evaluate(node => {
    const box = node.getBoundingClientRect();
    const after = getComputedStyle(node, '::after');
    return [
      [box.width, box.height],
      [parseFloat(after.width), parseFloat(after.height)]
    ];
  });
  expect(drawnBox).toEqual(iconBox);
});

test('brings the Check-up into sight and outlines it for a moment when the icon of its tab opens it', async ({
  page,
  tmpPath
}) => {
  // A short window: the Check-up, the last block of the Exploration panel,
  // is out of sight until the icon brings it.
  await page.setViewportSize({ width: 1600, height: 560 });
  const file = `${tmpPath}/outline.ipynb`;
  await newNotebook(page, file, ['x = 1']);
  await open(page, file);
  const section = checkup(page);
  await expect(section).toHaveCount(1);
  const scroller = page.locator('.jp-Epi-sidebar:has(.jp-Epi-right-main)');
  await scroller.evaluate(node => (node.scrollTop = 0));
  const inSight = () =>
    section.evaluate(node => {
      const box = node.getBoundingClientRect();
      const panel = node.closest('.jp-Epi-sidebar')!.getBoundingClientRect();
      return box.top >= panel.top - 1 && box.top < panel.bottom - 20;
    });
  expect(await inSight()).toBe(false);
  await watchFlash(page);
  await pressIcon(page, tab(page, 'outline.ipynb'));
  await expect(section.locator('.jp-Epi-checkup-head')).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await expect.poll(() => flashes(page)).toBe(1);
  await expect.poll(inSight).toBe(true);
  // The outline starts in the brand colour, and fades.
  const start = await outlineAt(page, 300);
  expect(start.outline).toBe(start.brand);
  const late = await outlineAt(page, 1200);
  expect(alpha(late.outline)).toBeGreaterThan(0);
  expect(alpha(late.outline)).toBeLessThan(1);
  // The outline goes at the end of its animation, and the analyst's own
  // click on the head does not outline the section again.
  await page.evaluate(() => (window as any).checkupFlash.animation.finish());
  await expect(section).not.toHaveClass(/jp-mod-flash/);
  const head = section.locator('.jp-Epi-checkup-head');
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(section.locator('.jp-Epi-checkup-body')).toBeVisible();
  // React runs the section's effects after the frame that drew it.
  await page.evaluate(
    () =>
      new Promise(resolve =>
        requestAnimationFrame(() => setTimeout(resolve, 0))
      )
  );
  expect(await flashes(page)).toBe(1);
});

test.describe('With the reduced motion of the system', () => {
  test.use({ reducedMotion: 'reduce' });

  test('outlines the Check-up with no fade', async ({ page, tmpPath }) => {
    const file = `${tmpPath}/still.ipynb`;
    await newNotebook(page, file, ['x = 1']);
    await open(page, file);
    await expect(checkup(page)).toHaveCount(1);
    await watchFlash(page);
    await pressIcon(page, tab(page, 'still.ipynb'));
    await expect.poll(() => flashes(page)).toBe(1);
    // The same outline at 1.2 s as at the start: it goes at the end.
    const late = await outlineAt(page, 1200);
    expect(late.outline).toBe(late.brand);
  });
});

test.describe("With the icon on every notebook's tab", () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      'whybook:checkup': { enabled: true, tabQuestion: 'notebooks' }
    }
  });

  test("opens the Whybook view from JupyterLab's notebook view on its Check-up, outlined", async ({
    page,
    tmpPath
  }) => {
    const file = `${tmpPath}/classic.ipynb`;
    await newNotebook(page, file, ['x = 1']);
    await open(page, file, 'Notebook');
    await expect(page.locator('.jp-Epi-bench')).toHaveCount(0);
    await watchFlash(page);
    await pressIcon(page, tab(page, 'classic.ipynb'));
    await expect(page.locator('.jp-Epi-bench')).toBeVisible();
    await expect(checkup(page).locator('.jp-Epi-checkup-head')).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    await expect.poll(() => flashes(page)).toBe(1);
  });
});
