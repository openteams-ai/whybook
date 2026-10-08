/**
 * Inline code and bold in a text that a model wrote. Models mark a name of the
 * data or of a package with backticks, and what they stress with two
 * asterisks, as Markdown does: "clustered by `psu`", "**age** and **sex**".
 * The view shows the code in the code font and the bold in bold, and leaves
 * the rest of the text as it came, since a model's text is not reliably
 * Markdown: a mark without its pair, an empty pair and a fenced block stay as
 * they are.
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
