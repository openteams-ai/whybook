/**
 * Inline code and bold in a text that a model wrote, and in a question. Models
 * mark a name of the data or of a package with backticks, and what they
 * stress with two asterisks, as Markdown does: "clustered by `psu`", "**age**
 * and **sex**". A question marks each name of code and each value the same
 * way, "What if `reml` were `False`?" (design iteration 1.145), and each name
 * of data in bold, "Does **pain_score** differ by **age**?" (1.146). The view
 * shows the code in the code font and the bold in bold, and leaves the rest
 * of the text as it came, since a model's text is not reliably Markdown: a
 * mark without its pair, an empty pair and a fenced block stay as they are.
 */

/**
 * The text cut around its inline code: "clustered by `psu`." gives
 * `["clustered by ", "psu", "."]`, with the code at each odd index, without
 * its backticks.
 */
export function splitCode(text: string): string[] {
  return text.split(/`([^`\n]+)`/g);
}

/**
 * The text cut around its bold: "**age** and **sex**" gives
 * `["", "age", " and ", "sex", ""]`, with the bold at each odd index. As in
 * Markdown, no space follows the opening asterisks or comes before the
 * closing ones, so "x ** 2 and y ** 3" stays as it is.
 */
export function splitBold(text: string): string[] {
  return text.split(/\*\*(\S(?:[^*\n]*\S)?)\*\*/g);
}

/** A part of a question's text: its words, a name or a value of code, or a name of data. */
export interface IMarkedPart {
  kind: 'text' | 'code' | 'data';
  text: string;
}

/**
 * A question's text cut into its parts: "Is **age** associated with `how`?"
 * gives the words "Is ", the data "age", the words " associated with ", the
 * code "how" and the words "?". Code goes in backticks, and data between two
 * asterisks with no space after the first pair or before the second, as
 * Markdown's bold: "x ** 2 and y ** 3" holds no data.
 */
export function splitMarks(text: string): IMarkedPart[] {
  const parts: IMarkedPart[] = [];
  let done = 0;
  for (const found of text.matchAll(
    /`([^`\n]+)`|\*\*(\S(?:[^*`\n]*\S)?)\*\*/g
  )) {
    const at = found.index ?? 0;
    if (at > done) {
      parts.push({ kind: 'text', text: text.slice(done, at) });
    }
    parts.push(
      found[1] !== undefined
        ? { kind: 'code', text: found[1] }
        : { kind: 'data', text: found[2] }
    );
    done = at + found[0].length;
  }
  if (done < text.length) {
    parts.push({ kind: 'text', text: text.slice(done) });
  }
  return parts;
}

/**
 * The text without the marks of its names and values: "What if `reml` were
 * `False` in the `fit` of **model_data**?" gives "What if reml were False in
 * the fit of model_data?". For a tooltip, an accessible name, a comment of
 * code, and a match against a text without marks, as a notebook saved before
 * them keeps.
 */
export function plainText(text: string): string {
  return splitMarks(text)
    .map(part => part.text)
    .join('');
}

/**
 * A name of code or a value in backticks, for the text of a question:
 * "`how`". A text that holds a backtick or a line break, or none at all,
 * stays as it is.
 */
export function inlineCode(text: string): string {
  return text && !/[`\n]/.test(text) ? `\`${text}\`` : text;
}

/**
 * A name of data between two asterisks, for the text of a question:
 * "**age**" (design iteration 1.146). A text that holds an asterisk, a
 * backtick or a line break, a space at an end, or none at all, stays as it is.
 */
export function inlineData(text: string): string {
  return text && text.trim() === text && !/[*`\n]/.test(text)
    ? `**${text}**`
    : text;
}
