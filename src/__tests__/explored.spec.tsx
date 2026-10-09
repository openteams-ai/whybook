/**
 * Variables explored, in the Exploration panel (design iteration 1.82): the
 * order of its rows, which no model sets, the list that scrolls past a few
 * rows under its head and its count, and the menu of orders on the head,
 * from a right click, the Menu key or Shift+F10.
 */
import './fakes/quiet';

import { CommandRegistry } from '@lumino/commands';
import * as fs from 'fs';
import * as path from 'path';
import * as React from 'react';

import schema from '../../schema/plugin.json';
import { addContextMenus } from '../contextmenu';
import { EpiSettings } from '../model/epimodel';
import type { IExploredKeys } from '../model/exploredorder';
import {
  EXPLORED_ORDERS,
  exploredOrder,
  orderExplored
} from '../model/exploredorder';
import { storedAnalysis } from '../model/restore';
import { readSettings } from '../model/settings';
import { coverage, EXPLORED_SHOWN, ExplorationPanel } from '../ui/exploration';
import { isMenuKey } from '../ui/menukeys';
import { benchModel } from './fakes/bench-fake';
import { mount, settle, step } from './fakes/bench-render';
import { composed } from './fakes/settings-fake';

/** A frame of the notebook: its rows and its columns. */
interface IFrame {
  name: string;
  rows: number;
  columns: number;
}

/**
 * Twelve frames of a home energy notebook, with their rows and columns.
 */
const FRAMES: IFrame[] = [
  { name: 'readings', rows: 129058, columns: 6 },
  { name: 'homes', rows: 360, columns: 10 },
  { name: 'readings_homes', rows: 129058, columns: 15 },
  { name: 'high_outliers', rows: 5124, columns: 6 },
  { name: 'sentinel', rows: 4, columns: 6 },
  { name: 'zero_rows', rows: 5, columns: 6 },
  { name: 'half_hourly', rows: 241920, columns: 3 },
  { name: 'tariffs', rows: 5, columns: 6 },
  { name: 'df', rows: 33457, columns: 17 },
  { name: 'summary', rows: 2, columns: 3 },
  { name: 'home_period', rows: 93, columns: 2 },
  { name: 'switchers', rows: 22961, columns: 17 }
];

/**
 * The frames that each cell reads. Cell k makes the frame k, and the last
 * cell makes none: readings and readings_homes are read by five cells,
 * half_hourly and tariffs by three, homes, sentinel, zero_rows, df and
 * switchers by two, and the others by one.
 */
const READS: string[][] = [
  ['readings'],
  ['readings', 'homes'],
  ['readings', 'homes', 'readings_homes'],
  ['readings', 'readings_homes', 'high_outliers'],
  ['readings', 'readings_homes', 'sentinel'],
  ['sentinel', 'zero_rows'],
  ['zero_rows', 'half_hourly'],
  ['half_hourly', 'tariffs'],
  ['readings_homes', 'tariffs', 'df'],
  ['half_hourly', 'tariffs', 'df', 'summary'],
  ['home_period'],
  ['readings_homes', 'switchers'],
  ['switchers']
];

/** The order of Auto for these frames: by the cells that read each, then by size. */
const AUTO = [
  'readings_homes',
  'readings',
  'half_hourly',
  'tariffs',
  'df',
  'switchers',
  'homes',
  'zero_rows',
  'sentinel',
  'high_outliers',
  'home_period',
  'summary'
];

/**
 * A notebook whose cells ran in a kernel that is gone: it keeps the frames
 * and the analysis of each cell, as a notebook saved by the view does.
 */
function notebook(frames = FRAMES, reads = READS): any {
  const cells = reads.map((uses, index) => {
    const made = frames[index]?.name;
    const source = made
      ? `${made} = build(${uses.join(', ')})`
      : `plot(${uses.join(', ')})`;
    return {
      cell_type: 'code',
      id: `c${index}`,
      source,
      metadata: {
        whybook: {
          analysis: storedAnalysis(
            {
              defs: made ? [made] : [],
              uses,
              formulas: [],
              columns: made ? { [made]: [`${made}_0`] } : {},
              decisions: [],
              attachments: []
            },
            source
          )
        }
      },
      execution_count: index + 1,
      outputs: []
    };
  });
  return {
    cells,
    metadata: {
      whybook: {
        variables: frames.map((frame, index) => ({
          name: frame.name,
          label: frame.name,
          kind: 'dataframe',
          rows: frame.rows,
          n_columns: frame.columns,
          columns: Array.from({ length: frame.columns }, (_, column) => ({
            label: `${frame.name}_${column}`,
            kind: 'numeric',
            tag: 'num'
          })),
          cell: `c${index}`
        }))
      }
    },
    nbformat: 4,
    nbformat_minor: 5
  };
}

/** A row as the order reads it. */
function keys(name: string | null, cells: number, size: number): IExploredKeys {
  return { name, cells, size };
}

const names = (rows: IExploredKeys[]) => rows.map(row => row.name);

describe('The order of Variables explored', () => {
  const rows = [
    keys('homes', 2, 3600),
    keys('readings', 5, 774348),
    keys('df', 2, 568769),
    keys(null, 0, 0),
    keys('readings_homes', 5, 1935870),
    keys('tariffs', 2, 30)
  ];

  it('puts first in Auto the frames that the most cells read, and of those the largest, with the derived variables last', () => {
    expect(names(orderExplored(rows, 'auto'))).toEqual([
      'readings_homes',
      'readings',
      'df',
      'homes',
      'tariffs',
      null
    ]);
  });

  it('puts the tables that cells read from files first in Auto, then the frames that the most cells read', () => {
    // The NHEFS notebook: three cells read the frame of the analysis, and one
    // reads the codebook.
    const nhefs = [
      { name: 'analysis', cells: 3, size: 17226, loaded: false },
      { name: 'nhefs_codebook', cells: 1, size: 128, loaded: true },
      { name: null, cells: 0, size: 0, loaded: false },
      { name: 'nhefs', cells: 2, size: 104256, loaded: true },
      { name: 'result', cells: 1, size: 5, loaded: false }
    ];
    expect(names(orderExplored(nhefs, 'auto'))).toEqual([
      'nhefs',
      'nhefs_codebook',
      'analysis',
      'result',
      null
    ]);
    // Most used counts the cells alone.
    expect(names(orderExplored(nhefs, 'used'))).toEqual([
      'analysis',
      'nhefs',
      'nhefs_codebook',
      'result',
      null
    ]);
  });

  it('keeps the order of the notebook in Most used among frames that as many cells read', () => {
    expect(names(orderExplored(rows, 'used'))).toEqual([
      'readings',
      'readings_homes',
      'homes',
      'df',
      'tariffs',
      null
    ]);
  });

  it('puts the frames with the most rows times columns first in Largest', () => {
    expect(names(orderExplored(rows, 'size'))).toEqual([
      'readings_homes',
      'readings',
      'df',
      'homes',
      'tariffs',
      null
    ]);
    // As large: the order of the notebook.
    expect(
      names(
        orderExplored(
          [keys('zero_rows', 2, 30), keys('tariffs', 3, 30)],
          'size'
        )
      )
    ).toEqual(['zero_rows', 'tariffs']);
  });

  it('orders the names from A to Z, numbers by their value and capitals as small letters', () => {
    expect(
      names(
        orderExplored(
          [
            keys('df10', 1, 1),
            keys(null, 0, 0),
            keys('Df2', 1, 1),
            keys('b', 1, 1),
            keys('_cache', 1, 1)
          ],
          'name'
        )
      )
    ).toEqual(['_cache', 'b', 'Df2', 'df10', null]);
  });

  it('reads any value that is no order as Auto', () => {
    expect(exploredOrder('name').id).toBe('name');
    expect(exploredOrder('random').id).toBe('auto');
    expect(exploredOrder(undefined).id).toBe('auto');
  });

  it('names each order as the choices of the setting do, Auto by default', () => {
    const property = (schema as any).properties.exploredOrder;
    expect(property.default).toBe('auto');
    expect(
      property.oneOf.map((choice: any) => [
        choice.const,
        choice.title,
        choice.description
      ])
    ).toEqual(
      EXPLORED_ORDERS.map(order => [order.id, order.title, order.caption])
    );
  });

  it('reads the order from the settings, and Auto when it holds no order', () => {
    const read = (raw: string) => {
      const { composite, user } = composed(raw);
      return readSettings(composite, user).exploredOrder;
    };
    expect(read('{}')).toBe('auto');
    expect(read('{"exploredOrder": "size"}')).toBe('size');
    expect(readSettings({ exploredOrder: 'largest' }, null).exploredOrder).toBe(
      'auto'
    );
  });
});

describe('The rows of Variables explored', () => {
  it('count the cells that read each frame, and its rows times columns', () => {
    const { model } = benchModel(notebook());
    const rows = coverage(model);
    const row = (name: string) => rows.find(item => item.name === name)!;
    expect(row('readings').cells).toBe(5);
    expect(row('readings').shape).toEqual({ rows: 129058, columns: 6 });
    expect(row('readings').size).toBe(129058 * 6);
    expect(row('tariffs').cells).toBe(3);
    expect(row('home_period').cells).toBe(1);
    expect(row('switchers').size).toBe(22961 * 17);
  });

  it('list the tables that cells read from files first in Auto', () => {
    const cell = (
      id: string,
      source: string,
      defs: string[],
      uses: string[],
      file?: string
    ) => ({
      cell_type: 'code',
      id,
      source,
      metadata: {
        whybook: {
          analysis: storedAnalysis(
            {
              defs,
              uses,
              formulas: [],
              columns: {},
              decisions: file
                ? [
                    {
                      name: 'filepath_or_buffer',
                      value: `'${file}'`,
                      provenance: 'literal',
                      param: 'filepath_or_buffer',
                      function: 'read_csv'
                    }
                  ]
                : [],
              attachments: []
            },
            source
          )
        }
      },
      execution_count: 1,
      outputs: []
    });
    const frame = (name: string, rows: number, columns: number) => ({
      name,
      label: name,
      kind: 'dataframe',
      rows,
      n_columns: columns,
      columns: Array.from({ length: columns }, (_, index) => ({
        label: `${name}_${index}`,
        kind: 'numeric',
        tag: 'num'
      }))
    });
    const { model } = benchModel({
      cells: [
        cell(
          'load',
          'nhefs = pd.read_csv("nhefs.csv")',
          ['nhefs'],
          ['pd'],
          'nhefs.csv'
        ),
        cell(
          'codebook',
          'nhefs_codebook = pd.read_csv("nhefs_codebook.csv")',
          ['nhefs_codebook'],
          ['pd', 'nhefs_codebook'],
          'nhefs_codebook.csv'
        ),
        cell('prepare', 'analysis = nhefs.dropna()', ['analysis'], ['nhefs']),
        cell('fit', 'fit = ols(analysis)', ['fit'], ['analysis']),
        cell('plot', 'plot(analysis)', [], ['analysis']),
        cell('table', 'table(analysis)', [], ['analysis'])
      ],
      metadata: {
        whybook: {
          variables: [
            { ...frame('nhefs', 1629, 64), cell: 'load' },
            { ...frame('nhefs_codebook', 64, 2), cell: 'codebook' },
            { ...frame('analysis', 1566, 11), cell: 'prepare' }
          ]
        }
      },
      nbformat: 4,
      nbformat_minor: 5
    } as any);
    // The two tables read from files come first, although fewer cells read them.
    expect(coverage(model).map(row => [row.name, row.cells])).toEqual([
      ['nhefs', 1],
      ['nhefs_codebook', 1],
      ['analysis', 3]
    ]);
    // Most used puts the frame of the analysis first.
    expect(coverage(model, 'used').map(row => row.name)).toEqual([
      'analysis',
      'nhefs',
      'nhefs_codebook'
    ]);
    model.dispose();
  });

  it('come in the order of the setting', () => {
    const { model } = benchModel(notebook());
    expect(coverage(model).map(row => row.name)).toEqual(AUTO);
    model.settings.update({ exploredOrder: 'name' });
    expect(coverage(model).map(row => row.name)).toEqual(
      [...AUTO].sort((a, b) => a.localeCompare(b))
    );
    model.settings.update({ exploredOrder: 'size' });
    expect(
      coverage(model)
        .map(row => row.name)
        .slice(0, 4)
    ).toEqual(['readings_homes', 'readings', 'half_hourly', 'df']);
    expect(
      coverage(model, 'used')
        .map(row => row.name)
        .slice(0, 5)
    ).toEqual([
      'readings',
      'readings_homes',
      'half_hourly',
      'tariffs',
      'homes'
    ]);
  });
});

/** The block Variables explored, in the panel drawn in the host. */
function block(host: Element) {
  const head = host.querySelector<HTMLElement>('.jp-Epi-explored-head')!;
  const list = host.querySelector<HTMLElement>('.jp-Epi-explored-list');
  const labels = Array.from(
    host.querySelectorAll('.jp-Epi-explored-list .jp-Epi-coverage-head')
  ).map(node => node.firstElementChild!.textContent);
  return { head, list, labels };
}

describe('The block Variables explored', () => {
  it('gives its count in the head, and past five rows a list that scrolls and takes the focus', async () => {
    const { model } = benchModel(notebook());
    const view = await mount(<ExplorationPanel model={model} />);
    const { head, list, labels } = block(view.host);
    expect(head.textContent).toBe('Variables explored12');
    expect(head.querySelector('.jp-Epi-section-count')!.textContent).toBe('12');
    expect(FRAMES.length).toBeGreaterThan(EXPLORED_SHOWN);
    expect(list!.classList.contains('jp-mod-scroll')).toBe(true);
    expect(list!.getAttribute('role')).toBe('list');
    expect(list!.tabIndex).toBe(0);
    expect(list!.getAttribute('aria-label')).toBe(
      'Variables explored. Order: Auto'
    );
    expect(list!.querySelectorAll('[role="listitem"]')).toHaveLength(12);
    // The head stays out of the list that scrolls.
    expect(list!.contains(head)).toBe(false);
    expect(labels).toEqual(AUTO);
    // The head takes the focus, and says how to change the order.
    expect(head.tabIndex).toBe(0);
    expect(head.title).toBe(
      'Order: Auto, tables from files first, then the most used. Right-click to change it, or press Shift+F10.'
    );
    // The name of a row gives what the order compares.
    const first = list!.querySelector('.jp-Epi-coverage-head span')!;
    expect(first.getAttribute('title')).toBe(
      'Used by 5 cells. 129,058 rows × 15 columns.'
    );
    await view.unmount();
  });

  it('shows five rows or fewer whole, with no scroll and no stop for the focus', async () => {
    const { model } = benchModel(
      notebook(FRAMES.slice(0, 5), READS.slice(0, 5))
    );
    const view = await mount(<ExplorationPanel model={model} />);
    const { head, list, labels } = block(view.host);
    expect(head.textContent).toBe('Variables explored5');
    expect(labels).toHaveLength(EXPLORED_SHOWN);
    expect(list!.classList.contains('jp-mod-scroll')).toBe(false);
    expect(list!.hasAttribute('tabindex')).toBe(false);
    await view.unmount();
  });

  it('says how to see the columns used while it has no rows, with no count', async () => {
    const { model } = benchModel([{ id: 'a', source: 'x = 1' }]);
    const view = await mount(<ExplorationPanel model={model} />);
    const { head, list } = block(view.host);
    expect(head.textContent).toBe('Variables explored');
    expect(list).toBeNull();
    expect(head.parentElement!.textContent).toContain(
      'Run the notebook to see which columns the analysis uses.'
    );
    await view.unmount();
  });

  it('draws the rows again in a new order when the setting changes', async () => {
    const { model } = benchModel(notebook());
    const view = await mount(<ExplorationPanel model={model} />);
    await step(() => model.settings.set('exploredOrder', 'name'));
    await settle();
    const { head, list, labels } = block(view.host);
    expect(labels).toEqual([...AUTO].sort((a, b) => a.localeCompare(b)));
    expect(head.title).toMatch(/^Order: By name, from A to Z\./);
    expect(list!.getAttribute('aria-label')).toBe(
      'Variables explored. Order: By name'
    );
    await view.unmount();
  });

  it('keeps a list that scrolls at a fixed height, from its style sheet', async () => {
    const style = document.createElement('style');
    style.textContent = ['base.css', 'explored.css']
      .map(file =>
        fs.readFileSync(path.join(__dirname, '..', '..', 'style', file), 'utf8')
      )
      .join('\n');
    document.head.appendChild(style);
    try {
      const long = benchModel(notebook()).model;
      const short = benchModel(
        notebook(FRAMES.slice(0, 3), READS.slice(0, 3))
      ).model;
      const view = await mount(
        <div className="jp-Epi">
          <ExplorationPanel model={long} />
          <ExplorationPanel model={short} />
        </div>
      );
      const [scrolling, whole] = Array.from(
        view.host.querySelectorAll<HTMLElement>('.jp-Epi-explored-list')
      );
      expect(getComputedStyle(scrolling).maxHeight).toBe('22em');
      expect(getComputedStyle(scrolling).overflowY).toBe('auto');
      expect(getComputedStyle(whole).maxHeight).not.toBe('22em');
      expect(getComputedStyle(whole).overflowY).not.toBe('auto');
      await view.unmount();
    } finally {
      style.remove();
    }
  });
});

describe('The keys of the menu of orders', () => {
  /** Press a key on the head, and give the menus that it opened. */
  async function press(
    head: HTMLElement,
    init: KeyboardEventInit
  ): Promise<{ menus: MouseEvent[]; prevented: boolean }> {
    const menus: MouseEvent[] = [];
    const listen = (event: Event) => menus.push(event as MouseEvent);
    document.addEventListener('contextmenu', listen);
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ...init
    });
    await step(() => {
      head.dispatchEvent(event);
    });
    document.removeEventListener('contextmenu', listen);
    return { menus, prevented: event.defaultPrevented };
  }

  it('opens the menu of the head under it with Shift+F10 or the Menu key, and not with other keys', async () => {
    const { model } = benchModel(notebook());
    const view = await mount(<ExplorationPanel model={model} />);
    const { head } = block(view.host);
    head.getBoundingClientRect = () =>
      ({ left: 1300, bottom: 420, top: 400, right: 1540 }) as DOMRect;
    for (const init of [
      { key: 'F10', shiftKey: true },
      { key: 'ContextMenu' }
    ]) {
      const { menus, prevented } = await press(head, init);
      expect(menus).toHaveLength(1);
      expect(menus[0].target).toBe(head);
      expect([menus[0].clientX, menus[0].clientY, menus[0].button]).toEqual([
        1300, 420, 2
      ]);
      // The browser opens no menu of its own.
      expect(prevented).toBe(true);
    }
    for (const init of [
      { key: 'F10' },
      { key: 'ContextMenu', ctrlKey: true },
      { key: 'Enter' }
    ]) {
      const { menus, prevented } = await press(head, init);
      expect(menus).toHaveLength(0);
      expect(prevented).toBe(false);
    }
    expect(
      isMenuKey({
        key: 'F10',
        shiftKey: true,
        altKey: true,
        ctrlKey: false,
        metaKey: false
      })
    ).toBe(false);
    await view.unmount();
  });

  it('gives the focus back to the head when the menu closes, unless the focus went elsewhere', async () => {
    const { model } = benchModel(notebook());
    const view = await mount(<ExplorationPanel model={model} />);
    const { head } = block(view.host);
    // As JupyterLab does: the menu goes into the page's body on the event,
    // and takes the focus a moment later, as Lumino posts the request.
    let menu: HTMLElement | null = null;
    const open = () => {
      menu = document.createElement('div');
      menu.className = 'lm-Widget lm-Menu';
      menu.tabIndex = -1;
      document.body.appendChild(menu);
      const opened = menu;
      setTimeout(() => opened.focus(), 0);
    };
    document.addEventListener('contextmenu', open);
    try {
      head.focus();
      await press(head, { key: 'F10', shiftKey: true });
      await settle(0);
      expect(document.activeElement).toBe(menu);
      // A pick or Escape takes the menu out of the page.
      menu!.remove();
      await settle(0);
      expect(document.activeElement).toBe(head);

      // A click in a field closes the menu, and the field keeps the focus.
      await press(head, { key: 'ContextMenu' });
      await settle(0);
      expect(document.activeElement).toBe(menu);
      const field = document.createElement('input');
      document.body.appendChild(field);
      field.focus();
      menu!.remove();
      await settle(0);
      expect(document.activeElement).toBe(field);
      field.remove();
    } finally {
      document.removeEventListener('contextmenu', open);
      await view.unmount();
    }
  });

  it('leaves the focus alone when no menu opens', async () => {
    const { model } = benchModel(notebook());
    const view = await mount(<ExplorationPanel model={model} />);
    const { head } = block(view.host);
    head.focus();
    await press(head, { key: 'F10', shiftKey: true });
    // Something else in the page, such as a dialog, takes the focus.
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    const other = document.createElement('div');
    document.body.appendChild(other);
    other.remove();
    await settle(0);
    expect(document.activeElement).toBe(field);
    field.remove();
    await view.unmount();
  });
});

describe('The menu of orders', () => {
  it('lists the four orders on the head of Variables explored, checks the current one, and saves a pick', async () => {
    const commands = new CommandRegistry();
    const items: { command?: string; args?: any; selector: string }[] = [];
    const app = {
      commands,
      contextMenu: { addItem: (item: any) => items.push(item) },
      contextMenuHitTest: () => undefined
    };
    const settings = new EpiSettings();
    const saved: [string, unknown][] = [];
    settings.save = (key, value) => saved.push([key, value]);
    addContextMenus(app as any, () => null, settings);
    const orders = items.filter(
      item => item.command === 'whybook:explored-order'
    );
    expect(orders.map(item => item.args.order)).toEqual([
      'auto',
      'used',
      'size',
      'name'
    ]);
    expect(
      orders.map(item => commands.label(item.command!, item.args))
    ).toEqual(['Auto', 'Most used', 'Largest', 'By name']);
    expect(
      orders.map(item => commands.isToggled(item.command!, item.args))
    ).toEqual([true, false, false, false]);
    await commands.execute('whybook:explored-order', { order: 'name' });
    expect(settings.exploredOrder).toBe('name');
    expect(saved).toEqual([['exploredOrder', 'name']]);
    expect(
      orders.map(item => commands.isToggled(item.command!, item.args))
    ).toEqual([false, false, false, true]);

    // The items are for the head of the block, wherever the panel shows.
    const { model } = benchModel(notebook());
    const view = await mount(
      <div className="jp-Epi">
        <ExplorationPanel model={model} />
      </div>
    );
    const { head } = block(view.host);
    for (const item of orders) {
      expect(head.matches(item.selector)).toBe(true);
    }
    expect(
      Array.from(view.host.querySelectorAll('.jp-Epi-coverage')).some(row =>
        row.matches(orders[0].selector)
      )
    ).toBe(false);
    await view.unmount();
  });
});
