import {
  Button,
  InputGroup,
  caretDownIcon,
  closeIcon,
  copyIcon
} from '@jupyterlab/ui-components';
import * as React from 'react';
import * as ReactDOM from 'react-dom';

import { helpIcon, microphoneIcon } from '../icons';
import type { EpiModel, IEpiCell } from '../model/epimodel';
import type { IChip } from '../model/decisions';
import { decisionChips, decisionKey } from '../model/decisions';
import { namedBy, splitLabels } from '../model/labels';
import type { IOrdered } from '../model/questionorder';
import { needsAI } from '../model/questionorder';
import type {
  Guess,
  IAnchor,
  IDecision,
  IItem,
  IOption,
  IPlacement,
  IWrittenBy,
  QuestionType
} from '../tokens';
import { ITEM_MIME } from '../tokens';
import { describeBy } from '../model/writtenby';
import { useTooltip } from './tooltip';
import type { IVoice } from './voice';
import { useVoice } from './voice';

/**
 * Re-render when the model changes.
 */
/**
 * Whole seconds since `started`, counted again every second while `active`:
 * a wait shows its time even when the server sends nothing.
 */
export function useSeconds(
  started: number | undefined,
  active: boolean
): number | null {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!active || started === undefined) {
      return;
    }
    const timer = window.setInterval(() => setTick(tick => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active, started]);
  return started === undefined
    ? null
    : Math.floor((Date.now() - started) / 1000);
}

/** What a model is doing and for how long, such as "AI is thinking · 12 s". */
export function stageText(
  stage: string | null,
  seconds: number | null
): string {
  return `AI is ${stage ?? 'starting'}${seconds !== null ? ` · ${seconds} s` : ''}`;
}

/**
 * Where a popup opens above an element, at its left edge; without room
 * above, beside the cell that holds the element, or else below the element
 * (./popoverplace.ts).
 */
export function anchorAbove(element: Element): IAnchor {
  const rect = element.getBoundingClientRect();
  const cell = element
    .closest('.jp-Epi-cell, .jp-Epi-linear-cell')
    ?.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    above: true,
    beside: cell ? { left: cell.left, right: cell.right } : undefined,
    bottom: rect.bottom
  };
}

/**
 * Where a popup opens under an element, left-aligned with it, as the
 * questions of a chip do (design iteration 1.86). It stays on that side while
 * it grows, so that it does not jump when its questions come, and ends
 * inside the window (./popoverplace.ts).
 */
export function anchorBelow(element: Element): IAnchor {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, bottom: rect.bottom, below: true };
}

/**
 * What a parallel run shares with the notebook: a subshell is a thread of
 * the same kernel, with the same variables (checked with ipykernel 7.3.0).
 */
export const PARALLEL_HELP =
  "A parallel run is a subshell of the same kernel: it reads and writes the same variables as every other cell, so what it makes is there at once, for every cell. A branch names what it makes apart, such as weekly_if_7, so that the main analysis keeps its own. To use a branch's result, use those names in a later cell. Run all makes a cell that uses a branch's names wait for that branch.";

/** The guesses a strip offers, in the order shown. */
export const GUESSES: { value: Guess; label: string }[] = [
  { value: 'higher', label: 'Higher' },
  { value: 'lower', label: 'Lower' },
  { value: 'none', label: 'No difference' },
  { value: 'unsure', label: 'Not sure' }
];

/** Question types whose answer has a direction to guess. */
export const GUESSED_TYPES: QuestionType[] = ['association', 'model', 'causal'];

export const GUESS_HELP =
  'Say what you expect before you see the result: a surprise is easier to notice. In a study, analysts who stated what they expected before seeing the data made 21% more correct inferences and 12% fewer false discoveries (Koonchanok and others, CHI 2023). The guess is optional, stays with the cell, and the settings can turn it off.';

/** The guess a cell keeps, as its chip reads: "expected higher". */
export function GuessChip(props: { guess: Guess }): JSX.Element {
  const label = GUESSES.find(g => g.value === props.guess)?.label ?? '';
  return (
    <span
      className="jp-Epi-guess-chip"
      title="What you expected before the result"
    >
      expected {label.toLowerCase()}
    </span>
  );
}

export function useModel(model: EpiModel | null): number {
  const [version, setVersion] = React.useState(0);
  React.useEffect(() => {
    if (!model) {
      return;
    }
    const update = () => setVersion(value => value + 1);
    model.changed.connect(update);
    return () => {
      model.changed.disconnect(update);
    };
  }, [model]);
  return version;
}

const TYPE_LABELS: Record<QuestionType, string> = {
  association: 'Association',
  causal: 'Causal',
  quality: 'Data quality',
  model: 'Model check',
  descriptive: 'Descriptive'
};

/**
 * The colour-coded question type. With `light`, the pointer on the badge
 * lights every badge and cell of its type, until it leaves or the badge goes.
 */
export function TypeBadge(props: {
  type: QuestionType;
  light?: (type: QuestionType | null) => void;
}): JSX.Element {
  const { type, light } = props;
  const lit = React.useRef(false);
  // The latest callback, so that a new one on each render does not unlight.
  const latest = React.useRef(light);
  latest.current = light;
  React.useEffect(
    () => () => {
      if (lit.current) {
        latest.current?.(null);
      }
    },
    []
  );
  return (
    <span
      className={`jp-Epi-type jp-mod-${type}`}
      onMouseEnter={
        light
          ? () => {
              lit.current = true;
              light(type);
            }
          : undefined
      }
      onMouseLeave={
        light
          ? () => {
              lit.current = false;
              light(null);
            }
          : undefined
      }
    >
      {TYPE_LABELS[type] ?? type}
    </span>
  );
}

/**
 * How relevant a question is, as a bar.
 */
export function Relevance(props: {
  value: number | null;
  reasons?: string[];
}): JSX.Element | null {
  if (props.value === null || props.value === undefined) {
    return null;
  }
  const percent = Math.round(100 * props.value);
  return (
    <span
      className="jp-Epi-relevance"
      title={`${percent}% relevant${props.reasons?.length ? '\n' + props.reasons.join('\n') : ''}`}
    >
      <span style={{ width: `${percent}%` }} />
    </span>
  );
}

export function ProgressBar(props: {
  value: number | null;
  label: string;
  wide?: boolean;
}): JSX.Element {
  const percent = props.value === null ? null : Math.round(100 * props.value);
  return (
    <span
      className={`jp-Epi-progress${props.wide ? ' jp-mod-wide' : ''}${percent === null ? ' jp-mod-indeterminate' : ''}`}
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
    >
      <span style={percent === null ? undefined : { width: `${percent}%` }} />
    </span>
  );
}

/**
 * The tag after what a model wrote or chose. With `by`, its tooltip names
 * the model and the day; `null` says that the notebook does not record it.
 */
/**
 * A cell's title, with the AI tag when a model wrote it. While a model
 * writes it, a pulsing bar stands in for it, with the first line of the
 * code as its tooltip.
 */
export function CellTitle(props: {
  model: EpiModel;
  cell: IEpiCell;
}): JSX.Element {
  const { model, cell } = props;
  if (model.cellTitles.state(cell.id) === 'pending') {
    return (
      <span
        className="jp-Epi-title jp-mod-pending"
        title={cell.title}
        aria-label={`${cell.title}: a title is being written`}
      >
        <span className="jp-Epi-title-skeleton" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className="jp-Epi-title">
      <LabelledText
        model={model}
        text={cell.title}
        refs={cell.meta.question?.refs}
      />
      {cell.titleBy !== undefined && (
        <AITag by={cell.titleBy} verb="Title written" />
      )}
    </span>
  );
}

/**
 * A cell's label. A count from an earlier run is greyed, as the variables
 * of the last run are: the cell's code has not run in the current kernel.
 */
export function CellLabel(props: { cell: IEpiCell }): JSX.Element {
  const { cell } = props;
  return (
    <span
      className={`jp-Epi-label${cell.lastRun ? ' jp-mod-lastrun' : ''}`}
      title={
        cell.lastRun
          ? `${cell.label} is from an earlier run: this code has not run in the current kernel`
          : undefined
      }
    >
      {cell.label}
    </span>
  );
}

/**
 * A text that names cells by their labels. A label that more than one cell
 * shows carries a small mark: the pointer on it gives the title of the cell
 * it names, and a click flashes that cell. `refs` settle which cell a label
 * names; where they do not, the pointer gives every cell that shows it.
 */
export function LabelledText(props: {
  model: EpiModel;
  text: string;
  refs?: Record<string, string>;
}): JSX.Element {
  const { model, text, refs } = props;
  const shared = model.sharedLabels();
  const parts = splitLabels(text);
  if (!parts.some((part, index) => index % 2 === 1 && shared.has(part))) {
    return <>{text}</>;
  }
  const cells = model.cells();
  return (
    <>
      {parts.map((part, index) => {
        if (index % 2 === 0 || !shared.has(part)) {
          return <React.Fragment key={index}>{part}</React.Fragment>;
        }
        const named = namedBy(part, refs, cells);
        const cell = named.length === 1 ? named[0] : null;
        const mark = (
          <span className="jp-Epi-labelref-mark" aria-hidden="true" />
        );
        if (!cell) {
          const tip = `${part} is shown by ${named.length} cells: ${named
            .map(item => `“${item.title}”`)
            .join(', ')}`;
          return (
            <span
              key={index}
              className="jp-Epi-labelref jp-mod-unsure"
              title={tip}
              aria-label={tip}
            >
              {part}
              {mark}
            </span>
          );
        }
        return (
          <button
            key={index}
            type="button"
            className="jp-Epi-labelref"
            title={`${part}: ${cell.title}`}
            aria-label={`${part}: ${cell.title}`}
            onMouseDown={event => event.stopPropagation()}
            onClick={event => {
              event.stopPropagation();
              model.showCell(cell.id);
            }}
          >
            {part}
            {mark}
          </button>
        );
      })}
    </>
  );
}

export function AITag(props: {
  title?: string;
  by?: IWrittenBy | null;
  verb?: string;
}): JSX.Element {
  const title =
    props.title ??
    (props.by !== undefined
      ? describeBy(props.by, props.verb)
      : 'Written or chosen by an AI model');
  return (
    <span className="jp-Epi-aitag" title={title}>
      AI
    </span>
  );
}

/**
 * The order of the questions below, when a model is chosen for "Question
 * order": the model's, the rules' while it works, or the rules' when it
 * failed. An order that came while the pointer was on the list waits, and
 * the note offers to show it.
 */
export function OrderNote(props: { list: IOrdered }): JSX.Element | null {
  const order = props.list.order;
  if (!order) {
    return null;
  }
  return (
    <div
      className={`jp-Epi-caption jp-Epi-ordernote jp-mod-${order.state}`}
      title={
        order.state === 'failed' ? (order.message ?? undefined) : undefined
      }
    >
      {order.state === 'pending' && `Ordering with ${order.name}…`}
      {order.state === 'held' && (
        <>
          {order.name} ordered these questions.{' '}
          <button className="jp-Epi-link" onClick={() => order.show?.()}>
            Show its order
          </button>
        </>
      )}
      {order.state === 'done' && (
        <>
          Ordered by {order.name} <AITag by={order.by} verb="Ordered" />
        </>
      )}
      {order.state === 'failed' &&
        `In the rules' order: ${order.name} failed (${order.message})`}
    </div>
  );
}

/**
 * The events of a list of questions that a model may order: its order
 * waits while the pointer is on the list.
 */
export function pointerOn(
  model: EpiModel,
  list: IOrdered
): Pick<
  React.HTMLAttributes<HTMLElement>,
  'onPointerEnter' | 'onPointerLeave'
> {
  return {
    onPointerEnter: () => model.pointAtList(list, true),
    onPointerLeave: () => model.pointAtList(list, false)
  };
}

/**
 * A decision chip: the name and the value, short (`BASE_TEMP_C 15.5`,
 * `inner join ×2`, `left join · weather`). Who chose the value shows in its
 * colour: the warning colour for a value nobody chose on purpose, a default
 * of the analyst's module or of a library, dark blue with the AI tag for the
 * AI's value, and plain for the analyst's. The tooltip, one of the view's own
 * (./tooltip.tsx), gives the value as code and the call, and names the calls
 * that "×2" covers; what else is known of the value is in the popover that a
 * click opens. A library default that a model found in the function's
 * signature keeps the warning colour, since nobody chose it, and has no AI
 * tag: the model chose to show the chip, and the popover says so (design
 * iteration 1.86). A value that an agent wrote into code keeps its AI tag.
 */
export function DecisionChip(props: {
  chip: IChip;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}): JSX.Element {
  const { chip } = props;
  const { decision } = chip;
  const open =
    decision.provenance === 'defaulted' ||
    decision.provenance === 'library_default';
  const agent = decision.provenance === 'agent';
  const found = decision.found;
  const text = chip.count > 1 ? `${chip.text} ×${chip.count}` : chip.text;
  const tooltip = useTooltip(chip.tooltip.split('\n'), { code: true });
  return (
    <button
      className={`jp-Epi-chip${open ? ' jp-mod-open' : ''}${found ? ' jp-mod-found' : ''}`}
      {...tooltip.props}
      onClick={event => {
        tooltip.hide();
        props.onClick?.(event);
      }}
    >
      <code className={agent ? 'jp-Epi-ai' : undefined}>{text}</code>
      {chip.target && (
        <span className="jp-Epi-chip-target"> · {chip.target}</span>
      )}
      {/* The chip's tooltip says it: a tag with its own title would show the browser's tooltip too. */}
      {agent && <AITag title="" />}
      {tooltip.node}
    </button>
  );
}

/**
 * The chips of a cell's decisions, one for the calls that leave the same
 * value. While a model reads the signatures of the cell's functions ("Find
 * more defaults with AI"), a pulsing bar follows the chips, and its tooltip
 * names the functions.
 */
export function DecisionChips(props: {
  decisions: IDecision[];
  onClick: (
    decision: IDecision,
    event: React.MouseEvent<HTMLButtonElement>
  ) => void;
  /** The functions whose defaults a model reads now or next. */
  waiting?: string[];
}): JSX.Element {
  const waiting = props.waiting ?? [];
  return (
    <div className="jp-Epi-chips">
      {decisionChips(props.decisions).map(chip => (
        <DecisionChip
          key={decisionKey(chip.decision)}
          chip={chip}
          onClick={event => props.onClick(chip.decision, event)}
        />
      ))}
      {waiting.length > 0 && (
        <span
          className="jp-Epi-chips-waiting"
          role="status"
          title={waitingTitle(waiting)}
        >
          <ProgressBar value={null} label="An AI model finds more defaults" />
        </span>
      )}
    </div>
  );
}

/** "An AI model reads the signatures of DataFrame.merge and read_csv, for more defaults." */
function waitingTitle(names: string[]): string {
  const listed =
    names.length < 2
      ? names.join('')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `An AI model reads the signature${names.length > 1 ? 's' : ''} of ${listed}, for more defaults.`;
}

export function PlacementTag(props: {
  placement: IPlacement | null;
}): JSX.Element | null {
  if (!props.placement) {
    return null;
  }
  return (
    <span className={`jp-Epi-placement jp-mod-${props.placement.kind}`}>
      {props.placement.label}
    </span>
  );
}

/**
 * One option of a question request: text, what it does, type, relevance and
 * placement. With `aiOff`, the reason no AI model answers, an option that
 * needs AI is greyed and does nothing: it stays in the list and takes the
 * keyboard focus, so that it can be read.
 */
export function OptionRow(props: {
  option: IOption;
  placement: IPlacement | null;
  onApply?: () => void;
  checked?: boolean;
  onToggle?: () => void;
  note?: string;
  aiOff?: string | null;
}): JSX.Element {
  const { option, placement, onApply, checked, onToggle, note } = props;
  const needs = needsAI(option);
  const checklist = onToggle !== undefined;
  const off = needs && props.aiOff ? props.aiOff : null;
  return (
    <button
      className={`jp-Epi-option${checklist ? ' jp-mod-checklist' : ''}${checked ? ' jp-mod-checked' : ''}${off ? ' jp-mod-disabled' : ''}`}
      onClick={off ? undefined : checklist ? onToggle : onApply}
      aria-pressed={checklist ? checked : undefined}
      aria-disabled={off ? 'true' : undefined}
      title={off ? `Needs an AI model: ${off}` : undefined}
    >
      {checklist && <span className="jp-Epi-checkbox" aria-hidden="true" />}
      <span className="jp-Epi-option-body">
        {option.origin === 'claude' || option.origin === 'local' ? (
          <span className="jp-Epi-option-text">
            <span className="jp-Epi-ai">{option.text}</span>
            <AITag
              by={option.by}
              verb="Proposed"
              title={
                option.kind
                  ? `${describeBy(option.by, 'Proposed')}. It reads the constant as ${option.kind}.`
                  : undefined
              }
            />
          </span>
        ) : (
          <span className="jp-Epi-option-text">{option.text}</span>
        )}
        <span className="jp-Epi-option-effect">
          {option.effect || option.reasons[0] || ''}
          {needs && <span className="jp-Epi-needs"> · needs AI</span>}
        </span>
        <span className="jp-Epi-option-meta">
          <TypeBadge type={option.type} />
          <Relevance value={option.probability} reasons={option.reasons} />
        </span>
      </span>
      <span className="jp-Epi-option-side">
        {note ? (
          <span className="jp-Epi-placement">{note}</span>
        ) : (
          <PlacementTag placement={placement} />
        )}
      </span>
    </button>
  );
}

/**
 * The rows of a list of questions. While no AI model answers, one line heads
 * the questions that need AI, which `runnableFirst` puts after the ones that
 * run.
 */
export function OptionRows<
  T extends Pick<IOption, 'id' | 'code' | 'action'>
>(props: {
  model: EpiModel;
  options: T[];
  children: (option: T) => JSX.Element;
}): JSX.Element {
  const first = props.model.aiOff() ? props.options.findIndex(needsAI) : -1;
  return (
    <>
      {props.options.map((option, index) => (
        <React.Fragment key={option.id}>
          {index === first && (
            <div className="jp-Epi-needs-line">These need an AI model</div>
          )}
          {props.children(option)}
        </React.Fragment>
      ))}
    </>
  );
}

/**
 * One line above questions that need AI, when no AI model answers them:
 * what is missing, and how to set a model up. The server's status gives both,
 * read without a call to the model.
 */
export function AIOffNote(props: { model: EpiModel }): JSX.Element | null {
  const off = props.model.aiOff();
  if (!off) {
    return null;
  }
  return (
    <div className="jp-Epi-aioff" role="note">
      Questions marked needs AI and your own questions are off: {off.reason}.
      {off.setup ? ` ${off.setup}` : ''}
    </div>
  );
}

/**
 * The reason the questions that need AI are off, for `OptionRow`, or null
 * when a model answers them.
 */
export function aiOffReason(model: EpiModel): string | null {
  return model.aiOff()?.reason ?? null;
}

/**
 * The arrow keys in a list of items that match `selector`, such as the
 * questions of a request or the variables: down and up move the focus to the
 * next and the previous item, Home and End to the first and the last.
 */
export function arrowKeys(
  selector: string
): (event: React.KeyboardEvent<HTMLElement>) => void {
  return event => {
    const target = event.target as HTMLElement;
    if (!target.matches?.(selector)) {
      return;
    }
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(selector)
    );
    const index = items.indexOf(target);
    const next =
      event.key === 'ArrowDown'
        ? items[Math.min(items.length - 1, index + 1)]
        : event.key === 'ArrowUp'
          ? items[Math.max(0, index - 1)]
          : event.key === 'Home'
            ? items[0]
            : event.key === 'End'
              ? items[items.length - 1]
              : null;
    if (next) {
      event.preventDefault();
      focusInView(next);
    }
  };
}

/**
 * Move the keyboard focus to an item of a list, and scroll the list just
 * enough to show it: an option that the arrow keys reach in a popover that
 * scrolls comes into sight (design iteration 1.83).
 */
export function focusInView(item: HTMLElement): void {
  item.focus({ preventScroll: true });
  item.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

/**
 * The keyboard in a list of questions: the arrow keys move between the
 * questions, and from the list itself to its first or last question. Enter
 * asks, as a button does; Escape closes the questions where the view handles
 * it.
 */
export function questionKeys(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.target === event.currentTarget) {
    const options =
      event.currentTarget.querySelectorAll<HTMLElement>('.jp-Epi-option');
    const next =
      event.key === 'ArrowDown' || event.key === 'Home'
        ? options[0]
        : event.key === 'ArrowUp' || event.key === 'End'
          ? options[options.length - 1]
          : undefined;
    if (next) {
      event.preventDefault();
      focusInView(next);
    }
    return;
  }
  arrowKeys('.jp-Epi-option')(event);
}

/**
 * The last way the analyst gave input: a key, or a pointer. A modifier held
 * for Shift+drop or Alt+drop is not a key press of its own.
 */
let lastInput: 'keyboard' | 'pointer' = 'pointer';
if (typeof document !== 'undefined') {
  document.addEventListener(
    'keydown',
    event => {
      if (!['Shift', 'Alt', 'Control', 'Meta'].includes(event.key)) {
        lastInput = 'keyboard';
      }
    },
    true
  );
  document.addEventListener(
    'pointerdown',
    () => {
      lastInput = 'pointer';
    },
    true
  );
}

/**
 * The search fields of Variables and Contents. A press or the focus in them
 * leaves the popover of a drop or a pick open, and its questions do not take
 * the focus from them: the analyst who clears the search after a pick keeps
 * the questions of the pick (design iteration 1.83).
 */
export const KEPT_SEARCHES =
  '.jp-Epi-variables .jp-Epi-search, .jp-Epi-contents .jp-Epi-search';

/**
 * The keyboard focus of the questions of a request, where they show: in the
 * popover, or in the Questions section when no popover opens. When the
 * questions come, the focus moves into them, unless the analyst put it in
 * them already, such as in the box for one's own question: to the first
 * question when they were asked from the keyboard, and else to the list, so
 * that a Space pressed to scroll asks nothing; from the list, the arrow keys
 * go to the questions. When they close with the focus in them, by Escape,
 * the close button or a pick, it goes back to where it was when they opened,
 * or else to the cell or the item they are about.
 */
export function useQuestionFocus(
  box: React.RefObject<HTMLElement>,
  model: EpiModel,
  active: boolean
): void {
  const ask = active ? model.ask : null;
  const id = ask?.id ?? null;
  const opener = React.useRef<{
    element: HTMLElement | null;
    ask: NonNullable<EpiModel['ask']>;
  } | null>(null);
  const focused = React.useRef<number | null>(null);
  const inside = React.useRef(false);
  // The element that had the focus when the questions opened.
  React.useLayoutEffect(() => {
    if (!ask) {
      return;
    }
    const current = document.activeElement as HTMLElement | null;
    const within = !!current && !!box.current?.contains(current);
    if (!within || !opener.current) {
      opener.current = {
        element: current && current !== document.body ? current : null,
        ask
      };
    } else {
      opener.current = { ...opener.current, ask };
    }
  }, [id]);
  // The first question takes the focus once it is there.
  React.useEffect(() => {
    const node = box.current;
    if (!ask || !node || focused.current === id) {
      return;
    }
    // The first question, or the first way to run what the questions need;
    // with none, once the request has its answer, the box for one's own
    // question, or else the list.
    const first = node.querySelector<HTMLElement>(
      '.jp-Epi-option, .jp-Epi-missing-actions button'
    );
    const settled = !ask.loading && (!ask.missing || ask.missing.plan !== null);
    if (!first && !settled) {
      return;
    }
    focused.current = id;
    // The analyst moved the focus into the questions while they loaded, to
    // the box for their own question or to the caret of the Ask button, or
    // types in the search of Variables or Contents, which leaves the popover
    // open: it stays where they put it.
    const current = document.activeElement;
    const moved =
      current instanceof HTMLElement &&
      current !== node &&
      (node.contains(current) || !!current.closest(KEPT_SEARCHES));
    if (moved) {
      return;
    }
    const field = node.querySelector<HTMLElement>(
      '.jp-Epi-ownbox input:not(:disabled)'
    );
    const target = lastInput === 'keyboard' ? (first ?? field) : null;
    if (target) {
      target.focus({ preventScroll: true });
    } else {
      node.tabIndex = -1;
      node.focus({ preventScroll: true });
    }
  });
  // Whether the focus is in the questions. A focused element that React
  // removes sends no event, so only a focus or a press elsewhere clears it.
  React.useEffect(() => {
    const track = (event: Event) => {
      const target = event.target as Node | null;
      inside.current = !!target && !!box.current?.contains(target);
    };
    document.addEventListener('focusin', track, true);
    document.addEventListener('pointerdown', track, true);
    return () => {
      document.removeEventListener('focusin', track, true);
      document.removeEventListener('pointerdown', track, true);
    };
  }, [box]);
  // The questions went with the focus in them: it goes back.
  React.useEffect(() => {
    if (ask || !opener.current) {
      return;
    }
    const { element, ask: closed } = opener.current;
    opener.current = null;
    focused.current = null;
    const lost =
      !document.activeElement || document.activeElement === document.body;
    if (!inside.current || !lost) {
      inside.current = false;
      return;
    }
    inside.current = false;
    const back =
      element && element.isConnected ? element : openerOf(model, closed);
    back?.focus({ preventScroll: true });
  }, [id]);
}

/**
 * Where the focus goes back to when the element that opened the questions is
 * gone, as a target of Click mode is once picked: the cell the questions are
 * about, in the view, or the item in the Variables panel.
 */
function openerOf(
  model: EpiModel,
  ask: NonNullable<EpiModel['ask']>
): HTMLElement | null {
  const cellId =
    ask.kind === 'drop'
      ? (ask.target.cellId ?? null)
      : ask.kind === 'cells'
        ? (ask.cells[0] ?? null)
        : 'cellId' in ask
          ? ask.cellId
          : null;
  const view = document.querySelector('.jp-Epi-main');
  const cell = cellId ? cellElement(view, cellId) : null;
  if (cell instanceof HTMLElement) {
    if (!cell.hasAttribute('tabindex')) {
      cell.setAttribute('tabindex', '-1');
    }
    return cell;
  }
  const item =
    ask.kind === 'drop' ? (ask.target.item ?? ask.source) : model.armed;
  if (item?.kind === 'variable') {
    return document.querySelector<HTMLElement>(
      `.jp-Epi-variable[data-variable="${CSS.escape(item.name)}"]`
    );
  }
  return null;
}

/** The microphone's name for each state, for screen readers. */
const VOICE_LABELS: Record<IVoice['state'], string> = {
  off: 'Ask by voice, off in the settings',
  checking: 'Ask by voice, checking',
  ready: 'Ask by voice',
  download: 'Download speech recognition to ask by voice',
  downloading: 'Downloading speech recognition',
  unavailable: 'Ask by voice, not available',
  listening: 'Stop listening',
  writing: 'Writing the words'
};

/**
 * The microphone of a question box, for the engine chosen under Spoken
 * questions (src/ui/voice.tsx): grey while it cannot listen, with the
 * reason as its tooltip. A click listens, and a second click or Escape
 * stops; the words fill the box, and nothing is asked until Enter.
 */
function VoiceButton(props: { voice: IVoice }): JSX.Element {
  const { voice } = props;
  const live =
    voice.state === 'ready' ||
    voice.state === 'download' ||
    voice.state === 'listening';
  const busy = voice.state === 'downloading' || voice.state === 'writing';
  return (
    <button
      type="button"
      className={`jp-Epi-voice${live || busy ? ' jp-mod-live' : ''}`}
      data-state={voice.state}
      aria-disabled={live ? undefined : 'true'}
      aria-pressed={voice.state === 'listening'}
      aria-busy={busy || voice.state === 'checking' ? true : undefined}
      aria-label={VOICE_LABELS[voice.state]}
      title={voice.title}
      onClick={event => {
        event.preventDefault();
        voice.toggle();
      }}
    >
      {busy ? (
        <span className="jp-Epi-spinner" />
      ) : (
        <microphoneIcon.react tag="span" />
      )}
    </button>
  );
}

/**
 * A question of one's own, in a box like the questions offered. Enter asks
 * it, and its cell goes where the box says; the menu of the Ask button picks
 * another place. Shift+Enter makes it a branch and Alt+Enter explores it in
 * parallel, as Shift and Alt do on a drop. An AI model writes the cell.
 */
export function OwnQuestion(props: {
  model: EpiModel;
  onAsk: (text: string, how: IAskHow) => void;
  placeholder?: string;
  /** Where the answer can go, the default first; none leaves it to the caller. */
  places?: IPlacement[];
  /** Whether Alt+Enter can add the question to an exploration in parallel. */
  parallel?: boolean;
}): JSX.Element {
  const { model, onAsk } = props;
  const places = props.places ?? [];
  const [text, setText] = React.useState('');
  const [chosen, setChosen] = React.useState<IPlacement | null>(null);
  const [open, setOpen] = React.useState(false);
  // The item of the menu that takes the focus: asked for by a key.
  const [focusItem, setFocusItem] = React.useState<IFocusItem | null>(null);
  const split = React.useRef<HTMLSpanElement>(null);
  const toggle = () =>
    split.current?.querySelector<HTMLElement>('.jp-Epi-split-toggle') ?? null;
  // The menu closes; after a key or a pick, the focus goes back to its toggle.
  const closeMenu = (back: boolean) => {
    setOpen(false);
    setFocusItem(null);
    if (back) {
      toggle()?.focus();
    }
  };
  const openMenu = (at: IFocusItem['at'] | null) => {
    setOpen(true);
    setFocusItem(at ? { at, count: (focusItem?.count ?? 0) + 1 } : null);
  };
  const field = React.useRef<HTMLSpanElement>(null);
  const available = model.aiReady('cells');
  const question = text.trim();
  const input = () => field.current?.querySelector('input') ?? null;
  const voice = useVoice({
    model,
    enabled: available,
    text: () => input()?.value ?? '',
    write: setText,
    focus: () => input()?.focus()
  });
  // The model chosen for typed questions sorts the text once the typing stops.
  const kinds = places.map(place => place.kind).join(' ');
  React.useEffect(() => {
    if (!question) {
      return;
    }
    const timer = window.setTimeout(
      () => void model.sortOwn(question, places),
      300
    );
    return () => window.clearTimeout(timer);
  }, [model, question, kinds]);
  const typed = model.ownType(question);
  const suggested = model.ownPlace(question, places);
  // A place picked in the menu stays while the request offers it.
  const pickedPlace = chosen
    ? places.find(place => place.label === chosen.label)
    : undefined;
  const place = pickedPlace ?? suggested.place;
  const placeBy = pickedPlace ? null : suggested.by;
  const branch = places.find(place => place.kind === 'branch') ?? null;
  const ask = (how: IAskHow) => {
    if (!question || !available) {
      return;
    }
    setText('');
    setChosen(null);
    setOpen(false);
    onAsk(question, how);
  };
  return (
    <form
      className="jp-Epi-own jp-Epi-ownbox"
      onSubmit={event => {
        event.preventDefault();
        ask(places.length ? { place } : {});
      }}
    >
      <div className="jp-Epi-own-row">
        <span className="jp-Epi-own-field" ref={field}>
          <InputGroup
            className="jp-Epi-own-input"
            type="text"
            value={text}
            disabled={!available}
            aria-label="Your own question"
            placeholder={
              available
                ? (props.placeholder ?? 'Your own question')
                : model.settings.models.cells === 'off'
                  ? 'AI is off for cells and answers in the settings'
                  : 'Needs an AI model on the server'
            }
            onChange={event => setText(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter') {
                return;
              }
              if (event.shiftKey && branch) {
                event.preventDefault();
                ask({ place: branch });
              } else if (event.altKey && props.parallel) {
                event.preventDefault();
                ask({ parallel: true });
              }
            }}
          />
          <VoiceButton voice={voice} />
        </span>
        <span className="jp-Epi-split" ref={split}>
          <Button
            type="submit"
            small
            className="jp-Epi-button jp-mod-styled jp-mod-accept"
            disabled={!available || !question}
          >
            {askLabel(place)}
          </Button>
          {places.length > 1 && (
            <Button
              type="button"
              small
              className="jp-Epi-button jp-mod-styled jp-mod-accept jp-Epi-split-toggle"
              aria-label="Where the answer goes"
              aria-haspopup="menu"
              aria-expanded={open}
              disabled={!available}
              onClick={event => {
                if (open) {
                  closeMenu(false);
                } else {
                  // Enter or Space clicks with no pointer: the focus goes in.
                  openMenu(event.detail === 0 ? 'current' : null);
                }
              }}
              onKeyDown={event => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  openMenu(event.key === 'ArrowDown' ? 'current' : 'last');
                }
              }}
            >
              <caretDownIcon.react tag="span" />
            </Button>
          )}
          {open && (
            <PlaceMenu
              anchor={split}
              places={places}
              current={place}
              parallel={!!props.parallel}
              focusItem={focusItem}
              onPick={picked => {
                setChosen(picked);
                closeMenu(true);
              }}
              onParallel={() => {
                ask({ parallel: true });
                closeMenu(true);
              }}
              onClose={closeMenu}
            />
          )}
        </span>
      </div>
      {voice.error && (
        <div className="jp-Epi-own-meta" role="status">
          {voice.error}
        </div>
      )}
      {question && (
        <div className="jp-Epi-own-meta">
          <TypeBadge type={typed.type} />
          {typed.by && (
            <AITag
              title={`Type chosen by ${typed.by}${typed.probability !== null ? `, ${Math.round(100 * typed.probability)}%` : ''}`}
            />
          )}
          {place && (
            <span className={placeBy ? 'jp-Epi-ai' : undefined}>
              {place.label}
            </span>
          )}
          {placeBy && <AITag title={`Place chosen by ${placeBy}`} />}
        </div>
      )}
    </form>
  );
}

/** How a typed question is asked: the place of its cell, or in parallel. */
export interface IAskHow {
  place?: IPlacement | null;
  parallel?: boolean;
}

/** The Ask button's word for a place, as a merge button names its method. */
function askLabel(place: IPlacement | null): string {
  switch (place?.kind) {
    case 'edit':
      return 'Edit';
    case 'branch':
      return 'Branch';
    case 'preview':
      return 'Preview';
    case 'new':
    case 'metadata':
    case undefined:
    default:
      return 'Ask';
  }
}

/**
 * A help icon: its text shows as the tooltip, and under the setting after a
 * click, for the keyboard and for touch screens.
 */
export function HelpButton(props: {
  label: string;
  text: string;
  open: boolean;
  onToggle: () => void;
  /** The button's name, when "What <label> controls" does not fit. */
  ariaLabel?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className="jp-Epi-help"
      title={props.text}
      aria-label={props.ariaLabel ?? `What ${props.label} controls`}
      aria-expanded={props.open}
      onClick={props.onToggle}
    >
      <helpIcon.react tag="span" />
    </button>
  );
}

/**
 * Close a popup when the user presses a pointer or moves keyboard focus
 * outside it: on the page, in another panel or in another document. The
 * listeners capture the events, so a widget that stops them still closes
 * the popup. `anchor` and the elements that match `keep`, such as a menu the
 * popup opened, count as inside.
 */
export function useDismiss(
  node: React.RefObject<HTMLElement>,
  onClose: () => void,
  options: { anchor?: React.RefObject<HTMLElement>; keep?: string } = {}
): void {
  const close = React.useRef(onClose);
  close.current = onClose;
  const { anchor, keep } = options;
  React.useEffect(() => {
    const outside = (target: EventTarget | null) => {
      if (!(target instanceof Node) || !target.isConnected) {
        return false;
      }
      if (node.current?.contains(target) || anchor?.current?.contains(target)) {
        return false;
      }
      const element = target instanceof Element ? target : target.parentElement;
      return !(keep && element?.closest(keep));
    };
    const dismiss = (event: Event) => {
      if (outside(event.target)) {
        close.current();
      }
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('focusin', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('focusin', dismiss, true);
    };
  }, [node, anchor, keep]);
}

/** The item of the Ask menu that a key sends the focus to, once per request. */
interface IFocusItem {
  /** The place chosen now, or the last item. */
  at: 'current' | 'last';
  count: number;
}

/**
 * The places of the Ask button, over the page as JupyterLab's menus are, so
 * that a short popover does not cut the menu. It opens under the button, or
 * over it when the window has no room below, and closes on a click outside,
 * a scroll or a resize.
 *
 * From the keyboard: Enter, Space or the down arrow on the toggle opens the
 * menu with the focus on the place chosen now, and the up arrow on the last
 * item. The arrow keys move through the items, Home and End go to the first
 * and the last, Enter picks, and Escape and Tab close the menu with the focus
 * back on its toggle, from which Tab goes on.
 */
function PlaceMenu(props: {
  anchor: React.RefObject<HTMLElement>;
  places: IPlacement[];
  current: IPlacement | null;
  parallel: boolean;
  focusItem: IFocusItem | null;
  onPick: (place: IPlacement) => void;
  onParallel: () => void;
  /** `back` gives the focus back to the toggle: after a key or a pick. */
  onClose: (back: boolean) => void;
}): JSX.Element {
  const { anchor, onClose, focusItem } = props;
  const node = React.useRef<HTMLDivElement>(null);
  const items = () =>
    Array.from(node.current?.querySelectorAll<HTMLElement>('button') ?? []);
  React.useEffect(() => {
    if (!focusItem) {
      return;
    }
    const list = items();
    const target =
      focusItem.at === 'last'
        ? list[list.length - 1]
        : (list.find(item => item.getAttribute('aria-checked') === 'true') ??
          list[0]);
    target?.focus({ preventScroll: true });
  }, [focusItem]);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const index = list.indexOf(event.target as HTMLElement);
    let next: HTMLElement | undefined;
    switch (event.key) {
      case 'ArrowDown':
        next = list[(index + 1) % list.length];
        break;
      case 'ArrowUp':
        next = list[(index - 1 + list.length) % list.length];
        break;
      case 'Home':
        next = list[0];
        break;
      case 'End':
        next = list[list.length - 1];
        break;
      case 'Tab':
        // The focus goes back to the toggle: Tab goes on from there, and
        // Shift+Tab stops on it.
        if (event.shiftKey) {
          event.preventDefault();
        }
        onClose(true);
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    next?.focus();
  };
  const [position, setPosition] = React.useState<{
    left: number;
    top: number;
  } | null>(null);
  React.useLayoutEffect(() => {
    const button = anchor.current?.getBoundingClientRect();
    const menu = node.current?.getBoundingClientRect();
    if (!button || !menu) {
      return;
    }
    const below = window.innerHeight - button.bottom - 8;
    const top =
      below >= menu.height || button.top - 8 < menu.height
        ? button.bottom + 2
        : button.top - 2 - menu.height;
    const left = Math.min(
      Math.max(8, button.right - menu.width),
      window.innerWidth - menu.width - 8
    );
    setPosition({ left, top });
  }, [anchor]);
  useDismiss(node, () => onClose(false), { anchor });
  React.useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose(true);
      }
    };
    // The button moves with a scroll or a resize, and the menu would not.
    const moved = (event: Event) => {
      if (!node.current?.contains(event.target as Node)) {
        onClose(false);
      }
    };
    window.addEventListener('scroll', moved, true);
    window.addEventListener('resize', moved);
    node.current?.addEventListener('keydown', escape);
    const current = node.current;
    return () => {
      window.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', moved);
      current?.removeEventListener('keydown', escape);
    };
  }, [anchor, onClose]);
  const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  return ReactDOM.createPortal(
    <div
      className="jp-Epi-placemenu"
      role="menu"
      aria-label="Where the answer goes"
      ref={node}
      onKeyDown={onKeyDown}
      style={
        position
          ? { left: position.left, top: position.top }
          : { left: -9999, top: -9999 }
      }
    >
      {props.places.map(place => (
        <button
          key={place.label}
          type="button"
          role="menuitemradio"
          tabIndex={-1}
          aria-checked={place.label === props.current?.label}
          onClick={() => props.onPick(place)}
        >
          <span className="jp-Epi-placemenu-check" aria-hidden="true">
            {place.label === props.current?.label ? '✓' : ''}
          </span>
          <span>{upper(place.label)}</span>
          {place.kind === 'branch' && (
            <kbd className="jp-Epi-placemenu-key">Shift+Enter</kbd>
          )}
        </button>
      ))}
      {props.parallel && (
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="jp-Epi-placemenu-parallel"
          onClick={props.onParallel}
        >
          <span className="jp-Epi-placemenu-check" aria-hidden="true" />
          <span>Explore in parallel, with the options checked</span>
          <kbd className="jp-Epi-placemenu-key">Alt+Enter</kbd>
        </button>
      )}
    </div>,
    document.body
  );
}

export function setDragItem(event: React.DragEvent, item: IItem): void {
  event.dataTransfer.setData(ITEM_MIME, JSON.stringify(item));
  event.dataTransfer.setData('text/plain', itemName(item));
  event.dataTransfer.effectAllowed = 'copyMove';
}

export function dragItem(event: {
  dataTransfer: DataTransfer | null;
}): IItem | null {
  const text = event.dataTransfer?.getData(ITEM_MIME);
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as IItem;
  } catch {
    return null;
  }
}

export function carriesItem(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(ITEM_MIME);
}

export function modifiersOf(
  event: { shiftKey: boolean; altKey: boolean },
  model: EpiModel
): { branch: boolean; parallel: boolean } {
  return {
    branch: event.shiftKey || model.pickModifiers.branch,
    parallel: event.altKey || model.pickModifiers.parallel
  };
}

export function anchorOf(event: { clientX: number; clientY: number }): IAnchor {
  return { x: event.clientX, y: event.clientY };
}

/**
 * Whether an element is laid out now. It is not in a cell that the browser
 * skips while the cell is far from the window (`content-visibility: auto`):
 * a size read there would lay the cell out at once, one cell after another,
 * and its ResizeObserver reports the size when the cell comes near.
 */
export function laidOut(node: Element): boolean {
  const check = (
    node as Element & {
      checkVisibility?: (options: {
        contentVisibilityAuto: boolean;
      }) => boolean;
    }
  ).checkVisibility;
  return (
    typeof check !== 'function' ||
    check.call(node, { contentVisibilityAuto: true })
  );
}

/**
 * The inner width of an element, kept current as the element resizes.
 */
export function useWidth(
  ref: React.RefObject<HTMLElement>,
  fallback: number
): number {
  const [width, setWidth] = React.useState(fallback);
  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    const measure = () => {
      if (!laidOut(node)) {
        return;
      }
      const style = window.getComputedStyle(node);
      const inner =
        node.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight);
      if (inner > 0) {
        setWidth(Math.floor(inner));
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return width;
}

export function itemName(item: IItem): string {
  return item.kind === 'variable' ? item.name : item.label;
}

/**
 * What the file browser puts in a drag: the paths of the dragged files.
 */
export const FILES_MIME = 'application/x-jupyter-icontents';

/**
 * The part of a Lumino drag event that a drop target reads and sets.
 */
interface IFileDragEvent extends MouseEvent {
  readonly mimeData: {
    hasData(mime: string): boolean;
    getData(mime: string): unknown;
  };
  readonly proposedAction: string;
  dropAction: string;
}

const DRAG_EVENTS = ['lm-dragenter', 'lm-dragleave', 'lm-dragover', 'lm-drop'];

/** The paths of the files that a Lumino drag from the file browser holds. */
function dragPaths(drag: IFileDragEvent): string[] {
  const paths = drag.mimeData.getData(FILES_MIME);
  return Array.isArray(paths) ? paths.map(String) : [];
}

/**
 * Accept files dragged from the file browser. The file browser starts a
 * Lumino drag, which sends lm-* events instead of HTML5 drag events.
 *
 * `onOver` says whether the files are over the element, with their paths.
 * Lumino sends a leave each time the pointer goes from one element to the
 * next, with the element entered as the related target, so a move between
 * two elements of the drop zone, such as the cells of a table in a card,
 * keeps it over. A zone inside another one, as a card in the bench, takes
 * the files dropped on it, and the outer zone counts the pointer as out
 * while it is over the inner one.
 */
export function useFileDrop(
  ref: React.RefObject<HTMLElement>,
  onDrop: (paths: string[], anchor: IAnchor) => void,
  onOver: (over: boolean, paths?: string[]) => void,
  /** Where the pointer is while the files are over the element, in the pixels of the window. */
  onMove?: (x: number, y: number) => void
): void {
  const handlers = React.useRef({ onDrop, onOver, onMove });
  handlers.current = { onDrop, onOver, onMove };
  React.useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    node.dataset.filedrop = '';
    const within = (target: EventTarget | null) =>
      target instanceof Element && target.closest('[data-filedrop]') === node;
    const handle = (event: Event) => {
      const drag = event as IFileDragEvent;
      if (!drag.mimeData?.hasData(FILES_MIME)) {
        return;
      }
      drag.preventDefault();
      drag.stopPropagation();
      if (event.type === 'lm-dragenter') {
        handlers.current.onOver(true, dragPaths(drag));
        handlers.current.onMove?.(drag.clientX, drag.clientY);
      } else if (event.type === 'lm-dragleave') {
        if (!within(drag.relatedTarget)) {
          handlers.current.onOver(false);
        }
      } else if (event.type === 'lm-dragover') {
        drag.dropAction = drag.proposedAction;
        handlers.current.onMove?.(drag.clientX, drag.clientY);
      } else {
        drag.dropAction = drag.proposedAction;
        handlers.current.onOver(false);
        const paths = dragPaths(drag);
        if (paths.length) {
          handlers.current.onDrop(paths, anchorOf(drag));
        }
      }
    };
    for (const type of DRAG_EVENTS) {
      node.addEventListener(type, handle);
    }
    return () => {
      delete node.dataset.filedrop;
      for (const type of DRAG_EVENTS) {
        node.removeEventListener(type, handle);
      }
    };
  }, [ref]);
}

/**
 * A close button with JupyterLab's close icon.
 */
/** What a copy puts on the clipboard: text, and HTML or a picture when there is one. */
export interface ICopied {
  text: string;
  html?: string;
  png?: Blob | null;
}

/** Put text, HTML and a PNG picture on the clipboard, whichever are given. */
export async function copyToClipboard(copied: ICopied): Promise<void> {
  const items: Record<string, Blob> = {
    'text/plain': new Blob([copied.text], { type: 'text/plain' })
  };
  if (copied.html) {
    items['text/html'] = new Blob([copied.html], { type: 'text/html' });
  }
  if (copied.png) {
    items['image/png'] = copied.png;
  }
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem(items)]);
  } else {
    await navigator.clipboard.writeText(copied.text);
  }
}

/** The colour behind an element: the first ancestor that paints one. */
function backgroundOf(element: Element): string {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (color && color !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(color)) {
      return color;
    }
  }
  return '#fff';
}

/**
 * A PNG picture of an SVG element as it is drawn now, on the colour behind
 * it, with the title above it when one is given.
 */
export async function svgToPng(
  svg: SVGSVGElement,
  title?: Element | null
): Promise<Blob | null> {
  const box = svg.getBoundingClientRect();
  const heading = title?.textContent?.trim() ?? '';
  const headStyle = heading ? getComputedStyle(title!) : null;
  const headHeight = heading ? title!.getBoundingClientRect().height + 4 : 0;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  // The page's styles colour the plot: copy the computed ones onto the clone.
  const source = svg.querySelectorAll('*');
  clone.querySelectorAll('*').forEach((node, index) => {
    const style = getComputedStyle(source[index]);
    (node as SVGElement).setAttribute(
      'style',
      `fill:${style.fill};stroke:${style.stroke};stroke-width:${style.strokeWidth};opacity:${style.opacity};font:${style.font}`
    );
  });
  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(clone)], {
      type: 'image/svg+xml'
    })
  );
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    const scale = 2;
    canvas.width = Math.round(box.width * scale);
    canvas.height = Math.round((box.height + headHeight) * scale);
    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }
    context.scale(scale, scale);
    context.fillStyle = backgroundOf(svg);
    context.fillRect(0, 0, box.width, box.height + headHeight);
    if (headStyle) {
      context.fillStyle = headStyle.color;
      context.font = `${headStyle.fontWeight} ${headStyle.fontSize} ${headStyle.fontFamily}`;
      context.textBaseline = 'top';
      context.fillText(heading, 0, 2);
    }
    context.drawImage(image, 0, headHeight, box.width, box.height);
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A copy button: a selection in the view asks a question, so copying needs
 * a button of its own. It says "Copied" for a moment after a copy.
 */
export function CopyButton(props: {
  label: string;
  copy: () => ICopied | Promise<ICopied>;
  className?: string;
}): JSX.Element {
  const [state, setState] = React.useState<'idle' | 'copied' | 'failed'>(
    'idle'
  );
  const title =
    state === 'copied'
      ? 'Copied'
      : state === 'failed'
        ? 'The browser did not allow the copy'
        : props.label;
  return (
    <button
      type="button"
      className={`jp-Epi-copy${props.className ? ` ${props.className}` : ''}${state === 'copied' ? ' jp-mod-copied' : ''}`}
      title={title}
      aria-label={props.label}
      onMouseDown={event => event.stopPropagation()}
      onClick={async event => {
        event.stopPropagation();
        try {
          await copyToClipboard(await props.copy());
          setState('copied');
        } catch (error) {
          console.warn('Copy failed', error);
          setState('failed');
        }
        window.setTimeout(() => setState('idle'), 1500);
      }}
    >
      <copyIcon.react tag="span" elementPosition="center" />
      {state === 'copied' && <span className="jp-Epi-copy-done">Copied</span>}
    </button>
  );
}

export function CloseButton(props: {
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <Button
      minimal
      small
      className="jp-Epi-close"
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
    >
      <closeIcon.react tag="span" elementPosition="center" />
    </Button>
  );
}

/** The element of a cell in a view: a card, a map node or a note. */
export function cellElement(
  root: Element | null,
  cellId: string
): Element | null {
  return root?.querySelector(`[data-cell-id="${CSS.escape(cellId)}"]`) ?? null;
}

/** Outlines an element for a moment, to show where it is. */
export function flash(element: Element): void {
  element.classList.remove('jp-mod-flash');
  // A reflow restarts the animation of an element that flashes already.
  void (element as HTMLElement).offsetWidth;
  element.classList.add('jp-mod-flash');
  const end = (event: Event) => {
    if ((event as AnimationEvent).animationName === 'jp-epi-flash') {
      element.classList.remove('jp-mod-flash');
      element.removeEventListener('animationend', end);
    }
  };
  element.addEventListener('animationend', end);
}

/** A smooth scroll, unless the analyst asked for less motion. */
export function scrollBehavior(): ScrollBehavior {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth';
}
