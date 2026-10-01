/**
 * How the view writes numbers and dates as text, by where they show. Each
 * place keeps the digits that tell its values apart:
 *
 * - a tick of an axis: the decimals of the step between ticks, and a power of
 *   ten that the whole axis shares when the labels would be long;
 * - a value in a tooltip or in text: three significant figures, whole from
 *   100 up, and a power of ten below 0.0001 or from a billion up;
 * - an estimate and its interval: one number of decimals for all three, from
 *   the width of the interval;
 * - a p-value: "< 0.001" below 0.001;
 * - a share: whole percents, one decimal below 1%, and "< 0.1%" for a share
 *   above 0 that would show as 0;
 * - a count: a whole number;
 * - a bound in Python code: the number at full precision, or a date as
 *   pd.Timestamp("2024-01-03").
 *
 * Digits of a value are grouped by thousands from 10,000 up, so that a year
 * stays 2024; a count is grouped from 1,000 up, as the rest of the view does.
 * The notebook helpers send numbers at full precision, and only the view
 * rounds. whybook/explore.py writes shares by the same rule.
 *
 * A date travels as the milliseconds since 1970 of its time on the clock of
 * the frame, and is written here in UTC, so that it shows as the frame holds
 * it: in text as 2024-01-03 or 2024-01-03 06:30, on a tick as Jan 3 or 06:30.
 */

import type { IPlotAxis } from '../tokens';
import { pyNumber, pyString } from './pycode';

const SUPERSCRIPT: Record<string, string> = {
  '-': '⁻',
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹'
};

/** "×10⁻⁷": the power of ten that the labels of an axis share. */
export function powerText(power: number): string {
  return `×10${String(power)
    .split('')
    .map(char => SUPERSCRIPT[char] ?? char)
    .join('')}`;
}

/** The digits of a whole part with a comma every three, from 10,000 up. */
function grouped(digits: string): string {
  return digits.length < 5 ? digits : digits.replace(/\B(?=(\d{3})+$)/g, ',');
}

/**
 * A number with a fixed count of decimals, trailing zeros kept or not, and
 * never "-0": 0.1 - 0.1 is "0".
 */
function fixed(value: number, decimals: number, trim: boolean): string {
  let text = value.toFixed(Math.min(100, Math.max(0, decimals)));
  if (trim && text.includes('.')) {
    text = text.replace(/\.?0+$/, '');
  }
  if (/^-0(\.0*)?$/.test(text)) {
    text = text.slice(1);
  }
  const negative = text.startsWith('-');
  const [whole, fraction] = (negative ? text.slice(1) : text).split('.');
  return `${negative ? '-' : ''}${grouped(whole)}${fraction !== undefined ? `.${fraction}` : ''}`;
}

/** 1.23e-7 and 4.5e9, with `digits` significant figures and no trailing zeros. */
function scientific(value: number, digits: number): string {
  const [mantissa, exponent] = value.toExponential(digits - 1).split('e');
  const trimmed = mantissa.includes('.')
    ? mantissa.replace(/\.?0+$/, '')
    : mantissa;
  return `${trimmed}e${Number(exponent)}`;
}

/** The power of ten of a number's first digit: 2 for 123, -3 for 0.0042. */
function magnitude(value: number): number {
  return Math.floor(Math.log10(Math.abs(value)) + 1e-12);
}

/**
 * A value in a tooltip or in text: 0.0042, 12.3, 1235, 12,346, 1.23e-7.
 * Three significant figures, whole numbers from 100 up, so that no digit of
 * a whole part turns to 0, and a power of ten below 0.0001 or from a billion.
 */
export function numberText(value: number): string {
  if (Number.isNaN(value)) {
    return 'NaN';
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? '∞' : '-∞';
  }
  if (value === 0) {
    return '0';
  }
  const size = Math.abs(value);
  if (size < 1e-4 || size >= 1e9) {
    return scientific(value, 3);
  }
  if (size >= 100) {
    return fixed(value, 0, true);
  }
  return fixed(value, 2 - magnitude(value), true);
}

/** A count, such as the rows behind a bar: 12, 1,234. */
export function countText(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/**
 * A share of a whole, as a percent: 12%, 0.4%, < 0.1%, 99.5%, > 99.9%.
 * Whole percents, and one decimal below 1% and above 99%, so that one row in
 * a thousand does not show as 0% and one row short of all does not show as
 * 100%.
 */
export function shareText(fraction: number): string {
  if (!Number.isFinite(fraction)) {
    return '';
  }
  const percent = 100 * fraction;
  const tenths = Math.round(percent * 10) / 10;
  if (percent > 0 && tenths === 0) {
    return '< 0.1%';
  }
  if (percent < 100 && tenths === 100) {
    return '> 99.9%';
  }
  if ((tenths > 0 && tenths < 1) || (tenths > 99 && percent < 100)) {
    return `${tenths.toFixed(1)}%`;
  }
  return `${Math.round(percent)}%`;
}

/**
 * A p-value: two decimals, three below 0.01 and near 0.05, "< 0.001" below
 * 0.001 and "> 0.99" above 0.99.
 */
export function pValueText(p: number): string {
  if (!Number.isFinite(p)) {
    return '';
  }
  if (p < 0.001) {
    return '< 0.001';
  }
  if (p > 0.99) {
    return '> 0.99';
  }
  if (p < 0.01) {
    return p.toFixed(3);
  }
  const text = p.toFixed(2);
  // 0.046 and 0.054 both round to 0.05: three decimals tell which side.
  return text === '0.05' ? p.toFixed(3) : text;
}

/**
 * An estimate and its interval, with one number of decimals for all three:
 * the decimals that give the width of the interval two significant figures,
 * so 0.0042 (0.0021, 0.0063) and 101.2 (98.1, 104.3). Tiny or huge numbers
 * share a power of ten: 4.2e-9 (2.1e-9, 6.3e-9). Without an interval, the
 * estimate is written as a value in text.
 */
export function estimateText(
  estimate: number,
  lo?: number | null,
  hi?: number | null
): { estimate: string; lo: string | null; hi: string | null } {
  if (
    typeof lo !== 'number' ||
    typeof hi !== 'number' ||
    !Number.isFinite(lo) ||
    !Number.isFinite(hi) ||
    !Number.isFinite(estimate) ||
    lo === hi
  ) {
    return {
      estimate: numberText(estimate),
      lo: typeof lo === 'number' ? numberText(lo) : null,
      hi: typeof hi === 'number' ? numberText(hi) : null
    };
  }
  const width = Math.abs(hi - lo);
  const largest = Math.max(Math.abs(estimate), Math.abs(lo), Math.abs(hi));
  const decimals = 1 - magnitude(width);
  if (decimals > 6 || largest >= 1e9) {
    const power = magnitude(largest);
    const scale = Math.pow(10, power);
    const places = Math.max(0, 1 - magnitude(width / scale));
    const write = (value: number) =>
      `${fixed(value / scale, places, false)}e${power}`;
    return { estimate: write(estimate), lo: write(lo), hi: write(hi) };
  }
  const places = Math.max(0, decimals);
  return {
    estimate: fixed(estimate, places, false),
    lo: fixed(lo, places, false),
    hi: fixed(hi, places, false)
  };
}

/** A step of 1, 2 or 5 times a power of ten, at least `raw`. */
export function niceStep(raw: number): number {
  const power = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const fraction = raw / power;
  return (
    (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power
  );
}

/** Ticks of an axis, what each tick reads, and a note that they all share. */
export interface ITicks {
  ticks: number[];
  labels: string[];
  /** A power of ten, as "×10⁻⁷", or the date of ticks that show only a time. */
  note: string | null;
}

/** The labels of an axis whose ticks are longer than this get a shared power of ten. */
const LONGEST_TICK = 7;

/**
 * Ticks of a number axis about `count` apart over a domain, each labelled
 * with the decimals of the step: 0, 0.002, 0.004 and 2020, 2020.2, 2020.4.
 * When a label would be longer than 7 characters, the axis shares a power of
 * ten: 0, 2, 4 with the note ×10⁻⁷.
 */
export function numberTicks(
  domain: [number, number],
  count: number
): ITicks & { step: number } {
  const [low, high] = domain;
  const step = niceStep((high - low) / Math.max(1, count));
  const ticks: number[] = [];
  for (
    let tick = Math.ceil(low / step) * step;
    tick <= high + step / 1e6;
    tick += step
  ) {
    ticks.push(Math.round(tick / step) * step);
  }
  const decimals = Math.max(0, -magnitude(step));
  const plain = ticks.map(tick => fixed(tick, decimals, true));
  if (plain.every(label => label.replace('-', '').length <= LONGEST_TICK)) {
    return { ticks, step, labels: plain, note: null };
  }
  const largest = Math.max(...ticks.map(Math.abs));
  if (!(largest > 0)) {
    return { ticks, step, labels: plain, note: null };
  }
  const power = magnitude(largest);
  const scale = Math.pow(10, power);
  const places = Math.max(0, -magnitude(step / scale));
  return {
    ticks,
    step,
    labels: ticks.map(tick => fixed(tick / scale, places, true)),
    note: powerText(power)
  };
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** The mean month and year, to choose a step; ticks fall on the calendar. */
const MONTH = 30.436875 * DAY;
const YEAR = 365.2425 * DAY;
/** 5 January 1970, the first Monday: weeks start on Mondays. */
const MONDAY = 4 * DAY;

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
];

/** How fine a date is: the smallest unit it names. */
export type DateUnit =
  'year' | 'month' | 'day' | 'minute' | 'second' | 'millisecond';

type StepUnit =
  | 'millisecond'
  | 'second'
  | 'minute'
  | 'hour'
  | 'day'
  | 'week'
  | 'month'
  | 'year';

interface IStep {
  unit: StepUnit;
  /** How many units one step spans. */
  n: number;
  /** Its length, in milliseconds; for months and years, the mean length. */
  ms: number;
}

/** The steps between date ticks, from a second to a year. */
const STEPS: IStep[] = [
  ...[1, 2, 5, 10, 15, 30].map(n => ({
    unit: 'second' as const,
    n,
    ms: n * SECOND
  })),
  ...[1, 2, 5, 10, 15, 30].map(n => ({
    unit: 'minute' as const,
    n,
    ms: n * MINUTE
  })),
  ...[1, 2, 3, 6, 12].map(n => ({ unit: 'hour' as const, n, ms: n * HOUR })),
  ...[1, 2].map(n => ({ unit: 'day' as const, n, ms: n * DAY })),
  { unit: 'week', n: 1, ms: WEEK },
  ...[1, 2, 3, 6].map(n => ({ unit: 'month' as const, n, ms: n * MONTH })),
  { unit: 'year', n: 1, ms: YEAR }
];

/** The length of each unit a date can need, as the finest step for it. */
const UNIT_MS: Record<DateUnit, number> = {
  millisecond: 0,
  second: SECOND,
  minute: MINUTE,
  day: DAY,
  month: DAY,
  year: DAY
};

/**
 * The step for ticks `target` apart: of the steps just below and just above
 * it, the one that gives a number of ticks closer to the one asked for, and
 * none shorter than `floor`: dates without a time get no tick at 12:00.
 */
function stepFor(target: number, floor: number): IStep {
  if (target < SECOND && floor < SECOND) {
    const ms = Math.max(1, niceStep(target));
    return { unit: 'millisecond', n: ms, ms };
  }
  if (target > YEAR) {
    const n = niceStep(target / YEAR);
    return { unit: 'year', n, ms: n * YEAR };
  }
  const steps = STEPS.filter(step => step.ms >= floor);
  const index = steps.findIndex(step => step.ms >= target);
  if (index <= 0) {
    return steps[Math.max(0, index)];
  }
  const below = steps[index - 1];
  const above = steps[index];
  return target / below.ms < above.ms / target ? below : above;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** The finest unit that a moment needs: a midnight is a day, 06:30 a minute. */
export function dateUnit(ms: number): DateUnit {
  const rounded = Math.round(ms);
  const within = ((rounded % DAY) + DAY) % DAY;
  if (within === 0) {
    return 'day';
  }
  if (within % MINUTE === 0) {
    return 'minute';
  }
  return within % SECOND === 0 ? 'second' : 'millisecond';
}

/** The finest unit that some moments need: day for dates without a time. */
export function finestUnit(values: number[]): DateUnit {
  const order: DateUnit[] = ['millisecond', 'second', 'minute', 'day'];
  let finest = order.length - 1;
  for (const value of values) {
    if (Number.isFinite(value)) {
      finest = Math.min(finest, order.indexOf(dateUnit(value)));
    }
  }
  return order[finest];
}

/**
 * A date in text, as pandas writes it: 2024-01-03, 2024-01-03 06:30,
 * 2024-01-03 06:30:15 or 2024-01-03 06:30:15.250, to the unit given or to
 * the finest one the moment needs. `ms` counts from 1970 on the frame's clock.
 */
export function dateText(ms: number, unit: DateUnit = dateUnit(ms)): string {
  const date = new Date(Math.round(ms));
  if (Number.isNaN(date.getTime())) {
    return 'NaT';
  }
  const year = date.getUTCFullYear();
  const day = `${year < 0 ? '-' : ''}${pad(Math.abs(year), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  if (unit === 'year') {
    return day.slice(0, -6);
  }
  if (unit === 'month') {
    return day.slice(0, -3);
  }
  if (unit === 'day') {
    return day;
  }
  const minutes = `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  if (unit === 'minute') {
    return minutes;
  }
  const seconds = `${minutes}:${pad(date.getUTCSeconds())}`;
  return unit === 'second'
    ? seconds
    : `${seconds}.${pad(date.getUTCMilliseconds(), 3)}`;
}

/** Jan 3: the day of a tick. */
function shortDay(date: Date): string {
  return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** The years that some dates fall in: "2024", or "2024 to 2025". */
function yearsOf(dates: Date[]): string {
  const years = dates.map(date => date.getUTCFullYear());
  const first = Math.min(...years);
  const last = Math.max(...years);
  return first === last ? String(first) : `${first} to ${last}`;
}

/**
 * Ticks of a date axis about `count` apart: on whole seconds, minutes,
 * hours, days, Mondays, months or years, and none finer than the `finest`
 * unit that the values need. Each tick names what changes at it, and the
 * note names what the ticks share:
 *
 * - years: 2024, 2025;
 * - months: Feb, Mar, and the year at January, as 2025; with no January
 *   among the ticks, the year goes in the note;
 * - days and weeks: Jan 3, Jan 10, with the year in the note;
 * - hours down to milliseconds: 06:00, 12:00, and the day at midnight, as
 *   Jan 4; with no midnight among the ticks, the note names the day, as
 *   Jan 3 2024.
 */
export function dateTicks(
  domain: [number, number],
  count: number,
  finest: DateUnit = 'millisecond'
): ITicks {
  const [start, end] = domain;
  if (!(end > start)) {
    return { ticks: [start], labels: [dateText(start)], note: null };
  }
  const step = stepFor((end - start) / Math.max(1, count), UNIT_MS[finest]);
  const ticks: number[] = [];
  if (step.unit === 'month' || step.unit === 'year') {
    const months = step.unit === 'month' ? step.n : 12 * step.n;
    const first = new Date(start);
    // From the first month or year that the step divides.
    let index =
      step.unit === 'month'
        ? first.getUTCFullYear() * 12 +
          Math.ceil(first.getUTCMonth() / months) * months
        : Math.ceil(first.getUTCFullYear() / step.n) * step.n * 12;
    for (;;) {
      const tick = Date.UTC(Math.floor(index / 12), index % 12, 1);
      if (tick > end) {
        break;
      }
      if (tick >= start) {
        ticks.push(tick);
      }
      index += months;
    }
  } else {
    // Weeks start on Mondays; the other steps divide a day, from midnight.
    const offset = step.unit === 'week' ? MONDAY : 0;
    for (
      let tick = Math.ceil((start - offset) / step.ms) * step.ms + offset;
      tick <= end + step.ms / 1e6;
      tick += step.ms
    ) {
      ticks.push(Math.round(tick));
    }
  }
  if (!ticks.length) {
    return { ticks: [start], labels: [dateText(start)], note: null };
  }
  return { ticks, ...dateLabels(ticks, step.unit) };
}

/** What each date tick reads, and the note of the axis: see dateTicks. */
function dateLabels(
  ticks: number[],
  unit: StepUnit
): { labels: string[]; note: string | null } {
  const dates = ticks.map(tick => new Date(tick));
  if (unit === 'year') {
    return {
      labels: dates.map(date => String(date.getUTCFullYear())),
      note: null
    };
  }
  if (unit === 'month') {
    const labels = dates.map(date =>
      date.getUTCMonth() === 0
        ? String(date.getUTCFullYear())
        : MONTH_NAMES[date.getUTCMonth()]
    );
    const shown = dates.some(date => date.getUTCMonth() === 0);
    return { labels, note: shown ? null : yearsOf(dates) };
  }
  if (unit === 'day' || unit === 'week') {
    return { labels: dates.map(shortDay), note: yearsOf(dates) };
  }
  const midnight = (date: Date) =>
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0;
  const clock = (date: Date) => {
    const minutes = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
    if (unit === 'hour' || unit === 'minute') {
      return minutes;
    }
    const seconds = `${minutes}:${pad(date.getUTCSeconds())}`;
    return unit === 'second'
      ? seconds
      : `${seconds}.${pad(date.getUTCMilliseconds(), 3)}`;
  };
  const labels = dates.map(date =>
    midnight(date) ? shortDay(date) : clock(date)
  );
  const note = dates.some(midnight)
    ? yearsOf(dates)
    : `${shortDay(dates[0])} ${dates[0].getUTCFullYear()}`;
  return { labels, note };
}

/** A value on an axis of a plot in text: a number, or a date. */
export function axisValueText(
  value: number,
  axis?: Pick<IPlotAxis, 'type'> | null
): string {
  return axis?.type === 'date' ? dateText(value) : numberText(value);
}

/**
 * A bound of a range picked on a plot's axis, as Python code at full
 * precision: a number as it reads back, and a date as
 * pd.Timestamp("2024-01-03 06:30"), with the time zone of the frame's dates.
 * region_summary.py counts the rows between the same bounds.
 */
export function boundCode(
  value: number,
  axis?: Pick<IPlotAxis, 'type' | 'tz'> | null
): string {
  if (axis?.type !== 'date') {
    return pyNumber(value);
  }
  const text = pyString(dateText(value));
  return axis.tz
    ? `pd.Timestamp(${text}, tz=${pyString(axis.tz)})`
    : `pd.Timestamp(${text})`;
}

/**
 * A column of a frame as Python code that compares with the bounds of its
 * axis: `visits["day"]`, parsed first as `pd.to_datetime(visits["day"])`
 * when the frame holds its dates as Python objects.
 */
export function columnCode(
  frame: string,
  column: string,
  axis?: Pick<IPlotAxis, 'objects'> | null
): string {
  const series = `${frame}[${pyString(column)}]`;
  return axis?.objects ? `pd.to_datetime(${series})` : series;
}

/** The milliseconds of each unit that a range of dates is rounded to. */
const ROUND_MS: Partial<Record<DateUnit, number>> = {
  day: DAY,
  minute: MINUTE,
  second: SECOND,
  millisecond: 1
};

/**
 * The two ends of a range on an axis, as read. A range of dates reads in the
 * unit that the plot's own dates need (`values`), each end rounded inward,
 * so that the text names the first and the last moment that the range
 * holds: a box drawn from Mar 12 12:29 to Mar 31 14:08 over days holds the
 * days Mar 13 to Mar 31. A range that holds none of those moments, and a
 * range of numbers, read as they are.
 */
export function rangeEnds(
  low: number,
  high: number,
  axis?: Pick<IPlotAxis, 'type'> | null,
  values: number[] = []
): [string, string] {
  const step =
    axis?.type === 'date' && values.length
      ? ROUND_MS[finestUnit(values)]
      : undefined;
  if (step !== undefined) {
    const from = Math.ceil(low / step) * step;
    const to = Math.floor(high / step) * step;
    if (from <= to) {
      const unit = finestUnit(values);
      return [dateText(from, unit), dateText(to, unit)];
    }
  }
  return [axisValueText(low, axis), axisValueText(high, axis)];
}

/**
 * A range of values on an axis of a plot: 5–9, 0.0012–0.0048, 2024-01-03 to
 * 2024-01-10, or one value when both ends read the same. `values` are the
 * plot's own values on that axis (rangeEnds).
 */
export function rangeText(
  low: number,
  high: number,
  axis?: Pick<IPlotAxis, 'type'> | null,
  values: number[] = []
): string {
  const [from, to] = rangeEnds(low, high, axis, values);
  if (from === to) {
    return from;
  }
  return axis?.type === 'date' ? `${from} to ${to}` : `${from}–${to}`;
}

/** The values that a plot draws on one axis: its points, its lines or its bins. */
export function axisValues(
  plot: {
    series?: { points: { x: number }[] }[];
    points?: { x: number; y: number }[];
    bins?: { x0: number; x1: number }[];
  },
  axis: 'x' | 'y'
): number[] {
  if (axis === 'y') {
    return (plot.points ?? []).map(point => point.y);
  }
  return [
    ...(plot.series ?? []).flatMap(series =>
      series.points.map(point => point.x)
    ),
    ...(plot.points ?? []).map(point => point.x),
    ...(plot.bins ?? []).flatMap(bin => [bin.x0, bin.x1])
  ];
}
