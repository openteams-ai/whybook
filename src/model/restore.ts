import type {
  ICellAnalysis,
  IStoredColumn,
  IStoredVariable,
  IVariable
} from '../tokens';
import { prepareVariable } from './kernel';
import { fingerprint } from './tables';

/**
 * What the notebook keeps of the kernel, so that the view opens as it was
 * left: the variables in the notebook metadata, the analysis of each cell in
 * the cell's metadata. Without a kernel, or after a restart, the view shows
 * the kept variables as from the last run, until their cells run again. The
 * notebook keeps no text of a secret, and forgets a variable whose cell is
 * gone.
 */

/** At most this many columns of a frame are kept: `olink` has 4,813. */
export const KEPT_COLUMNS = 100;
const KEPT_TERMS = 40;
const KEPT_VALUE = 200;

export type { IStoredColumn, IStoredVariable };

/** The analysis of a cell, with a hash of the source it was made from. */
export interface IStoredAnalysis extends ICellAnalysis {
  source: string;
}

/**
 * The rule that hides a secret, as the server (privacy.py, which says it in
 * full), the kernel's listing and its analysis of cells apply it; the cases
 * of whybook/server/tests/data/secret_names.json hold for all four. Only a
 * string is a secret. A part of its name that is one of SECRET_WORDS, that
 * ends with one of SECRET_ENDINGS, or two parts of SECRET_PAIRS make one;
 * max_tokens, n_tokens and author do not.
 */
const SECRET_WORDS = new Set([
  'apikey',
  'auth',
  'bearer',
  'credential',
  'credentials',
  'passwd',
  'password',
  'passwords',
  'pwd',
  'secret',
  'secrets',
  'token'
]);
const SECRET_ENDINGS = ['token', 'secret', 'password', 'passwd', 'apikey'];
const SECRET_PAIRS = new Set([
  'api key',
  'access key',
  'private key',
  'secret key'
]);
/** A known prefix of a key, followed by 16 or more characters. */
const SECRET_PREFIX =
  /(?<![A-Za-z0-9])(?:sk-|sk_live_|sk_test_|hf_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abpr]-|xapp-|AKIA|ASIA|AIza|ya29\.|eyJ|npm_|pypi-)[A-Za-z0-9_.=-]{16,}/;
/** scheme://user:password@host, the user possibly empty: redis://:pw@localhost. */
const URL_PASSWORD = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#@:]*:[^\s/?#@]+@/;
/** The name of each query parameter that has a value: api_key of ?api_key=abc. */
const QUERY_NAME = /[?&]([A-Za-z0-9_.-]+)=[^&#\s]/g;

/**
 * A name's parts, split on every character that is not a letter and at each
 * capital that starts a word: dbPassword is db and password.
 */
function nameParts(name: string): string[] {
  return (name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? []).map(part =>
    part.toLowerCase()
  );
}

/** Whether a name says secret: HF_TOKEN, dbPassword, api_key; not max_tokens or author. */
function secretName(name: string): boolean {
  const parts = nameParts(name);
  return parts.some(
    (part, index) =>
      SECRET_WORDS.has(part) ||
      SECRET_ENDINGS.some(ending => part.endsWith(ending)) ||
      SECRET_PAIRS.has(`${part} ${parts[index + 1]}`)
  );
}

/**
 * Whether a text holds a known prefix of a key, a password in a URL, a query
 * parameter whose name says secret, a run of 20 or more letters and digits
 * with upper case, lower case and digits, or any run of 32 or more: a hex
 * hash does, an upper-case sample id does not.
 */
function secretText(text: string): boolean {
  return (
    SECRET_PREFIX.test(text) ||
    URL_PASSWORD.test(text) ||
    Array.from(text.matchAll(QUERY_NAME)).some(match => secretName(match[1])) ||
    (text.match(/[A-Za-z0-9]{20,}/g) ?? []).some(
      run =>
        run.length >= 32 ||
        (/[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run))
    )
  );
}

/**
 * Whether a variable holds a key, a token or a password, from its name and
 * its value as the kernel lists it: Python's repr of a string. HF_TOKEN =
 * 'hf_...' and githubtoken = 'abc' do; max_tokens = 512, author = 'Smith'
 * and a name without its value do not.
 */
export function looksSecret(name: string, value?: string): boolean {
  const quoted = /^(['"])([\s\S]*)\1$/.exec(value ?? '');
  if (!quoted) {
    return false;
  }
  return secretName(name) || secretText(quoted[2]);
}

/**
 * A variable without the text of a secret: one that the kernel lists as a
 * secret, or a string that looks like one by its name or its text
 * (looksSecret), as a notebook saved before 29 September 2026 may keep. Its
 * length stays where it is known.
 */
export function withoutSecret<
  T extends Pick<IVariable, 'kind' | 'name' | 'value' | 'secret' | 'length'>
>(variable: T): T {
  const kept =
    variable.kind === 'constant' && looksSecret(variable.name, variable.value);
  if (!variable.secret && !kept) {
    return variable;
  }
  if (variable.secret && variable.value === undefined) {
    return variable;
  }
  const { value, ...rest } = variable;
  // The repr of a string without escapes: its length is the text's.
  const quoted = /^(['"])([^'"\\]*)\1$/.exec(value ?? '');
  const length = variable.length ?? quoted?.[2].length;
  return {
    ...rest,
    secret: true,
    ...(length !== undefined ? { length } : {})
  } as T;
}

export function storedVariable(
  shown: IVariable,
  cell: string | null
): IStoredVariable {
  const variable = withoutSecret(shown);
  // The kernel's change marks, and what prepareVariable adds on reading.
  const { fingerprint: _f, unchanged: _u, stale: _s, ...rest } = variable;
  const stored: IStoredVariable = { ...rest, cell };
  if (variable.columns) {
    stored.columns = variable.columns
      .slice(0, KEPT_COLUMNS)
      .map(
        ({ name: _n, parent: _p, rows: _r, library: _l, ...column }) => column
      );
  }
  if (variable.groups) {
    const kept = new Set((stored.columns ?? []).map(column => column.label));
    stored.groups = variable.groups.map(group => ({
      label: group.label,
      columns: group.columns.filter(label => kept.has(label)),
      total: group.total ?? group.columns.length
    }));
  }
  if (
    typeof variable.value === 'string' &&
    variable.value.length > KEPT_VALUE
  ) {
    stored.value = `${variable.value.slice(0, KEPT_VALUE)}…`;
  }
  if (variable.terms && variable.terms.length > KEPT_TERMS) {
    stored.terms = variable.terms.slice(0, KEPT_TERMS);
  }
  return stored;
}

/**
 * The variables to show: the kernel's, and the kept ones that the kernel
 * lacks and whose cell has not run in this kernel yet, marked stale. With
 * no kernel listing, every kept variable is stale. A kept variable whose
 * cell is gone from the notebook is forgotten, and a kept secret shows
 * without its text. The kept order holds.
 */
export function listing(
  kernel: IVariable[] | null,
  stored: IStoredVariable[],
  ranHere: (cellId: string) => boolean,
  hasCell: (cellId: string) => boolean = () => true
): IVariable[] {
  const stale = (variable: IStoredVariable): IVariable => ({
    ...prepareVariable(withoutSecret(variable)),
    stale: true
  });
  const live = new Map(
    (kernel ?? []).map(variable => [variable.name, variable])
  );
  const result: IVariable[] = [];
  for (const variable of stored) {
    const current = live.get(variable.name);
    if (current) {
      result.push(current);
      live.delete(variable.name);
    } else if (variable.cell && !hasCell(variable.cell)) {
      continue;
    } else if (!kernel || !(variable.cell && ranHere(variable.cell))) {
      result.push(stale(variable));
    }
  }
  return [...result, ...live.values()];
}

/**
 * What to keep after a listing from the kernel: what the view shows, with
 * the cell that defines each name, or else the cell kept for it, so that
 * the variable is forgotten once that cell goes. Null when the kept list
 * stays as it is.
 */
export function toStore(
  shown: IVariable[],
  stored: IStoredVariable[],
  cellOf: (name: string) => string | null
): IStoredVariable[] | null {
  const kept = new Map(stored.map(variable => [variable.name, variable]));
  const next = shown.map(variable =>
    variable.stale && kept.has(variable.name)
      ? withoutSecret(kept.get(variable.name)!)
      : storedVariable(
          variable,
          cellOf(variable.name) ?? kept.get(variable.name)?.cell ?? null
        )
  );
  return JSON.stringify(next) === JSON.stringify(stored) ? null : next;
}

/**
 * What to keep while the kernel lists nothing: the kept list, without the
 * text of a secret and without the variables whose cell is gone. Null when
 * the kept list stays as it is.
 */
export function keptWithout(
  stored: IStoredVariable[],
  hasCell: (cellId: string) => boolean
): IStoredVariable[] | null {
  const next = stored
    .filter(variable => !variable.cell || hasCell(variable.cell))
    .map(variable => withoutSecret(variable));
  return JSON.stringify(next) === JSON.stringify(stored) ? null : next;
}

export function storedAnalysis(
  analysis: ICellAnalysis,
  source: string
): IStoredAnalysis {
  return { ...analysis, source: fingerprint(source) };
}

/** The kept analysis, when it was made from this source. */
export function analysisFor(
  stored: IStoredAnalysis | undefined,
  source: string
): ICellAnalysis | null {
  if (!stored || stored.source !== fingerprint(source)) {
    return null;
  }
  const { source: _s, ...analysis } = stored;
  return analysis;
}
