/**
 * The rows of Variables and Contents, and the line above the columns of
 * Contents (critique 5, the app, A18, A20, A21 and A22).
 *
 * - A18: in Variables, a long type ran past the right edge of the panel and
 *   the size beside it shrank to one character. The type now ends in an
 *   ellipsis and the size shows whole (style/base.css). jsdom lays out
 *   nothing, so the galata test ui-tests/tests/variables-rows.spec.ts
 *   measures the row. Here: the tooltip holds the whole type that the row
 *   shows, and a row with no size has no element for it, whose gap made the
 *   space after an ellipsis wider.
 * - A20: the line "Shown as", a grey box like a switch, then "metadata",
 *   is one sentence of plain text, and a plain list of columns has none.
 * - A21: a range read "-3–2.99", like a subtraction: "-3 to 2.99".
 * - A22: the tooltip of a column held only its name and its type.
 */
import './fakes/quiet';

import * as React from 'react';

import { rangeText } from '../model/numbers';
import type { IColumn, IVariable } from '../tokens';
import { ContentsSection, VariablesSection, columnMeta } from '../ui/variables';
import { benchModel } from './fakes/bench-fake';
import { mount, settle } from './fakes/bench-render';

/** A column of `frame` with 318 rows. */
function column(
  frame: string,
  label: string,
  rest: Partial<IColumn> = {}
): IColumn {
  return {
    name: `${frame}['${label}']`,
    label,
    parent: frame,
    kind: 'numeric',
    tag: 'num',
    dtype: 'Float64',
    rows: 318,
    missing: 0,
    ...rest
  };
}

function frame(
  name: string,
  columns: IColumn[],
  rest: Partial<IVariable> = {}
): IVariable {
  return {
    name,
    label: name,
    kind: 'dataframe',
    type: 'pandas.core.frame.DataFrame',
    rows: 318,
    n_columns: columns.length,
    columns,
    ...rest
  };
}

/** Draw `Section` over a kernel that lists these variables, with `selected` selected. */
async function drawn(
  Section: typeof VariablesSection,
  variables: IVariable[],
  selected?: string
) {
  const { model } = benchModel([{ id: 'load', source: 'x = 1', count: 1 }]);
  (model.sessionContext as any).session = { kernel: {} };
  (model.bridge as any)._snapshot = { variables, packages: {} };
  if (selected) {
    model.select(selected);
  }
  const view = await mount(<Section model={model} />);
  await settle();
  return {
    host: view.host,
    close: async () => {
      await view.unmount();
      model.dispose();
    }
  };
}

describe('a row of Variables', () => {
  it('holds the whole type that it shows in its tooltip, and has no size element without a size', async () => {
    const { host, close } = await drawn(VariablesSection, [
      frame('model_data_by_age', [], { rows: 5837, n_columns: 7 }),
      {
        name: 'lmm_fit_by_age',
        label: 'lmm_fit_by_age',
        kind: 'model',
        type: 'statsmodels.regression.mixed_linear_model.MixedLMResultsWrapper'
      },
      frame('old_patients', [], {
        rows: 40,
        n_columns: 3,
        selection: { of: 'patients', where: '60 <= age' }
      })
    ]);
    const rows = Array.from(host.querySelectorAll('.jp-Epi-variable')).map(
      row => ({
        type: row.querySelector('.jp-Epi-item-type')?.textContent,
        size: row.querySelector('.jp-Epi-item-shape')?.textContent ?? null,
        title: row.getAttribute('title')
      })
    );
    await close();
    expect(rows).toEqual([
      {
        type: 'DataFrame',
        size: '5,837 × 7',
        title: 'pandas.core.frame.DataFrame'
      },
      {
        type: 'MixedLMResultsWrapper',
        size: null,
        title: 'statsmodels.regression.mixed_linear_model.MixedLMResultsWrapper'
      },
      {
        type: 'Selection',
        size: '40 × 3',
        title: 'Selection of patients: pandas.core.frame.DataFrame'
      }
    ]);
  });
});

describe('the line above the columns of Contents', () => {
  async function line(variable: IVariable) {
    const { host, close } = await drawn(
      ContentsSection,
      [variable],
      variable.name
    );
    const found = {
      line: host.querySelector('.jp-Epi-repr')?.textContent ?? null,
      // The grey box that looked like a switch.
      box: host.querySelector('.jp-Epi-repr-label') !== null
    };
    await close();
    return found;
  }

  it('says in one sentence where the groups or the rows come from, and is not there for a plain list', async () => {
    const olink = frame('olink', [column('olink', 'IL6')], {
      groups: [{ label: 'Inflammation', columns: ['IL6'] }],
      grouped_by: 'assay panel'
    });
    const selection = frame('old_patients', [column('old_patients', 'age')], {
      selection: { of: 'patients', where: '60 <= age' }
    });
    const plain = frame('patients', [column('patients', 'age')]);
    expect([
      await line(olink),
      await line(selection),
      await line(plain)
    ]).toEqual([
      {
        line: "Grouped by assay panel, from the frame's metadata.",
        box: false
      },
      { line: 'Rows of patients, from a plot selection.', box: false },
      { line: null, box: false }
    ]);
  });
});

describe('the range of a column', () => {
  it('joins its two ends with "to", for numbers as for dates', () => {
    expect([
      rangeText(-3, 2.99),
      rangeText(-2.84, 2.93),
      rangeText(5, 9),
      rangeText(4, 4)
    ]).toEqual(['-3 to 2.99', '-2.84 to 2.93', '5 to 9', '4']);
  });

  it('reads the same in a row of Contents, for an ordinal column too', () => {
    expect([
      columnMeta(column('olink', 'IL6', { min: -3, max: 2.99, missing: 29 })),
      columnMeta(
        column('survey', 'agreement', {
          kind: 'categorical',
          tag: 'ord',
          levels: ['-2', '-1', '0', '1', '2']
        })
      )
    ]).toEqual(['-3 to 2.99 · 9% NA', '-2 to 2']);
  });
});

describe('a column row of Contents', () => {
  it('holds its whole line in its tooltip', async () => {
    const olink = frame('olink', [
      column('olink', 'patient_id', {
        kind: 'id',
        tag: 'id',
        dtype: 'Int64'
      }),
      column('olink', 'CXCL10', { min: -2.82, max: 4.4, missing: 41 })
    ]);
    const { host, close } = await drawn(ContentsSection, [olink], 'olink');
    const titles = Array.from(host.querySelectorAll('.jp-Epi-column')).map(
      row => row.getAttribute('title')
    );
    await close();
    expect(titles).toEqual([
      'patient_id · Int64',
      'CXCL10 · Float64 · -2.82 to 4.4 · 13% NA'
    ]);
  });
});
