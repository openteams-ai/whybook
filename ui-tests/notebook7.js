/**
 * Browser check of Whybook in Jupyter Notebook 7, and of the same steps in
 * JupyterLab: open the demo notebook in the notebook editor, show it in
 * Whybook, Run all, drag a column onto a cell and run a question from a
 * template, and go back to the notebook editor, which shows the edit.
 *
 * In Notebook 7 it also checks that the files page has no Whybook panels,
 * that Whybook and the editor share one document, that the side panels open
 * and close with Whybook, that a reload shows Whybook again, and that an
 * edit page that opens the notebook in Whybook, as Open With does, sends the
 * browser to the notebook's page, and that All AI settings opens the settings
 * editor on the files page.
 *
 * It needs a server that serves a copy of examples/pain_diary, because it
 * edits the notebook it opens, with settings and workspaces directories of
 * its own, and no model: a data folder of its own (WHYBOOK_DATA_DIR) and
 * --Whybook.describe_tables=False. Notebook 7.6 or later:
 *
 *   DEMO=$(mktemp -d)
 *   cp -r examples/pain_diary "$DEMO/demo"
 *   WHYBOOK_DATA_DIR="$DEMO/data" jupyter notebook --no-browser --port 8936 \
 *     --ServerApp.port_retries=0 --IdentityProvider.token=testtoken \
 *     --JupyterNotebookApp.expose_app_in_browser=True \
 *     --ServerApp.root_dir="$DEMO/demo" \
 *     --JupyterNotebookApp.user_settings_dir="$DEMO/settings" \
 *     --JupyterNotebookApp.workspaces_dir="$DEMO/workspaces" \
 *     --Whybook.describe_tables=False \
 *     --Whybook.claude_cli_path=/nonexistent/claude &
 *   EPI_APP=notebook7 EPI_URL=http://localhost:8936 \
 *     PLAYWRIGHT_CORE=<path to playwright-core> node ui-tests/notebook7.js [shots-dir]
 *
 * JupyterLab: the same with `jupyter lab`, the --LabApp options in place of
 * the --JupyterNotebookApp ones, a port of its own, and EPI_APP=lab.
 * EPI_TOKEN (default testtoken) is the server's token, and EPI_CHROMIUM a
 * Chromium of Playwright's cache, when the one that playwright-core expects
 * is not there. It prints one `ok` line per check, saves screenshots, and
 * exits with 1 at the first failed check, after a `failure.png`.
 */
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const fs = require('fs');
const path = require('path');

const APP = process.env.EPI_APP || 'notebook7';
const URL = process.env.EPI_URL || 'http://localhost:8936';
const TOKEN = process.env.EPI_TOKEN || 'testtoken';
const SHOTS = process.argv[2] || path.join(__dirname, `${APP}-shots`);
const NOTEBOOK = 'pain_diary_cohort.ipynb';
const NB7 = APP === 'notebook7';

fs.mkdirSync(SHOTS, { recursive: true });

function check(condition, message) {
  if (!condition) {
    throw new Error(`Check failed: ${message}`);
  }
  console.log(`ok  ${message}`);
}

/** Check a condition that holds once the page has drawn the change. */
async function eventually(predicate, message, timeout = 15000) {
  const end = Date.now() + timeout;
  let holds = await predicate();
  while (!holds && Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 100));
    holds = await predicate();
  }
  check(holds, message);
}

/** An HTML5 drag. Chromium starts a drag only when the mouse moves in steps. */
async function drag(page, source, target) {
  await target.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + from.height / 2 + 5, {
    steps: 5
  });
  await page.mouse.move(to.x + to.width / 2, to.y + 30, { steps: 12 });
  await page.mouse.up();
}

/** Wait until no cell of the view runs. */
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

/** Wait for the app, and for its first widget in the main area. */
async function started(page) {
  await page.waitForFunction(() => !!window.jupyterapp, null, {
    timeout: 60000
  });
  await page.evaluate(() => window.jupyterapp.restored.then(() => null));
}

/**
 * What the page shows: the kind of the main area's widget, whether the
 * notebook editor shares Whybook's document context, Whybook's panels, the
 * Trusted indicators of Notebook 7's menu bar, and the address.
 */
function pageState(page) {
  return page.evaluate(() => {
    const app = window.jupyterapp;
    const registry = app.pluginRegistry;
    // The notebook tracker, which the page does not expose otherwise.
    let tracker = null;
    for (const [token, id] of registry._services) {
      if (token.name === '@jupyterlab/notebook:INotebookTracker') {
        tracker = registry._plugins.get(id).service;
      }
    }
    const main = app.shell.currentWidget;
    const editor = tracker?.currentWidget ?? null;
    const visible = id => !!document.getElementById(id)?.offsetParent;
    const panelIds = area =>
      Array.from(app.shell.widgets(area)).map(widget => widget.id);
    return {
      whybook: !!main?.node.querySelector('.jp-Epi-bench'),
      editorInMain: !!editor && editor === main,
      sharedContext:
        !!editor && !!main?.context && editor.context === main.context,
      editorSource: editor
        ? editor.content.model.sharedModel.cells
            .map(cell => cell.getSource())
            .join('\n')
        : '',
      variables: visible('epi-variables'),
      exploration: visible('epi-exploration'),
      whybookPanels: [...panelIds('left'), ...panelIds('right')].filter(id =>
        id.startsWith('epi-')
      ),
      trusted: document.querySelectorAll('.jp-NotebookTrustedStatus').length,
      href: location.href
    };
  });
}

/** The view that the switch of Notebook 7's menu bar shows as chosen. */
function switchShows(page) {
  return page.evaluate(
    () =>
      document.querySelector('.jp-Epi-editorswitch [aria-checked="true"]')
        ?.dataset.value ?? null
  );
}

/** Errors whose stack passes through Whybook's code. */
function whybookErrors(page, errors) {
  page.on('pageerror', error => {
    if (/\/whybook\//.test(error.stack || '')) {
      errors.push(error.stack);
    }
  });
  page.on('console', message => {
    const location = message.location()?.url || '';
    if (message.type() === 'error' && /\/whybook\//.test(location)) {
      errors.push(message.text());
    }
  });
}

/** Open the demo in the notebook editor. */
async function openEditor(page) {
  if (NB7) {
    await page.goto(`${URL}/notebooks/${NOTEBOOK}?token=${TOKEN}`);
    await started(page);
  } else {
    await page.goto(`${URL}/lab?token=${TOKEN}&reset`);
    await started(page);
    await page.evaluate(
      notebook =>
        window.jupyterapp.commands
          .execute('docmanager:open', { path: notebook })
          .then(() => null),
      NOTEBOOK
    );
  }
  await page.waitForSelector('.jp-NotebookPanel .jp-Cell', { timeout: 60000 });
}

/** Show the notebook in Whybook: Notebook 7's switch, JupyterLab's command. */
async function toWhybook(page) {
  if (NB7) {
    await page.locator('.jp-Epi-editorswitch [data-value="whybook"]').click();
  } else {
    await page.evaluate(() =>
      window.jupyterapp.commands
        .execute('whybook:open-epinotebook')
        .then(() => null)
    );
  }
  await page.waitForSelector('.jp-Epi-bench', { timeout: 60000 });
}

/** Show the notebook editor again. */
async function toEditor(page) {
  if (NB7) {
    await page.locator('.jp-Epi-editorswitch [data-value="notebook"]').click();
  } else {
    await page.evaluate(() =>
      window.jupyterapp.commands
        .execute('whybook:open-notebook')
        .then(() => null)
    );
  }
  await page.waitForSelector('.jp-NotebookPanel .jp-Cell', { timeout: 60000 });
}

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.EPI_CHROMIUM || undefined
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 }
  });
  const page = await context.newPage();
  const errors = [];
  whybookErrors(page, errors);
  // The segments of a switch change colour over 0.12 s.
  const shot = async (name, which = page) => {
    await which.waitForTimeout(300);
    await which.screenshot({ path: path.join(SHOTS, `${APP}-${name}.png`) });
  };

  try {
    if (NB7) {
      await page.goto(`${URL}/tree?token=${TOKEN}`);
      await started(page);
      await page.waitForTimeout(1000);
      const tree = await pageState(page);
      check(
        tree.whybookPanels.length === 0,
        'the files page has no Whybook panels'
      );
      await shot('01-tree');
    }

    await openEditor(page);
    let state = await pageState(page);
    check(state.editorInMain, 'the notebook opens in the notebook editor');
    if (NB7) {
      check(
        !state.variables && !state.exploration,
        "Whybook's panels stay closed beside the editor"
      );
    }
    await shot('02-editor');

    await toWhybook(page);
    await eventually(async () => {
      const now = await pageState(page);
      return now.whybook && now.variables && now.exploration;
    }, 'Whybook shows, with Variables and Exploration open');
    state = await pageState(page);
    check(
      state.sharedContext,
      'Whybook and the notebook editor share one document context'
    );
    if (NB7) {
      await eventually(
        async () => (await switchShows(page)) === 'whybook',
        'the switch in the menu bar shows Whybook'
      );
      check(
        state.href.includes('factory=Whybook'),
        "the page's address names Whybook"
      );
      check(context.pages().length === 1, 'no other browser tab opened');
    }
    await shot('03-whybook');

    // Run all, as the demo starts.
    await page
      .locator('.jp-Epi-questions .jp-Epi-toggle [data-value="drag"]')
      .click();
    await page.locator('.jp-Epi-runall').click();
    await page.waitForFunction(
      () => document.querySelectorAll('.jp-Epi-variable').length >= 5,
      null,
      { timeout: 180000 }
    );
    await idle(page);
    check(true, 'Run all lists the variables');
    await shot('04-ran');

    // Drag a protein column onto the model cell and add it as a covariate.
    const model = page
      .locator('.jp-Epi-cell', { hasText: 'Mixed model' })
      .first();
    await page.locator('.jp-Epi-variable', { hasText: 'olink' }).click();
    await page.locator('.jp-Epi-contents .jp-Epi-search input').fill('IL6');
    await page.waitForTimeout(400);
    await drag(
      page,
      page.locator('.jp-Epi-column', { hasText: 'IL6' }).first(),
      model
    );
    await page.waitForSelector('.jp-Epi-popover .jp-Epi-option', {
      timeout: 30000
    });
    await page.waitForTimeout(300);
    const box = page.locator('.jp-Epi-popover');
    check(
      (await box.locator('.jp-Epi-option').count()) > 0,
      'a column dropped onto a cell offers questions'
    );
    await shot('05-questions');
    await box
      .locator('.jp-Epi-option', { hasText: 'Add IL6 as a covariate' })
      .click();
    await idle(page);
    check(
      (await model.locator('.jp-Epi-formula').innerText()).includes('+ IL6'),
      'the question from a template edits the model, and the cell runs'
    );
    await shot('06-answered');

    await toEditor(page);
    await eventually(
      async () => (await pageState(page)).editorInMain,
      'the notebook editor shows again'
    );
    state = await pageState(page);
    check(
      state.editorSource.includes('IL6'),
      "the notebook editor shows Whybook's edit of the model cell"
    );
    if (NB7) {
      await eventually(
        async () => (await switchShows(page)) === 'notebook',
        'the switch in the menu bar shows the notebook editor'
      );
      check(
        !state.variables && !state.exploration,
        "Whybook's panels close with Whybook"
      );
      check(
        !state.href.includes('factory='),
        "the page's address no longer names Whybook"
      );
      check(state.trusted === 1, 'the menu bar has one Trusted indicator');
    }
    await shot('07-editor-again');

    if (NB7) {
      // A reload shows what the page showed: Whybook, from the address.
      await toWhybook(page);
      await page.reload();
      await started(page);
      await eventually(async () => {
        const now = await pageState(page);
        return now.whybook && now.variables && now.exploration;
      }, 'a reload shows Whybook again, with its panels');
      await shot('08-reload');

      // Open With › Whybook opens an edit page in a new tab.
      const other = await context.newPage();
      whybookErrors(other, errors);
      await other.goto(`${URL}/edit/${NOTEBOOK}?factory=Whybook`);
      await other.waitForURL(/\/notebooks\/.*factory=Whybook/, {
        timeout: 30000
      });
      await started(other);
      await other.waitForSelector('.jp-Epi-bench', { timeout: 60000 });
      check(
        true,
        "an edit page that opens the notebook in Whybook goes to the notebook's page"
      );
      check(
        context.pages().length === 2,
        'the edit page opens no other browser tab'
      );
      await shot('09-from-edit-page', other);
      await other.close();

      // A notebook's page has no settings editor: All AI settings opens the
      // files page in a new tab, which opens the settings editor at
      // Whybook's settings and takes the query out of its address.
      await page.locator('.jp-Epi-aibutton').first().click();
      const opening = context.waitForEvent('page', { timeout: 15000 });
      await page.getByText('All AI settings', { exact: true }).click();
      const settings = await opening;
      whybookErrors(settings, errors);
      await started(settings);
      await eventually(
        () =>
          settings.evaluate(
            () =>
              location.pathname.endsWith('/tree') &&
              location.search === '' &&
              [...document.querySelectorAll('.lm-TabBar-tabLabel')].some(
                tab => tab.textContent.trim() === 'Settings'
              ) &&
              [...document.querySelectorAll('.jp-PluginList-entry')].every(
                entry => entry.textContent.includes('Whybook')
              ) &&
              document.body.innerText.includes('Settings of Whybook')
          ),
        'All AI settings opens the settings editor at Whybook on the files page, in a new tab'
      );
      await shot('10-settings', settings);
      await settings.close();
    }

    check(
      errors.length === 0,
      `no errors from Whybook's code in the console${errors.length ? `: ${errors.join('\n')}` : ''}`
    );
  } catch (error) {
    await page.screenshot({ path: path.join(SHOTS, `${APP}-failure.png`) });
    console.error(error.message);
    if (errors.length) {
      console.error(errors.join('\n'));
    }
    await browser.close();
    process.exit(1);
  }
  await browser.close();
}

void main();
