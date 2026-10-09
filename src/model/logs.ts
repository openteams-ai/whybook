/**
 * The text of stream and plain-text outputs, as the bench shows it: in full
 * when it is short, with each Python warning cut to its category and message.
 */

/** A stream or plain-text output of at most this many lines shows in full. */
export const SHORT_TEXT_LINES = 10;

/** Printed lines shown in full at each level of detail; longer text is a tile. */
export const TEXT_LINES: Record<'overview' | 'compact' | 'full', number> = {
  overview: 0,
  compact: 3,
  full: SHORT_TEXT_LINES
};

export interface IOutputText {
  /** The lines to show: a warning is one line, its category and message. */
  lines: string[];
  /** How many lines the output has as printed, less the hidden ones. */
  total: number;
  /** How many lines IPython printed about its own machinery. */
  hidden: number;
  /** How many Python warnings the text holds. */
  warnings: number;
  /** The stream it was printed to, or null for a plain-text result. */
  stream: 'stdout' | 'stderr' | null;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** `path/to/file.py:268: ConvergenceWarning: Maximum Likelihood ...` */
const WARNING = /^(.+?):(\d+): (\w*Warning): (.*)$/;

/** The line of code that Python prints after a warning's message, two spaces in. */
const SOURCE = /^ {2}\S/;

/**
 * What IPython prints when its history database fails, which happens when
 * several kernels share the database. It is not about the analysis, so the
 * view does not show it.
 */
const HIDDEN = [
  /^The history saving thread hit an unexpected error\b/,
  /^ERROR! Session\/line number was not unique in database\b/,
  /^!! Session\/line number for output was not unique in database\b/
];

function joined(value: unknown): string {
  return Array.isArray(value) ? value.join('') : String(value ?? '');
}

/**
 * Split printed text into lines as a terminal shows them: colour codes
 * dropped, and a line redrawn with a carriage return kept as last drawn.
 * Each warning starts with one line, `ConvergenceWarning: ...`, without the
 * file and the line number, and the source line that Python prints after
 * the message is left out. A message of several lines, as scikit-learn's
 * ConvergenceWarning, keeps its other lines.
 * The messages of IPython's history database are left out.
 */
export function readText(text: string): {
  lines: string[];
  total: number;
  warnings: number;
  hidden: number;
} {
  const printed = text
    .replace(ANSI, '')
    .split('\n')
    .map(line => line.split('\r').pop() ?? '');
  if (printed.length > 1 && printed[printed.length - 1] === '') {
    printed.pop();
  }
  const lines: string[] = [];
  let warnings = 0;
  let hidden = 0;
  // In a warning's message, until its source line.
  let warning = false;
  for (let index = 0; index < printed.length; index++) {
    if (HIDDEN.some(pattern => pattern.test(printed[index]))) {
      hidden++;
      continue;
    }
    const match = WARNING.exec(printed[index]);
    if (!match) {
      // The source line after a message of several lines is its last line:
      // the text ends, or the next warning starts.
      const next = printed[index + 1];
      if (
        warning &&
        SOURCE.test(printed[index]) &&
        (next === undefined || WARNING.test(next))
      ) {
        warning = false;
        continue;
      }
      lines.push(printed[index]);
      continue;
    }
    warnings++;
    lines.push(`${match[3]}: ${match[4]}`);
    warning = true;
    if (/^\s/.test(printed[index + 1] ?? '')) {
      warning = false;
      index++;
    }
  }
  return { lines, total: printed.length - hidden, warnings, hidden };
}

/**
 * A plain-text form that only names the object, such as
 * `<IPython.core.display.HTML object>`: what the output shows is in its HTML
 * alone, as a styled table or the log that sas_kernel sends.
 */
export const PLACEHOLDER =
  /^<(?:class '[\w.]+'|[\w.]+ object(?: at 0x[0-9a-f]+)?)>$/;

/** The elements whose end starts a new line when HTML is read as text. */
const BLOCKS = 'p, div, pre, li, tr, table, ul, ol, h1, h2, h3, h4, h5, h6';

/**
 * The text of an HTML output as it reads on screen: a new line at each
 * `<br>` and at the end of each block, and none of the head, the styles or
 * the scripts.
 */
export function htmlText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('head, style, script').forEach(node => node.remove());
  doc.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  doc.querySelectorAll(BLOCKS).forEach(node => node.append('\n'));
  return (doc.body?.textContent ?? '')
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The text of a stream output or of a plain-text result, or null. */
export function outputText(data: {
  readonly [key: string]: unknown;
}): IOutputText | null {
  for (const stream of ['stdout', 'stderr'] as const) {
    const value = data[`application/vnd.jupyter.${stream}`];
    if (value !== undefined) {
      return { ...readText(joined(value)), stream };
    }
  }
  const plain = data['text/plain'];
  if (plain === undefined) {
    return null;
  }
  const text = joined(plain);
  const html = data['text/html'];
  if (html !== undefined && PLACEHOLDER.test(text.trim())) {
    // The text of the HTML, such as the log of a SAS cell, in place of the
    // name of the object.
    const shown = htmlText(joined(html));
    if (shown) {
      return { ...readText(shown), stream: null };
    }
  }
  return { ...readText(text), stream: null };
}

/**
 * Printed lines of a fit's summary shown in full on its card once the fit
 * converged, at Compact and Full: the summary of a mixed model of
 * statsmodels takes 18 lines (design iteration 1.77).
 */
export const SUMMARY_LINES = 40;

/**
 * How a fit's summary says it ended: statsmodels prints `Converged: Yes`
 * for a mixed model and `converged: True` for a discrete model. True when
 * the text says that the fit converged, false when it says that it did not,
 * and null for text that says neither.
 */
export function convergedIn(lines: string[]): boolean | null {
  let converged: boolean | null = null;
  for (const line of lines) {
    const match = /\bconverged:\s*(yes|true|no|false)\b/i.exec(line);
    if (match) {
      if (/^(no|false)$/i.test(match[1])) {
        return false;
      }
      converged = true;
    }
  }
  return converged;
}

/** What a fit prints when it stops before it converges. */
const NOT_CONVERGED =
  /\b(?:failed to converge|did not converge|has not converged|hasn't converged|not converged)\b|\bconverged:\s*(?:no|false)\b/i;
const CONVERGED = /\bconverged:\s*(?:yes|true)\b/i;

/**
 * Whether the fit of a cell stopped before it converged (design iteration
 * 1.116), from the text of its outputs and from whether each model of the
 * kernel's listing that the cell makes converged: a warning such as
 * scikit-learn's "lbfgs failed to converge", a summary that says
 * `converged: False`, or a model that did not converge. A summary or a model
 * that says that the fit converged wins, as after the warnings of a MixedLM
 * that tried again.
 */
export function stoppedBeforeConverging(
  texts: string[],
  listed: (boolean | null)[]
): boolean {
  if (listed.includes(true) || texts.some(text => CONVERGED.test(text))) {
    return false;
  }
  return listed.includes(false) || texts.some(text => NOT_CONVERGED.test(text));
}

/** The printed text of an output, as it came: a stream's, or a result's plain text. */
export function rawText(data: { readonly [key: string]: unknown }): string {
  for (const key of [
    'application/vnd.jupyter.stderr',
    'application/vnd.jupyter.stdout',
    'text/plain'
  ]) {
    if (data[key] !== undefined) {
      return joined(data[key]);
    }
  }
  return '';
}

/**
 * Whether a warning, as readText cuts it, is one that a fit prints before
 * it tries again, which a fit that converged leaves behind: statsmodels'
 * "Maximum Likelihood optimization failed to converge" and "Retrying
 * MixedLM optimization with lbfgs". A warning about the result, such as an
 * estimate on the boundary of the parameter space or a Hessian that is not
 * positive definite, is not one of them.
 */
export function retriedWarning(line: string): boolean {
  return /^ConvergenceWarning: (?:.*\bfailed to converge\b|Retrying\b)/.test(
    line
  );
}
