import type { IEditorMimeTypeService } from '@jupyterlab/codeeditor';
import type * as nbformat from '@jupyterlab/nbformat';

import { python, r } from '../kernelCode';
import { RESULT_MIME } from '../tokens';

/**
 * The code the view sends to a kernel, by the kernel's language.
 *
 * The view lists the kernel's variables, analyses the cells and summarises
 * the rows behind a region of a plot with small programs that it runs in the
 * kernel (future/kernel_code). A language adapter holds these programs for
 * one language. The `language_info.name` of the kernel's info reply picks
 * the adapter. In a kernel of a language without an adapter, the view runs
 * cells and shows their outputs, and the features that need the programs
 * are off, each with a note where it would show.
 */

/**
 * A program of future/kernel_code, by the name of its file: inspect_variables,
 * analyze_cells, region_summary.
 */
export type Snippet = string;

/**
 * What the view does in a kernel beyond running cells and showing outputs:
 *
 * - variables: the Variables and Contents sections, from inspect_variables;
 * - analysis: decisions, and the names and columns each cell uses, from
 *   analyze_cells;
 * - plots: questions about the rows behind a region of a plot, from
 *   region_summary;
 * - questions: offered and typed questions, which ask about the variables
 *   that inspect_variables lists. The templates' code is Python: in a kernel
 *   of another language the server sends their questions without code, and a
 *   model writes the cells in the kernel's language.
 */
export type Feature = 'variables' | 'analysis' | 'plots' | 'questions';

export interface ILanguage {
  /** Its names in `language_info.name`, in lower case. */
  names: string[];
  /** Its name in the view's messages. */
  label: string;
  /** The code of each program it has, by the program's name. */
  snippets: Record<Snippet, string>;
  /**
   * Code that defines a program's function, calls it with JSON arguments and
   * removes it again, or null when the language lacks the program.
   */
  call(name: Snippet, args: unknown): string | null;
  /** Code that evaluates to a column of a frame: `df['age']` in Python. */
  column(frame: string, label: string): string;
  /**
   * Whether the view runs code in the kernel's subshells, when the kernel
   * lists them. A kernel written as a subclass of ipykernel's Kernel lists
   * them on ipykernel 7 whatever runs behind it: sas_kernel does, with one
   * SAS session for every subshell, where two cells at once would mix.
   */
  subshells: boolean;
  /**
   * The text of a line that holds a comment alone, or null for any other
   * line: `# Load the visits` gives "Load the visits" in Python. A cell
   * without a title takes it from its first line.
   */
  commentText(line: string): string | null;
}

/** A comment line of Python or R: `# Load the visits`. */
function hashComment(line: string): string | null {
  const match = /^\s*#+(.*)$/.exec(line);
  return match ? match[1].trim() : null;
}

/** Every Python file of future/kernel_code. */
export const PYTHON: ILanguage = {
  names: ['python'],
  label: 'Python',
  snippets: python,
  call(name, args) {
    const code = this.snippets[name];
    if (!code) {
      return null;
    }
    const fn = `_whybook_${name}`;
    const payload = JSON.stringify(JSON.stringify(args));
    return `${code}\ntry:\n    ${fn}(__import__("json").loads(${payload}))\nfinally:\n    del ${fn}\n`;
  },
  column: (frame, label) => `${frame}[${pythonString(label)}]`,
  subshells: true,
  commentText: hashComment
};

/**
 * R kernels, such as xeus-r and IRkernel: the variables, and the analysis of
 * cells with their chips since 1 October 2026 (design iteration 1.79), and
 * questions, whose code a model writes in R.
 */
export const R: ILanguage = {
  names: ['r'],
  label: 'R',
  snippets: r,
  call(name, args) {
    const code = this.snippets[name];
    if (!code) {
      return null;
    }
    const fn = `.whybook_${name}`;
    // An error in a silent request does not reach the view in xeus-r, so it
    // goes out as the result. The JSON escapes every character outside
    // printable ASCII, so that the code reads the same in any locale.
    const json = JSON.stringify(args).replace(
      /[^ -~]/g,
      char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
    );
    return [
      code,
      `tryCatch(${fn}(jsonlite::fromJSON(${JSON.stringify(json)}, simplifyVector = FALSE)),`,
      `  error = function(e) IRdisplay::publish_mimebundle(list("${RESULT_MIME}" = list(error = conditionMessage(e)))),`,
      `  finally = rm(list = "${fn}", envir = globalenv()))`,
      ''
    ].join('\n');
  },
  column: (frame, label) =>
    `${frame}[["${label.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]]`,
  // No R kernel lists subshells yet; one that does implements them itself.
  subshells: true,
  commentText: hashComment
};

// A comment line of SAS: a block comment, /* Load the visits */, the
// statement * Load the visits; or the macro comment %* Load the visits;.
// The first line of a block comment that goes on counts too, and a line
// with code after its comment does not.
function sasComment(line: string): string | null {
  const trimmed = line.trim();
  let text: string | null = null;
  if (trimmed.startsWith('/*')) {
    const end = trimmed.indexOf('*/', 2);
    if (end >= 0 && end + 2 < trimmed.length) {
      return null;
    }
    text = trimmed.slice(2, end >= 0 ? end : undefined);
  } else if (/^%?\*[^;]*;$/.test(trimmed)) {
    text = trimmed.slice(trimmed.indexOf('*') + 1, -1);
  }
  return text === null ? null : text.replace(/^\*+|\*+$/g, '').trim();
}

/**
 * A SAS name, or a name literal for any other label: `age`, `'patient id'n`.
 * A SAS name has at most 32 letters, digits and underscores.
 */
export function sasName(label: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(label)
    ? label
    : `'${label.replace(/'/g, "''")}'n`;
}

/**
 * SAS kernels, such as sas_kernel, which submits the code through saspy to a
 * SAS session of SAS 9.4 or SAS Viya (research/sas-kernel.md). The view has
 * no program in SAS yet: it runs cells, shows their outputs and reads a
 * cell's title from its comment, and sends the kernel no code of its own.
 */
export const SAS: ILanguage = {
  names: ['sas'],
  label: 'SAS',
  snippets: {},
  call: () => null,
  // PROC SQL names a column of a data set visits.age.
  column: (frame, label) => `${frame}.${sasName(label)}`,
  subshells: false,
  commentText: sasComment
};

/** The adapters, in the order of the messages that name them. */
export const LANGUAGES: ILanguage[] = [PYTHON, R, SAS];

/** The adapter for a kernel's `language_info.name`, or null without one. */
export function languageOf(name: string | null | undefined): ILanguage | null {
  const lower = (name ?? '').trim().toLowerCase();
  return LANGUAGES.find(language => language.names.includes(lower)) ?? null;
}

export function supports(
  language: ILanguage | null,
  feature: Feature
): boolean {
  if (!language) {
    return false;
  }
  switch (feature) {
    case 'variables':
      return !!language.snippets.inspect_variables;
    case 'analysis':
      return !!language.snippets.analyze_cells;
    case 'plots':
      return !!language.snippets.region_summary;
    case 'questions':
      return !!language.snippets.inspect_variables;
  }
}

/**
 * Why a feature is off in a kernel of this language, or null when it is on.
 * `name` is the kernel's `language_info.name`; before the kernel answers it
 * is null, and every feature counts as on.
 */
export function unsupported(
  feature: Feature,
  name: string | null
): string | null {
  if (!name) {
    return null;
  }
  const language = languageOf(name);
  if (supports(language, feature)) {
    return null;
  }
  const others = LANGUAGES.filter(other => supports(other, feature)).map(
    other => other.label
  );
  const needs = others.length ? others.join(' or ') : 'another';
  const runs = `This kernel runs ${language?.label ?? name}.`;
  switch (feature) {
    case 'variables':
      return `Variables are listed in a ${needs} kernel. ${runs}`;
    case 'analysis':
      return `The columns each cell uses are read in a ${needs} kernel. ${runs}`;
    case 'plots':
      return `Questions about a plot need a ${needs} kernel. ${runs}`;
    case 'questions':
      return `Questions ask about the kernel's variables, which the view lists in a ${needs} kernel. ${runs}`;
  }
}

/**
 * Whether the view runs code of this kernel's language in subshells, when
 * the kernel lists them: in Python and R. A language without an adapter
 * does not: the kernels of other languages that list subshells are
 * subclasses of ipykernel's Kernel with one process behind them, as
 * sas_kernel and bash_kernel are.
 */
export function usesSubshells(name: string | null | undefined): boolean {
  return languageOf(name)?.subshells ?? false;
}

/**
 * Why the branches run one after another in the main shell, or null when
 * they run in subshells. `listed` is whether the kernel lists subshells in
 * its info reply, and `name` its `language_info.name`.
 */
export function noSubshells(
  listed: boolean,
  name: string | null | undefined
): string | null {
  if (!listed) {
    return 'This kernel has no subshells: branches run one after another in the main shell';
  }
  if (usesSubshells(name)) {
    return null;
  }
  const label = languageOf(name)?.label ?? name;
  return `This kernel lists subshells and runs one ${label ? `${label} ` : ''}session behind them: branches run one after another in the main shell`;
}

/**
 * The MIME type of a notebook's code, which picks the highlighting of its
 * cells in the view: from the language that the notebook keeps from its
 * kernel, else from its kernelspec's language. A SAS notebook gets
 * text/x-sas, CodeMirror's SAS mode; a notebook that names no language,
 * Python's.
 */
export function codeMimeType(
  notebook: { getMetadata(key: string): unknown },
  mimeTypes: IEditorMimeTypeService
): string {
  const info = notebook.getMetadata('language_info') as
    nbformat.ILanguageInfoMetadata | undefined;
  const spec = notebook.getMetadata('kernelspec') as
    { language?: string } | undefined;
  // A notebook model starts with `language_info.name` empty.
  if (info?.name) {
    return mimeTypes.getMimeTypeByLanguage(info);
  }
  if (spec?.language) {
    return mimeTypes.getMimeTypeByLanguage({ name: spec.language });
  }
  return 'text/x-ipython';
}

export function pythonString(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
