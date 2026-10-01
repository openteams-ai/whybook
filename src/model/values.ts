/**
 * A variable's value as the variables list and Contents show it: numpy's
 * wrapper dropped, `np.float64(-0.4131654135338354)` as `-0.41317`, and a
 * number cut to three decimals from 1 up, or five significant figures below
 * 1. The value as Python prints it goes in the tooltip.
 */
export function valueText(value: string): string {
  const text = value.trim();
  const inner =
    /^np\.[A-Za-z_]+\d*\(([\s\S]*)\)$/.exec(text)?.[1] ??
    text.replace(/^np\.(True|False)_$/, '$1');
  const number = Number(inner);
  if (
    /^[-+]?(\d|\.\d)/.test(inner) &&
    Number.isFinite(number) &&
    !Number.isInteger(number)
  ) {
    return String(
      Number(Math.abs(number) >= 1 ? number.toFixed(3) : number.toPrecision(5))
    );
  }
  return inner;
}

/**
 * A constant as the variables list and Contents show it: its value, or for
 * a secret, which the kernel lists without its text, "hidden, 37 characters".
 */
export function constantText(variable: {
  value?: string;
  secret?: boolean;
  length?: number;
}): string {
  if (!variable.secret) {
    return valueText(variable.value ?? '');
  }
  const length = variable.length;
  return length === undefined
    ? 'hidden'
    : `hidden, ${length} ${length === 1 ? 'character' : 'characters'}`;
}

/** A name as a regular expression matches it literally. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
