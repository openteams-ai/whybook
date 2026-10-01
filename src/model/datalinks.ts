/**
 * The links between the cells of a notebook through the names they make and
 * read, as Cell details shows them, and the rule that tells an import from a
 * name that a cell makes.
 */
import type { EpiModel, IEpiCell } from './epimodel';
import { escapeRegExp } from './values';

/**
 * Whether the code imports a name rather than makes it: the first of its
 * lines that names it starts with import or from, as in "import pandas as
 * pd" or "from prep import drop_sparse".
 */
export function importsName(source: string, name: string): boolean {
  const word = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  return /^\s*(from|import)\s/.test(
    source.split('\n').find(line => word.test(line)) ?? ''
  );
}

/** Names and the cells they link a cell to. */
export interface IDataLink {
  names: string[];
  /**
   * For a use, the cell before that makes the names, or none when no cell
   * does. For a definition, the later cells that read them.
   */
  cells: IEpiCell[];
  /** Whether that cell imports the names, as in "import pandas as pd". */
  imported: boolean;
}

/**
 * What links a cell to the others through its names. Uses: the names it
 * reads, grouped by the last cell before it that makes or imports each, and
 * then the names that no cell makes. Defines: each name it makes, with the
 * later cells that read it, up to the cell that makes the name again; then
 * the names that no later cell reads, as one group, and its imports as one
 * group, since pd or whybook would link it to nearly every cell.
 */
export function dataLinks(
  model: Pick<EpiModel, 'codeCells'>,
  cell: IEpiCell
): { uses: IDataLink[]; defines: IDataLink[] } {
  const cells = model.codeCells();
  const at = cells.findIndex(item => item.id === cell.id);
  const earlier = cells.slice(0, Math.max(0, at));
  const later = cells.slice(at + 1);
  const imported = (item: IEpiCell, name: string) =>
    importsName(item.model.sharedModel.getSource(), name);
  const uses: IDataLink[] = [];
  const unmade: string[] = [];
  for (const name of cell.analysis?.uses ?? []) {
    const maker = earlier
      .filter(item => item.analysis?.defs.includes(name))
      .pop();
    if (!maker) {
      // A name the cell makes and then reads is its own.
      if (!cell.analysis?.defs.includes(name)) {
        unmade.push(name);
      }
      continue;
    }
    const kind = imported(maker, name);
    const group = uses.find(
      link => link.cells[0] === maker && link.imported === kind
    );
    if (group) {
      group.names.push(name);
    } else {
      uses.push({ names: [name], cells: [maker], imported: kind });
    }
  }
  uses.sort(
    (a, b) =>
      a.cells[0].index - b.cells[0].index ||
      Number(a.imported) - Number(b.imported)
  );
  if (unmade.length) {
    uses.push({ names: unmade, cells: [], imported: false });
  }
  const readers = (name: string) => {
    const found: IEpiCell[] = [];
    for (const item of later) {
      if (item.analysis?.uses.includes(name)) {
        found.push(item);
      }
      if (item.analysis?.defs.includes(name)) {
        break;
      }
    }
    return found;
  };
  const defs = cell.analysis?.defs ?? [];
  const imports = defs.filter(name => imported(cell, name));
  const made = defs
    .filter(name => !imports.includes(name))
    .map(name => ({ names: [name], cells: readers(name), imported: false }));
  const defines: IDataLink[] = made.filter(link => link.cells.length);
  const unread = made.filter(link => !link.cells.length);
  if (unread.length) {
    defines.push({
      names: unread.map(link => link.names[0]),
      cells: [],
      imported: false
    });
  }
  if (imports.length) {
    defines.push({
      names: imports,
      cells: later.filter(item =>
        imports.some(name => item.analysis?.uses.includes(name))
      ),
      imported: true
    });
  }
  return { uses, defines };
}
