/**
 * The links under the title of Cell details (critique 5, the app, A23).
 * The first read "Show in the view", and "the view" names no part of
 * Whybook. It names the view in front, on a line of its own, and the links
 * to the other views go on the line under it.
 */
import './fakes/quiet';

import * as fs from 'fs';
import * as path from 'path';
import * as React from 'react';

import type { ViewKind } from '../tokens';
import { CellDetails } from '../ui/details';
import { benchModel } from './fakes/bench-fake';
import { mount, settle, step } from './fakes/bench-render';

/** A section with its heading, a text and the mixed model [5]. */
function notebook() {
  return benchModel([
    { id: 'head', type: 'markdown', source: '## Model' },
    {
      id: 'intro',
      type: 'markdown',
      source: 'Does arm change the trajectory of pain?'
    },
    { id: 'fit', source: 'fit = smf.mixedlm(formula, data).fit()', count: 5 }
  ]).model;
}

/** The links of Cell details, by line: the first line, then the line under it. */
function lines(host: Element): string[][] {
  const links = host.querySelector('.jp-Epi-details-links');
  return Array.from(links?.children ?? []).map(line =>
    line.matches('button')
      ? [line.textContent ?? '']
      : Array.from(line.querySelectorAll('button')).map(
          button => button.textContent ?? ''
        )
  );
}

describe('The links of Cell details', () => {
  it('name the view in front, then the other views on the line under it', async () => {
    const model = notebook();
    const view = await mount(
      <CellDetails model={model} width={260} editorServices={null} />
    );
    const found: Record<string, Record<ViewKind, string[][]>> = {};
    for (const cellId of ['fit', 'intro', 'head']) {
      found[cellId] = {} as Record<ViewKind, string[][]>;
      for (const kind of ['bench', 'map', 'linear'] as const) {
        await step(() => {
          model.setCurrentCell(cellId);
          model.setView(kind);
        });
        await settle();
        found[cellId][kind] = lines(view.host);
      }
    }
    await view.unmount();
    model.dispose();
    expect(found).toEqual({
      fit: {
        bench: [['Show on the bench'], ['Show on the map']],
        map: [['Show on the map'], ['Show on the bench']],
        linear: [
          ['Show in the Code view'],
          ['Show on the bench', 'Show on the map']
        ]
      },
      intro: {
        bench: [['Show on the bench'], ['Show on the map']],
        map: [['Show on the map'], ['Show on the bench']],
        linear: [
          ['Show in the Code view'],
          ['Show on the bench', 'Show on the map']
        ]
      },
      // A heading is the head of its section, and the map does not show it.
      head: {
        bench: [['Show on the bench']],
        map: [['Show on the bench']],
        linear: [['Show in the Code view'], ['Show on the bench']]
      }
    });
  });

  it('show the cell in the view in front, and switch to another view', async () => {
    const model = notebook();
    const shown: string[] = [];
    model.cellShown.connect((_, cellId) => shown.push(cellId));
    const view = await mount(
      <CellDetails model={model} width={260} editorServices={null} />
    );
    await step(() => model.setCurrentCell('fit'));
    await settle();
    const link = (text: string) =>
      Array.from(
        view.host.querySelectorAll<HTMLButtonElement>(
          '.jp-Epi-details-links button'
        )
      ).find(button => button.textContent === text)!;
    await step(() => link('Show on the bench').click());
    await step(() => link('Show on the map').click());
    await settle();
    const found = { shown, view: model.view, pending: model.takePendingShow() };
    await view.unmount();
    model.dispose();
    expect(found).toEqual({ shown: ['fit'], view: 'map', pending: 'fit' });
  });

  it('put the link to the view in front on a line of its own', async () => {
    // The view's style sheet: jsdom applies its rules, with no layout.
    const style = document.createElement('style');
    style.textContent = fs.readFileSync(
      path.join(__dirname, '..', '..', 'style', 'base.css'),
      'utf8'
    );
    document.head.appendChild(style);
    const model = notebook();
    const view = await mount(
      <CellDetails model={model} width={260} editorServices={null} />
    );
    try {
      await step(() => model.setCurrentCell('fit'));
      await settle();
      const links = view.host.querySelector('.jp-Epi-details-links')!;
      const others = links.lastElementChild!;
      expect({
        column: getComputedStyle(links).flexDirection,
        others: getComputedStyle(others).display,
        wrap: getComputedStyle(others).flexWrap
      }).toEqual({ column: 'column', others: 'flex', wrap: 'wrap' });
    } finally {
      await view.unmount();
      model.dispose();
      style.remove();
    }
  });
});
