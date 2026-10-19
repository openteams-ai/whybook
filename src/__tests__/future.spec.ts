/// <reference types="node" />
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import * as kernelCode from '../kernelCode';
import { snippetCall } from '../model/kernel';
import { PYTHON } from '../model/languages';
import { cellMeta, editMeta, lineDiff, setCellMeta } from '../model/notebook';
import type { IEpiCellMeta, IPlotPayload } from '../tokens';
import { plotXValues } from '../ui/plot';

const KERNEL_CODE = join(
  __dirname,
  '..',
  '..',
  'whybook',
  'server',
  'kernel_code'
);

describe('kernel code', () => {
  const files = readdirSync(KERNEL_CODE).filter(file => file.endsWith('.py'));

  it('embeds every Python file', () => {
    expect(files.sort()).toEqual([
      'analyze_cells.py',
      'inspect_variables.py',
      'kernel_facts.py',
      'plot_hooks.py',
      'region_summary.py',
      'table_rows.py',
      'write_frames.py'
    ]);
  });

  it.each(files)('matches %s', file => {
    const source = readFileSync(join(KERNEL_CODE, file), 'utf8');
    expect(kernelCode.python[file.replace(/\.py$/, '')]).toEqual(source);
  });
});

describe('snippetCall', () => {
  it('runs the snippet and its call in globals of their own, which hold the arguments', () => {
    const args = { known: { df: 'x"y' }, names: ["it's", 'a\\b'] };
    const code = snippetCall('inspect_variables', args);
    // One statement, which names no variable of the notebook: `type =
    // "linear"` there does not reach the snippet, and the snippet's own
    // names do not stay there.
    const match =
      /^__import__\("builtins"\)\.exec\((".*"), \{"_whybook_args": __import__\("json"\)\.loads\((".*")\)\}\)\n$/.exec(
        code
      );
    expect(match).not.toBeNull();
    // Python reads each literal as a string, as JSON does.
    expect(JSON.parse(match![1])).toBe(
      `${kernelCode.inspectVariables}\n_whybook_inspect_variables(_whybook_args)\n`
    );
    expect(JSON.parse(JSON.parse(match![2]))).toEqual(args);
  });

  it('sends the code of whybook/server/tests/data/kernel_call.json, which the Python tests run', () => {
    const { name, program, args, code } = JSON.parse(
      readFileSync(
        join(KERNEL_CODE, '..', 'tests', 'data', 'kernel_call.json'),
        'utf8'
      )
    );
    const language = { ...PYTHON, snippets: { [name]: program } };
    expect(language.call(name, args)).toBe(code);
  });
});

describe('lineDiff', () => {
  it('marks a changed line as removed and added', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { kind: ' ', text: 'a' },
      { kind: '-', text: 'b' },
      { kind: '+', text: 'B' },
      { kind: ' ', text: 'c' }
    ]);
  });

  it('keeps the old lines around an insertion', () => {
    expect(lineDiff('a\nc', 'a\nb\nc').map(line => line.kind)).toEqual([
      ' ',
      '+',
      ' '
    ]);
  });
});

describe('editMeta', () => {
  /**
   * A cell model with only the metadata calls that the helpers make, in no
   * notebook.
   */
  function fakeCell(whybook?: IEpiCellMeta): any {
    const metadata: Record<string, any> = whybook ? { whybook } : {};
    return {
      sharedModel: { notebook: null },
      getMetadata: (key: string) =>
        metadata[key] === undefined
          ? undefined
          : JSON.parse(JSON.stringify(metadata[key])),
      setMetadata: (key: string, value: any) => {
        metadata[key] = JSON.parse(JSON.stringify(value));
      },
      deleteMetadata: (key: string) => {
        delete metadata[key];
      }
    };
  }

  const model: Partial<IEpiCellMeta> = {
    summary: 'Adds age to the model.',
    assumptions: [{ text: 'age acts linearly', kind: 'modelling' }],
    follow_up: [{ text: 'Is age related to the arm?', type: 'association' }],
    generated_by: {
      agent: 'claude',
      model: 'a model',
      choice: 'remote',
      at: '2026-09-25T20:00:00.000Z'
    }
  };

  it("keeps what a model wrote about the code it put in a cell, and Undo puts the analyst's cell back", () => {
    // The analyst wrote the cell: it has a title and no mark of a model.
    const cell = fakeCell({ title: 'Mixed model' });
    const edit = editMeta(cellMeta(cell), model);
    setCellMeta(cell, edit.patch);
    expect(cellMeta(cell)).toEqual({
      title: 'Mixed model',
      written_by: 'agent',
      ...model
    });
    setCellMeta(cell, edit.restore);
    expect(cellMeta(cell)).toEqual({ title: 'Mixed model' });
  });

  it("replaces a model's earlier notes, and Undo brings them back", () => {
    const earlier: IEpiCellMeta = {
      written_by: 'agent',
      summary: 'Fits the model.',
      follow_up: [{ text: 'Are the residuals normal?', type: 'model' }],
      generated_by: { agent: 'claude', model: 'an older model' }
    };
    const cell = fakeCell(earlier);
    const edit = editMeta(cellMeta(cell), model);
    setCellMeta(cell, edit.patch);
    // The old follow-ups and summary described the old code.
    expect(cellMeta(cell)).toEqual({ written_by: 'agent', ...model });
    setCellMeta(cell, edit.restore);
    expect(cellMeta(cell)).toEqual(earlier);
  });

  it('adds a value the analyst chose to those the cell keeps, and Undo takes it away', () => {
    const typed = { name: 'MIN_DAYS', param: 'min_days', value: '14' };
    const cell = fakeCell({
      user_values: [{ name: 'ALPHA', param: null, value: '0.1' }]
    });
    const edit = editMeta(cellMeta(cell), { user_values: [typed] });
    setCellMeta(cell, edit.patch);
    expect(cellMeta(cell).user_values).toEqual([
      { name: 'ALPHA', param: null, value: '0.1' },
      typed
    ]);
    setCellMeta(cell, edit.restore);
    expect(cellMeta(cell).user_values).toEqual([
      { name: 'ALPHA', param: null, value: '0.1' }
    ]);
  });

  it("marks a template's edit and keeps the notes the cell had", () => {
    const cell = fakeCell({ summary: 'Fits the model.' });
    const edit = editMeta(cellMeta(cell), {});
    expect(edit.patch).toEqual({ written_by: 'agent', template: true });
    setCellMeta(cell, edit.patch);
    expect(cellMeta(cell)).toEqual({
      summary: 'Fits the model.',
      written_by: 'agent',
      template: true
    });
    setCellMeta(cell, edit.restore);
    expect(cellMeta(cell)).toEqual({ summary: 'Fits the model.' });
  });

  it("keeps a model's mark through a template's edit, and a model's edit takes a template's mark away", () => {
    // A template's edit of a model's cell leaves the model's mark, as before.
    const byModel = fakeCell({ written_by: 'agent', ...model });
    expect(editMeta(cellMeta(byModel), {}).patch).toEqual({
      written_by: 'agent'
    });
    const byTemplate = fakeCell({ written_by: 'agent', template: true });
    const edit = editMeta(cellMeta(byTemplate), model);
    setCellMeta(byTemplate, edit.patch);
    expect(cellMeta(byTemplate).template).toBeUndefined();
    setCellMeta(byTemplate, edit.restore);
    expect(cellMeta(byTemplate)).toEqual({
      written_by: 'agent',
      template: true
    });
  });
});

describe('plotXValues', () => {
  const base = {
    version: 1,
    title: 't',
    x: { label: 'week' },
    y: { label: 'pain' },
    source: { frame: 'weekly', x: 'week', y: 'pain_score' },
    select: 'x'
  };

  it('lists the x values of all series once, in order', () => {
    const payload = {
      ...base,
      kind: 'ribbon',
      series: [
        { name: 'A', points: [3, 1, 2].map(x => ({ x, y: 0, lo: 0, hi: 0 })) },
        { name: 'B', points: [2, 4].map(x => ({ x, y: 0, lo: 0, hi: 0 })) }
      ]
    } as unknown as IPlotPayload;
    expect(plotXValues(payload)).toEqual([1, 2, 3, 4]);
  });

  it('uses the bin edges of a histogram', () => {
    const payload = {
      ...base,
      kind: 'hist',
      bins: [
        { x0: 0, x1: 5, n: 2 },
        { x0: 5, x1: 10, n: 1 }
      ]
    } as unknown as IPlotPayload;
    expect(plotXValues(payload)).toEqual([0, 5, 5, 10]);
  });
});
