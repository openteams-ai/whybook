/**
 * Values that the view writes into Python code. A column, a frame's key or a
 * level comes from the data, so every such name goes through `pyString`: a
 * quote or a line break in it cannot end the literal. A bound goes through
 * `pyNumber`, at full precision: the rows the code keeps are the rows that
 * the summary counted.
 */

/** A Python string literal: `sleep "hours"` gives `"sleep \"hours\""`. */
export function pyString(text: string): string {
  // Every escape that JSON writes is also a Python escape: \" \\ \n \t \uXXXX.
  return JSON.stringify(text);
}

/** A Python number literal that reads back as `value`: 0.0012 stays 0.0012. */
export function pyNumber(value: number): string {
  if (Number.isNaN(value)) {
    return 'float("nan")';
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? 'float("inf")' : '-float("inf")';
  }
  // The shortest text that reads back as the same double: 1e-7, 0.1, 42.
  return String(value);
}

/**
 * A comment of Python code: `# ` before each line of the text, so that a
 * line break in a name cannot end the comment and start code. A control
 * character becomes a space: Python refuses a null byte in its source.
 */
export function pyComment(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map(line =>
      // eslint-disable-next-line no-control-regex
      `# ${line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')}`.trimEnd()
    )
    .join('\n');
}
