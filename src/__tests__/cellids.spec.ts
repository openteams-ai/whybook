/**
 * A notebook older than nbformat 4.5 has no cell ids in its file, so
 * JupyterLab gives its cells new ids at each load, and does not save them.
 * Whybook keys the cell of each kept variable and the parent of each branch
 * by cell id: when it first writes its metadata to such a notebook, it sets
 * the notebook's `nbformat_minor` to 5 (src/model/notebook.ts), and
 * JupyterLab then saves the ids. A notebook that Whybook does not write to
 * stays as it was.
 */
import './fakes/quiet';

import type * as nbformat from '@jupyterlab/nbformat';
import { NotebookModel } from '@jupyterlab/notebook';

import {
  findCell,
  insertCodeCell,
  notebookMeta,
  setCellMeta,
  setNotebookMeta
} from '../model/notebook';
import { keptWithout } from '../model/restore';

/** The two cells of the sweep's notebook, in a file of nbformat 4.4 or 4.5. */
function file(minor: number): nbformat.INotebookContent {
  return {
    cells: ['x = [1, 2, 3]', 'y = len(x)\ny'].map((source, index) => ({
      cell_type: 'code',
      ...(minor >= 5 ? { id: `cell-${index}` } : {}),
      metadata: {},
      source,
      outputs: [],
      execution_count: null
    })) as nbformat.ICell[],
    metadata: {},
    nbformat: 4,
    nbformat_minor: minor
  };
}

/** The notebook as JupyterLab loads it from a file. */
function load(content: nbformat.INotebookContent): NotebookModel {
  const model = new NotebookModel();
  model.fromJSON(JSON.parse(JSON.stringify(content)));
  model.dirty = false;
  return model;
}

function ids(model: NotebookModel): string[] {
  return Array.from(model.cells).map(cell => cell.id);
}

describe('a notebook older than nbformat 4.5', () => {
  it('gets nbformat 4.5 when Whybook keeps a variable, and its cells keep their ids through a save and a load', () => {
    const model = load(file(4));
    const before = ids(model);
    // Run all keeps the variables of the run, each with the id of its cell.
    setNotebookMeta(model, {
      variables: [
        { name: 'x', type: 'list', kind: 'other', cell: before[0] },
        { name: 'y', type: 'int', kind: 'scalar', cell: before[1] }
      ] as any
    });
    const saved = model.toJSON() as nbformat.INotebookContent;
    expect(saved.nbformat_minor).toBe(5);
    expect(saved.cells.map(cell => cell.id)).toEqual(before);
    // The next load has the same ids, so the kept variables keep their
    // cells: the view does not drop them, and writes nothing on opening.
    const again = load(saved);
    expect(ids(again)).toEqual(before);
    const kept = notebookMeta(again).variables ?? [];
    expect(
      keptWithout(kept, cellId => Boolean(findCell(again, cellId)))
    ).toBeNull();
  });

  it("gets nbformat 4.5 when Whybook writes a cell's metadata", () => {
    const model = load(file(4));
    setCellMeta(model.cells.get(1), { template: true });
    expect(model.sharedModel.nbformat_minor).toBe(5);
    expect(
      (model.toJSON() as nbformat.INotebookContent).cells.map(cell => cell.id)
    ).toEqual(ids(model));
  });

  it("gets nbformat 4.5 when a cell with Whybook's metadata goes in", () => {
    const model = load(file(4));
    insertCodeCell(model, 2, 'z = y + 1', { template: true });
    expect(model.sharedModel.nbformat_minor).toBe(5);
  });

  it('keeps the parent of a branch through a save and a load', () => {
    const model = load(file(4));
    const parent = model.cells.get(1).id;
    // A branch of the second cell, as an answer that branches writes it.
    insertCodeCell(model, 2, 'y = len(x) + 1\ny', {
      branch: { of: parent, letter: 'b' }
    });
    const again = load(model.toJSON() as nbformat.INotebookContent);
    const branch = again.cells.get(2).getMetadata('whybook') as any;
    expect(findCell(again, branch.branch.of)?.sharedModel.getSource()).toBe(
      'y = len(x)\ny'
    );
  });

  it("gets nbformat 4.5 at the next write that changes something, when it holds Whybook's metadata already", () => {
    // A notebook that an older release of Whybook saved, with the version
    // of the layout of the metadata and no cell ids.
    const content = file(4);
    content.metadata = { whybook: { format: 1, outcome: 'y' } };
    const model = load(content);
    setNotebookMeta(model, { unit: 'x' });
    expect(model.sharedModel.nbformat_minor).toBe(5);
  });

  it('stays as it was after a read, or a write that changes nothing, so that opening it does not mark it as changed', () => {
    const content = file(4);
    content.metadata = { whybook: { format: 1, outcome: 'y' } };
    content.cells[0].metadata = { whybook: { template: true } };
    const model = load(content);
    notebookMeta(model);
    // What the view writes again when the notebook opens.
    setNotebookMeta(model, { outcome: 'y' });
    setCellMeta(model.cells.get(0), { template: true });
    expect(model.sharedModel.nbformat_minor).toBe(4);
    expect(model.dirty).toBe(false);
    const saved = model.toJSON() as nbformat.INotebookContent;
    expect(saved.nbformat_minor).toBe(4);
    expect(saved.cells.map(cell => cell.id)).toEqual([undefined, undefined]);
  });
});

describe('a notebook of nbformat 4.5', () => {
  it('keeps its version and its ids when Whybook writes to it', () => {
    const model = load(file(5));
    setCellMeta(model.cells.get(0), { template: true });
    setNotebookMeta(model, { outcome: 'y' });
    const saved = model.toJSON() as nbformat.INotebookContent;
    expect(saved.nbformat_minor).toBe(5);
    expect(saved.cells.map(cell => cell.id)).toEqual(['cell-0', 'cell-1']);
  });
});
