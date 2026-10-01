/**
 * Code of the view that the analyst changed by hand (design iteration 1.83).
 * The view keeps a key of the code that it writes in a cell, from a
 * template, a model or an agent's run (`view_code_key`), and once the
 * analyst changes that code in the view, the code as the view wrote it
 * (`view_code`). So the view tells which cells the analyst edited since:
 * the strip of an agent's run says that its answer may no longer hold, the
 * values of the analyst's own code are theirs, and the names of an edited
 * cell are no longer the run's own (./runnames.ts).
 */
import type { IDecision, IEpiCellMeta } from '../tokens';
import { fingerprint } from './tables';

/** The key of a cell's code: the same code, with or without blank lines around it, has the same key. */
export function codeKey(source: string): string {
  return fingerprint(source.trim());
}

/** Whether the view wrote the cell's code and the code changed since. */
export function editedByHand(meta: IEpiCellMeta, source: string): boolean {
  return (
    meta.written_by === 'agent' &&
    !!meta.view_code_key &&
    codeKey(source) !== meta.view_code_key
  );
}

/**
 * The code to keep as the view wrote it when a change of the cell's code
 * comes: the code before the change, when the view wrote it and the change
 * is the first that leaves it; else null. The view sets the key of its own
 * code before it writes the code, so its own writes keep nothing.
 */
export function viewCodeToKeep(
  meta: IEpiCellMeta,
  before: string,
  after: string
): string | null {
  if (
    meta.written_by !== 'agent' ||
    !meta.view_code_key ||
    meta.view_code !== undefined
  ) {
    return null;
  }
  return codeKey(before) === meta.view_code_key &&
    codeKey(after) !== meta.view_code_key
    ? before
    : null;
}

/** Code without spaces, with one kind of quote: `drop = "x"` reads `drop='x'`. */
function plain(code: string): string {
  return code
    .replace(/[^\S\n]+/g, '')
    .replace(/\n+/g, '\n')
    .replace(/"/g, "'");
}

/**
 * Whether code holds this value for the decision's name: `drop=True` for
 * drop = True, `x = 5` for an assignment.
 */
export function holdsValue(code: string, decision: IDecision): boolean {
  const text = plain(code);
  const value = plain(decision.value);
  const names = [decision.param, decision.name].filter(
    (name): name is string => !!name
  );
  for (const name of new Set(names)) {
    const pattern = new RegExp(
      `(?<![\\w.])${name.replace(/[^\w]/g, '\\$&')}=(?!=)`,
      'g'
    );
    for (const match of text.matchAll(pattern)) {
      const rest = text.slice(match.index + match[0].length);
      if (
        rest.startsWith(value) &&
        /^($|[,)\]};#\n])/.test(rest.slice(value.length))
      ) {
        return true;
      }
    }
  }
  return false;
}
