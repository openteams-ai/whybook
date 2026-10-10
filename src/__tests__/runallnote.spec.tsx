/**
 * The notes of Variables and Contents about the names of the last run that
 * the kernel lacks, while Run all runs (critique 5, the app, A9). During
 * Run all the note of Variables read "17 from the last run, not in the
 * kernel. Run all", and offered a run that had already started. While Run
 * all runs, each note now reads "Running all cells", with dots that count
 * from one to three, and offers no run. Run all counts as running until the
 * kernel's variables are listed after its last cell, so that the old note
 * does not come back in between. A name that is still missing then, as
 * after a cell that failed, brings the note and its run back.
 */
import './fakes/quiet';

import * as React from 'react';

import type { IStoredVariable } from '../model/restore';
import type { IVariable } from '../tokens';
import { ContentsSection, VariablesSection } from '../ui/variables';
import { benchModel, notebookOf } from './fakes/bench-fake';
import { mount, settle } from './fakes/bench-render';

const DIARY: IVariable = {
  name: 'diary',
  label: 'diary',
  kind: 'dataframe',
  type: 'pandas.core.frame.DataFrame',
  rows: 10,
  n_columns: 3
};

/** A promise that the test settles. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => (resolve = done));
  return { promise, resolve };
}

/**
 * A notebook that kept `diary` from its last run, over a kernel that lists
 * nothing: `diary` is stale. The cell that makes it runs until the test
 * ends it.
 */
async function staleDiary(Section: typeof VariablesSection) {
  const content = notebookOf([{ id: 'load', source: 'diary = load()' }]);
  content.metadata = {
    whybook: {
      variables: [{ ...DIARY, cell: 'load' } as IStoredVariable]
    }
  } as any;
  const { model } = benchModel(content);
  (model.sessionContext as any).session = { kernel: {} };
  (model.bridge as any)._snapshot = { variables: [], packages: {} };
  model.select('diary');
  const cell = deferred();
  const ran: string[] = [];
  model.runCell = async (id: string) => {
    ran.push(id);
    await cell.promise;
  };
  const view = await mount(<Section model={model} />);
  await settle();
  const note = () => {
    const found = view.host.querySelector('.jp-Epi-stale-note');
    return found
      ? {
          text: found.textContent,
          buttons: Array.from(found.querySelectorAll('button')).map(
            button => button.textContent
          ),
          dots: found.querySelector('.jp-Epi-dots')?.getAttribute('aria-hidden')
        }
      : null;
  };
  return {
    model,
    ran,
    note,
    /** The cell that makes `diary` ends. */
    finish: () => cell.resolve(),
    close: async () => {
      await view.unmount();
      model.dispose();
    }
  };
}

const RUNNING = {
  text: 'Running all cells...',
  buttons: [],
  dots: 'true'
};

describe('the note of Variables during Run all', () => {
  it('reads "Running all cells" with no button, and comes back with Run all when a name is still missing', async () => {
    const { model, note, finish, close } = await staleDiary(VariablesSection);
    const seen = [note()];
    const run = model.runAll();
    await settle();
    seen.push(note());
    finish();
    await run;
    await settle();
    seen.push(note());
    await close();
    expect(seen).toEqual([
      {
        text: '1 from the last run, not in the kernel. Run all',
        buttons: ['Run all'],
        dots: undefined
      },
      RUNNING,
      {
        text: '1 from the last run, not in the kernel. Run all',
        buttons: ['Run all'],
        dots: undefined
      }
    ]);
  });

  it('waits for the listing after the last cell, and goes once the name is in the kernel', async () => {
    const { model, note, finish, close } = await staleDiary(VariablesSection);
    // The refresh that the last cell makes due goes out as the cell ends.
    const listing = deferred();
    const run = model.runAll();
    await settle();
    (model as any)._pendingRefresh = listing.promise;
    finish();
    await run;
    await settle();
    const before = note();
    // The listing holds diary, and the view draws it, as a refresh does.
    (model.bridge as any)._snapshot = { variables: [DIARY], packages: {} };
    (model as any)._version++;
    (model as any)._emit();
    listing.resolve();
    await settle();
    const after = note();
    await close();
    expect({ before, after }).toEqual({ before: RUNNING, after: null });
  });

  it('reads "Running all cells" when the questions run every cell to make a missing name', async () => {
    const { model, ran, note, finish, close } =
      await staleDiary(VariablesSection);
    model.refresh = () => Promise.resolve();
    model.ask = {
      kind: 'drop',
      id: 1,
      anchor: null,
      loading: false,
      error: null,
      source: { kind: 'variable', name: 'diary', label: 'diary' },
      target: { cellId: 'load' },
      modifiers: { branch: false, parallel: false },
      result: null,
      checked: [],
      claudeStage: null,
      missing: {
        names: ['diary'],
        noKernel: false,
        nothingRan: false,
        from: 'variable',
        plan: ['load'],
        unresolved: [],
        running: false,
        claude: null,
        resume: () => undefined
      }
    } as any;
    const run = model.runMissing(true);
    await settle();
    const during = note();
    finish();
    await run;
    await close();
    expect({ ran, during }).toEqual({ ran: ['load'], during: RUNNING });
  });
});

describe('the note of Contents during Run all', () => {
  it('reads "Running all cells" with no button', async () => {
    const { model, note, finish, close } = await staleDiary(ContentsSection);
    const seen = [note()];
    const run = model.runAll();
    await settle();
    seen.push(note());
    finish();
    await run;
    await settle();
    seen.push(note());
    await close();
    const stale = {
      text: 'From the last run, not in the kernel now. Run the cells that make it',
      buttons: ['Run the cells that make it'],
      dots: undefined
    };
    expect(seen).toEqual([stale, RUNNING, stale]);
  });
});
