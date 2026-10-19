/**
 * The version of the layout of Whybook's metadata in a notebook
 * (METADATA_FORMAT in src/tokens.ts), so that a later release can migrate
 * the notebook. Every write of Whybook's metadata marks the notebook with
 * it, and a notebook that holds none of Whybook's metadata stays as it was.
 */
import './fakes/quiet';

import { NotebookModel } from '@jupyterlab/notebook';

import {
  cellMeta,
  insertCodeCell,
  notebookMeta,
  setCellMeta,
  setNotebookMeta
} from '../model/notebook';

function notebook(cells = 1): NotebookModel {
  const model = new NotebookModel();
  for (let i = 0; i < cells; i++) {
    model.sharedModel.insertCell(i, { cell_type: 'code', source: `x = ${i}` });
  }
  return model;
}

describe("the version of the layout of Whybook's metadata", () => {
  it("is written with the notebook's metadata", () => {
    const model = notebook();
    setNotebookMeta(model, { outcome: 'pain' });
    expect(model.getMetadata('whybook')).toEqual({
      outcome: 'pain',
      format: 0
    });
  });

  it("is written on the notebook when a cell's metadata is written", () => {
    const model = notebook();
    setCellMeta(model.cells.get(0), { template: true });
    expect(notebookMeta(model)).toEqual({ format: 0 });
    expect(cellMeta(model.cells.get(0))).toEqual({ template: true });
  });

  it("is written when a cell with Whybook's metadata goes in", () => {
    const model = notebook(0);
    insertCodeCell(model, 0, 'y = 1', { template: true });
    expect(notebookMeta(model)).toEqual({ format: 0 });
  });

  it("is not written by a read, so a notebook without Whybook's metadata stays unchanged", () => {
    const model = notebook();
    model.dirty = false;
    notebookMeta(model);
    cellMeta(model.cells.get(0));
    expect(model.getMetadata('whybook')).toBeUndefined();
    expect(model.dirty).toBe(false);
  });

  it('is not written by a write that changes nothing, so a notebook saved before the number opens unchanged', () => {
    const model = notebook();
    model.setMetadata('whybook', { outcome: 'pain' });
    setCellMeta(model.cells.get(0), { template: true });
    model.setMetadata('whybook', { outcome: 'pain' });
    model.dirty = false;
    // What the view writes again when the notebook opens.
    setNotebookMeta(model, { outcome: 'pain' });
    setCellMeta(model.cells.get(0), { template: true });
    expect(model.getMetadata('whybook')).toEqual({ outcome: 'pain' });
    expect(model.dirty).toBe(false);
  });

  it('keeps a higher number, which a later release wrote', () => {
    const model = notebook();
    model.setMetadata('whybook', { format: 2, outcome: 'pain' });
    setCellMeta(model.cells.get(0), { template: true });
    setNotebookMeta(model, { unit: 'patient' });
    expect(notebookMeta(model)).toEqual({
      format: 2,
      outcome: 'pain',
      unit: 'patient'
    });
  });
});
