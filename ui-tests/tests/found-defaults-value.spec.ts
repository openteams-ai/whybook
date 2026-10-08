/**
 * The defaults that a model found, by their value (design iteration 1.102).
 *
 * "Find more defaults with AI" (1.53) shows the parameters that a model
 * picked from the signatures of a cell's functions as chips. The server
 * leaves out the picks of parameters that never change a result in a way
 * that an analyst asks about: subset None of a formula model, deep True of
 * copy, the optimizer of a logistic fit, index None of a frame. It keeps the
 * model's answers as they came, so a function whose every pick is noise has
 * an answer, and no model is asked about it again.
 *
 * The picks are those that the demo videos' model made while the takes were
 * recorded (whybook/server/tests/data/found_defaults_takes.json). The test
 * puts them into the test server's store of kept answers, as an earlier call
 * of the model would have, through the notebook's kernel, which shares the
 * server's data folder (WHYBOOK_DATA_DIR). No model is called.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { IJupyterLabPageFixture } from '@jupyterlab/galata';

import { expect, test } from './fixtures';

const TAKES = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      '..',
      '..',
      'whybook',
      'server',
      'tests',
      'data',
      'found_defaults_takes.json'
    ),
    'utf8'
  )
).functions as {
  function: string;
  library: string;
  picks: { param: string; why: string }[];
}[];

/** The functions of the card below, with the picks that the videos' model made for each. */
const KEPT = [
  'pandas.core.generic.NDFrame.copy',
  'statsmodels.base.model.Model.from_formula',
  'statsmodels.discrete.discrete_model.Logit.fit',
  'statsmodels.regression.linear_model.RegressionModel.fit',
  'statsmodels.regression.linear_model.RegressionResults.conf_int',
  'pandas.core.frame.DataFrame.__init__'
].map(name => {
  const item = TAKES.find(take => take.function === name)!;
  return [item.function, item.library, item.picks];
});

/**
 * Keep the answers in the server's store, for the versions of the
 * libraries that the kernel runs, as library_defaults.keep does after a
 * call of the model.
 */
const KEEP = `
import json as _json
import pandas as _pandas
import statsmodels as _statsmodels
from whybook.server import library_defaults as _defaults

_versions = {"pandas": _pandas.__version__, "statsmodels": _statsmodels.__version__}
_by = {"choice": "remote", "model": "openrouter:inception/mercury-2.5", "at": "2026-10-07T16:30:14Z"}
for _name, _library, _picks in _json.loads(${JSON.stringify(JSON.stringify(KEPT))}):
    _function = _defaults.Function(
        function=_name, name=_name, module=_name.rsplit(".", 1)[0], library=_library,
        version=_versions[_library], params=tuple(_defaults.Param(_pick["param"]) for _pick in _picks),
    )
    _defaults.keep(_function, _picks, _by)
`;

/**
 * Take the same answers out of the store again. Every test of a run shares
 * the test server's store, and signatures.spec.ts expects the model to be
 * asked about pandas' DataFrame, which this file keeps an answer for.
 */
const FORGET = `
import json as _json
import pandas as _pandas
import statsmodels as _statsmodels
from whybook.server import keystore as _keystore
from whybook.server import library_defaults as _defaults

_versions = {"pandas": _pandas.__version__, "statsmodels": _statsmodels.__version__}
_store = _keystore.read_json(_defaults.store_path())
for _name, _library, _picks in _json.loads(${JSON.stringify(JSON.stringify(KEPT))}):
    _store.get("libraries", {}).get(_library, {}).get(_versions[_library], {}).pop(_name, None)
_keystore.write_private(_defaults.store_path(), _store)
`;

/** Run code in the kernel of the notebook in front, and give the reply's status. */
async function execute(
  page: IJupyterLabPageFixture,
  code: string
): Promise<string> {
  return page.evaluate(async (code: string) => {
    const kernel = (window as any).jupyterapp.shell.currentWidget.context
      .sessionContext.session.kernel;
    const reply = await kernel.requestExecute({
      code,
      silent: true,
      store_history: false
    }).done;
    return reply.content.status;
  }, code);
}

let kept = false;

test.afterEach(async ({ page }) => {
  if (kept) {
    kept = false;
    expect(await execute(page, FORGET)).toBe('ok');
  }
});

/** A cell as an analysis of the video wrote it: a copy of the data, a propensity model, a fit with robust errors and its interval. */
const CELLS = [
  'import numpy as np\nimport pandas as pd\nimport statsmodels.formula.api as smf\n\nrng = np.random.default_rng(0)\ndf = pd.DataFrame({"y": rng.normal(size=200), "x": rng.normal(size=200), "t": rng.integers(0, 2, 200)})',
  'analysis = df.copy()\npropensity = smf.logit("t ~ x", data=analysis).fit(disp=False)\nfit = smf.ols("y ~ t + x", data=analysis).fit(cov_type="HC3")\nci = fit.conf_int()\npd.DataFrame({"low": ci[0], "high": ci[1]})'
];

/**
 * The server's status with a connected model, so that the view would ask it
 * about a function that has no kept answer. The fixture aborts the request.
 */
async function connected(page: IJupyterLabPageFixture): Promise<void> {
  await page.route(/\/whybook\/status/, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: {
        ...status,
        claude_available: true,
        claude: {
          ...status.claude,
          available: true,
          provider: 'openrouter',
          label: 'OpenRouter: fake/model',
          reason: null,
          setup: null,
          priced: true
        },
        remote_model: 'OpenRouter: fake/model'
      }
    });
  });
}

async function newNotebook(
  page: IJupyterLabPageFixture,
  file: string
): Promise<void> {
  const notebook = {
    cells: CELLS.map((source, index) => ({
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

test('shows the picks of the takes that are worth a chip, and none of their noise', async ({
  page,
  tmpPath
}) => {
  await connected(page);
  const asked: string[] = [];
  page.on('request', request => {
    if (/\/whybook\/defaults\/ask$/.test(new URL(request.url()).pathname)) {
      asked.push(request.postDataJSON().function.function);
    }
  });
  const file = `${tmpPath}/picks.ipynb`;
  await newNotebook(page, file);
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
  // The answers that the server kept while the videos were recorded.
  kept = true;
  expect(await execute(page, KEEP)).toBe('ok');

  const lookup = page.waitForResponse(/\/whybook\/defaults(\?|$)/);
  await page.locator('.jp-Epi-runall').click();
  await lookup;
  const card = page.locator(
    '.jp-Epi-bench .jp-Epi-cell[data-cell-id="cell-1"]'
  );
  // Before, the card showed deep True, subset None ×2 and method newton:
  // what copy keeps, every row of the data, and the optimizer of the
  // propensity model. Now the level of the interval and the distribution
  // of the tests of the fit, beside the value that the cell wrote.
  await expect(card.locator('.jp-Epi-chip.jp-mod-found')).toHaveText(
    ['alpha 0.05', 'use_t None'],
    { timeout: 60000 }
  );
  await expect(card.locator('.jp-Epi-chip')).toHaveText([
    'alpha 0.05',
    'use_t None',
    'cov_type HC3'
  ]);
  await expect(card.locator('.jp-Epi-chips-waiting')).toHaveCount(0);
  // Every function of the card has an answer, also those whose every pick
  // is noise: no model is asked about them.
  expect(asked.filter(name => KEPT.some(item => item[0] === name))).toEqual([]);
});
