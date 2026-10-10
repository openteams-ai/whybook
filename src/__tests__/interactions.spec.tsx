/**
 * Pointer and menu interactions of the view (design iteration 1.77): Click
 * mode, a file dropped on a card, scrolling during a drag, the minimap, a
 * model's card, JupyterLab's Kernel menu, the quick look's preview and a
 * box on a plot.
 */
import * as React from 'react';
import { act } from 'react';
import type * as nbformat from '@jupyterlab/nbformat';
import { CommandRegistry } from '@lumino/commands';
import { MainMenu } from '@jupyterlab/mainmenu';
import { SemanticCommand } from '@jupyterlab/apputils';
import { Widget } from '@lumino/widgets';

import { KernelMenuIDs, addKernelMenu } from '../kernelmenu';
import { convergedIn, retriedWarning } from '../model/logs';
import type { IPlotPayload } from '../tokens';
import { PLOT_MIME } from '../tokens';
import { Bench } from '../ui/bench';
import { FILES_MIME } from '../ui/common';
import { EDGE, STEP, edgeStep, scrollTarget } from '../ui/dragscroll';
import { RightPanel } from '../ui/exploration';
import { EpiPlot } from '../ui/plot';
import { ContentsSection, QuestionsSection, inPopover } from '../ui/variables';
import type { IBenchCell } from './fakes/bench-fake';
import { benchModel } from './fakes/bench-fake';
import { mount, settle, step } from './fakes/bench-render';

/** The bench of this view model, mounted in jsdom. */
function bench(model: ReturnType<typeof benchModel>['model']) {
  return mount(
    <Bench model={model} editorServices={null} openFile={() => undefined} />
  );
}

const CELLS: IBenchCell[] = [
  { id: 'a', source: 'visits = pd.read_csv("visits.csv")', count: 1 },
  {
    id: 'b',
    source: 'fit = smf.mixedlm("dose ~ week", visits).fit()',
    count: 2
  }
];

describe('Click mode', () => {
  it('shows the questions of a pick in the popover beside the target, and once', async () => {
    const { model } = benchModel(CELLS);
    model.settings.update({ interaction: 'click' });
    const view = await mount(<QuestionsSection model={model} />);
    // A pick made with the pointer: the popover shows the questions, and the
    // Questions section keeps its instructions.
    await step(() =>
      model.showAsk({
        kind: 'drop',
        id: 101,
        anchor: { x: 700, y: 400 },
        loading: true,
        error: null,
        source: { kind: 'column', name: 'week', label: 'week' },
        target: { item: { kind: 'column', name: 'crp', label: 'crp' } },
        modifiers: { branch: false, parallel: false },
        result: null,
        checked: [],
        claudeStage: null
      })
    );
    await settle();
    const pointer = {
      popover: inPopover(model, model.ask!),
      block: view.host.querySelectorAll('.jp-Epi-ask-block').length,
      instructions: !!view.host.querySelector('.jp-Epi-instructions')
    };
    // The same pick from the keyboard has no place: the section shows it.
    await step(() => model.showAsk({ ...model.ask!, id: 102, anchor: null }));
    await settle();
    const keyboard = {
      popover: inPopover(model, model.ask!),
      block: view.host.querySelectorAll('.jp-Epi-ask-block').length
    };
    await view.unmount();
    model.dispose();
    expect({ pointer, keyboard }).toEqual({
      pointer: { popover: true, block: 0, instructions: true },
      keyboard: { popover: false, block: 1 }
    });
  });

  it('shows the contents of a variable clicked, and picks it only from Pick in Contents', async () => {
    const { model } = benchModel(CELLS);
    model.settings.update({ interaction: 'click' });
    const item = { kind: 'variable' as const, name: 'visits', label: 'visits' };
    model.pick(item, { branch: false, parallel: false }, { x: 1, y: 1 });
    const clicked = { selected: model.selected, armed: model.armed };
    // A column click still picks the column.
    model.pick(
      { kind: 'column', name: 'week', label: 'week', parent: 'visits' },
      { branch: false, parallel: false },
      { x: 1, y: 1 }
    );
    const column = model.armed?.name ?? null;
    model.dispose();
    expect({ clicked, column }).toEqual({
      clicked: { selected: 'visits', armed: null },
      column: 'week'
    });
  });

  it('has Pick in the head of Contents in Click mode, which picks the variable shown', async () => {
    const armed: unknown[] = [];
    const signal = { connect: () => undefined, disconnect: () => undefined };
    const model: any = {
      selected: 'visits',
      armed: null,
      interaction: 'click',
      changed: signal,
      arm: (item: unknown) => armed.push(item),
      variable: (name: string) =>
        name === 'visits'
          ? { name, label: name, kind: 'other', type: 'list', length: 3 }
          : null,
      variableCells: () => ({ made: [], imported: [], used: [] })
    };
    const view = await mount(<ContentsSection model={model} />);
    const button = () =>
      view.host.querySelector<HTMLButtonElement>('.jp-Epi-contents-pick');
    const pick = button()?.textContent;
    await step(() => button()?.click());
    // Picked, the button stays pressed, where the keyboard focus is, and a
    // second press lets go of the pick.
    model.armed = { kind: 'variable', name: 'visits', label: 'visits' };
    await view.render(<ContentsSection model={{ ...model }} />);
    const picked = {
      text: button()?.textContent,
      pressed: button()?.getAttribute('aria-pressed')
    };
    await step(() => button()?.click());
    // In Drag mode the head has no Pick.
    model.armed = null;
    model.interaction = 'drag';
    await view.render(<ContentsSection model={{ ...model }} />);
    const inDrag = !!button();
    await view.unmount();
    expect({ pick, picked, armed, inDrag }).toEqual({
      pick: 'Pick',
      picked: { text: 'Picked', pressed: 'true' },
      armed: [{ kind: 'variable', name: 'visits', label: 'visits' }, null],
      inDrag: false
    });
  });

  it("picks a card as the target from a click on the card's title", async () => {
    const { model } = benchModel(CELLS);
    model.settings.update({ interaction: 'click' });
    const view = await bench(model);
    await settle();
    await step(() =>
      model.arm({ kind: 'column', name: 'week', label: 'week' })
    );
    const title = view.host.querySelector<HTMLElement>(
      '.jp-Epi-cell[data-cell-id="b"] .jp-Epi-title'
    )!;
    await step(() =>
      title.dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: 500, clientY: 300 })
      )
    );
    const ask = model.ask;
    const found = {
      kind: ask?.kind,
      target: ask?.kind === 'drop' ? ask.target : null,
      anchor: ask?.anchor ?? null,
      armed: model.armed
    };
    await view.unmount();
    model.dispose();
    expect(found).toEqual({
      kind: 'drop',
      target: { cellId: 'b' },
      anchor: { x: 500, y: 300 },
      armed: null
    });
  });
});

/** A Lumino drag event of the file browser, as useFileDrop reads it. */
function fileEvent(
  type: string,
  relatedTarget: EventTarget | null = null
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    relatedTarget
  }) as any;
  event.mimeData = {
    hasData: (mime: string) => mime === FILES_MIME,
    getData: () => ['home_energy/tariffs.csv']
  };
  event.proposedAction = 'copy';
  event.dropAction = 'none';
  return event;
}

describe('A file dragged over a card', () => {
  it('keeps the card outlined while the pointer goes from cell to cell of its table, and says where the drop goes', async () => {
    const { model } = benchModel([
      {
        id: 'a',
        source: 'pd.crosstab(df.tariff, df.has_ev)',
        count: 1,
        outputs: [
          {
            output_type: 'execute_result',
            execution_count: 1,
            metadata: {},
            data: { 'text/plain': 'a table' }
          }
        ]
      }
    ]);
    const view = await bench(model);
    await settle();
    const card = view.host.querySelector<HTMLElement>(
      '.jp-Epi-cell[data-cell-id="a"]'
    )!;
    // Two elements of the card, as two cells of its table.
    const first = card.querySelector('.jp-Epi-cell-head')!;
    const second = card.querySelector('.jp-Epi-cell-foot')!;
    await step(() => first.dispatchEvent(fileEvent('lm-dragenter')));
    // Lumino enters the next element, then leaves the last one with the
    // element entered as its related target.
    await step(() => second.dispatchEvent(fileEvent('lm-dragenter')));
    await step(() => first.dispatchEvent(fileEvent('lm-dragleave', second)));
    const within = {
      outlined: card.classList.contains('jp-mod-filedrop'),
      note: card.querySelector('.jp-Epi-filedrop-note')?.textContent ?? null
    };
    // Out of the card, to the bench around it: the card lets go, and the
    // bench, where the drop would start from the file, takes it.
    const around = view.host.querySelector<HTMLElement>('.jp-Epi-bench')!;
    await step(() => around.dispatchEvent(fileEvent('lm-dragenter')));
    await step(() => second.dispatchEvent(fileEvent('lm-dragleave', around)));
    const outside = {
      outlined: card.classList.contains('jp-mod-filedrop'),
      bench: around.classList.contains('jp-mod-filedrop')
    };
    await view.unmount();
    model.dispose();
    expect({ within, outside }).toEqual({
      within: { outlined: true, note: 'Drop tariffs.csv on [1]' },
      outside: { outlined: false, bench: true }
    });
  });
});

describe('Scrolling during a drag', () => {
  it('scrolls faster the nearer the pointer is to an edge, and not in the middle', () => {
    expect([
      edgeStep(100, 100, 500),
      edgeStep(100 + EDGE / 2, 100, 500),
      edgeStep(300, 100, 500),
      edgeStep(500 - EDGE / 2, 100, 500),
      edgeStep(500, 100, 500),
      edgeStep(90, 100, 500)
    ]).toEqual([-STEP, -STEP / 2, 0, STEP / 2, STEP, 0]);
  });

  /** An element that scrolls, with its box on the page and its content height. */
  function scroller(
    className: string,
    box: { top: number; bottom: number },
    content: number,
    scrollTop: number
  ): HTMLElement {
    const element = document.createElement('div');
    element.className = className;
    element.getBoundingClientRect = () =>
      ({
        left: 0,
        right: 300,
        top: box.top,
        bottom: box.bottom,
        width: 300,
        height: box.bottom - box.top
      }) as DOMRect;
    Object.defineProperty(element, 'scrollHeight', { value: content });
    Object.defineProperty(element, 'clientHeight', {
      value: box.bottom - box.top
    });
    // jsdom lays nothing out, so its scrollTop stays 0.
    let top = scrollTop;
    Object.defineProperty(element, 'scrollTop', {
      get: () => top,
      set: (value: number) => {
        top = value;
      }
    });
    return element;
  }

  /**
   * What a pointer at y over a row of Contents scrolls: the long list of
   * columns, from `list` to `list + 336` on the page and scrolled by
   * `listTop`, in the section of the side panel from 330 to 700, scrolled
   * by 200.
   */
  function scrolled(list: number, listTop: number, y: number): string | null {
    const section = scroller(
      'jp-Epi-sidebar',
      { top: 330, bottom: 700 },
      900,
      200
    );
    const columns = scroller(
      'jp-Epi-list jp-mod-virtual',
      { top: list, bottom: list + 336 },
      420,
      listTop
    );
    const row = document.createElement('button');
    columns.appendChild(row);
    section.appendChild(columns);
    document.body.appendChild(section);
    const target = scrollTarget(row, 100, y);
    section.remove();
    return target
      ? `${target.element.className} ${target.step < 0 ? 'up' : 'down'}`
      : null;
  }

  it('scrolls the list of Contents near its edge, and the section around it when the list cannot', () => {
    expect({
      // Near the top of the list, which can scroll up.
      list: scrolled(350, 84, 355),
      // The list at its top: the section, whose top edge is near too.
      listAtTop: scrolled(350, 0, 355),
      // The top of the list out of sight, above the section's top edge.
      listHidden: scrolled(250, 84, 335),
      // In the middle of both.
      middle: scrolled(350, 84, 500)
    }).toEqual({
      list: 'jp-Epi-list jp-mod-virtual up',
      listAtTop: 'jp-Epi-sidebar up',
      listHidden: 'jp-Epi-sidebar up',
      middle: null
    });
  });
});

describe('The minimap', () => {
  const Observer = window.ResizeObserver;
  let observers: (() => void)[] = [];
  beforeEach(() => {
    observers = [];
    window.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        observers.push(() => callback([], this as any));
      }
      observe(): void {
        // The test calls the callbacks.
      }
      unobserve(): void {
        // As above.
      }
      disconnect(): void {
        // As above.
      }
    } as any;
  });
  afterEach(() => {
    window.ResizeObserver = Observer;
  });

  it('is off by default, and keeps no column at the right of a wide bench then', async () => {
    const { model } = benchModel(CELLS);
    const view = await bench(model);
    await settle();
    const node = view.host.querySelector<HTMLElement>('.jp-Epi-bench')!;
    Object.defineProperty(node, 'clientWidth', {
      configurable: true,
      get: () => 1018
    });
    await step(() => observers.forEach(observe => observe()));
    const found = {
      gutter: node.classList.contains('jp-mod-gutter'),
      minimap: !!node.querySelector('.jp-Epi-minimap')
    };
    await view.unmount();
    model.dispose();
    expect(found).toEqual({ gutter: false, minimap: false });
  });

  it('has a column of its own at the right of the cards on a wide bench', async () => {
    const { model } = benchModel(CELLS);
    model.settings.minimap = true;
    const view = await bench(model);
    await settle();
    const node = view.host.querySelector<HTMLElement>('.jp-Epi-bench')!;
    const widths: Record<string, boolean> = {};
    for (const width of [1018, 700]) {
      Object.defineProperty(node, 'clientWidth', {
        configurable: true,
        get: () => width
      });
      await step(() => observers.forEach(observe => observe()));
      widths[width] = node.classList.contains('jp-mod-gutter');
    }
    const minimap = !!node.querySelector(
      ':scope > .jp-Epi-minimap-dock > .jp-Epi-minimap'
    );
    await view.unmount();
    model.dispose();
    expect({ widths, minimap }).toEqual({
      widths: { 1018: true, 700: false },
      minimap: true
    });
  });
});

// The outputs of the agent's mixed model in the pain tester's notebook:
// statsmodels warns twice, retries with lbfgs, and converges.
const WARNINGS: nbformat.IOutput = {
  output_type: 'stream',
  name: 'stderr',
  text:
    '/site-packages/statsmodels/regression/mixed_linear_model.py:2384: ConvergenceWarning: Maximum Likelihood optimization failed to converge. Check mle_retvals\n' +
    '  rslt = super().fit(\n' +
    '/tmp/ipykernel_1/384502019.py:5: ConvergenceWarning: Retrying MixedLM optimization with lbfgs\n' +
    '  fit = model.fit()\n'
};

function summary(converged: 'Yes' | 'No'): nbformat.IOutput {
  return {
    output_type: 'stream',
    name: 'stdout',
    text: [
      '             Mixed Linear Model Regression Results',
      '===============================================================',
      'Model:            MixedLM Dependent Variable: analgesic_dose_mg',
      'No. Observations: 1428    Method:             REML             ',
      'No. Groups:       318     Scale:              1792.9230        ',
      'Min. group size:  3       Log-Likelihood:     -7737.3083       ',
      `Max. group size:  6       Converged:          ${converged}              `,
      'Mean group size:  4.5                                          ',
      '---------------------------------------------------------------',
      '                  Coef.   Std.Err.   z    P>|z|  [0.025  0.975]',
      '---------------------------------------------------------------',
      'Intercept         207.787    4.101 50.665 0.000 199.749 215.826',
      'week                0.106    0.166  0.639 0.523  -0.220   0.432',
      'Group Var        3611.465   10.331                             ',
      'Group x week Cov   -2.202    0.297                             ',
      'week Var            0.159    0.016                             ',
      '==============================================================='
    ].join('\n')
  };
}

describe("A model's card", () => {
  it('reads how a fit ended, and which warnings a fit that converged leaves behind', () => {
    expect({
      yes: convergedIn(['Max. group size:  6       Converged:          Yes']),
      no: convergedIn(['Converged: No']),
      logit: convergedIn(['converged:                       True']),
      none: convergedIn(['Intercept 207.787']),
      retried: [
        'ConvergenceWarning: Maximum Likelihood optimization failed to converge. Check mle_retvals',
        'ConvergenceWarning: Retrying MixedLM optimization with lbfgs',
        'ConvergenceWarning: The MLE may be on the boundary of the parameter space.',
        'ConvergenceWarning: The Hessian matrix at the estimated parameter values is not positive definite.'
      ].map(retriedWarning)
    }).toEqual({
      yes: true,
      no: false,
      logit: true,
      none: null,
      retried: [true, true, false, false]
    });
  });

  /** What the card of the mixed model shows, for a fit that converged or not. */
  async function card(converged: 'Yes' | 'No') {
    const { model } = benchModel([
      {
        id: 'fit',
        source: 'fit = model.fit()\nprint(fit.summary())',
        count: 11,
        outputs: [WARNINGS, summary(converged)]
      }
    ]);
    const view = await bench(model);
    await settle();
    const host = view.host.querySelector('.jp-Epi-cell[data-cell-id="fit"]')!;
    const folded = host.querySelector<HTMLButtonElement>(
      '.jp-Epi-foldedwarnings'
    );
    const shown = {
      folded: folded?.textContent ?? null,
      red: !!host.querySelector('.jp-Epi-textoutput.jp-mod-stderr'),
      summary: !!Array.from(
        host.querySelectorAll('pre.jp-Epi-textoutput')
      ).find(pre => pre.textContent?.includes('Converged:')),
      tile: !!host.querySelector('.jp-Epi-logtile')
    };
    // A click on the folded line shows the warnings.
    await step(() => folded?.click());
    const opened = !!host.querySelector('.jp-Epi-textoutput.jp-mod-stderr');
    await view.unmount();
    model.dispose();
    return { ...shown, opened };
  }

  it('folds the warnings that the fit resolved, and shows the summary, when the fit converged', async () => {
    expect(await card('Yes')).toEqual({
      folded: '2 convergence warnings, then the fit converged',
      red: false,
      summary: true,
      tile: false,
      opened: true
    });
  });

  it('keeps the warnings in red, and the summary in its tile, when the fit did not converge', async () => {
    expect(await card('No')).toEqual({
      folded: null,
      red: true,
      summary: false,
      tile: true,
      opened: true
    });
  });
});

describe("JupyterLab's Kernel menu", () => {
  it('acts on the kernel of the Whybook view in front: Interrupt, Restart, Restart and Run All, Change Kernel', async () => {
    const commands = new CommandRegistry();
    const mainMenu = new MainMenu(commands);
    const calls: string[] = [];
    const view = new Widget() as any;
    view.id = 'whybook-view';
    view.context = {
      sessionContext: {
        session: {
          kernel: {
            interrupt: async () => {
              calls.push('interrupt');
            }
          }
        }
      },
      model: { cells: [] }
    };
    view.content = {
      model: {
        runAll: async () => {
          calls.push('run all');
        }
      }
    };
    const other = new Widget();
    const tracker: any = {
      currentWidget: view,
      has: (widget: Widget) => widget === view,
      find: (test: (widget: Widget) => boolean) =>
        test(view) ? view : undefined
    };
    const dialogs: any = {
      restart: async () => {
        calls.push('restart');
        return true;
      },
      selectKernel: async () => {
        calls.push('change');
      }
    };
    const app: any = { commands, shell: { currentWidget: view } };
    addKernelMenu(app, tracker, mainMenu, dialogs);
    const users = mainMenu.kernelMenu.kernelUsers;
    const runners = mainMenu.runMenu.codeRunners;
    const active = {
      interrupt: users.interruptKernel.getActiveCommandId(view),
      restart: users.restartKernel.getActiveCommandId(view),
      change: users.changeKernel.getActiveCommandId(view),
      restartForRunAll: runners.restart.getActiveCommandId(view),
      runAll: runners.runAll.getActiveCommandId(view),
      // Another widget in front, such as a console, is not the view's.
      other: users.restartKernel.getActiveCommandId(other)
    };
    const args = { [SemanticCommand.WIDGET]: view.id };
    for (const id of [
      KernelMenuIDs.interrupt,
      KernelMenuIDs.restart,
      KernelMenuIDs.runAll,
      KernelMenuIDs.change
    ]) {
      await commands.execute(id, args);
    }
    expect({ active, calls }).toEqual({
      active: {
        interrupt: KernelMenuIDs.interrupt,
        restart: KernelMenuIDs.restart,
        change: KernelMenuIDs.change,
        restartForRunAll: KernelMenuIDs.restart,
        runAll: KernelMenuIDs.runAll,
        other: null
      },
      calls: ['interrupt', 'restart', 'run all', 'change']
    });
  });
});

const HISTOGRAM: IPlotPayload = {
  version: 1,
  kind: 'hist',
  title: 'Distribution of kwh_import',
  x: { field: 'kwh_import', label: 'kwh_import' },
  y: { field: 'rows', label: 'rows' },
  source: { frame: 'readings', x: 'kwh_import', y: null, by: null, rows: 9 },
  select: 'x',
  bins: [
    { x0: 0, x1: 10, n: 6 },
    { x0: 10, x1: 20, n: 3 }
  ]
};

describe("The quick look's preview", () => {
  const Observer = window.ResizeObserver;
  let observers: (() => void)[] = [];
  beforeEach(() => {
    observers = [];
    window.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        observers.push(() => callback([], this as any));
      }
      observe(): void {
        // The test calls the callbacks.
      }
      unobserve(): void {
        // As above.
      }
      disconnect(): void {
        // As above.
      }
    } as any;
  });
  afterEach(() => {
    window.ResizeObserver = Observer;
  });

  it('opens under the tabs of the right panel, and draws its plot as wide as the room it has', async () => {
    const { model } = benchModel(CELLS);
    model.preview = {
      title: 'Summarise kwh_import: distribution and missingness',
      code: 'whybook.hist(readings, "kwh_import")',
      status: 'done',
      stage: null,
      elapsed: null,
      started: 1,
      outputs: [
        {
          output_type: 'display_data',
          metadata: {},
          data: { [PLOT_MIME]: HISTOGRAM as any }
        }
      ],
      error: null,
      option: {
        id: 'quick',
        text: 'Summarise kwh_import: distribution and missingness',
        type: 'quality',
        origin: 'template',
        probability: null,
        reasons: [],
        placement: {
          kind: 'sidebar',
          cell: null,
          label: 'a preview in the sidebar'
        },
        code: null
      }
    } as any;
    const view = await mount(<RightPanel model={model} width={270} />);
    await settle();
    const box = view.host.querySelector<HTMLElement>('.jp-Epi-preview')!;
    // The panel leaves the preview 214 px inside its padding.
    box.style.padding = '0px';
    Object.defineProperty(box, 'clientWidth', {
      configurable: true,
      get: () => 214
    });
    await step(() => observers.forEach(observe => observe()));
    const right = view.host.querySelector('.jp-Epi-right')!;
    const main = right.querySelector('.jp-Epi-right-main')!;
    const found = {
      split: right.classList.contains('jp-mod-split'),
      // The tabs, then the preview, then what the tab shows: the preview
      // and the tab's content scroll under the tabs.
      order: Array.from(
        main.querySelectorAll(
          '.jp-Epi-tabs, .jp-Epi-right-preview, .jp-Epi-exploration'
        )
      ).map(child => `${child.parentElement!.className} > ${child.className}`),
      plot: view.host
        .querySelector('.jp-Epi-preview svg.jp-Epi-plot')
        ?.getAttribute('width')
    };
    await view.unmount();
    model.dispose();
    expect(found).toEqual({
      split: false,
      order: [
        'jp-Epi-right-main > jp-Epi-tabs',
        'jp-Epi-right-scroll > jp-Epi-right-preview',
        'jp-Epi-right-scroll > jp-Epi-exploration'
      ],
      plot: '214'
    });
  });
});

const SCATTER: IPlotPayload = {
  version: 1,
  kind: 'scatter',
  title: 'analgesic_dose_mg by week',
  x: { field: 'week', label: 'week' },
  y: { field: 'analgesic_dose_mg', label: 'analgesic_dose_mg' },
  source: {
    frame: 'visits',
    x: 'week',
    y: 'analgesic_dose_mg',
    by: null,
    rows: 4
  },
  select: 'xy',
  points: [
    { x: 0, y: 100, g: null, i: 0 },
    { x: 10, y: 200, g: null, i: 1 },
    { x: 20, y: 400, g: null, i: 2 },
    { x: 25, y: 400, g: null, i: 3 }
  ]
};

describe('A box on a plot', () => {
  it('ends at the edge of the plot when the pointer is released a few pixels past it', async () => {
    const asked: { x0: number; x1: number; y?: [number, number] | null }[] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <EpiPlot
          payload={SCATTER}
          width={600}
          height={330}
          onSelect={(x0, x1, anchor, y) => asked.push({ x0, x1, y })}
        />
      );
    });
    const svg = host.querySelector<SVGSVGElement>('svg.jp-Epi-plot')!;
    // The plot is drawn at its own size, at the page's top left.
    svg.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 600,
        bottom: 330,
        width: 600,
        height: 330
      }) as DOMRect;
    const mouse = (type: string, target: EventTarget, x: number, y: number) =>
      target.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: x,
          clientY: y
        })
      );
    // From inside the plot up past its top edge, as the tester did: the
    // pointer leaves the plot by 3 px before it is released.
    await act(async () => {
      mouse('mousedown', svg, 100, 100);
    });
    await act(async () => {
      mouse('mousemove', svg, 300, 20);
      svg.dispatchEvent(
        new MouseEvent('mouseout', {
          bubbles: true,
          relatedTarget: document.body,
          clientX: 300,
          clientY: -3
        })
      );
    });
    await act(async () => {
      mouse('mousemove', document.body, 590, -3);
      mouse('mouseup', document.body, 590, -3);
    });
    await act(async () => root.unmount());
    host.remove();
    expect(asked).toHaveLength(1);
    // The box reaches the top of the plot: the highest points are in it.
    const box = asked[0];
    expect(box.y![1]).toBeGreaterThanOrEqual(400);
    expect(box.x1).toBeGreaterThanOrEqual(25);
  });
});
