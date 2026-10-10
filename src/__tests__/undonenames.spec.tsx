/**
 * The names that only an undone answer made (design iteration 1.119; A8 of
 * research/critique-5/app.md). Undo deletes the cell that an answer added
 * and leaves the kernel as it is. After two questions about age on [2], one
 * answered by a branch and one by a new cell, and Undo of both, Variables
 * listed model_data_by_age, lmm_fit_by_age and age_vs_pain_score with the
 * names that cells make, and Variables explored counted model_data_by_age.
 * Variables now lists them under "From undone answers", each with Remove,
 * and Variables explored leaves them out.
 */
import './fakes/quiet';

import type { Signal } from '@lumino/signaling';
import * as React from 'react';

import type { KernelBridge } from '../model/kernel';
import { PYTHON, R, SAS } from '../model/languages';
import { deleteCell, insertCodeCell } from '../model/notebook';
import { storedAnalysis } from '../model/restore';
import type { ICellAnalysis, IVariable } from '../tokens';
import { coverage } from '../ui/exploration';
import { VariablesSection } from '../ui/variables';
import type { IBenchCell } from './fakes/bench-fake';
import { benchModel, typeKey } from './fakes/bench-fake';
import { button, mount, settle, step } from './fakes/bench-render';

const LOAD = 'diary = pd.read_csv("diary.csv")';
const FIT =
  'lmm_fit = smf.mixedlm("pain_score ~ treatment_arm * month", diary, groups=diary["patient_id"]).fit()';
// The branch that "Does age change the trajectory of pain?" added to [2]: it
// fits lmm_fit again, as a branch does, and makes two names of its own.
const BRANCH = [
  'model_data_by_age = diary.dropna(subset=["age"])',
  'lmm_fit = smf.mixedlm("pain_score ~ treatment_arm * month + age", model_data_by_age, groups=model_data_by_age["patient_id"]).fit()',
  'lmm_fit_by_age = lmm_fit'
].join('\n');
// The new cell that "Is age associated with pain_score here?" added.
const NEW = 'age_vs_pain_score = smf.ols("pain_score ~ age", data=diary).fit()';

const BRANCH_QUESTION = 'Does age change the trajectory of pain?';
const NEW_QUESTION = 'Is age associated with pain_score here?';

function analysisOf(defs: string[], uses: string[]): ICellAnalysis {
  return {
    defs,
    uses,
    formulas: [],
    columns: {},
    decisions: [],
    attachments: []
  };
}

/** A cell that ran, with the analysis that the notebook kept of it. */
function analysed(
  id: string,
  source: string,
  count: number,
  defs: string[],
  uses: string[],
  meta: Record<string, unknown> = {}
): IBenchCell {
  return {
    id,
    source,
    count,
    meta: { ...meta, analysis: storedAnalysis(analysisOf(defs, uses), source) }
  };
}

function frame(name: string, labels: string[]): IVariable {
  return {
    name,
    label: name,
    kind: 'dataframe',
    type: 'pandas.core.frame.DataFrame',
    rows: 5880,
    n_columns: labels.length,
    columns: labels.map(label => ({
      name: `${name}['${label}']`,
      label,
      parent: name,
      kind: 'numeric',
      tag: 'num',
      rows: 5880
    }))
  };
}

function fitted(name: string, type: string): IVariable {
  return { name, label: name, kind: 'model', type };
}

const MIXED = 'statsmodels.regression.mixed_linear_model.MixedLMResultsWrapper';
const OLS = 'statsmodels.regression.linear_model.RegressionResultsWrapper';

/** What the kernel holds after both answers ran. */
const KERNEL: IVariable[] = [
  frame('diary', ['pain_score', 'month', 'age']),
  fitted('lmm_fit', MIXED),
  frame('model_data_by_age', ['pain_score', 'month', 'age']),
  fitted('lmm_fit_by_age', MIXED),
  fitted('age_vs_pain_score', OLS)
];

/** An answer to a question about [2] that added this cell, done. */
function strip(
  anchor: string,
  inserted: string,
  kind: 'branch' | 'new',
  text: string
): any {
  return {
    cellId: anchor,
    text,
    action: '',
    placement: { kind, cell: 'fit', label: '' },
    status: 'done',
    stage: null,
    elapsed: null,
    started: 0,
    thinking: null,
    before: null,
    after: null,
    insertedId: inserted,
    error: null,
    showDiff: false
  };
}

/**
 * The demo after both answers, in a Python kernel that holds KERNEL. The
 * kernel runs `del` when the test lets it (`answer`), and its variables are
 * listed again on each refresh.
 */
function afterBothAnswers(
  options: { newCell?: IBenchCell; branch?: IBenchCell } = {}
) {
  const { model, nb } = benchModel([
    analysed('load', LOAD, 1, ['diary'], ['pd']),
    analysed('fit', FIT, 2, ['lmm_fit'], ['smf', 'diary']),
    options.branch ??
      analysed(
        'byage',
        BRANCH,
        3,
        ['model_data_by_age', 'lmm_fit', 'lmm_fit_by_age'],
        ['diary', 'smf'],
        { branch: { of: 'fit', letter: 'b' }, written_by: 'agent' }
      ),
    options.newCell ??
      analysed('agecell', NEW, 4, ['age_vs_pain_score'], ['smf', 'diary'])
  ]);
  (model.sessionContext as any).session = { kernel: {} };
  (model.bridge as any)._languageName = 'python';
  let held = [...KERNEL];
  const listed = () => {
    (model.bridge as any)._snapshot = { variables: held, packages: {} };
    (model.bridge.changed as Signal<KernelBridge, string>).emit('variables');
  };
  listed();
  const waiting: (() => void)[] = [];
  const execute = jest.spyOn(model.bridge, 'execute').mockImplementation(
    (code: string) =>
      new Promise(resolve =>
        waiting.push(() => {
          const names = code.replace(/^del /, '').split(', ');
          held = held.filter(variable => !names.includes(variable.name));
          resolve({ outputs: [], error: null });
        })
      )
  );
  jest.spyOn(model, 'refresh').mockImplementation(async () => listed());
  model.strips.set('fit', strip('fit', 'byage', 'branch', BRANCH_QUESTION));
  model.strips.set('end:1', strip('end:1', 'agecell', 'new', NEW_QUESTION));
  /** The kernel runs what it was sent. */
  const answer = async () => {
    while (waiting.length) {
      waiting.shift()!();
    }
    await settle();
  };
  return { model, nb, execute, answer };
}

/** The rows of the main list of Variables. */
function main(host: Element): (string | null)[] {
  return Array.from(
    host.querySelectorAll('.jp-Epi-list > .jp-Epi-variable')
  ).map(row => row.getAttribute('data-variable'));
}

/** The rows under "From undone answers". */
function apart(host: Element): (string | null)[] {
  return Array.from(
    host.querySelectorAll('.jp-Epi-undone-row .jp-Epi-variable')
  ).map(row => row.getAttribute('data-variable'));
}

function row(host: Element, name: string): HTMLElement {
  return host.querySelector<HTMLElement>(
    `.jp-Epi-variable[data-variable="${name}"]`
  )!;
}

function removeOf(host: Element, name: string): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(
    `.jp-Epi-undone-one[aria-label="Remove ${name} from the kernel"]`
  )!;
}

/** Both Undos, as the analyst presses them. */
async function undoBoth(model: any): Promise<void> {
  await step(() => {
    model.undo('fit');
    model.undo('end:1');
  });
  await settle();
}

afterEach(() => jest.restoreAllMocks());

describe('the names that only an undone answer made', () => {
  it('lists them under "From undone answers" after both Undos, and keeps lmm_fit, which [2] makes, in the main list', async () => {
    const { model, execute } = afterBothAnswers();
    const view = await mount(<VariablesSection model={model} />);
    try {
      expect(main(view.host)).toEqual([
        'diary',
        'lmm_fit',
        'model_data_by_age',
        'lmm_fit_by_age',
        'age_vs_pain_score'
      ]);
      // Nothing shows without a name.
      expect(view.host.querySelector('.jp-Epi-undone-head')).toBeNull();
      await undoBoth(model);
      expect(main(view.host)).toEqual(['diary', 'lmm_fit']);
      expect(apart(view.host)).toEqual([
        'model_data_by_age',
        'lmm_fit_by_age',
        'age_vs_pain_score'
      ]);
      const head = view.host.querySelector('.jp-Epi-undone-head')!;
      expect(head.querySelector('.jp-Epi-undone-title')?.textContent).toBe(
        'From undone answers'
      );
      expect(button(head, 'Remove all').title).toBe(
        'Remove these 3 names from the kernel: del model_data_by_age, lmm_fit_by_age, age_vs_pain_score'
      );
      // Each row names the answer that made it.
      expect(row(view.host, 'age_vs_pain_score').title).toBe(
        `${OLS}, from the answer to "${NEW_QUESTION}". You undid that answer.`
      );
      expect(row(view.host, 'lmm_fit_by_age').title).toBe(
        `${MIXED}, from the answer to "${BRANCH_QUESTION}". You undid that answer.`
      );
      // The kernel still holds them, and nothing runs there without a click.
      expect(
        view.host.querySelector('.jp-Epi-section-count')?.textContent
      ).toBe('5 in kernel');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
      model.dispose();
    }
  });

  it('leaves the frames that only undone answers made out of Variables explored', () => {
    const { model } = afterBothAnswers();
    try {
      // While the branch is in the notebook, it makes model_data_by_age.
      expect(coverage(model).map(entry => entry.label)).toContain(
        'model_data_by_age'
      );
      model.undo('fit');
      model.undo('end:1');
      const labels = coverage(model).map(entry => entry.label);
      expect(labels).toContain('diary');
      expect(labels).not.toContain('model_data_by_age');
      // Nor does the map draw them, or the Derived row count them.
      expect(model.mainVariables().map((v: IVariable) => v.name)).toEqual([
        'diary',
        'lmm_fit'
      ]);
    } finally {
      model.dispose();
    }
  });

  it('removes a name from the kernel with del on a click on its Remove, and the rest with Remove all', async () => {
    const { model, execute, answer } = afterBothAnswers();
    const view = await mount(<VariablesSection model={model} />);
    try {
      await undoBoth(model);
      await step(() => model.select('lmm_fit_by_age'));
      const remove = removeOf(view.host, 'lmm_fit_by_age');
      expect(remove.title).toBe(
        'Remove lmm_fit_by_age from the kernel: del lmm_fit_by_age'
      );
      await step(() => remove.focus());
      await step(() => remove.click());
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenLastCalledWith('del lmm_fit_by_age');
      // Until the kernel lists its variables again, the row stays, dimmed,
      // and the focus is on the next row.
      expect(
        row(view.host, 'lmm_fit_by_age').closest('.jp-Epi-undone-row')
          ?.classList
      ).toContain('jp-mod-removing');
      expect(removeOf(view.host, 'lmm_fit_by_age').disabled).toBe(true);
      expect(document.activeElement?.getAttribute('data-variable')).toBe(
        'age_vs_pain_score'
      );
      await answer();
      expect(apart(view.host)).toEqual([
        'model_data_by_age',
        'age_vs_pain_score'
      ]);
      expect(main(view.host)).toEqual(['diary', 'lmm_fit']);
      // Contents does not keep a name that is gone.
      expect(model.selected).toBeNull();
      const head = view.host.querySelector('.jp-Epi-undone-head')!;
      await step(() => button(head, 'Remove all').click());
      expect(execute).toHaveBeenLastCalledWith(
        'del model_data_by_age, age_vs_pain_score'
      );
      await answer();
      expect(view.host.querySelector('.jp-Epi-undone-head')).toBeNull();
      expect(apart(view.host)).toEqual([]);
      expect(main(view.host)).toEqual(['diary', 'lmm_fit']);
      expect(
        view.host.querySelector('.jp-Epi-section-count')?.textContent
      ).toBe('2 in kernel');
    } finally {
      await view.unmount();
      model.dispose();
    }
  });

  it('reaches Remove all, each name and its Remove with the arrow keys', async () => {
    const { model } = afterBothAnswers();
    const view = await mount(<VariablesSection model={model} />);
    try {
      await undoBoth(model);
      const press = (key: string) =>
        step(() => {
          document.activeElement!.dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true })
          );
        });
      await step(() => row(view.host, 'lmm_fit').focus());
      await press('ArrowDown');
      expect(document.activeElement?.textContent).toBe('Remove all');
      await press('ArrowDown');
      expect(document.activeElement?.getAttribute('data-variable')).toBe(
        'model_data_by_age'
      );
      await press('ArrowDown');
      expect(document.activeElement).toBe(
        removeOf(view.host, 'model_data_by_age')
      );
      await press('End');
      expect(document.activeElement).toBe(
        removeOf(view.host, 'age_vs_pain_score')
      );
    } finally {
      await view.unmount();
      model.dispose();
    }
  });

  it('puts a name back in the main list once a cell makes it, and keeps it there after that cell goes by hand', async () => {
    const { model, nb } = afterBothAnswers();
    const view = await mount(<VariablesSection model={model} />);
    try {
      await undoBoth(model);
      const source = 'model_data_by_age = diary[diary.age > 30]';
      await step(() => {
        insertCodeCell(nb, 2, source, {
          analysis: storedAnalysis(
            analysisOf(['model_data_by_age'], ['diary']),
            source
          )
        });
      });
      await settle();
      expect(main(view.host)).toEqual([
        'diary',
        'lmm_fit',
        'model_data_by_age'
      ]);
      expect(apart(view.host)).toEqual(['lmm_fit_by_age', 'age_vs_pain_score']);
      // A cell of the analyst made it last, and no Undo removed that cell.
      await step(() => deleteCell(nb, nb.cells.get(2).id));
      await settle();
      expect(main(view.host)).toEqual([
        'diary',
        'lmm_fit',
        'model_data_by_age'
      ]);
    } finally {
      await view.unmount();
      model.dispose();
    }
  });

  it('counts the names that a cell made at its last run while the analyst edits it', async () => {
    const { model, nb } = afterBothAnswers();
    const view = await mount(<VariablesSection model={model} />);
    try {
      // A key typed in [2]: the kernel has not analysed its new code yet.
      await step(() => typeKey(nb, 'fit', '#'));
      expect(model.cell('fit')?.analysis).toBeNull();
      await undoBoth(model);
      expect(main(view.host)).toEqual(['diary', 'lmm_fit']);
      expect(apart(view.host)).toEqual([
        'model_data_by_age',
        'lmm_fit_by_age',
        'age_vs_pain_score'
      ]);
    } finally {
      await view.unmount();
      model.dispose();
    }
  });

  it('asks the kernel for the names of a cell that it has not analysed yet, when Undo comes right after the run', async () => {
    const { model } = afterBothAnswers({
      newCell: { id: 'agecell', source: NEW, count: 4 }
    });
    try {
      let analysed = false;
      const refreshAnalysis = jest
        .spyOn(model.bridge, 'refreshAnalysis')
        .mockImplementation(async () => {
          analysed = true;
        });
      const fresh = model.bridge.freshAnalysis.bind(model.bridge);
      jest
        .spyOn(model.bridge, 'freshAnalysis')
        .mockImplementation((cellId: string, source: string) =>
          analysed && cellId === 'agecell' && source === NEW
            ? analysisOf(['age_vs_pain_score'], ['smf', 'diary'])
            : fresh(cellId, source)
        );
      expect(model.cell('agecell')?.analysis).toBeNull();
      model.undo('end:1');
      expect(refreshAnalysis).toHaveBeenCalledWith([
        { id: 'agecell', source: NEW }
      ]);
      await settle();
      expect(model.undoneNames().map((v: IVariable) => v.name)).toEqual([
        'age_vs_pain_score'
      ]);
    } finally {
      model.dispose();
    }
  });
});

describe('the code of Remove', () => {
  it('deletes the names with del in Python and rm in R, and has none in SAS, whose variables are not listed', () => {
    expect(PYTHON.remove?.(['model_data_by_age', 'lmm_fit_by_age'])).toBe(
      'del model_data_by_age, lmm_fit_by_age'
    );
    expect(R.remove?.(['fit_by_age'])).toBe(
      'rm(list = c("fit_by_age"), envir = globalenv())'
    );
    expect(SAS.remove).toBeUndefined();
  });
});
