import type {
  IDecision,
  IDecisionCall,
  IEpiCellMeta,
  IOption,
  IUserValue
} from '../tokens';
import { editedByHand, holdsValue } from './handedit';

/** Calls that join one frame to another, named by the frame they join. */
const JOINS = new Set(['merge', 'join', 'merge_asof', 'merge_ordered']);

/** The parameters that name the file a reader such as read_csv reads. */
const FILE_PARAMS = new Set([
  'filepath_or_buffer',
  'path',
  'path_or_buf',
  'path_or_buffer',
  'io',
  'source',
  'file',
  'filename',
  'fname',
  'filepath'
]);

/**
 * The calls a decision lists, in the order of the code: none for a decision
 * kept before calls were listed, or kept in another form.
 */
export function callsOf(decision: IDecision): IDecisionCall[] {
  return Array.isArray(decision.calls)
    ? decision.calls.filter(
        call => typeof call?.line === 'number' && typeof call?.col === 'number'
      )
    : [];
}

/**
 * The name that the cell calls: `merge` for `DataFrame.merge`. An R function
 * comes with its package, and its name may hold a dot: `t.test` for
 * `stats::t.test`.
 */
export function shortName(name: string): string {
  const at = name.lastIndexOf('::');
  if (at >= 0) {
    return name.slice(at + 2);
  }
  // A class for its constructor, as the cell calls it: LogisticRegression
  // for the LogisticRegression.__init__ of a notebook kept before the kernel
  // named it so.
  const parts = name.split('.');
  return parts.length > 1 && parts[parts.length - 1] === '__init__'
    ? parts[parts.length - 2]
    : (parts.pop() ?? '');
}

/** The name of the function whose call makes a decision: `merge`, `t.test`. */
export function shortFunction(decision: IDecision): string {
  return shortName(decision.function ?? '');
}

/**
 * Readers, whose file is the chip: pandas' read_csv and polars' scan_csv, R's
 * read.csv and readRDS, readr's read_csv.
 */
export const READER = /^(read|scan)[_.]|^readRDS$/;

/**
 * The join that R's merge makes, by the value of `all`, `all.x` or `all.y`
 * that a decision shows: an inner join, unless the frames keep their rows
 * without a match. Null for any other decision.
 */
function rJoin(decision: IDecision, value: string): string | null {
  if (
    !(decision.function ?? '').includes('::') ||
    shortFunction(decision) !== 'merge'
  ) {
    return null;
  }
  const kept = value === 'TRUE' || value === 'T';
  if (decision.param === 'all') {
    return kept ? 'outer join' : 'inner join';
  }
  if (decision.param === 'all.x' || decision.param === 'all.y') {
    return kept
      ? `${decision.param === 'all.x' ? 'left' : 'right'} join`
      : null;
  }
  return null;
}

/** A string value without its quotes: `inner` for `'inner'`; other values as they are. */
function unquote(value: string): string {
  const text = value.trim();
  const quoted = /^(['"])(.*)\1$/s.exec(text);
  return quoted ? quoted[2] : text;
}

/**
 * Whether a decision is a path written in the call of a reader such as
 * read_csv: its chip is the file's name. A constant that a file defines keeps
 * its name on the chip, since the variable matters more than its path.
 */
export function readsFile(decision: IDecision): boolean {
  return (
    ['literal', 'you', 'agent', 'template'].includes(decision.provenance) &&
    READER.test(shortFunction(decision)) &&
    FILE_PARAMS.has(decision.param ?? '') &&
    /^(['"]).*\1$/s.test(decision.value.trim())
  );
}

/**
 * The words for a text of one sign, which a chip cannot show on its own:
 * the separator of a read, `sep comma`, or its decimal mark, `decimal point`
 * (design iteration 1.91). The keys are the texts as code writes them, so a
 * tab is `\t`.
 */
const SIGNS = new Map([
  [',', 'comma'],
  [';', 'semicolon'],
  ['\\t', 'tab'],
  [' ', 'space'],
  ['|', 'pipe'],
  [':', 'colon'],
  ['.', 'point'],
  ['', 'empty text']
]);

/**
 * The words of a chip: the name and the value, without "=" or quotes, as
 * `BASE_TEMP_C 15.5`. The value of `how` of a merge is a join, `inner join`,
 * as is `all = FALSE` of R's merge, and the file that a read reads is its
 * file name, `homes.csv`. A text of one sign is its name, `sep comma`.
 */
export function chipText(decision: IDecision): string {
  const value = unquote(decision.value);
  if (JOINS.has(shortFunction(decision)) && decision.param === 'how') {
    return `${value} join`;
  }
  const join = rJoin(decision, value);
  if (join) {
    return join;
  }
  if (readsFile(decision)) {
    return value.split(/[\\/]/).pop() || value;
  }
  const sign = SIGNS.get(value);
  if (sign && /^(['"]).*\1$/s.test(decision.value.trim())) {
    return `${decision.name} ${sign}`;
  }
  return `${decision.name} ${value}`;
}

/**
 * The name of the function that a call of a decision names: `sum` for a
 * call that names its function, as the calls of a decision of several
 * functions do, else the decision's.
 */
export function callFunction(decision: IDecision, call: IDecisionCall): string {
  return call.function ? shortName(call.function) : shortFunction(decision);
}

/**
 * What one call of a decision's function is, and several: merge and merges,
 * read and reads. The calls of several functions are calls.
 */
function callNouns(decision: IDecision): [string, string] {
  const name = shortFunction(decision);
  const names = new Set(
    callsOf(decision).map(call => callFunction(decision, call))
  );
  if (names.size > 1) {
    return ['call', 'calls'];
  }
  if (JOINS.has(name)) {
    const noun = name === 'join' ? 'join' : 'merge';
    return [noun, `${noun}s`];
  }
  if (READER.test(name)) {
    return ['read', 'reads'];
  }
  return ['call', 'calls'];
}

/**
 * One call of a decision, named by the frame it joins or reads: "the merge
 * with weather", "the read of homes", "the ribbon of february", and by its
 * function where the decision's calls are of several: "the sum of x1". Its
 * line follows where these do not tell it from the decision's other calls,
 * or always with `line` true, and never with `line` false.
 */
export function callName(
  decision: IDecision,
  call: IDecisionCall,
  line: boolean | null = null
): string {
  const [noun] = callNouns(decision);
  const name = noun === 'call' ? callFunction(decision, call) : noun;
  const what = !call.target
    ? `the ${name}`
    : noun === 'merge' || noun === 'join'
      ? `the ${noun} with ${call.target}`
      : `the ${name} of ${call.target}`;
  const alike =
    !call.target ||
    callsOf(decision).filter(
      other =>
        other.target === call.target &&
        callFunction(decision, other) === callFunction(decision, call)
    ).length > 1;
  return (line ?? alike) ? `${what} on line ${call.line}` : what;
}

/** All the calls of a decision: "both merges", "all 3 calls". */
export function allCalls(decision: IDecision): string {
  const count = callsOf(decision).length;
  const [, nouns] = callNouns(decision);
  return count === 2 ? `both ${nouns}` : `all ${count} ${nouns}`;
}

/** A choice of where a what-if value goes, as the menu of a chip lists it: "Merge with homes". */
export function callChoice(decision: IDecision, call: IDecisionCall): string {
  const text = callName(decision, call).replace(/^the /, '');
  // A function's name keeps its case.
  return callNouns(decision)[0] === 'call'
    ? text
    : text.charAt(0).toUpperCase() + text.slice(1);
}

/** A list of phrases: "a", "a and b", "a, b and c". */
function listed(parts: string[]): string {
  return parts.length < 2
    ? parts.join('')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** One chip of a cell, for the decision it shows. */
export interface IChip {
  decision: IDecision;
  /** The name and the value, as the chip shows them: `inner join`. */
  text: string;
  /** The calls the chip stands for: 2 for `inner join ×2`; 1 for a decision that lists none. */
  count: number;
  /**
   * The frame that the chip's one call joins or reads, where other calls of
   * its function leave another value: `weather` for `left join · weather`.
   * Else the functions of its calls, where another chip shows the same words
   * for calls of other functions: `sum` for `skipna False · sum`.
   */
  target: string | null;
  /**
   * The chip's tooltip, one line after another: the value as code and the
   * call it goes into, `how = 'inner'` and `parameter how of DataFrame.merge,
   * line 4`. What else is known of the value, such as the library whose
   * default it is and the reason of a model that flagged it, is in the
   * popover that a click on the chip opens (design iteration 1.86).
   */
  tooltip: string;
}

/**
 * The library of a default and its version, `pandas 3.0.6`: for a default
 * that a model found, from the signature that it read; for a default of the
 * view's own list, from the kernel. Null where neither is known, as for a
 * decision that an older version kept in the notebook.
 */
export function libraryOf(decision: IDecision): string | null {
  const found = decision.found;
  const name = found ? found.library : decision.library;
  const version = found ? found.version : decision.version;
  return name ? (version ? `${name} ${version}` : name) : null;
}

/**
 * Where a value comes from, in the popover's first line: `default in pandas
 * 3.0.6` for a library default whose library is known. For any other
 * decision it is the server's note, such as `defaulted in prep.py:31`.
 */
export function sourceNote(decision: IDecision, note: string): string {
  if (decision.provenance !== 'library_default') {
    return note;
  }
  const library = libraryOf(decision);
  return library ? `default in ${library}` : note;
}

/**
 * The chips of a cell's decisions. One chip stands for every call that
 * leaves the same value, `inner join ×2`. Where calls of one function leave
 * different values, each chip names the frame of its call, in one word:
 * `inner join · homes` and `left join · weather`. A chip does not repeat a
 * word it shows: `homes.csv` needs no `· homes`. Two chips that show the
 * same words for calls of different functions each name their functions:
 * `skipna False · mean` and `skipna False · sum`.
 */
export function decisionChips(decisions: IDecision[]): IChip[] {
  const texts = decisions.map(chipText);
  const functions = decisions.map(decision => {
    const calls = callsOf(decision);
    const names = calls.length
      ? calls.map(call => callFunction(decision, call))
      : [shortFunction(decision)];
    return [...new Set(names)].filter(Boolean).join(', ');
  });
  return decisions.map((decision, index) => {
    const calls = callsOf(decision);
    const text = texts[index];
    const differs =
      !!decision.function &&
      !!decision.param &&
      decisions.some(
        other =>
          other !== decision &&
          shortFunction(other) === shortFunction(decision) &&
          other.param === decision.param
      );
    let target: string | null = null;
    if (differs && calls.length === 1) {
      const word = calls[0].target || `line ${calls[0].line}`;
      const shown = text.split(/[^\w]+/).includes(word);
      target = shown ? null : word;
    }
    const twin = texts.some(
      (other, at) =>
        at !== index && other === text && functions[at] !== functions[index]
    );
    if (target === null && twin && functions[index]) {
      target = functions[index];
    }
    return {
      decision,
      text,
      count: Math.max(1, calls.length),
      target,
      tooltip: tooltipLines(decision, calls, target).join('\n')
    };
  });
}

/**
 * The lines of a chip's tooltip: the value as code, then the call, such as
 * `parameter how of DataFrame.merge, line 4`, or the calls that a chip of
 * several stands for. A value that an agent or a template wrote into code
 * says so, since its chip shows it by no colour of its own, and the AI tag of
 * an agent's value has no tooltip of its own.
 */
function tooltipLines(
  decision: IDecision,
  calls: IDecisionCall[],
  target: string | null
): string[] {
  // A default that no parameter holds, such as the sums of squares that R's
  // anova computes, is a name and a value that is no code.
  const anonymous = decision.param === null && !!decision.function;
  const lines = [
    anonymous && decision.provenance === 'library_default'
      ? `${decision.name}: ${unquote(decision.value)}`
      : `${decision.name} = ${decision.value}`
  ];
  if (calls.length > 1) {
    const each = calls.map(
      call => `${callName(decision, call, false)} (line ${call.line})`
    );
    lines.push(`In ${allCalls(decision)}: ${listed(each)}.`);
  } else if (target !== null && calls.length === 1) {
    lines.push(
      `In ${callName(decision, calls[0], false)} (line ${calls[0].line}).`
    );
  } else if (decision.function) {
    const where = calls.length === 1 ? `, line ${calls[0].line}` : '';
    lines.push(
      anonymous
        ? `${decision.function}${where}`
        : `parameter ${decision.param ?? decision.name} of ${decision.function}${where}`
    );
  }
  // Neither the colour nor a tag of such a chip says who chose the value.
  if (decision.provenance === 'agent') {
    lines.push('Chosen by AI.');
  } else if (decision.provenance === 'template') {
    lines.push('Chosen by the template you picked.');
  }
  return lines;
}

/** A key for a decision among the decisions of its cell. */
export function decisionKey(decision: IDecision): string {
  const call = callsOf(decision)[0];
  return [
    decision.name,
    decision.value,
    decision.provenance,
    decision.function ?? '',
    call ? `${call.line}:${call.col}` : ''
  ].join('|');
}

/**
 * Who chose each value written in a cell, as its chip's colour and tooltip
 * show. In code that the analyst wrote, the analyst chose it. In code that
 * the view wrote, from a template or with a model, the analyst chose a value
 * that they typed or picked for a decision: the view records it in
 * `user_values`. The template that the analyst picked chose the others in
 * code that a template wrote with no model call, which the view marks
 * `template`, and the AI chose them in any other
 * code of the view. Defaults stay defaults.
 *
 * Code of the view that the analyst changed by hand, with `source` the code
 * now, is theirs, but for the values that the code as the view wrote it
 * holds, when the view kept that code (design iteration 1.83,
 * ./handedit.ts).
 */
export function attributed(
  decisions: IDecision[],
  meta: IEpiCellMeta,
  source?: string
): IDecision[] {
  const byView = meta.written_by === 'agent';
  const byTemplate = byView && meta.template === true && !meta.generated_by;
  const chosen = meta.user_values ?? [];
  const edited = source !== undefined && editedByHand(meta, source);
  const viewCode = edited ? (meta.view_code ?? null) : null;
  return decisions.map(decision => {
    if (decision.provenance !== 'literal') {
      return decision;
    }
    const yours =
      !byView ||
      chosen.some(value => isValueOf(value, decision)) ||
      (edited && !(viewCode !== null && holdsValue(viewCode, decision)));
    return {
      ...decision,
      provenance: yours ? 'you' : byTemplate ? 'template' : 'agent'
    };
  });
}

/**
 * The parameters that shape a drawing and not a result: the size of a
 * figure, its labels, its marks and its colours. Their values show no chip,
 * so that the chip that matters, such as cov_type cluster on the card of a
 * model with its plot, is not lost among them (design iteration 1.83).
 */
const DRAWING_PARAMS = new Set([
  'figsize',
  'dpi',
  'xlabel',
  'ylabel',
  'zlabel',
  'label',
  'title',
  'suptitle',
  't',
  's',
  'marker',
  'markersize',
  'ms',
  'linestyle',
  'ls',
  'linewidth',
  'lw',
  'color',
  'c',
  'colors',
  'palette',
  'cmap',
  'alpha',
  'edgecolor',
  'facecolor',
  'fontsize',
  'loc',
  'ncol',
  'frameon',
  'rotation',
  'grid',
  'legend',
  'width',
  'height',
  'aspect',
  'size',
  'style',
  'theme',
  'bbox_inches'
]);

/** The functions that draw: their values in DRAWING_PARAMS shape a drawing. */
const DRAWING_FUNCTIONS =
  /^(subplots|figure|plot|scatter|bar|barh|hist|boxplot|violinplot|errorbar|fill_between|axhline|axvline|axline|step|stairs|stem|pie|imshow|text|annotate|legend|title|suptitle|savefig|xlabel|ylabel|set_xlabel|set_ylabel|set_title|set|set_xlim|set_ylim|xlim|ylim|tight_layout|grid|lineplot|scatterplot|barplot|boxplot|histplot|kdeplot|regplot|lmplot|catplot|relplot|pointplot|stripplot|swarmplot|heatmap|pairplot|jointplot|displot|countplot|ggplot|aes|labs|ggtitle|xlab|ylab|theme|geom_\w+)$/;

/**
 * The decisions less the values that only shape a drawing: a parameter of
 * DRAWING_PARAMS in a call of a drawing function, such as figsize of
 * plt.subplots, xlabel of ax.set_xlabel or marker of ax.plot.
 */
export function withoutDrawing(decisions: IDecision[]): IDecision[] {
  return decisions.filter(decision => {
    const fn = (decision.function ?? '').split('.').pop() ?? '';
    const param = decision.param ?? decision.name;
    return !(
      decision.provenance === 'literal' &&
      DRAWING_FUNCTIONS.test(fn) &&
      DRAWING_PARAMS.has(param)
    );
  });
}

/**
 * Whether a decision found in a cell is the value that the analyst chose:
 * the same parameter or name, and the same value. A branch renames what its
 * cell defines, so `x = 7` in a branch of the cell that defines `x` reads
 * `x_if_7 = 7`. A file matches the path of a reader call that reads it:
 * `pd.read_csv('data/visits.csv')` for the file data/visits.csv.
 */
function isValueOf(value: IUserValue, decision: IDecision): boolean {
  if (value.file) {
    return readsFile(decision) && samePath(decision.value, value.value);
  }
  const named =
    decision.name === value.name ||
    decision.name.startsWith(`${value.name}_`) ||
    (!!value.param &&
      (decision.param === value.param || decision.name === value.param));
  return named && sameValue(decision.value, value.value);
}

/**
 * Whether two paths name one file, with or without quotes and a leading
 * `./`. A model that writes a load may shorten the path, so `visits.csv`
 * and `data/visits.csv` are one file, and `data/visits.csv` and
 * `old/visits.csv` are not.
 */
function samePath(a: string, b: string): boolean {
  const clean = (path: string) => unquote(path).replace(/^\.\//, '');
  const left = clean(a);
  const right = clean(b);
  return (
    left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
  );
}

/**
 * Whether two values, as Python writes them, are one value: 21 and 21.0,
 * 1e3 and 1000.0, 'left' and "left", [7, 14] and [7,14].
 */
export function sameValue(a: string, b: string): boolean {
  const left = a.trim();
  const right = b.trim();
  if (left === right) {
    return true;
  }
  const number = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
  if (number.test(left) && number.test(right)) {
    return Number(left) === Number(right);
  }
  const quoted = /^(['"])(.*)\1$/s;
  const one = quoted.exec(left);
  const two = quoted.exec(right);
  if (one && two) {
    return one[2] === two[2];
  }
  return left.replace(/\s+/g, '') === right.replace(/\s+/g, '');
}

/**
 * The value that the analyst chose with an option of the questions about a
 * decision, or null when the option chooses none. A value typed in the box
 * comes as `typed`; a value picked from the list is in the option's text,
 * "What if MIN_DAYS were 7?", or "What if how were "left" in the merge with
 * weather?" for one call of several; "Choose MIN_DAYS in [14]" keeps the
 * value the cell had. A sweep of several values is the template's.
 */
export function chosenValue(
  decision: IDecision,
  option: IOption,
  typed: string | null = null
): IUserValue | null {
  const value = (): string | null => {
    if (typed !== null) {
      return typed;
    }
    const whatIf =
      /^What if (.+?) were (.+?)(?: in (?:both|all \d+|\d+ of the|the) [^?]*)?\?$/s.exec(
        option.text
      );
    if (whatIf && whatIf[1] === decision.name) {
      return whatIf[2];
    }
    if (option.text.startsWith(`Choose ${decision.name} in `)) {
      return decision.value;
    }
    return null;
  };
  const chosen = value();
  return chosen === null
    ? null
    : { name: decision.name, param: decision.param ?? null, value: chosen };
}
