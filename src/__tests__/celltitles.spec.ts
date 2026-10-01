import {
  BACKGROUND,
  BACKGROUND_RETRY,
  BACKGROUND_START,
  CellTitles,
  TITLE_PAUSE,
  importsTitle,
  titleKey,
  titleNote
} from '../model/celltitles';
import { cellMeta } from '../model/notebook';

/** A code cell with the parts that CellTitles reads and writes. */
function fakeCell(id: string, source: string) {
  const metadata: Record<string, unknown> = {};
  return {
    id,
    type: 'code',
    sharedModel: {
      getSource: () => source,
      setSource: (text: string) => (source = text)
    },
    getMetadata: (key: string) => metadata[key],
    setMetadata: (key: string, value: unknown) => (metadata[key] = value),
    deleteMetadata: (key: string) => delete metadata[key]
  };
}

function setup(options: { enabled?: boolean; title?: string } = {}) {
  const cell = fakeCell('weekly', 'weekly = diary.groupby("week").mean()');
  const requests: any[] = [];
  const api = {
    titleCells: (body: any, onEvent: (event: any) => void) => {
      requests.push(body);
      onEvent({
        type: 'result',
        model: 'claude-opus-5-5',
        cells: [
          { id: 'weekly', title: options.title ?? 'Weekly mean of the diary' }
        ]
      });
      return Promise.resolve();
    }
  };
  const titles = new CellTitles({
    api: api as any,
    notebook: () => ({ cells: { length: 1, get: () => cell } }) as any,
    enabled: () => options.enabled ?? true,
    model: () => 'remote',
    shown: () => 'weekly = diary.groupby("week").mean()',
    changed: () => undefined
  });
  return { cell, requests, titles };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('CellTitles', () => {
  it('asks for a title once the analyst stops typing, and keeps it for the code', async () => {
    const { cell, requests, titles } = setup();
    titles.edited('weekly');
    jest.advanceTimersByTime(TITLE_PAUSE - 1);
    titles.edited('weekly');
    jest.advanceTimersByTime(TITLE_PAUSE - 1);
    expect(requests).toHaveLength(0);
    jest.advanceTimersByTime(1);
    expect(requests).toEqual([
      {
        model: 'remote',
        cells: [
          {
            id: 'weekly',
            code: 'weekly = diary.groupby("week").mean()',
            title: 'weekly = diary.groupby("week").mean()'
          }
        ]
      }
    ]);
    await Promise.resolve();
    const note = cellMeta(cell as any).title_note!;
    expect(note.title).toBe('Weekly mean of the diary');
    expect(note.key).toBe(titleKey(cell.sharedModel.getSource()));
    expect(note.by?.choice).toBe('remote');
    expect(note.by?.model).toBe('claude-opus-5-5');
    // The same code is not titled again.
    titles.edited('weekly');
    jest.advanceTimersByTime(TITLE_PAUSE);
    expect(requests).toHaveLength(1);
  });

  it('asks at once when the cell runs during the pause', () => {
    const { requests, titles } = setup();
    titles.flush('weekly');
    expect(requests).toHaveLength(0);
    titles.edited('weekly');
    titles.flush('weekly');
    expect(requests).toHaveLength(1);
    jest.advanceTimersByTime(TITLE_PAUSE);
    expect(requests).toHaveLength(1);
  });

  it('keeps a title that a person gave, and the question of an answer', () => {
    for (const meta of [
      { title: 'Weekly pain per patient, by arm' },
      { question: { id: 'q1', text: 'Does MIN_DAYS change the result?' } }
    ]) {
      const { cell, requests, titles } = setup();
      cell.setMetadata('whybook', meta);
      titles.edited('weekly');
      jest.advanceTimersByTime(TITLE_PAUSE);
      expect(requests).toHaveLength(0);
    }
    // The agent's title is a model's, so the agent's cell gets a new one.
    const { cell, requests, titles } = setup();
    cell.setMetadata('whybook', { title: 'A step', written_by: 'agent' });
    titles.edited('weekly');
    jest.advanceTimersByTime(TITLE_PAUSE);
    expect(requests).toHaveLength(1);
  });

  it('asks nothing when no model can title', () => {
    const { requests, titles } = setup({ enabled: false });
    titles.edited('weekly');
    jest.advanceTimersByTime(TITLE_PAUSE);
    expect(requests).toHaveLength(0);
  });

  it('keeps the last title while the code changes, and asks for the new code', async () => {
    const { cell, requests, titles } = setup();
    titles.edited('weekly');
    jest.advanceTimersByTime(TITLE_PAUSE);
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
    }
    expect(titleNote(cellMeta(cell as any), 'remote')?.title).toBe(
      'Weekly mean of the diary'
    );
    // Spaces around the code do not count as an edit.
    cell.sharedModel.setSource(`\n${cell.sharedModel.getSource()}\n`);
    titles.edited('weekly');
    jest.advanceTimersByTime(TITLE_PAUSE);
    expect(requests).toHaveLength(1);
    // New code keeps the last title on the card until its own comes.
    cell.sharedModel.setSource('weekly = diary.groupby("month").mean()');
    expect(titleNote(cellMeta(cell as any), 'remote')?.title).toBe(
      'Weekly mean of the diary'
    );
    titles.edited('weekly');
    jest.advanceTimersByTime(TITLE_PAUSE);
    expect(requests).toHaveLength(2);
  });
});

describe('CellTitles in the background', () => {
  /** A notebook of first-line cells, and the requests that reach the API. */
  function notebook(
    count: number,
    options: { model?: string; busy?: () => boolean; fail?: boolean } = {}
  ) {
    const cells = Array.from({ length: count }, (_, i) =>
      fakeCell(`c${i}`, `x${i} = ${i}`)
    );
    const requests: any[] = [];
    const api = {
      titleCells: (body: any, onEvent: (event: any) => void) => {
        requests.push(body);
        if (!options.fail) {
          onEvent({
            type: 'result',
            cells: body.cells.map((cell: any) => ({
              id: cell.id,
              title: `Title of ${cell.id}`
            }))
          });
        }
        return Promise.resolve();
      }
    };
    const titles = new CellTitles({
      api: api as any,
      notebook: () =>
        ({
          cells: { length: cells.length, get: (i: number) => cells[i] }
        }) as any,
      enabled: () => true,
      model: () => options.model ?? 'remote',
      shown: id => id,
      changed: () => undefined,
      busy: options.busy
    });
    return { cells, requests, titles };
  }

  const flush = async () => {
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
    }
  };

  it('titles a notebook of first lines in batches, one request at a time', async () => {
    const { cells, requests, titles } = notebook(10);
    titles.titleAll();
    jest.advanceTimersByTime(BACKGROUND_START - 1);
    expect(requests).toHaveLength(0);
    jest.advanceTimersByTime(1);
    expect(requests.map(body => body.cells.length)).toEqual([8]);
    await flush();
    jest.advanceTimersByTime(BACKGROUND.remote.pause - 1);
    expect(requests).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(requests.map(body => body.cells.length)).toEqual([8, 2]);
    await flush();
    expect(cells.map(cell => cellMeta(cell as any).title_note?.title)).toEqual(
      cells.map(cell => `Title of ${cell.id}`)
    );
    // Titled cells are not asked again.
    titles.titleAll();
    jest.advanceTimersByTime(BACKGROUND_START * 2);
    expect(requests).toHaveLength(2);
  });

  it('asks a local model for one cell at a time', async () => {
    const { requests, titles } = notebook(3, { model: 'gemma-4-e2b' });
    titles.titleAll();
    jest.advanceTimersByTime(BACKGROUND_START);
    for (let i = 0; i < 3; i++) {
      await flush();
      jest.advanceTimersByTime(BACKGROUND.local.pause);
    }
    expect(
      requests.map(body => body.cells.map((cell: any) => cell.id))
    ).toEqual([['c0'], ['c1'], ['c2']]);
  });

  it('waits while the analyst waits for an answer', async () => {
    let busy = true;
    const { requests, titles } = notebook(2, { busy: () => busy });
    titles.titleAll();
    jest.advanceTimersByTime(BACKGROUND_START + 3 * BACKGROUND_RETRY);
    expect(requests).toHaveLength(0);
    busy = false;
    jest.advanceTimersByTime(BACKGROUND_RETRY);
    expect(requests).toHaveLength(1);
  });

  it('does not ask a model for a cell that only imports', () => {
    const { cells, requests, titles } = notebook(3);
    cells[0].sharedModel.setSource(
      'import pandas as pd\nfrom prep import load'
    );
    titles.titleAll();
    jest.advanceTimersByTime(BACKGROUND_START);
    expect(requests[0].cells.map((cell: any) => cell.id)).toEqual(['c1', 'c2']);
    titles.edited('c0');
    jest.advanceTimersByTime(TITLE_PAUSE);
    expect(requests).toHaveLength(1);
  });

  it('leaves the titles that people gave, and does not ask again after a failure', async () => {
    const { cells, requests, titles } = notebook(3, { fail: true });
    cells[1].setMetadata('whybook', { title: 'Weekly pain' });
    titles.titleAll();
    jest.advanceTimersByTime(BACKGROUND_START);
    await flush();
    expect(requests[0].cells.map((cell: any) => cell.id)).toEqual(['c0', 'c2']);
    expect(titles.state('c0')).toBe('failed');
    titles.titleAll();
    jest.advanceTimersByTime(BACKGROUND_START * 2);
    expect(requests).toHaveLength(1);
  });
});

describe('importsTitle', () => {
  it('names the modules of a cell that only imports', () => {
    expect(
      importsTitle(
        'import whybook\nimport pandas as pd\nimport statsmodels.formula.api as smf\n' +
          'from prep import MIN_DAYS, drop_sparse, load_diary_raw'
      )
    ).toBe('Imports: whybook, pandas, statsmodels and prep');
    expect(importsTitle('import numpy as np')).toBe('Imports: numpy');
    expect(
      importsTitle(
        '# Tools\n%matplotlib inline\nfrom prep import (\n    load,\n    clean,\n)\n' +
          'from . import tools\nimport numpy as np, scipy.stats'
      )
    ).toBe('Imports: prep, tools, numpy and scipy');
    expect(
      importsTitle('import a\nimport b\nimport c\nimport d\nimport e\nimport f')
    ).toBe('Imports: a, b, c, d and 2 more');
  });

  it('leaves a cell with other code to the model', () => {
    expect(
      importsTitle('import pandas as pd\ndiary = pd.read_csv("diary.csv")')
    ).toBeNull();
    expect(importsTitle('')).toBeNull();
    expect(importsTitle('# A note')).toBeNull();
  });
});
