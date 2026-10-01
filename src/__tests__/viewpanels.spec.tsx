/**
 * Popovers, the panels and an agent's run in the view (design iteration
 * 1.83), in jsdom (ui-tests/tests/view-panels.spec.ts in the browser).
 */
import * as React from 'react';
import { act } from 'react';

import { CommandRegistry } from '@lumino/commands';
import { Signal } from '@lumino/signaling';

import { checkupPlugin } from '../checkup';
import { speedFindings } from '../model/checkup';
import { attributed, withoutDrawing } from '../model/decisions';
import type { Ask } from '../model/epimodel';
import {
  codeKey,
  editedByHand,
  holdsValue,
  viewCodeToKeep
} from '../model/handedit';
import { KernelBridge } from '../model/kernel';
import { cellMeta, insertCodeCell } from '../model/notebook';
import type { IStoredVariable } from '../model/restore';
import { runNames } from '../model/runnames';
import { pastRun } from '../model/runs';
import { fingerprint } from '../model/tables';
import type { IAnchor, IDecision } from '../tokens';
import { AgentRunView } from '../ui/agent';
import { focusInView, questionKeys } from '../ui/common';
import { DocumentView } from '../ui/document';
import { RightPanel } from '../ui/exploration';
import { viewExtensions } from '../ui/extensions';
import { mapLayout } from '../ui/map';
import { placePopover, placeTooltip } from '../ui/popoverplace';
import { VariablesSection } from '../ui/variables';
import type { IBenchCell } from './fakes/bench-fake';
import { benchModel, notebookOf, typeKey } from './fakes/bench-fake';
import { mount, settle, step } from './fakes/bench-render';

/** The testers' window: 1,000 px high, JupyterLab's panels between y = 28 and y = 976. */
const BOUNDS = { top: 34, bottom: 970, left: 6, right: 1594 };

/** A drop or a pick that opens the questions beside this point. */
function dropAsk(anchor: IAnchor, id = 7): Ask {
  return {
    kind: 'drop',
    id,
    anchor,
    loading: true,
    error: null,
    source: { kind: 'column', name: 'tou_start', label: 'tou_start' },
    target: { item: { kind: 'column', name: 'kwh_peak', label: 'kwh_peak' } },
    modifiers: { branch: false, parallel: false },
    result: null,
    checked: [],
    claudeStage: null
  } as unknown as Ask;
}

describe('a popover inside the window', () => {
  it('keeps a tall Click-mode popover beside a low target inside the window, with the room as its height', () => {
    // Energy step 17: tou_start then kwh_peak, the row of kwh_peak at
    // y = 501; the popover was 984 px high and started at y = 481.
    const placed = placePopover(
      { x: 150, y: 501 },
      { width: 420, height: 984 },
      BOUNDS
    );
    expect(placed.top).toBeGreaterThanOrEqual(BOUNDS.top);
    expect(placed.maxHeight).toBe(BOUNDS.bottom - BOUNDS.top);
    expect(placed.top + Math.min(984, placed.maxHeight)).toBeLessThanOrEqual(
      BOUNDS.bottom
    );
    // Beside the target, to its right.
    expect(placed.left).toBe(162);
  });

  it('moves a popover up as far as it must when the model makes it grow, and leaves a short one where the pointer is', () => {
    // Energy step 23: the drop at y = 530 grew to 871 px.
    const short = placePopover(
      { x: 700, y: 530 },
      { width: 420, height: 300 },
      BOUNDS
    );
    expect(short.top).toBe(510);
    const grown = placePopover(
      { x: 700, y: 530 },
      { width: 420, height: 871 },
      BOUNDS
    );
    expect(grown.top).toBe(BOUNDS.bottom - 871);
    expect(grown.top).toBeLessThan(530);
  });

  it('never starts over the menu bar', () => {
    // Energy step 12: the popover started at y = 8.
    const placed = placePopover(
      { x: 150, y: 20 },
      { width: 420, height: 984 },
      BOUNDS
    );
    expect(placed.top).toBe(BOUNDS.top);
  });

  it('opens a chip’s questions under the chip, on the side that has the room, and keeps that side while they grow', () => {
    // The chip of the tester's merge, 94 by 21 at the left edge of its cell:
    // the popover came above it while it loaded, and beside the cell
    // or below the chip once the questions came, so that it jumped.
    const chip = (y: number, x = 400) => ({
      x,
      y,
      bottom: y + 22,
      below: true
    });
    const size = (height: number) => ({ width: 420, height });
    const short = placePopover(chip(257), size(111), BOUNDS);
    const tall = placePopover(chip(257), size(382), BOUNDS);
    // Under the chip and left-aligned with it, at any height.
    expect([short.left, short.top]).toEqual([400, 285]);
    expect([tall.left, tall.top]).toEqual([400, 285]);
    // Taller than the room below: it keeps its top, takes the room as its height and scrolls.
    const huge = placePopover(chip(257), size(2000), BOUNDS);
    expect([huge.left, huge.top, huge.maxHeight]).toEqual([
      400,
      285,
      BOUNDS.bottom - 285
    ]);
    // Inside the window: moved left as far as it must.
    expect(placePopover(chip(257, 1500), size(300), BOUNDS).left).toBe(
      BOUNDS.right - 420
    );
    // Less than 320 px below and more above: above the chip, its foot at the chip.
    const low = placePopover(chip(900), size(300), BOUNDS);
    expect([low.top, low.maxHeight]).toEqual([594, 900 - 6 - BOUNDS.top]);
    // The side comes from the room and not from the height: a short popover is above too.
    expect(placePopover(chip(900), size(100), BOUNDS).top).toBe(794);
  });

  it('places a tooltip under its element, left-aligned and inside the window, or above it where there is no room below', () => {
    const size = { width: 200, height: 40 };
    expect(
      placeTooltip({ left: 400, top: 257, bottom: 279 }, size, BOUNDS)
    ).toEqual({ left: 400, top: 285 });
    // At the right edge of the window.
    expect(
      placeTooltip({ left: 1500, top: 257, bottom: 279 }, size, BOUNDS).left
    ).toBe(BOUNDS.right - 200);
    expect(
      placeTooltip({ left: -20, top: 257, bottom: 279 }, size, BOUNDS).left
    ).toBe(BOUNDS.left);
    // At the foot of the window: above the element.
    expect(
      placeTooltip({ left: 400, top: 940, bottom: 962 }, size, BOUNDS).top
    ).toBe(894);
    // A window too low for either side: inside it still.
    const low = { top: 34, bottom: 74, left: 6, right: 1594 };
    const placed = placeTooltip({ left: 400, top: 40, bottom: 62 }, size, low);
    expect(placed.top).toBeGreaterThanOrEqual(low.top);
    expect(placed.top + size.height).toBeLessThanOrEqual(low.bottom);
  });

  it('places the popover of the view again when its questions make it grow, so that it ends inside the window', async () => {
    const window1000 = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 1000
    });
    // jsdom lays nothing out: the popover's content is as tall as `content`.
    let content = 140;
    const sizes = {
      scrollHeight: () => content,
      offsetHeight: () => content,
      clientHeight: () => content,
      offsetWidth: () => 420
    };
    const saved = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, size] of Object.entries(sizes)) {
      saved.set(
        name,
        Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
      );
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains('jp-Epi-popover') ? size() : 0;
        }
      });
    }
    // The browser tells a watcher of sizes when a part of the popover grows.
    const watchers: (() => void)[] = [];
    (globalThis as any).ResizeObserver = class {
      constructor(callback: () => void) {
        watchers.push(callback);
      }
      observe() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
    const { model } = benchModel([{ id: 'a', source: 'x = 1', count: 1 }]);
    const mounted = await mount(
      <DocumentView
        model={model}
        editorServices={null}
        openFile={() => undefined}
        isVisible={() => true}
      />
    );
    try {
      // Opened while the questions load: short, its head level with the pointer.
      await step(() => model.showAsk(dropAsk({ x: 150, y: 501 })));
      await settle();
      const popover = document.querySelector<HTMLElement>('.jp-Epi-popover')!;
      expect(popover).not.toBeNull();
      expect(popover.style.top).toBe('481px');
      // The model's questions come 17 s later, and nothing of the view draws.
      content = 984;
      await act(async () => {
        watchers.forEach(watcher => watcher());
      });
      const top = parseFloat(popover.style.top);
      const height = Math.min(content, parseFloat(popover.style.maxHeight));
      expect(top).toBeGreaterThanOrEqual(6);
      expect(top + height).toBeLessThanOrEqual(994);
      expect(parseFloat(popover.style.maxHeight)).toBe(988);
    } finally {
      await mounted.unmount();
      for (const [name, descriptor] of saved) {
        if (descriptor) {
          Object.defineProperty(HTMLElement.prototype, name, descriptor);
        } else {
          delete (HTMLElement.prototype as any)[name];
        }
      }
      delete (globalThis as any).ResizeObserver;
      if (window1000) {
        Object.defineProperty(window, 'innerHeight', window1000);
      }
    }
  });

  it('scrolls the option that the arrow keys reach into sight', async () => {
    const scrolled: { element: Element; options: unknown }[] = [];
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (
      this: Element,
      options?: unknown
    ) {
      scrolled.push({ element: this, options });
    };
    const list = document.createElement('div');
    for (const text of ['first', 'second', 'last, below the window']) {
      const option = document.createElement('button');
      option.className = 'jp-Epi-option';
      option.textContent = text;
      list.appendChild(option);
    }
    document.body.appendChild(list);
    try {
      const options = list.querySelectorAll<HTMLElement>('.jp-Epi-option');
      focusInView(options[1]);
      scrolled.length = 0;
      const event = {
        key: 'ArrowDown',
        target: options[1],
        currentTarget: list,
        preventDefault: () => undefined
      } as unknown as React.KeyboardEvent<HTMLElement>;
      questionKeys(event);
      expect(document.activeElement).toBe(options[2]);
      expect(scrolled).toEqual([
        {
          element: options[2],
          options: { block: 'nearest', inline: 'nearest' }
        }
      ]);
    } finally {
      list.remove();
      Element.prototype.scrollIntoView = scrollIntoView;
    }
  });
});

describe('the search of Contents after a pick', () => {
  // jsdom has no watcher of sizes, which the cards of the view use.
  beforeAll(() => {
    (globalThis as any).ResizeObserver = class {
      observe() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  });
  afterAll(() => {
    delete (globalThis as any).ResizeObserver;
  });

  it('keeps the questions of a pick open while the analyst clears the search, and closes them on a click elsewhere', async () => {
    const { model } = benchModel([{ id: 'a', source: 'x = 1', count: 1 }]);
    const mounted = await mount(
      <DocumentView
        model={model}
        editorServices={null}
        openFile={() => undefined}
        isVisible={() => true}
      />
    );
    // The search of Contents, in the side panel beside the view.
    const contents = document.createElement('div');
    contents.className = 'jp-Epi-section jp-Epi-contents';
    contents.innerHTML =
      '<div class="jp-InputGroup jp-Epi-search"><input type="text" value="kwh_import"></div><button class="jp-Epi-item">heating</button>';
    document.body.appendChild(contents);
    try {
      await step(() => model.showAsk(dropAsk({ x: 150, y: 501 })));
      await settle();
      expect(document.querySelector('.jp-Epi-popover')).not.toBeNull();
      const search = contents.querySelector('input')!;
      await step(() => {
        search.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        search.focus();
        search.value = '';
      });
      await settle();
      expect(model.ask).not.toBeNull();
      expect(document.querySelector('.jp-Epi-popover')).not.toBeNull();
      // A click on a row of the list is a new pick: the questions close.
      const row = contents.querySelector('button')!;
      await step(() => {
        row.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      });
      await settle();
      expect(model.ask).toBeNull();
      // The questions about a cell of the map did not come from the lists:
      // the focus in their search is elsewhere, and closes them.
      await step(() =>
        model.showAsk({
          kind: 'cells',
          id: 8,
          anchor: { x: 700, y: 300 },
          loading: false,
          error: null,
          cells: ['a'],
          options: []
        } as Ask)
      );
      await settle();
      expect(model.ask?.kind).toBe('cells');
      await step(() => {
        search.blur();
        search.focus();
      });
      await settle();
      expect(model.ask).toBeNull();
    } finally {
      contents.remove();
      await mounted.unmount();
    }
  });
});

/** A code cell whose kept analysis defines and reads these names, as the kernel read them. */
function analysed(
  id: string,
  source: string,
  defs: string[],
  uses: string[],
  meta: Record<string, unknown> = {}
): IBenchCell {
  return {
    id,
    source,
    count: 1,
    meta: {
      ...meta,
      analysis: {
        defs,
        uses,
        formulas: [],
        columns: {},
        decisions: [],
        attachments: [],
        source: fingerprint(source)
      }
    }
  };
}

/** A cell of agent run `run`, with the key of the code the view wrote. */
function ofRun(
  run: string,
  id: string,
  source: string,
  defs: string[],
  uses: string[]
): IBenchCell {
  return analysed(id, source, defs, uses, {
    written_by: 'agent',
    agent: { run, step: 1 },
    view_code_key: codeKey(source)
  });
}

/** A frame or a number as the notebook keeps it from the last run. */
function kept(name: string, cell: string, frame = false): IStoredVariable {
  return frame
    ? ({
        name,
        kind: 'dataframe',
        type: 'pandas.DataFrame',
        rows: 10,
        n_columns: 3,
        cell
      } as IStoredVariable)
    : ({
        name,
        kind: 'constant',
        type: 'builtins.float',
        value: '1.5',
        cell
      } as IStoredVariable);
}

/** The energy notebook after the agent's first run: the analyst's three frames and the run's ten names. */
const ENERGY_SOURCES = {
  load: 'readings = pd.read_parquet("readings.parquet")',
  homes:
    'homes = pd.read_csv("homes.csv")\nreadings_homes = readings.merge(homes, on="home_id", how="left")',
  run3: 'desc = readings_homes.kwh_import.describe()\nneg_or_zero = (readings_homes.kwh_import <= 0).sum()\nq1, q3 = readings_homes.kwh_import.quantile([0.25, 0.75])\niqr = q3 - q1\nupper = q3 + 3 * iqr\nhigh_outliers = readings_homes[readings_homes.kwh_import > upper]',
  run4: 'sentinel = readings_homes[readings_homes.kwh_import > 999]\nzero_rows = readings_homes[readings_homes.kwh_import == 0]\nh219 = readings_homes[readings_homes.home_id == "H219"]',
  later: 'h219.kwh_import.describe()'
};

function energyNotebook(withLater: boolean) {
  const cells: IBenchCell[] = [
    analysed('load', ENERGY_SOURCES.load, ['readings'], ['pd']),
    analysed(
      'homes',
      ENERGY_SOURCES.homes,
      ['homes', 'readings_homes'],
      ['pd', 'readings']
    ),
    ofRun(
      'r1',
      'run3',
      ENERGY_SOURCES.run3,
      ['desc', 'neg_or_zero', 'q1', 'q3', 'iqr', 'upper', 'high_outliers'],
      ['readings_homes']
    ),
    ofRun(
      'r1',
      'run4',
      ENERGY_SOURCES.run4,
      ['sentinel', 'zero_rows', 'h219'],
      ['readings_homes']
    ),
    ...(withLater
      ? [analysed('later', ENERGY_SOURCES.later, [], ['h219'])]
      : [])
  ];
  const variables: IStoredVariable[] = [
    kept('readings', 'load', true),
    kept('homes', 'homes', true),
    kept('readings_homes', 'homes', true),
    ...['desc', 'neg_or_zero', 'q1', 'q3', 'iqr', 'upper'].map(name =>
      kept(name, 'run3')
    ),
    kept('high_outliers', 'run3', true),
    kept('sentinel', 'run4', true),
    kept('zero_rows', 'run4', true),
    kept('h219', 'run4', true)
  ];
  const content = notebookOf(cells);
  content.metadata = {
    whybook: {
      variables,
      agent_runs: {
        r1: {
          question: 'Does kwh_import have outliers or impossible values?',
          provider: 'openrouter',
          model: 'anthropic/claude-opus-5.5',
          cost_usd: 0.1,
          cells: ['run3', 'run4'],
          files: [],
          state: 'done',
          at: '2026-10-01T09:42:00.000Z'
        }
      }
    }
  } as any;
  return content;
}

describe('the names of an agent’s run', () => {
  it('gives a run the names that only its cells make and that no later cell outside it reads', () => {
    const cells = [
      { id: 'a', run: null, defs: ['readings'], uses: [] },
      { id: 'b', run: 'r1', defs: ['desc', 'q1', 'df'], uses: ['readings'] },
      { id: 'c', run: 'r1', defs: ['h219'], uses: ['desc'] },
      // A later run reads the first run's desc; the analyst redefines df.
      { id: 'd', run: 'r2', defs: ['fig', 'ax', 'grp'], uses: ['desc'] },
      { id: 'e', run: null, defs: ['df'], uses: ['grp'] }
    ];
    expect(
      runNames(cells, [
        'readings',
        'desc',
        'q1',
        'df',
        'h219',
        'fig',
        'ax',
        'grp'
      ])
    ).toEqual([
      { run: 'r1', names: ['q1', 'h219'] },
      { run: 'r2', names: ['fig', 'ax'] }
    ]);
  });

  it('lists the run’s ten names under the run, folded, and the analyst’s three frames above', async () => {
    const { model } = benchModel(energyNotebook(false));
    await settle();
    const view = await mount(<VariablesSection model={model} />);
    try {
      const rows = () =>
        Array.from(view.host.querySelectorAll('.jp-Epi-variable')).map(row =>
          row.getAttribute('data-variable')
        );
      expect(rows()).toEqual(['readings', 'homes', 'readings_homes']);
      const head = view.host.querySelector<HTMLButtonElement>(
        '.jp-Epi-rungroup-head'
      )!;
      expect(head.getAttribute('aria-expanded')).toBe('false');
      expect(head.textContent).toBe(
        'Does kwh_import have outliers or impossible values?10'
      );
      await step(() => head.click());
      expect(rows()).toEqual([
        'readings',
        'homes',
        'readings_homes',
        'desc',
        'neg_or_zero',
        'q1',
        'q3',
        'iqr',
        'upper',
        'high_outliers',
        'sentinel',
        'zero_rows',
        'h219'
      ]);
      // The map leaves the run's frames out of its data.
      expect(model.mainVariables().map(variable => variable.name)).toEqual([
        'readings',
        'homes',
        'readings_homes'
      ]);
      const frames = mapLayout(model)
        .nodes.filter(node => node.kind === 'frame')
        .map(node => node.label);
      expect(frames).toEqual(['readings', 'homes', 'readings_homes']);
    } finally {
      await view.unmount();
      model.dispose();
    }
  });

  it('puts a name of the run back in the list once a later cell of the analyst reads it, and shows a run’s names that a search finds', async () => {
    const { model } = benchModel(energyNotebook(true));
    await settle();
    const view = await mount(<VariablesSection model={model} />);
    try {
      const rows = () =>
        Array.from(view.host.querySelectorAll('.jp-Epi-variable')).map(row =>
          row.getAttribute('data-variable')
        );
      expect(rows()).toEqual(['readings', 'homes', 'readings_homes', 'h219']);
      expect(
        view.host.querySelector('.jp-Epi-rungroup-count')?.textContent
      ).toBe('9');
      const filter = view.host.querySelector<HTMLInputElement>(
        'input[aria-label="Filter variables"]'
      )!;
      await step(() => {
        const set = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value'
        )!.set!;
        set.call(filter, 'q');
        filter.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(rows()).toEqual(['q1', 'q3', 'iqr']);
    } finally {
      await view.unmount();
      model.dispose();
    }
  });

  it('counts a cell of a run that the analyst edited by hand as the analyst’s', async () => {
    // Pain step 6: the analyst renamed the agent's _long to diary by hand.
    const agents =
      'id_cols = ["patient_id", "week"]\n_long = pd.wide_to_long(diary_raw, ["pain"], i=id_cols, j="day")';
    const edited =
      'id_cols = ["patient_id", "week"]\ndiary = pd.wide_to_long(diary_raw, ["pain"], i=id_cols, j="day").reset_index(drop=True)';
    const cells = [
      analysed(
        'load',
        'diary_raw = pd.read_csv("diary_raw.csv")',
        ['diary_raw'],
        ['pd']
      ),
      {
        ...ofRun('r1', 'melt', edited, ['id_cols', 'diary'], ['diary_raw']),
        meta: {
          ...ofRun('r1', 'melt', edited, ['id_cols', 'diary'], ['diary_raw'])
            .meta,
          view_code_key: codeKey(agents)
        }
      }
    ];
    const content = notebookOf(cells);
    content.metadata = {
      whybook: {
        variables: [
          kept('diary_raw', 'load', true),
          kept('id_cols', 'melt'),
          kept('diary', 'melt', true)
        ]
      }
    } as any;
    const { model } = benchModel(content);
    await settle();
    expect(model.editedByHand('melt')).toBe(true);
    expect(model.runNames()).toEqual([]);
    expect(model.mainVariables().map(variable => variable.name)).toEqual([
      'diary_raw',
      'id_cols',
      'diary'
    ]);
    model.dispose();
  });
});

describe('code of the view that the analyst changed by hand', () => {
  const AGENTS =
    'diary = pd.wide_to_long(diary_raw, ["pain"], i=id_cols, j="day").reset_index()\nfit = smf.ols("pain ~ week", diary).fit(cov_type="cluster", cov_kwds={"groups": diary.patient_id})';
  const EDITED =
    'diary = pd.wide_to_long(diary_raw, ["pain"], i=id_cols, j="day").reset_index(drop = True)\nfit = smf.ols("pain ~ week", diary).fit(cov_type="cluster", cov_kwds={"groups": diary.patient_id})';
  const decisions: IDecision[] = [
    {
      name: 'drop',
      value: 'True',
      provenance: 'literal',
      param: 'drop',
      function: 'reset_index'
    },
    {
      name: 'cov_type',
      value: "'cluster'",
      provenance: 'literal',
      param: 'cov_type',
      function: 'fit'
    },
    {
      name: 'how',
      value: "'any'",
      provenance: 'library_default',
      param: 'how',
      function: 'DataFrame.dropna'
    }
  ];

  it('tells the code the view wrote from the analyst’s change of it', () => {
    const meta = {
      written_by: 'agent' as const,
      view_code_key: codeKey(AGENTS)
    };
    expect(editedByHand(meta, AGENTS)).toBe(false);
    expect(editedByHand(meta, `\n${AGENTS}\n`)).toBe(false);
    expect(editedByHand(meta, EDITED)).toBe(true);
    // The analyst's own cell, and a cell of the view from before the key.
    expect(editedByHand({}, EDITED)).toBe(false);
    expect(editedByHand({ written_by: 'agent' }, EDITED)).toBe(false);
    expect(viewCodeToKeep(meta, AGENTS, EDITED)).toBe(AGENTS);
    expect(
      viewCodeToKeep({ ...meta, view_code: AGENTS }, AGENTS, EDITED)
    ).toBeNull();
    expect(viewCodeToKeep(meta, EDITED, `${EDITED}\n# more`)).toBeNull();
  });

  it('badges the values of the analyst’s change as theirs, and keeps the AI’s on the values the view wrote', () => {
    const meta = {
      written_by: 'agent' as const,
      generated_by: { agent: 'openrouter' },
      view_code_key: codeKey(AGENTS)
    };
    const provenance = (decided: IDecision[]) =>
      Object.fromEntries(decided.map(d => [d.name, d.provenance]));
    // Before the edit: both values are the AI's.
    expect(provenance(attributed(decisions, meta, AGENTS))).toEqual({
      drop: 'agent',
      cov_type: 'agent',
      how: 'library_default'
    });
    // After it, with the code the view wrote kept: drop=True is the analyst's.
    expect(
      provenance(attributed(decisions, { ...meta, view_code: AGENTS }, EDITED))
    ).toEqual({ drop: 'you', cov_type: 'agent', how: 'library_default' });
    // Edited where the view kept no code, as in another program: all theirs.
    expect(provenance(attributed(decisions, meta, EDITED))).toEqual({
      drop: 'you',
      cov_type: 'you',
      how: 'library_default'
    });
    expect(holdsValue('f(drop=True)', decisions[0])).toBe(true);
    expect(holdsValue('f(drop=Truee)', decisions[0])).toBe(false);
    expect(holdsValue('fit(cov_type = "cluster")', decisions[1])).toBe(true);
  });

  it('keeps the key of the code it writes in a new cell, and the code itself at the analyst’s first change', async () => {
    const bench = benchModel([{ id: 'a', source: 'x = 1', count: 1 }]);
    const { nb, model } = bench;
    const cell = insertCodeCell(nb, 1, AGENTS, {
      written_by: 'agent',
      agent: { run: 'r1', step: 1 }
    });
    expect(cellMeta(cell).view_code_key).toBe(codeKey(AGENTS));
    // The view reads the cell once, as it draws it; then a key is typed.
    model.cells();
    typeKey(nb, cell.id, '# ');
    await settle();
    expect(cellMeta(cell).view_code).toBe(AGENTS);
    expect(model.editedByHand(cell.id)).toBe(true);
    model.dispose();
  });

  it('says under an agent’s answer which of its cells the analyst changed since', async () => {
    const source = 'diary = diary_raw.melt(id_vars=["patient_id"])';
    const content = notebookOf([
      { id: 'a', source: 'import pandas as pd', count: 1 },
      {
        id: 'melt',
        source: `${source}\ndiary = diary.dropna()`,
        count: 4,
        meta: {
          written_by: 'agent',
          agent: { run: 'r1', step: 1 },
          view_code_key: codeKey(source)
        }
      }
    ]);
    const { model } = benchModel(content);
    const run = pastRun('r1', {
      question: 'Reshape diary_raw: one row per patient-day',
      provider: 'openrouter',
      model: null,
      cost_usd: null,
      cells: ['melt'],
      files: [],
      state: 'done',
      at: '2026-10-01T09:40:00.000Z',
      steps: [
        { tool: 'run_cell', title: 'Melt', cells: ['melt'], state: 'done' }
      ],
      answer: 'The long frame has 41,160 day-level rows [4].'
    });
    const view = await mount(
      <AgentRunView model={model} run={run} place="strip" />
    );
    try {
      expect(
        view.host.querySelector('.jp-Epi-agentrun-edited')?.textContent
      ).toBe(
        'You changed the code of [4] since this answer: what it says of that cell may no longer hold.'
      );
    } finally {
      await view.unmount();
      model.dispose();
    }
  });
});

describe('chips of a drawing', () => {
  it('shows no chip for the size, the labels and the marks of a plot, and keeps cov_type', () => {
    // The chips of the card of the pain tester's run 2.
    const chips: IDecision[] = [
      {
        name: 'figsize',
        value: '(8, 5)',
        provenance: 'literal',
        param: 'figsize',
        function: 'subplots'
      },
      {
        name: 'xlabel',
        value: "'Week'",
        provenance: 'literal',
        param: 'xlabel',
        function: 'set_xlabel'
      },
      {
        name: 'ylabel',
        value: "'Mean pain'",
        provenance: 'literal',
        param: 'ylabel',
        function: 'set_ylabel'
      },
      {
        name: 'label',
        value: "'Mean pain by week, first 6 months, by treatment arm'",
        provenance: 'literal',
        param: 'label',
        function: 'set_title'
      },
      {
        name: 'cov_type',
        value: "'cluster'",
        provenance: 'literal',
        param: 'cov_type',
        function: 'fit'
      },
      {
        name: 'marker',
        value: "'o'",
        provenance: 'literal',
        param: 'marker',
        function: 'plot'
      },
      // A size that is not a drawing's, and a default, stay.
      {
        name: 'size',
        value: '100',
        provenance: 'literal',
        param: 'size',
        function: 'sample'
      },
      {
        name: 'reml',
        value: 'True',
        provenance: 'library_default',
        param: 'reml',
        function: 'MixedLM.fit'
      }
    ];
    expect(withoutDrawing(chips).map(chip => chip.name)).toEqual([
      'cov_type',
      'size',
      'reml'
    ]);
  });
});

describe('the speed of the Check-up', () => {
  it('says that the view times cells only while the Check-up is on', () => {
    const { note } = speedFindings(
      [{ id: 'a', label: '[1]', source: 'x = 1' } as any],
      new Map()
    );
    expect(note).toBe(
      'No run times yet. The view times a cell only while "Questions about the notebook" is on and the notebook is open in it. Run the cells again to time them.'
    );
  });
});

describe('the Check-up turned on in the settings', () => {
  it('shows in a view that is open, with no reload of the page', async () => {
    const settings = {
      composite: { enabled: false } as Record<string, unknown>,
      changed: new Signal<unknown, void>({})
    };
    const app = {
      shell: {
        widgets: () => [],
        currentWidget: null,
        activateById: () => undefined
      },
      docRegistry: { getWidgetFactory: () => undefined },
      restored: Promise.resolve(),
      commands: new CommandRegistry(),
      contextMenu: { addItem: () => undefined },
      contextMenuHitTest: () => null
    };
    // The plugin reads its settings, and settle() lets that finish.
    void checkupPlugin.activate(
      app as any,
      { load: async () => settings } as any,
      null
    );
    await settle();
    const { model } = benchModel([{ id: 'a', source: 'x = 1', count: 1 }]);
    const view = await mount(<RightPanel model={model} width={260} />);
    try {
      expect(view.host.querySelector('.jp-Epi-checkup')).toBeNull();
      settings.composite = { enabled: true };
      await step(() => settings.changed.emit());
      await settle();
      expect(view.host.querySelector('.jp-Epi-checkup')).not.toBeNull();
      settings.composite = { enabled: false };
      await step(() => settings.changed.emit());
      await settle();
      expect(view.host.querySelector('.jp-Epi-checkup')).toBeNull();
    } finally {
      await view.unmount();
      model.dispose();
      viewExtensions.exploration.delete('whybook:checkup');
    }
  });
});

describe('a kernel that ran before the view connected to it', () => {
  it('reads the kernel’s history, so that the cells that ran count as run after a reload of the page', async () => {
    const history: [number, number, string][] = [
      [0, 1, 'import pandas as pd'],
      [0, 2, 'diary = pd.read_csv("diary.csv")']
    ];
    const kernel = {
      status: 'idle',
      supportsSubshells: false,
      info: Promise.resolve({ language_info: { name: 'python' } }),
      requestHistory: jest.fn(async () => ({
        content: { status: 'ok', history }
      }))
    };
    const session = {
      session: { kernel },
      kernelChanged: new Signal<unknown, unknown>({}),
      statusChanged: new Signal<unknown, unknown>({}),
      iopubMessage: new Signal<unknown, unknown>({})
    };
    const bridge = new KernelBridge(session as any);
    try {
      expect(bridge.hasRun('import pandas as pd')).toBe(false);
      await (bridge as any)._readHistory();
      expect(kernel.requestHistory).toHaveBeenCalledWith({
        output: false,
        raw: true,
        hist_access_type: 'range',
        session: 0,
        start: 1,
        stop: 1000000
      });
      expect(bridge.hasRun('import pandas as pd')).toBe(true);
      // IPython keeps an input without its last line break.
      expect(bridge.hasRun('diary = pd.read_csv("diary.csv")\n')).toBe(true);
      expect(bridge.hasRun('weekly = diary.groupby("week").mean()')).toBe(
        false
      );
      // Once per kernel.
      await (bridge as any)._readHistory();
      expect(kernel.requestHistory).toHaveBeenCalledTimes(1);
    } finally {
      bridge.dispose();
    }
  });
});
