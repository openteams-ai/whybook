/**
 * Undo of "Delete cell", and Move up and Move down of the cell menu
 * (src/contextmenu.ts), which call deleteCell, restoreCell, canMove and
 * moveCell of the view model. The bench draws each branch under its parent;
 * Run all runs the code cells in the notebook's order.
 */
import type { ISharedCodeCell } from '@jupyter/ydoc';

import { fakeModel, ids } from './fakes/model-fake';

describe('Undo of a deleted cell', () => {
  it('puts back the id, the outputs, the metadata and the count', () => {
    const { nb, model } = fakeModel([
      { id: 'a' },
      { id: 'b', count: 3, meta: { title: 'Load' } },
      { id: 'c' }
    ]);
    (nb.sharedModel.getCell(1) as ISharedCodeCell).setOutputs([
      { output_type: 'stream', name: 'stdout', text: 'hi\n' }
    ]);
    const before = nb.cells.get(1).toJSON();
    model.restoreCell(model.deleteCell('b'));
    expect(ids(nb)).toEqual(['a', 'b', 'c']);
    expect(nb.cells.get(1).toJSON()).toEqual(before);
  });

  it('puts the cell back between its neighbours after a cell above it was deleted', () => {
    const { nb, model } = fakeModel([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
      { id: 'd' }
    ]);
    // The notice of c, with its Undo, is still up when a goes too.
    const savedC = model.deleteCell('c');
    model.deleteCell('a');
    model.restoreCell(savedC);
    expect(ids(nb)).toEqual(['b', 'c', 'd']);
  });

  it('puts the cell back after the cell it followed, after a move', () => {
    const { nb, model } = fakeModel([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
      { id: 'd' }
    ]);
    const savedB = model.deleteCell('b');
    model.moveCellTo('d', 0);
    model.restoreCell(savedB);
    expect(ids(nb)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('puts the first cell back before the cell that followed it', () => {
    const { nb, model } = fakeModel([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const savedA = model.deleteCell('a');
    model.moveCellTo('c', 0);
    model.restoreCell(savedA);
    expect(ids(nb)).toEqual(['c', 'a', 'b']);
  });

  it('does not add a second cell with the same id when the cell is back already', () => {
    const { nb, model } = fakeModel([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const saved = model.deleteCell('b');
    // The notebook view of the same file shares the model: its Undo put the
    // cell back first.
    nb.sharedModel.insertCell(1, saved.cell);
    model.restoreCell(saved);
    expect(ids(nb)).toEqual(['a', 'b', 'c']);
  });
});

describe('moving a cell that has branches', () => {
  const cells = () => [
    { id: 'a', source: 'weekly = df.resample("W").mean()' },
    {
      id: 'a2',
      source: 'weekly = df.resample("7D").mean()',
      meta: { branch: { of: 'a', letter: 'b' } }
    },
    {
      id: 'a3',
      source: 'weekly = df.resample("14D").mean()',
      meta: { branch: { of: 'a', letter: 'c' } }
    },
    { id: 'c', source: 'weekly.plot()' },
    { id: 'd', source: 'weekly.describe()' }
  ];

  it('moves the parent down together with its branches', () => {
    const { nb, model } = fakeModel(cells());
    expect(model.canMove('a', 1)).toBe(true);
    model.moveCell('a', 1);
    expect(ids(nb)).toEqual(['c', 'a', 'a2', 'a3', 'd']);
    model.moveCell('a', -1);
    expect(ids(nb)).toEqual(['a', 'a2', 'a3', 'c', 'd']);
    expect(model.canMove('a', -1)).toBe(false);
  });

  it('moves a cell past a parent and its branches in one step', () => {
    const { nb, model } = fakeModel(cells());
    model.moveCell('c', -1);
    expect(ids(nb)).toEqual(['c', 'a', 'a2', 'a3', 'd']);
    model.moveCell('c', 1);
    expect(ids(nb)).toEqual(['a', 'a2', 'a3', 'c', 'd']);
  });

  it('moves a branch among the branches of its parent, and not above it', () => {
    const { nb, model } = fakeModel(cells());
    expect(model.canMove('a2', -1)).toBe(false);
    model.moveCell('a2', -1);
    expect(ids(nb)).toEqual(['a', 'a2', 'a3', 'c', 'd']);
    expect(model.canMove('a2', 1)).toBe(true);
    model.moveCell('a2', 1);
    expect(ids(nb)).toEqual(['a', 'a3', 'a2', 'c', 'd']);
    expect(model.canMove('a2', 1)).toBe(false);
  });

  it('runs the parent before its branches in Run all after Move down', async () => {
    const { model } = fakeModel(cells());
    model.moveCell('a', 1);
    model.context.sessionContext = { session: { kernel: {} } };
    const ran: string[] = [];
    model.runCell = async (id: string) => {
      ran.push(id);
    };
    await model.runAll();
    expect(ran).toEqual(['c', 'a', 'a2', 'a3', 'd']);
  });
});
