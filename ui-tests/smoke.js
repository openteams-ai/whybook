/**
 * Browser smoke test of the Whybook demo: one pass through the main flows.
 *
 * It needs a running JupyterLab that serves a copy of examples/pain_diary,
 * because it edits the notebook it opens. The view saves the Drag or Click
 * choice and the layout as settings, so give that server its own settings and
 * workspaces directories. See TESTING.md for the commands.
 *
 *   PLAYWRIGHT_CORE=<path to playwright-core> node ui-tests/smoke.js [shots-dir]
 *
 * EPI_URL (default http://localhost:8899) and EPI_TOKEN (default testtoken)
 * point it at the server. It exits with 1 at the first failed check.
 */
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const fs = require('fs');
const path = require('path');

const URL = process.env.EPI_URL || 'http://localhost:8899';
const TOKEN = process.env.EPI_TOKEN || 'testtoken';
const SHOTS = process.argv[2] || path.join(__dirname, 'smoke-shots');
const NOTEBOOK = 'pain_diary_cohort.ipynb';

fs.mkdirSync(SHOTS, { recursive: true });

function check(condition, message) {
  if (!condition) {
    throw new Error(`Check failed: ${message}`);
  }
  console.log(`ok  ${message}`);
}

/**
 * Check a condition that holds once the view renders: it updates on the next
 * animation frame after a click.
 */
async function eventually(predicate, message, timeout = 10000) {
  const end = Date.now() + timeout;
  let holds = await predicate();
  while (!holds && Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 100));
    holds = await predicate();
  }
  check(holds, message);
}

async function text(locator) {
  return (await locator.innerText()).replace(/\s+/g, ' ');
}

/**
 * An HTML5 drag. Chromium starts a drag only when the mouse moves in steps.
 */
async function drag(page, source, target, options = {}) {
  await target.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + from.height / 2 + 5, {
    steps: 5
  });
  if (options.shift) {
    await page.keyboard.down('Shift');
  }
  if (options.alt) {
    await page.keyboard.down('Alt');
  }
  await page.mouse.move(
    to.x + (options.dx ?? to.width / 2),
    to.y + (options.dy ?? 30),
    { steps: 10 }
  );
  await page.mouse.up();
  if (options.shift) {
    await page.keyboard.up('Shift');
  }
  if (options.alt) {
    await page.keyboard.up('Alt');
  }
}

async function idle(page) {
  await page.waitForFunction(
    () =>
      !document.querySelector('.jp-Epi-cell-actions button[disabled]') &&
      !document.querySelector('.jp-Epi-strip .jp-mod-indeterminate'),
    null,
    { timeout: 180000 }
  );
  await page.waitForTimeout(1000);
}

async function popover(page) {
  await page.waitForSelector('.jp-Epi-popover .jp-Epi-option', {
    timeout: 30000
  });
  await page.waitForTimeout(300);
  return page.locator('.jp-Epi-popover');
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 }
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !/favicon|404/.test(message.text())) {
      errors.push(message.text());
    }
  });
  const shot = name =>
    page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

  try {
    // Open the demo in the Whybook view and run it.
    await page.goto(`${URL}/lab?token=${TOKEN}&reset`);
    await page.waitForFunction(
      () => window.jupyterapp?.commands.hasCommand('docmanager:open'),
      null,
      { timeout: 60000 }
    );
    // A widget opened before the workspace is restored can be closed again.
    await page.evaluate(() => window.jupyterapp.restored.then(() => null));
    await page.evaluate(
      path =>
        window.jupyterapp.commands
          .execute('docmanager:open', { path, factory: 'Whybook' })
          .then(() => null),
      NOTEBOOK
    );
    await page.waitForSelector('.jp-Epi-bench', { timeout: 60000 });
    await page.waitForFunction(
      () =>
        window.jupyterapp.shell.currentWidget?.context?.sessionContext?.session
          ?.kernel?.status === 'idle',
      null,
      { timeout: 60000 }
    );
    // Start from the defaults: an earlier run can stop in Click mode.
    await page
      .locator('.jp-Epi-questions .jp-Epi-toggle [data-value="drag"]')
      .click();
    await page.locator('.jp-Epi-layout [data-value="sidebars"]').click();
    await page.locator('.jp-Epi-runall').click();
    await page.waitForFunction(
      () => document.querySelectorAll('.jp-Epi-variable').length >= 5,
      null,
      { timeout: 180000 }
    );
    await idle(page);
    await shot('01-ran');
    const model = page
      .locator('.jp-Epi-cell', { hasText: 'Mixed model' })
      .first();
    // innerText is empty in a card far from the window: the card is not laid out.
    await model.scrollIntoViewIfNeeded();
    const chips = await model
      .locator('.jp-Epi-chip')
      .evaluateAll(nodes =>
        nodes.map(node => ({ text: node.textContent, title: node.title }))
      );
    check(
      chips.some(
        chip =>
          chip.text.startsWith('reml True') &&
          chip.title.startsWith('A library default')
      ),
      'the model cell shows reml=True as a library default'
    );

    // Worth asking next: ask the suggested MIN_DAYS question.
    // Only suggestions with offline code: the others would call Claude.
    await page
      .locator('.jp-Epi-tabs button', { hasText: 'Exploration' })
      .click();
    const next = page
      .locator('.jp-Epi-next', { hasText: /MIN_DAYS|olink/ })
      .first();
    if (await next.count()) {
      const strips = await page.locator('.jp-Epi-strip').count();
      await next.locator('button', { hasText: 'Ask' }).click();
      await page.waitForTimeout(1500);
      await idle(page);
      check(
        (await page.locator('.jp-Epi-strip').count()) > strips,
        'a suggested question runs'
      );
      await shot('08-next');
    } else {
      console.log('--  no offline suggestion to ask');
    }

    // Drag a protein column onto the model cell and add it as a covariate.
    await page.locator('.jp-Epi-variable', { hasText: 'olink' }).click();
    await page.locator('.jp-Epi-contents .jp-Epi-search input').fill('IL6');
    await page.waitForTimeout(400);
    await drag(
      page,
      page.locator('.jp-Epi-column', { hasText: 'IL6' }).first(),
      model
    );
    let box = await popover(page);
    check(
      (await text(box)).includes('joined on patient_id'),
      'the drop popover says how IL6 is joined'
    );
    await box
      .locator('.jp-Epi-option', { hasText: 'Add IL6 as a covariate' })
      .click();
    await idle(page);
    check(
      (await model.locator('.jp-Epi-formula').innerText()).includes('+ IL6'),
      'the edited model formula includes IL6'
    );
    await model
      .locator('.jp-Epi-strip button', { hasText: 'Undo' })
      .first()
      .click();
    await page.waitForTimeout(1000);
    await idle(page);
    check(
      !(await model.locator('.jp-Epi-formula').innerText()).includes('IL6'),
      'Undo restores the formula'
    );

    // Map view: one cell, then a rectangle over two cells.
    await page.locator('.jp-Epi-views [data-value="map"]').click();
    const node = page
      .locator('.jp-Epi-map-cell', { hasText: 'Mixed model' })
      .first();
    await node.click();
    box = await popover(page);
    check(
      (await text(box)).includes('ranked for this cell'),
      'a map cell click asks about the cell'
    );
    await box.locator('.jp-Epi-close').click();
    const first = await page
      .locator('.jp-Epi-map-cell', { hasText: 'Weekly pain' })
      .first()
      .boundingBox();
    const last = await node.boundingBox();
    const map = await page.locator('.jp-Epi-map').boundingBox();
    await page.mouse.move(map.x + 6, first.y - 8);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width + 10, last.y + last.height + 8, {
      steps: 12
    });
    await page.mouse.up();
    box = await popover(page);
    check(
      (await text(box)).includes('2 cells selected'),
      'a rectangle selects two map cells'
    );
    await shot('02-map');
    await box.locator('.jp-Epi-close').click();
    await page.locator('.jp-Epi-views [data-value="bench"]').click();

    // Brush weeks of the ribbon in the cell's details and keep the selection.
    // The bench shows plots in full by default, and as thumbnails at Overview.
    const detail = page.locator('.jp-Epi-detail input');
    const level = page.locator('.jp-Epi-detail-value');
    await eventually(
      async () => (await text(level)) === 'Full',
      'the bench shows its outputs in full'
    );
    await detail.fill('0');
    await eventually(
      async () => (await text(level)) === 'Overview',
      'the Detail slider shows the plots as thumbnails'
    );
    const weekly = page
      .locator('.jp-Epi-cell', { hasText: 'Weekly pain' })
      .first();
    await weekly.scrollIntoViewIfNeeded();
    await weekly.locator('.jp-Epi-miniature').first().click();
    await detail.fill('2');
    const plot = page.locator(
      '.jp-Epi-details-output.jp-mod-opened svg.jp-Epi-plot'
    );
    const area = await plot.boundingBox();
    const panel = await page.locator('.jp-Epi-details').boundingBox();
    check(
      area.x + area.width <= panel.x + panel.width + 1,
      'the full plot fits its panel'
    );
    await page.mouse.move(
      area.x + area.width * 0.55,
      area.y + area.height * 0.4
    );
    await page.mouse.down();
    await page.mouse.move(
      area.x + area.width * 0.85,
      area.y + area.height * 0.4,
      { steps: 10 }
    );
    await page.mouse.up();
    box = await popover(page);
    check(/\d rows/.test(await text(box)), 'a brushed range reports its rows');
    const where = await box.boundingBox();
    check(
      where.x + where.width <= panel.x,
      'the region questions open beside the plot'
    );
    await shot('03-region');
    await box.locator('.jp-Epi-keep').click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.jp-Epi-variable')].some(node =>
          node.textContent.startsWith('sel_week')
        ),
      null,
      { timeout: 60000 }
    );
    check(true, 'Keep selection adds a sel_week variable');

    // Click mode: pick a variable, then a cell; Escape cancels a pick.
    await page
      .locator('.jp-Epi-questions .jp-Epi-toggle [data-value="click"]')
      .click();
    await eventually(
      async () =>
        (await text(page.locator('.jp-Epi-questions'))).includes(
          'Click a variable or a column to pick it'
        ),
      'click mode explains itself'
    );
    await page
      .locator('.jp-Epi-variable', { hasText: 'patients' })
      .first()
      .click();
    await model.scrollIntoViewIfNeeded();
    await model.locator('.jp-Epi-dropzone').click();
    await page.waitForSelector('.jp-Epi-questions .jp-Epi-option', {
      timeout: 30000
    });
    check(
      (await page.locator('.jp-Epi-popover').count()) === 0,
      'click mode lists the questions in the panel only'
    );
    await shot('04-click');
    await page.locator('.jp-Epi-questions .jp-Epi-close').click();
    await page
      .locator('.jp-Epi-variable', { hasText: 'weekly' })
      .first()
      .focus();
    await page.keyboard.press('Enter');
    await eventually(
      async () => (await page.locator('.jp-Epi-picked').count()) === 1,
      'Enter picks a focused variable'
    );
    await page.keyboard.press('Escape');
    await eventually(
      async () => (await page.locator('.jp-Epi-picked').count()) === 0,
      'Escape cancels the pick'
    );
    await page
      .locator('.jp-Epi-questions .jp-Epi-toggle [data-value="drag"]')
      .click();

    // Layout: all panels in the view, then back to the sidebars.
    await page.locator('.jp-Epi-layout [data-value="all-here"]').click();
    await eventually(
      async () => (await page.locator('.jp-Epi-docpanel').count()) === 2,
      'the panels move into the view'
    );
    await shot('05-all-here');
    await page.locator('.jp-Epi-layout [data-value="sidebars"]').click();
    await eventually(
      () => page.locator('#epi-variables').isVisible(),
      'the sidebar opens again'
    );

    // Alt+drop: explore in parallel, two branches in subshells.
    await drag(
      page,
      page.locator('.jp-Epi-variable', { hasText: 'MIN_DAYS' }).first(),
      weekly,
      { alt: true }
    );
    box = await popover(page);
    check(
      (await text(box)).includes('parallel exploration'),
      'Alt+drop offers a parallel checklist'
    );
    await box.locator('.jp-Epi-parallel-foot button').click();
    await page.waitForTimeout(1500);
    await idle(page);
    const sweep = page
      .locator('.jp-Epi-cell.jp-mod-branch', {
        hasText: 'What changes if MIN_DAYS'
      })
      .first();
    await sweep.scrollIntoViewIfNeeded();
    check(
      (await sweep.locator('.jp-Epi-chip').allInnerTexts()).some(chip =>
        chip.startsWith('min_days_values')
      ),
      'the sweep branch shows the values it tried'
    );
    await shot('06-parallel');

    // Shift+drop: every option becomes a branch.
    await page
      .locator('.jp-Epi-variable', { hasText: 'patients' })
      .first()
      .click();
    await drag(
      page,
      page.locator('.jp-Epi-column', { hasText: 'age' }).first(),
      model,
      { shift: true }
    );
    box = await popover(page);
    const tags = await box.locator('.jp-Epi-placement').allInnerTexts();
    check(
      tags.length > 0 && tags.every(tag => tag.startsWith('branch of')),
      'Shift+drop branches every option'
    );
    await box.locator('.jp-Epi-close').click();

    // Drop a variable on itself: a preview, kept as a cell after its source.
    const diary = page
      .locator('.jp-Epi-variable')
      .filter({
        has: page.locator('.jp-Epi-item-name', { hasText: /^diary$/ })
      })
      .first();
    await drag(page, diary, diary, { dx: 60, dy: 8 });
    box = await popover(page);
    // The learned order puts other questions first, some of them for the AI:
    // the profile, a preview from a template, is picked by its text.
    await box
      .locator('.jp-Epi-option', { hasText: /^Profile diary/ })
      .first()
      .click();
    await page.waitForSelector('.jp-Epi-preview table', { timeout: 60000 });
    await shot('07-preview');
    await page.locator('button', { hasText: 'Keep as a cell' }).first().click();
    await idle(page);
    // The text, and not innerText, which is empty in a card far from the
    // window: the card is not laid out.
    const titles = await page
      .locator('.jp-Epi-cell .jp-Epi-title')
      .allTextContents();
    check(
      titles.indexOf('Profile diary: types, missingness, duplicates') ===
        titles.indexOf('One row per patient-day') + 1,
      'the kept profile follows the cell that makes diary'
    );

    check(
      errors.length === 0,
      `no errors in the console${errors.length ? `: ${errors.join(' | ')}` : ''}`
    );
  } catch (error) {
    await shot('failure');
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
