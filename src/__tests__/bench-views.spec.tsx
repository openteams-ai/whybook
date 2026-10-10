/**
 * Smaller defects of the views: a cell shown in a collapsed section, a file
 * dropped on a card of the map, the Code view while the file loads, an
 * output pinned before a run, and an output that cannot be drawn.
 */
import * as React from 'react';
import type * as nbformat from '@jupyterlab/nbformat';
import { Sanitizer } from '@jupyterlab/apputils';
import type { ICodeCellModel } from '@jupyterlab/cells';
import {
  RenderMimeRegistry,
  standardRendererFactories
} from '@jupyterlab/rendermime';

import { FILES_MIME } from '../ui/common';
import { Bench } from '../ui/bench';
import { DocumentView } from '../ui/document';
import { LinearView } from '../ui/linear';
import { MapView } from '../ui/map';
import * as plot from '../ui/plot';
import { PLOT_MIME } from '../tokens';
import { benchModel } from './fakes/bench-fake';
import { mount, settle, step } from './fakes/bench-render';

describe('"Show on the bench" for a cell in a collapsed section', () => {
  const scrolled: Element[] = [];
  const scrollIntoView = Element.prototype.scrollIntoView;
  beforeAll(() => {
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
  });
  afterAll(() => {
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  it('opens the section and brings the cell into sight', async () => {
    const { model } = benchModel([
      { id: 'h1', type: 'markdown', source: '## Load' },
      { id: 'a', source: "diary = pd.read_csv('diary.csv')", count: 1 },
      { id: 'h2', type: 'markdown', source: '## Model' },
      { id: 'b', source: 'fit = ols(diary)', count: 2 }
    ]);
    model.toggleSection('h2');
    const view = await mount(
      <DocumentView
        model={model}
        editorServices={null}
        openFile={() => undefined}
        isVisible={() => true}
      />
    );
    await settle();
    const card = () =>
      view.host.querySelector('.jp-Epi-cell[data-cell-id="b"]');
    const hidden = !card();
    await step(() => model.showCell('b'));
    await settle();
    const shown = card();
    const found = {
      hidden,
      shown: !!shown,
      open: !model.collapsed.has('h2'),
      scrolled: !!shown && scrolled.includes(shown)
    };
    await view.unmount();
    model.dispose();
    expect(found).toEqual({
      hidden: true,
      shown: true,
      open: true,
      scrolled: true
    });
  });
});

describe('A file from the file browser dropped on the map', () => {
  it('asks about the file with the cell whose card it is dropped on', async () => {
    const { model } = benchModel([
      { id: 'a', source: "diary = pd.read_csv('diary.csv')", count: 1 },
      { id: 'b', source: 'weekly = diary.groupby("week").mean()', count: 2 }
    ]);
    const asked: unknown[] = [];
    jest
      .spyOn(model, 'askFileDrop')
      .mockImplementation((paths, target) => asked.push(target));
    const view = await mount(<MapView model={model} />);
    await settle();
    const drop = (target: Element) => {
      const event = new MouseEvent('lm-drop', {
        bubbles: true,
        cancelable: true
      }) as any;
      event.mimeData = {
        hasData: (mime: string) => mime === FILES_MIME,
        getData: () => ['data/sites.csv']
      };
      event.proposedAction = 'copy';
      event.dropAction = 'none';
      target.dispatchEvent(event);
    };
    await step(() =>
      drop(view.host.querySelector('.jp-Epi-map-cell[data-cell-id="b"]')!)
    );
    await step(() => drop(view.host.querySelector('.jp-Epi-map-viewport')!));
    await view.unmount();
    model.dispose();
    // On a card: that cell. On the map around the cards: no cell.
    expect(asked).toEqual([{ cellId: 'b' }, {}]);
  });
});

describe('The Code view while the file loads', () => {
  it('says that the notebook loads, and offers cells to add once it has loaded', async () => {
    const { nb, model, context } = benchModel([], { loading: true });
    const view = await mount(
      <LinearView model={model} editorServices={null} />
    );
    await settle();
    const shown = () => ({
      loading: (view.host.textContent ?? '').includes('Loading the notebook'),
      adds: view.host.querySelectorAll('.jp-Epi-insert-button').length > 0
    });
    const loading = shown();
    // The file's content comes.
    context.isReady = true;
    nb.sharedModel.insertCell(0, { cell_type: 'code', source: 'x = 1' });
    await settle();
    const loaded = shown();
    await view.unmount();
    model.dispose();
    expect({ loading, loaded }).toEqual({
      loading: { loading: true, adds: false },
      loaded: { loading: false, adds: true }
    });
  });
});

// Two pictures and a printed log, as base64 text in the outputs.
const PICTURE_A = 'aVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
const PICTURE_B = 'bVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

function picture(data: string): nbformat.IOutput {
  return {
    output_type: 'display_data',
    data: { 'image/png': data },
    metadata: {}
  };
}

describe('An output pinned under its cell', () => {
  it('stays on the same output after a run that prints before it', async () => {
    const rendermime = new RenderMimeRegistry({
      initialFactories: standardRendererFactories,
      sanitizer: new Sanitizer()
    });
    const { nb, model } = benchModel(
      [
        {
          id: 'a',
          source: 'plot(weekly)',
          count: 1,
          outputs: [picture(PICTURE_A)]
        }
      ],
      { rendermime }
    );
    // At Overview a picture is a thumbnail that pins it with a click.
    model.settings.detail = 'overview';
    const view = await mount(
      <Bench model={model} editorServices={null} openFile={() => undefined} />
    );
    await settle();
    await step(() =>
      view.host
        .querySelector<HTMLElement>('.jp-Epi-miniature.jp-mod-image')!
        .click()
    );
    await settle();
    const pinned = () => {
      const area = view.host.querySelector('.jp-Epi-pinned');
      return area
        ? {
            picture: area.querySelector('img')?.getAttribute('src') ?? null,
            text: area.textContent?.trim() ?? ''
          }
        : null;
    };
    const before = pinned();
    // The cell runs again, and prints a line before its plot.
    const cell = nb.cells.get(0) as ICodeCellModel;
    cell.outputs.clear();
    cell.outputs.add({
      output_type: 'stream',
      name: 'stdout',
      text: 'Loaded 1,200 rows\n'
    });
    cell.outputs.add(picture(PICTURE_B));
    await settle();
    const after = pinned();
    // A run without a picture leaves nothing pinned.
    cell.outputs.clear();
    cell.outputs.add({
      output_type: 'stream',
      name: 'stdout',
      text: 'No rows\n'
    });
    await settle();
    const none = pinned();
    await view.unmount();
    model.dispose();
    expect({ before, after, none }).toEqual({
      before: { picture: `data:image/png;base64,${PICTURE_A}`, text: '' },
      after: { picture: `data:image/png;base64,${PICTURE_B}`, text: '' },
      none: null
    });
  });
});

describe('An output that throws when it is drawn', () => {
  // A plot payload of another version, whose axes moved under "axes": the
  // plot reads `x.label` of it and throws.
  const payload = {
    version: 2,
    kind: 'scatter',
    title: 'pain by week',
    axes: { x: { field: 'week' }, y: { field: 'pain' } },
    points: [{ x: 1, y: 2, g: null, i: 0 }]
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows a short line in its place, and the rest of the view stays', async () => {
    jest.spyOn(plot, 'EpiPlot').mockImplementation(() => {
      throw new TypeError(
        "Cannot read properties of undefined (reading 'label')"
      );
    });
    // React and jsdom report the error that the boundary catches.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { model } = benchModel([
      {
        id: 'a',
        source: 'whybook.scatter(weekly, "week", "pain")',
        count: 1,
        outputs: [
          {
            output_type: 'display_data',
            data: {
              [PLOT_MIME]: payload,
              'text/plain': '<whybook scatter: pain by week>'
            },
            metadata: {}
          } as nbformat.IOutput
        ]
      },
      { id: 'b', source: 'fit = ols(weekly)', count: 2 }
    ]);
    const view = await mount(
      <Bench model={model} editorServices={null} openFile={() => undefined} />
    );
    await settle();
    const found = {
      line: view.host.querySelector(
        '.jp-Epi-cell[data-cell-id="a"] .jp-Epi-error'
      )?.textContent,
      other: !!view.host.querySelector('.jp-Epi-cell[data-cell-id="b"]')
    };
    await view.unmount();
    model.dispose();
    expect(found).toEqual({
      line: 'This output could not be drawn',
      other: true
    });
  });
});
