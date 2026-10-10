/**
 * The counts of Contents and Variables take the noun in the singular for
 * one and in the plural for any other number (critique 5, the app, A19).
 * The search of Contents read "3 match · searching all 4,813", a frame of
 * one column read "1 columns", and with no kernel Variables read "the 1
 * below are from the last run".
 */
import './fakes/quiet';

import * as React from 'react';

import type { IStoredVariable } from '../model/restore';
import type { IColumn, IVariable } from '../tokens';
import { ContentsSection, VariablesSection } from '../ui/variables';
import { benchModel, notebookOf } from './fakes/bench-fake';
import { mount, settle, step } from './fakes/bench-render';

function frame(name: string, labels: string[]): IVariable {
  return {
    name,
    label: name,
    kind: 'dataframe',
    type: 'pandas.DataFrame',
    rows: 318,
    n_columns: labels.length,
    columns: labels.map(
      label =>
        ({
          name: `${name}['${label}']`,
          label,
          parent: name,
          kind: 'numeric',
          tag: 'num'
        }) as IColumn
    )
  };
}

/** Contents of `variable`, as the kernel lists it. */
async function contentsOf(variable: IVariable) {
  const { model } = benchModel([{ id: 'load', source: 'x = 1', count: 1 }]);
  (model.sessionContext as any).session = { kernel: {} };
  (model.bridge as any)._snapshot = { variables: [variable], packages: {} };
  model.select(variable.name);
  const view = await mount(<ContentsSection model={model} />);
  await settle();
  const search = view.host.querySelector<HTMLInputElement>(
    'input[aria-label="Search columns"]'
  )!;
  return {
    search,
    caption: () =>
      view.host.querySelector('.jp-Epi-contents-frame > .jp-Epi-caption')
        ?.textContent,
    type: async (text: string) => {
      await step(() => {
        const set = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value'
        )!.set!;
        set.call(search, text);
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });
    },
    group: async (label: string) => {
      const button = Array.from(
        view.host.querySelectorAll<HTMLButtonElement>('.jp-Epi-group')
      ).find(item => item.textContent?.startsWith(label))!;
      await step(() => button.click());
    },
    close: async () => {
      await view.unmount();
      model.dispose();
    }
  };
}

describe('the counts of Contents', () => {
  it('count one match and several matches', async () => {
    const olink = frame('olink', ['IL6', 'IL1B', 'IL10', 'IL17A', 'NGF']);
    olink.groups = [
      { label: 'Inflammation', columns: ['IL6', 'IL1B', 'IL10', 'IL17A'] },
      { label: 'Neurology', columns: ['NGF'] }
    ];
    olink.grouped_by = 'assay panel';
    const contents = await contentsOf(olink);
    const captions: (string | null | undefined)[] = [];
    try {
      captions.push(contents.caption());
      for (const query of ['IL1', 'IL6', 'CXCL']) {
        await contents.type(query);
        captions.push(contents.caption());
      }
      await contents.type('');
      await contents.group('Neurology');
      captions.push(contents.caption());
      await contents.group('Inflammation');
      captions.push(contents.caption());
    } finally {
      await contents.close();
    }
    expect(captions).toEqual([
      '5 columns',
      '3 matches · searching all 5',
      '1 match · searching all 5',
      '0 matches · searching all 5',
      '1 Neurology column',
      '4 Inflammation columns'
    ]);
  });

  it('counts the column of a frame of one column', async () => {
    const contents = await contentsOf(frame('ids', ['patient_id']));
    const found = {
      caption: contents.caption(),
      placeholder: contents.search.placeholder
    };
    await contents.close();
    expect(found).toEqual({
      caption: '1 column',
      placeholder: 'Search 1 column'
    });
  });
});

describe('the note of Variables with no kernel', () => {
  const kept = (name: string): IStoredVariable =>
    ({
      name,
      kind: 'dataframe',
      type: 'pandas.DataFrame',
      rows: 10,
      n_columns: 3,
      cell: 'load'
    }) as IStoredVariable;

  async function note(names: string[]) {
    const content = notebookOf([
      { id: 'load', source: names.map(name => `${name} = 1`).join('\n') }
    ]);
    content.metadata = {
      whybook: { variables: names.map(kept) }
    } as any;
    const { model } = benchModel(content);
    const view = await mount(<VariablesSection model={model} />);
    await settle();
    const text = view.host
      .querySelector('.jp-Epi-stale-note')
      ?.textContent?.replace(/Run all$/, '')
      .trim();
    await view.unmount();
    model.dispose();
    return text;
  }

  it('says "is" of one name and "are" of several', async () => {
    expect([await note(['diary']), await note(['diary', 'weekly'])]).toEqual([
      'No kernel is running: the 1 below is from the last run.',
      'No kernel is running: the 2 below are from the last run.'
    ]);
  });
});
