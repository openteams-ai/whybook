/**
 * Where a new cell goes in the notebook (design iteration 1.74): one rule
 * for the cell of an answer, a template's or a model's, and for each cell of
 * an agent's run. The notebook then runs from the top in the order in which
 * its cells ran:
 *
 * - The new cell goes below the cell that the question is about, and below
 *   the last cell that ran in the kernel now running: it runs after them.
 * - It goes below the first cell that defines a name its code reads, when
 *   no cell above that place defines the name.
 * - It never goes between two cells of one agent's run: it goes after the
 *   run's last cell.
 * - A run's next cell goes right after the run's last cell, so that the
 *   cells of one run stay together, in the order in which they ran.
 *
 * A branch goes beside its cell and an edit changes its cell: this module
 * places neither.
 */
import { namesIn } from './names';

/** What the rule reads of a cell of the notebook. */
export interface IPlacedCell {
  id: string;
  /** The cell that it is a branch of: a new cell goes after a cell's branches. */
  branchOf: string | null;
  /** The agent's run that wrote it, if any. */
  run: string | null;
  /** Whether it ran in the kernel now running, or runs now. */
  ran: boolean;
  /** The names it defines, as the kernel's analysis read them. */
  defs: readonly string[];
}

/** The new cell. */
export interface INewCell {
  /**
   * The cell that the question is about; for a run's next cell, the run's
   * last cell. Null for none.
   */
  below: string | null;
  /** Its code, when it is known: a template's, or a cell of an agent's run. */
  code?: string | null;
  /**
   * The agent's run that it belongs to, and whether the run has cells in
   * the notebook already: a later cell of a run goes after the run's last
   * cell, and not after the last cell that ran.
   */
  run?: { id: string | null; later: boolean } | null;
}

/**
 * The id of the cell after which the new cell goes, after that cell's
 * branches; null when nothing places it, for the end of the notebook.
 */
export function placeAfter(
  cells: readonly IPlacedCell[],
  cell: INewCell
): string | null {
  const known = new Set(cells.map(each => each.id));
  // A branch sits beside its cell: a place is a cell that is no branch.
  const parentOf = (each: IPlacedCell): string =>
    each.branchOf && known.has(each.branchOf) ? each.branchOf : each.id;
  const top = cells.filter(each => parentOf(each) === each.id);
  const index = new Map(top.map((each, at) => [each.id, at]));
  const at = (each: IPlacedCell): number => index.get(parentOf(each)) ?? -1;
  const below = cell.below
    ? cells.find(each => each.id === cell.below)
    : undefined;
  let floor = below ? at(below) : -1;
  if (!cell.run?.later) {
    for (const each of cells) {
      if (each.ran) {
        floor = Math.max(floor, at(each));
      }
    }
  }
  if (cell.code) {
    const own = ownNames(cell.code);
    const code = withoutComments(cell.code);
    const first = new Map<string, number>();
    for (const each of cells) {
      for (const name of each.defs) {
        const place = at(each);
        if (!first.has(name) || place < first.get(name)!) {
          first.set(name, place);
        }
      }
    }
    for (const [name, place] of first) {
      if (place > floor && !own.has(name) && namesIn(code, name)) {
        floor = place;
      }
    }
  }
  // Past the end of every other run that the place would split.
  const ownRun = cell.run?.id ?? null;
  for (let moved = true; moved;) {
    moved = false;
    const spans = new Map<string, [number, number]>();
    top.forEach((each, place) => {
      if (each.run && each.run !== ownRun) {
        const span = spans.get(each.run);
        spans.set(
          each.run,
          span
            ? [Math.min(span[0], place), Math.max(span[1], place)]
            : [place, place]
        );
      }
    });
    for (const [start, end] of spans.values()) {
      if (start <= floor && end > floor) {
        floor = end;
        moved = true;
      }
    }
  }
  return floor >= 0 ? top[floor].id : null;
}

/**
 * The names that code brings in itself, which it does not read from the
 * cells above: its imports, and the functions and classes it defines.
 */
export function ownNames(code: string): Set<string> {
  const names = new Set<string>();
  for (const line of withoutComments(code).split('\n')) {
    const imported = /^\s*import\s+(.+)$/.exec(line);
    for (const part of imported ? imported[1].split(',') : []) {
      const match = /^\s*([\w.]+)(?:\s+as\s+(\w+))?/.exec(part);
      if (match) {
        names.add(match[2] ?? match[1].split('.')[0]);
      }
    }
    const from = /^\s*from\s+\S+\s+import\s+\(?([^)#]*)/.exec(line);
    for (const part of from ? from[1].split(',') : []) {
      const match = /^\s*(\w+)(?:\s+as\s+(\w+))?/.exec(part);
      if (match) {
        names.add(match[2] ?? match[1]);
      }
    }
    const defined = /^\s*(?:async\s+)?(?:def|class)\s+(\w+)/.exec(line);
    if (defined) {
      names.add(defined[1]);
    }
  }
  return names;
}

/** The code without its comments: a name in a comment is not read. */
function withoutComments(code: string): string {
  return code
    .split('\n')
    .map(line => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (quote) {
          if (char === '\\') {
            i++;
          } else if (char === quote) {
            quote = null;
          }
        } else if (char === '"' || char === "'") {
          quote = char;
        } else if (char === '#') {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}
