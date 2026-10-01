/**
 * The names that an agent's run made for itself (design iteration 1.83).
 * An agent's run works in the notebook's kernel, and leaves there the names
 * of its working steps: desc, q1, q3, iqr, fig, ax, grp. The prompt asks it
 * to start such names with `_`, which the listing of the kernel leaves out,
 * and the testers' runs did not, in 4 runs out of 4. So the view sorts the
 * names itself, from what it knows of each cell: the run that wrote it, and
 * the names that it defines and reads.
 *
 * A name belongs to a run when only cells of that run define it, and no
 * later cell outside the run reads it. The Variables panel lists it under
 * the run, folded, and the map leaves it out of its data. A name that a
 * later cell reads, the analyst's or another run's, is part of the
 * analysis: it stays in the main list. A cell of a run that the analyst
 * edited by hand counts as the analyst's.
 */

/** What the rule reads of a code cell, in the order of the notebook. */
export interface IRunCell {
  id: string;
  /** The agent's run that wrote it; null for the analyst's or a template's cell. */
  run: string | null;
  /** The names it defines. */
  defs: readonly string[];
  /** The names it reads. */
  uses: readonly string[];
}

/** The names of one run, in the order that the variables list them. */
export interface IRunNames {
  run: string;
  names: string[];
}

/** The names of one run, with the run's question, as the Variables panel lists them. */
export interface IRunGroup extends IRunNames {
  question: string;
}

/**
 * The names among `names` that belong to a run, by run, in the order of
 * each run's first cell in the notebook.
 */
export function runNames(
  cells: readonly IRunCell[],
  names: readonly string[]
): IRunNames[] {
  const byRun = new Map<string, string[]>();
  // Each run's first cell, for the order of the groups.
  const firstOf = new Map<string, number>();
  cells.forEach((cell, index) => {
    if (cell.run && !firstOf.has(cell.run)) {
      firstOf.set(cell.run, index);
    }
  });
  for (const name of names) {
    let owner: string | null = null;
    let first = -1;
    let analysts = false;
    cells.forEach((cell, index) => {
      if (!cell.defs.includes(name)) {
        return;
      }
      if (!cell.run) {
        analysts = true;
        return;
      }
      // The run that defines it last holds the value that the kernel has.
      if (cell.run !== owner) {
        owner = cell.run;
        first = index;
      }
    });
    if (analysts || owner === null) {
      continue;
    }
    const run: string = owner;
    const readLater = cells.some(
      (cell, index) =>
        index > first && cell.run !== run && cell.uses.includes(name)
    );
    if (readLater) {
      continue;
    }
    const list = byRun.get(run) ?? [];
    list.push(name);
    byRun.set(run, list);
  }
  return [...byRun]
    .sort((a, b) => (firstOf.get(a[0]) ?? 0) - (firstOf.get(b[0]) ?? 0))
    .map(([run, list]) => ({ run, names: list }));
}
