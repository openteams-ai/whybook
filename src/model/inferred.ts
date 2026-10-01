/**
 * The outcomes and the units of an analysis, inferred (design iteration
 * 1.64): the column that an analysis explains, such as pain_score, and the
 * column whose values name what its rows repeat over, such as patient_id.
 * Some templates need both. The demos set one of each by hand in the
 * notebook's metadata (`whybook.outcome`, `whybook.unit`); any other
 * notebook gets them from three places, in this order:
 *
 * - the analyst, who picked one from the chip of a question that uses it;
 * - the rules, which read the code: the left side of a model's formula, the
 *   groups of a mixed model, and an id column whose values repeat in a frame;
 * - the model that writes questions, which names them in the same call from
 *   the formulas and the columns of the frames.
 *
 * The notebook keeps what the analyst picked and what a model named, in
 * `whybook.inferred`. The rules' candidates come from the code and the
 * kernel's listing each time, and are not kept. A value set by hand wins,
 * and then nothing is inferred.
 */
import type {
  IEpiNotebookMeta,
  IInferredColumn,
  IInferredMeta,
  IVariable,
  IWrittenBy
} from '../tokens';

export type InferredKind = 'outcome' | 'unit';

/** An outcome or a unit, with who set it and where it comes from. */
export interface IInferred extends IInferredColumn {
  /** For the rules: the id of the cell whose code names it. */
  cell?: string | null;
}

/** A code cell as the rules read it: its code and the formulas that the kernel found in it. */
export interface IRuleCell {
  id: string;
  source: string;
  formulas: string[];
}

/** The outcomes and the units that the view knows, best first, and those set by hand. */
export interface IInferredLists {
  outcomes: IInferred[];
  units: IInferred[];
  /** The notebook's own, set by hand in its metadata, as in the demos. */
  hand: { outcome: string | null; unit: string | null };
}

/**
 * The column on the left side of a model's formula: "pain_score" for
 * "pain_score ~ arm * week", for "np.log(pain_score) ~ arm", and "sleep
 * hours" for 'Q("sleep hours") ~ age'. Null for a text that only holds a
 * tilde, such as a path in the home folder.
 */
export function formulaOutcome(formula: string): string | null {
  const at = formula.indexOf('~');
  if (at < 0) {
    return null;
  }
  const left = formula.slice(0, at).trim();
  const quoted = /^Q\(\s*(["'])(.+)\1\s*\)$/.exec(left);
  if (quoted) {
    return quoted[2];
  }
  const call = /^[\w.]+\(\s*([A-Za-z_]\w*)\s*\)$/.exec(left);
  if (call) {
    return call[1];
  }
  return /^[A-Za-z_]\w*$/.test(left) ? left : null;
}

/**
 * The targets of the fits that a cell's code makes: "price" for
 * `model.fit(X, homes["price"])` and for `model.fit(homes[cols], homes.price)`.
 * A target held in a name of its own, `y = homes["price"]`, is not read.
 */
export function fitTargets(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(
    /\.fit\(\s*[^,()]+(?:\([^()]*\))?\s*,\s*[A-Za-z_]\w*(?:\[\s*(["'])([^"'\]]+)\1\s*\]|\.([A-Za-z_]\w*))\s*[,)]/g
  )) {
    found.push(match[2] ?? match[3]);
  }
  return found;
}

/** The groups of a mixed model that a cell's code names: `groups="home_id"`, or `groups=df["home_id"]`. */
export function groupsOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(
    /\bgroups\s*=\s*(?:[A-Za-z_]\w*\[\s*)?(["'])([A-Za-z_]\w*)\1/g
  )) {
    found.push(match[2]);
  }
  return found;
}

/** The frames of the listing, from the kernel or kept from the last run. */
function framesOf(variables: IVariable[]): IVariable[] {
  return variables.filter(
    variable => variable.kind === 'dataframe' && !!variable.columns?.length
  );
}

/** The frame that holds a column, or null. */
function frameWith(frames: IVariable[], column: string): string | null {
  return (
    frames.find(frame => frame.columns!.some(item => item.label === column))
      ?.name ?? null
  );
}

function add(list: IInferred[], entry: IInferred): void {
  if (!list.some(item => item.column === entry.column)) {
    list.push(entry);
  }
}

/**
 * The outcomes that the code names: the left side of each model's formula,
 * and the target of each fit, in the order of the cells. With frames listed,
 * only a column of a frame counts.
 */
export function rulesOutcomes(
  cells: IRuleCell[],
  variables: IVariable[]
): IInferred[] {
  const frames = framesOf(variables);
  const found: IInferred[] = [];
  for (const cell of cells) {
    const columns = [
      ...cell.formulas.map(formulaOutcome),
      ...fitTargets(cell.source)
    ];
    for (const column of columns) {
      const frame = column ? frameWith(frames, column) : null;
      if (column && (frame || !frames.length)) {
        add(found, { column, frame, by: 'rules', cell: cell.id });
      }
    }
  }
  return found;
}

/**
 * The units that the code and the data name: the groups of a mixed model,
 * in the order of the cells, then each id column whose values repeat in a
 * frame, as home_id repeats in daily readings. An id column that also names
 * one row of another frame, a table of the units, comes first among those,
 * then the one that repeats most.
 */
export function rulesUnits(
  cells: IRuleCell[],
  variables: IVariable[]
): IInferred[] {
  const frames = framesOf(variables);
  const found: IInferred[] = [];
  for (const cell of cells) {
    for (const column of groupsOf(cell.source)) {
      const frame = frameWith(frames, column);
      if (frame || !frames.length) {
        add(found, { column, frame, by: 'rules', cell: cell.id });
      }
    }
  }
  const repeats: {
    column: string;
    frame: string;
    per: number;
    table: boolean;
  }[] = [];
  for (const frame of frames) {
    for (const column of frame.columns!) {
      if (
        column.tag !== 'id' ||
        !column.unique ||
        !frame.rows ||
        column.unique >= frame.rows
      ) {
        continue;
      }
      repeats.push({
        column: column.label,
        frame: frame.name,
        per: frame.rows / column.unique,
        table: frames.some(
          other =>
            other !== frame &&
            other.columns!.some(
              item => item.label === column.label && item.unique === other.rows
            )
        )
      });
    }
  }
  repeats.sort((a, b) => Number(b.table) - Number(a.table) || b.per - a.per);
  for (const repeat of repeats) {
    add(found, { column: repeat.column, frame: repeat.frame, by: 'rules' });
  }
  return found;
}

/** Those of one kind that the notebook keeps, by who set them. */
function kept(
  meta: IInferredMeta | undefined,
  kind: InferredKind,
  by: IInferred['by']
): IInferred[] {
  const list = kind === 'outcome' ? meta?.outcomes : meta?.units;
  return (list ?? []).filter(entry => entry.by === by);
}

/**
 * Every outcome and unit that the view knows, best first: the analyst's
 * pick, the rules', then the model's, each column once. A value set by hand
 * in the metadata stands alone.
 */
export function inferredLists(
  meta: IEpiNotebookMeta,
  cells: IRuleCell[],
  variables: IVariable[]
): IInferredLists {
  const merge = (kind: InferredKind, rules: IInferred[]) => {
    const list: IInferred[] = [];
    for (const entry of [
      ...kept(meta.inferred, kind, 'analyst'),
      ...rules,
      ...kept(meta.inferred, kind, 'model')
    ]) {
      add(list, entry);
    }
    return list;
  };
  return {
    outcomes: meta.outcome
      ? []
      : merge('outcome', rulesOutcomes(cells, variables)),
    units: meta.unit ? [] : merge('unit', rulesUnits(cells, variables)),
    hand: { outcome: meta.outcome ?? null, unit: meta.unit ?? null }
  };
}

/**
 * The outcome and the unit that the server's templates use, and every one
 * that the view knows: the server takes, for a frame, the first outcome
 * that the frame holds (`Context.outcome_in`).
 */
export function contextOf(lists: IInferredLists): {
  outcome?: string;
  unit?: string;
  outcomes: string[];
  units: string[];
} {
  const outcomes = lists.hand.outcome
    ? [lists.hand.outcome]
    : lists.outcomes.map(entry => entry.column);
  const units = lists.hand.unit
    ? [lists.hand.unit]
    : lists.units.map(entry => entry.column);
  return {
    ...(outcomes[0] ? { outcome: outcomes[0] } : {}),
    ...(units[0] ? { unit: units[0] } : {}),
    outcomes,
    units
  };
}

/**
 * What the notebook keeps once a model named outcomes and units: its lists
 * take the place of the model's earlier ones, and an empty list keeps them.
 * The analyst's pick stays.
 */
export function withModel(
  meta: IInferredMeta | undefined,
  named: {
    outcomes: { column: string; frame: string; why: string }[];
    units: { column: string; frame: string; why: string }[];
  },
  by: IWrittenBy
): IInferredMeta {
  const next = (kind: InferredKind, found: typeof named.outcomes) => {
    const list = kind === 'outcome' ? meta?.outcomes : meta?.units;
    if (!found.length) {
      return list ?? [];
    }
    return [
      ...(list ?? []).filter(entry => entry.by !== 'model'),
      ...found.map(item => ({
        column: item.column,
        frame: item.frame,
        by: 'model' as const,
        model: by,
        why: item.why || null
      }))
    ];
  };
  return {
    outcomes: next('outcome', named.outcomes),
    units: next('unit', named.units)
  };
}

/** What the notebook keeps once the analyst picked a column from a chip: it goes first, as theirs. */
export function withPick(
  meta: IInferredMeta | undefined,
  kind: InferredKind,
  pick: { column: string; frame?: string | null }
): IInferredMeta {
  const list = kind === 'outcome' ? meta?.outcomes : meta?.units;
  const next: IInferredColumn[] = [
    { column: pick.column, frame: pick.frame ?? null, by: 'analyst' },
    ...(list ?? []).filter(entry => entry.by !== 'analyst')
  ];
  return kind === 'outcome'
    ? { ...meta, outcomes: next }
    : { ...meta, units: next };
}

/**
 * The words of a chip: "outcome pain_score · inferred from [5]", "unit
 * home_id · inferred from meter_readings", "outcome kwh_import · inferred
 * by AI" or "outcome kwh_import · chosen by you". `label` gives a cell's
 * label now.
 */
export function chipText(
  kind: InferredKind,
  entry: IInferred,
  label: (cellId: string) => string | null
): string {
  const head = `${kind} ${entry.column}`;
  switch (entry.by) {
    case 'analyst':
      return `${head} · chosen by you`;
    case 'model':
      return `${head} · inferred by AI`;
    case 'rules': {
      const cell = entry.cell ? label(entry.cell) : null;
      if (cell) {
        return `${head} · inferred from ${cell}`;
      }
      return entry.frame
        ? `${head} · inferred from ${entry.frame}`
        : `${head} · inferred from the code`;
    }
  }
}

/** Why a candidate is one: the model's reason, or what the rules read. */
export function chipTitle(
  kind: InferredKind,
  entry: IInferred,
  label: (cellId: string) => string | null
): string {
  switch (entry.by) {
    case 'analyst':
      return `You chose ${entry.column} as the ${kind} of this analysis.`;
    case 'model':
      return `An AI model named ${entry.column} as a likely ${kind}${entry.why ? `: ${entry.why}` : '.'}`;
    case 'rules': {
      const cell = entry.cell ? label(entry.cell) : null;
      if (kind === 'outcome') {
        return cell
          ? `The code of ${cell} models it: the left side of a formula, or the target of a fit.`
          : `The left side of a formula, or the target of a fit, in the code.`;
      }
      return cell
        ? `The groups of the mixed model in ${cell}.`
        : `Its values repeat in the rows of ${entry.frame ?? 'a frame'}: each is measured more than once.`;
    }
  }
}
