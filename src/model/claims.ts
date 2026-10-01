/**
 * The numbers a text states, and the outputs that show them: a check that
 * a writeup says what the notebook's results say.
 */

export interface INumberFound {
  cellId: string;
  /** The output that shows the number, by its index in the cell. */
  output: number;
  /** The number as the output prints it. */
  shown: string;
}

export interface INumberCheck {
  /** The number as the text writes it: "0.32", "26%", "3.9e-5". */
  text: string;
  /**
   * The outputs that show it, rounded as the text rounds it: first those
   * that print it with as many digits as the text.
   */
  found: INumberFound[];
  /** When no output shows it: the cells whose code has it as written. */
  inCode: string[];
}

export interface INumbersInText {
  checked: INumberCheck[];
  /**
   * Whole numbers under 100: they show in too many outputs for a match to
   * tell anything, so they are listed and not checked.
   */
  skipped: string[];
}

/** An output, or the code of a cell (output -1), as text to search. */
export interface ISourceText {
  cellId: string;
  output: number;
  text: string;
}

interface INumber {
  text: string;
  value: number;
  /** Significant digits, as written: "0.32" has 2, "1,428" has 4. */
  digits: number;
  percent: boolean;
  whole: boolean;
}

const NUMBER =
  /(?<![\w.])[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+−]?\d+)?%?(?![\w])/g;

function parse(text: string): INumber {
  const plain = text.replace(/−/g, '-').replace(/,/g, '');
  const percent = plain.endsWith('%');
  const number = percent ? plain.slice(0, -1) : plain;
  const mantissa = number.replace(/^-/, '').split(/[eE]/)[0];
  const digits = mantissa.replace('.', '').replace(/^0+/, '').length || 1;
  return {
    text,
    value: Number(number),
    digits,
    percent,
    whole: /^-?\d+$/.test(number)
  };
}

/** Every number in a text, as written there. */
export function numbersIn(text: string): INumber[] {
  const found: INumber[] = [];
  for (const match of text.matchAll(NUMBER)) {
    // After < or >, a number is a threshold, such as p < 0.05.
    const before = text.slice(0, match.index).trimEnd();
    if (/[<>≤≥]$/.test(before)) {
      continue;
    }
    found.push(parse(match[0]));
  }
  return found;
}

function roundTo(value: number, digits: number): number {
  return value === 0 ? 0 : Number(value.toPrecision(digits));
}

function same(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Whether an output's number is the text's number, rounded as the text
 * rounds it. Signs are not compared: "falls by 0.32" reports -0.318. A
 * percent in the text also matches a share: 26% is 0.262.
 */
export function shows(claim: INumber, shown: INumber): boolean {
  const target = Math.abs(claim.value);
  const candidates = claim.percent
    ? shown.percent
      ? [Math.abs(shown.value)]
      : Math.abs(shown.value) <= 1
        ? [Math.abs(shown.value) * 100]
        : []
    : shown.percent
      ? []
      : [Math.abs(shown.value)];
  return candidates.some(value => same(roundTo(value, claim.digits), target));
}

/** Whole numbers under 100, and years, which too many outputs show. */
function tooCommon(number: INumber): boolean {
  if (!number.whole || number.percent) {
    return false;
  }
  const value = Math.abs(number.value);
  return value < 100 || (value >= 1900 && value <= 2100);
}

/**
 * Check each number of a text against the outputs and the code of the
 * notebook's cells.
 */
export function checkNumbers(
  text: string,
  sources: ISourceText[]
): INumbersInText {
  const claims = numbersIn(text);
  const outputs = sources
    .filter(source => source.output >= 0)
    .map(source => ({ ...source, numbers: numbersIn(source.text) }));
  const code = sources.filter(source => source.output < 0);
  const checked: INumberCheck[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const claim of claims) {
    if (seen.has(claim.text)) {
      continue;
    }
    seen.add(claim.text);
    if (tooCommon(claim)) {
      skipped.push(claim.text);
      continue;
    }
    // An output that prints the number with as many digits as the text
    // comes first: 26% is more likely 0.26 than a coefficient of 0.259.
    const matches: (INumberFound & { extra: number })[] = [];
    for (const source of outputs) {
      const match = source.numbers.find(number => shows(claim, number));
      if (match) {
        matches.push({
          cellId: source.cellId,
          output: source.output,
          shown: match.text,
          extra: Math.abs(match.digits - claim.digits)
        });
      }
    }
    const found = matches
      .sort((a, b) => a.extra - b.extra)
      .map(({ cellId, output, shown }) => ({ cellId, output, shown }));
    const written = claim.text.replace(/%$/, '');
    const inCode = found.length
      ? []
      : code
          .filter(source =>
            numbersIn(source.text).some(number => number.text === written)
          )
          .map(source => source.cellId);
    checked.push({ text: claim.text, found, inCode });
  }
  return { checked, skipped };
}

/** An HTML output as text: tags dropped, entities read. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&minus;/g, '-')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** The start of a text, cut at a word: at most `max` characters. */
export function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) {
    return flat;
  }
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[,;:.]$/, '')}…`;
}
