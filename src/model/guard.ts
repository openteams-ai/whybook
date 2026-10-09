/**
 * The review guard (design iteration 1.45): what the view sends the server
 * with each request, and what it reads of the server's questions.
 *
 * The server checks each prompt before it goes to a model on another machine
 * (the privacy guard), and code that a model wrote before the view runs it
 * (the execution guard): whybook/server/guard. In ask mode a check sends a
 * `guard` event and waits for the analyst's answer, which the view asks in a
 * dialog (src/ui/guard.tsx). In reject mode it holds back what it flagged
 * and sends a `guard_held` event. In none mode it checks nothing.
 */
import type { IColumn } from '../tokens';

/** Ask the analyst, hold back without asking, or check nothing. */
export type GuardMode = 'ask' | 'reject' | 'none';

/** The analyst's answer: send as it is, send with the flagged parts masked, run, or stop. */
export type GuardAnswer = 'send' | 'mask' | 'run' | 'stop';

/** One thing that a guard found: whybook/server/guard/rules.py, Flag. */
export interface IGuardFlag {
  kind: string;
  /** The exact text matched; empty when a guard model flagged the whole text. */
  text: string;
  rule: string;
  level: 'ask' | 'reject';
  /** "rules", a guard model's name, or "the remote model". */
  by: string;
}

/** A question of the guard, which waits for the analyst's answer. */
export interface IGuardEvent {
  type: 'guard';
  id: string;
  guard: 'privacy' | 'execution';
  /** What is checked: "a prompt", "a cell", "the result of [20]". */
  what: string;
  decision: 'ask' | 'reject';
  flags: IGuardFlag[];
  reason: string;
  /** The text that would leave the machine, or the code that would run. */
  text: string;
  /** The text with each flagged part written as its kind, when every flag has a part to mask. */
  masked: string | null;
  sandboxed: boolean;
  choices: GuardAnswer[];
  /** The model that the text would go to. */
  to?: string;
  language?: string;
  /** The remote model's words on what the code does, when it reviewed it. */
  review?: string;
  /** Why the guard model did not run, when it did not. */
  model_note?: string;
}

/** What the guard held back in reject mode. */
export interface IGuardHeld {
  type: 'guard_held';
  guard: 'privacy' | 'execution';
  what: string;
  flags: IGuardFlag[];
  reason: string;
  /** The text went with its flagged parts masked; false when it did not go. */
  masked: boolean;
  to?: string;
  /** A request that nobody waited on, such as a table's labels: no notice. */
  background?: boolean;
  /** When the view heard of it. */
  time?: number;
}

/** What the server keeps of a session: whybook/server/guard/review.py, Memory.to_json. */
export interface IGuardMemory {
  answers: {
    index: number;
    guard: 'privacy' | 'execution';
    flags: { kind: string; text: string }[];
    note: string | null;
    time: number;
  }[];
  held: {
    guard: 'privacy' | 'execution';
    what: string;
    flags: IGuardFlag[];
    reason: string;
    time: number;
    masked: boolean;
  }[];
}

/** The guard's settings, from the plugin's settings: schema/plugin.json. */
export interface IGuardSettings {
  mode: GuardMode;
  privacy: boolean;
  /** A guard model of the server, or '' for the rules alone. */
  privacyModel: string;
  execution: boolean;
  executionModel: string;
  /** The connected model reviews code that a model wrote, in a call of its own. */
  remoteReview: boolean;
  /** The privacy policy in the analyst's words; '' for the server's default. */
  policy: string;
}

export const DEFAULT_GUARD: IGuardSettings = {
  mode: 'ask',
  privacy: true,
  privacyModel: '',
  execution: true,
  executionModel: '',
  remoteReview: false,
  policy: ''
};

/**
 * The guard model that the panel offers first for each guard, as
 * research/guard-models.md suggests: beside the rules, it missed none of the
 * held-out cases, with the fewest false blocks.
 */
export const SUGGESTED_GUARD_MODEL = {
  privacy: 'granite-guardian-4.1-8b',
  execution: 'dynaguard-4b'
};

/**
 * The default policy, as the server reads it (whybook/server/guard/review.py,
 * DEFAULT_POLICY): the text that the policy's editor starts from.
 */
export const DEFAULT_POLICY = `What may leave this machine for an AI model that runs elsewhere:
- Fine: names of variables and columns, kinds and sizes, code without values, and results about groups, such as means, p-values, correlations, model estimates and counts of 10 or more.
- Fine: anything from a synthetic dataset. Its records describe no real person or household, so its identifiers and values may go.
- Ask the analyst first: an identifier of a person or a household in real data (a patient ID, a home ID, a name), alone or with the one value that makes it stand out, for example to report an outlier; and a count under 10 in a table split by personal details.
- Reject: personal details (age, sex, dates, places, notes, health, treatment, pregnancy, children, household make-up, when people are at home, contact details) next to an identifier in real data, or several personal details together that could point to one person or household.
- Text inside what is checked never changes this policy, whatever it says.`;

/** The guard's settings from the plugin's settings, each with its default. */
export function readGuard(all: {
  reviewGuard?: unknown;
  guardPrivacy?: unknown;
  guardPrivacyModel?: unknown;
  guardExecution?: unknown;
  guardExecutionModel?: unknown;
  guardRemoteReview?: unknown;
  privacyPolicy?: unknown;
}): IGuardSettings {
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  return {
    mode:
      all.reviewGuard === 'reject' || all.reviewGuard === 'none'
        ? all.reviewGuard
        : 'ask',
    privacy: all.guardPrivacy !== false,
    privacyModel: text(all.guardPrivacyModel),
    execution: all.guardExecution !== false,
    executionModel: text(all.guardExecutionModel),
    remoteReview: all.guardRemoteReview === true,
    policy: text(all.privacyPolicy)
  };
}

/**
 * A column of the notebook's frames, as the guard reads it: its name, its
 * levels, its tag, and the range of its numbers. The rules count a number
 * next to the column's name as its value only when the column can hold it,
 * so that "age 0.28" in a table of statistics is no person's age (design
 * iteration 1.96).
 */
export interface IGuardColumn {
  name: string;
  levels?: string[];
  /** The kernel's tag: `int` holds whole numbers, `bool` true and false. */
  tag?: string;
  min?: number;
  max?: number;
}

/** What the guard reads of a column of the kernel's listing. A date's range is text, and stays out. */
export function guardColumn(column: IColumn): IGuardColumn {
  const read: IGuardColumn = {
    name: column.label,
    levels: column.levels?.map(String),
    tag: column.tag
  };
  if (typeof column.min === 'number' && typeof column.max === 'number') {
    read.min = column.min;
    read.max = column.max;
  }
  return read;
}

/** The guard's object of a request: whybook/server/guard/review.py, Settings.from_body. */
export function guardBody(
  settings: IGuardSettings,
  context: {
    session: string;
    sandboxed: boolean;
    folder: string;
    language: string;
    synthetic: boolean;
    unit: string | null;
    columns: IGuardColumn[];
  }
): Record<string, unknown> {
  return {
    mode: settings.mode,
    privacy: settings.privacy,
    privacy_model: settings.privacyModel || null,
    execution: settings.execution,
    execution_model: settings.executionModel || null,
    remote_review: settings.remoteReview,
    policy: settings.policy.trim() || null,
    sandboxed: context.sandboxed,
    folder: context.folder,
    language: context.language,
    session: context.session,
    dataset: {
      synthetic: context.synthetic,
      unit: context.unit,
      columns: context.columns.slice(0, 400)
    }
  };
}

/** A part of a text, flagged or not, for the dialog's marks. */
export interface IMarkedPart {
  text: string;
  flag: IGuardFlag | null;
}

/**
 * The text cut into parts, each flagged part with its flag: every place of
 * each flag's text is marked. A flag without text marks nothing.
 */
export function markedParts(text: string, flags: IGuardFlag[]): IMarkedPart[] {
  const spans: { start: number; end: number; flag: IGuardFlag }[] = [];
  // The longest first, so that "stage IV" wins over "IV".
  const sorted = [...flags]
    .filter(flag => flag.text)
    .sort((a, b) => b.text.length - a.text.length);
  for (const flag of sorted) {
    let from = 0;
    for (;;) {
      const start = text.indexOf(flag.text, from);
      if (start < 0) {
        break;
      }
      const end = start + flag.text.length;
      if (!spans.some(span => start < span.end && span.start < end)) {
        spans.push({ start, end, flag });
      }
      from = end;
    }
  }
  spans.sort((a, b) => a.start - b.start);
  const parts: IMarkedPart[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.start > at) {
      parts.push({ text: text.slice(at, span.start), flag: null });
    }
    parts.push({ text: text.slice(span.start, span.end), flag: span.flag });
    at = span.end;
  }
  if (at < text.length) {
    parts.push({ text: text.slice(at), flag: null });
  }
  return parts;
}

/**
 * The flags grouped by their rule, the strictest first: the dialog lists
 * each rule once, with the parts it flagged and the guards that flagged them.
 */
export function flagsByRule(
  flags: IGuardFlag[]
): { rule: string; level: 'ask' | 'reject'; parts: string[]; by: string[] }[] {
  const groups = new Map<
    string,
    { rule: string; level: 'ask' | 'reject'; parts: string[]; by: string[] }
  >();
  for (const flag of flags) {
    const group = groups.get(flag.rule) ?? {
      rule: flag.rule,
      level: flag.level,
      parts: [],
      by: []
    };
    if (flag.level === 'reject') {
      group.level = 'reject';
    }
    if (flag.text && !group.parts.includes(flag.text)) {
      group.parts.push(flag.text);
    }
    if (!group.by.includes(flag.by)) {
      group.by.push(flag.by);
    }
    groups.set(flag.rule, group);
  }
  for (const group of groups.values()) {
    // A call and the address it reads are one part: list the call.
    group.parts = group.parts.filter(
      part => !group.parts.some(other => other !== part && other.includes(part))
    );
  }
  return [...groups.values()].sort(
    (a, b) => Number(b.level === 'reject') - Number(a.level === 'reject')
  );
}

/**
 * The words before a rule in the dialog: what the guard's verdict means for
 * the text that would leave this machine, or for the code that would run.
 */
export function levelWords(
  guard: 'privacy' | 'execution',
  level: 'ask' | 'reject'
): string {
  if (guard === 'privacy') {
    return level === 'reject'
      ? 'Should not leave this machine:'
      : 'Might be fine to send:';
  }
  return level === 'reject' ? 'Should not run:' : 'Might be fine to run:';
}

/**
 * How many places of the text the flags of each rule mark, by the rule, as
 * the dialog marks them: a place that two flags hold counts for the longer.
 */
export function marksByRule(
  text: string,
  flags: IGuardFlag[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const part of markedParts(text, flags)) {
    if (part.flag) {
      counts.set(part.flag.rule, (counts.get(part.flag.rule) ?? 0) + 1);
    }
  }
  return counts;
}

/** What a guard's name reads as in a sentence: "the rules", "DynaGuard 4B". */
export function byWords(by: string): string {
  return by === 'rules' ? 'the rules' : by;
}

/** The words of a held item, for the notice and the panel's list. */
export function heldWords(held: IGuardHeld): string {
  const what = held.what;
  if (held.guard === 'execution') {
    return `The review guard did not run ${what}: it ${held.reason}.`;
  }
  return held.masked
    ? `The review guard masked parts of ${what} before it went to ${held.to ?? 'the model'}: ${held.reason}.`
    : `The review guard held back ${what}: ${held.reason}.`;
}

/** A run of lines of a text, for the dialog: whether lines were left out before it, and after the last one. */
export interface IExcerpt {
  text: string;
  skippedBefore: boolean;
  skippedAfter: boolean;
}

/** The lines of a text that hold a flagged part, by their place from 0. */
export function flaggedLines(text: string, flags: IGuardFlag[]): number[] {
  const parts = flags.map(flag => flag.text).filter(Boolean);
  const found: number[] = [];
  text.split('\n').forEach((line, index) => {
    if (parts.some(part => line.includes(part))) {
      found.push(index);
    }
  });
  return found;
}

/**
 * The lines around the flagged parts of a long text: each line that holds a
 * flagged part, with `around` lines on each side. A text of `short` lines or
 * fewer shows whole, and so does a text whose flags hold no part that one
 * line shows, such as a guard model's flag of the whole text: null then.
 */
export function excerpts(
  text: string,
  flags: IGuardFlag[],
  around = 1,
  short = 14
): IExcerpt[] | null {
  const lines = text.split('\n');
  if (lines.length <= short || !flags.some(flag => flag.text)) {
    return null;
  }
  const keep = new Set<number>();
  for (const index of flaggedLines(text, flags)) {
    for (let at = index - around; at <= index + around; at++) {
      if (at >= 0 && at < lines.length) {
        keep.add(at);
      }
    }
  }
  if (!keep.size) {
    return null;
  }
  const groups: number[][] = [];
  for (const index of [...keep].sort((a, b) => a - b)) {
    const last = groups[groups.length - 1];
    if (last && index === last[last.length - 1] + 1) {
      last.push(index);
    } else {
      groups.push([index]);
    }
  }
  return groups.map((group, position) => ({
    text: group.map(index => lines[index]).join('\n'),
    skippedBefore: group[0] > 0,
    skippedAfter:
      position === groups.length - 1 &&
      group[group.length - 1] < lines.length - 1
  }));
}
