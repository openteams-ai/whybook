/** Whether the code names this variable, other than as an attribute. */
export function namesIn(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w.])${escaped}(?!\\w)`).test(source);
}
