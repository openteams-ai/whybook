import {
  Button,
  caretDownIcon,
  caretRightIcon,
  InputGroup
} from '@jupyterlab/ui-components';
import * as React from 'react';

import type { ICellPart, Segment } from '../model/cost';
import {
  COST_KINDS,
  GO_ON_USD,
  KIND_LABELS,
  callsText,
  capReached,
  unpricedOf,
  exactUsd,
  formatUsd,
  parseCap,
  unpricedText
} from '../model/cost';
import type { EpiModel } from '../model/epimodel';
import type { ICostSum } from '../tokens';

/** The button past the notebook's cap: it raises the cap and starts the answer. */
export const GO_ON_LABEL = `Go on, for up to $${GO_ON_USD} more`;

/** The tooltip of the Cost section: what counts, and what the cap holds. */
export const COST_HELP =
  'What the model calls of this notebook cost: its answers, its titles, the labels of its tables, ' +
  'the summaries of its frames, the order of its questions and the rest, each call once. ' +
  'A call whose model has no known price, such as a model on Hugging Face or on a model server of yours, ' +
  'is not in the total, and does not count against the cap. A model on this machine costs nothing. ' +
  'The total stays when cells go.';

/**
 * An amount as the view shows it, "$0.00041", with the exact amount on
 * hover: "$0.000412, 0.041 cents".
 */
export function Usd(props: { value: number }): JSX.Element {
  return (
    <span className="jp-Epi-usd" title={exactUsd(props.value)}>
      {formatUsd(props.value)}
    </span>
  );
}

/** How many calls a sum counts; those without a known price are in its tooltip. */
function Calls(props: { sum: ICostSum }): JSX.Element {
  const note = unpricedOf(props.sum);
  return (
    <td className="jp-Epi-cost-calls" title={note ?? undefined}>
      {callsText(props.sum)}
      {note && '*'}
    </td>
  );
}

/** Words with amounts in them, each amount with its exact value on hover. */
export function CostText(props: { segments: Segment[] }): JSX.Element {
  return (
    <>
      {props.segments.map((segment, index) =>
        typeof segment === 'string' ? (
          <React.Fragment key={index}>{segment}</React.Fragment>
        ) : (
          <Usd key={index} value={segment.usd} />
        )
      )}
    </>
  );
}

/**
 * The Cost section of the Exploration panel, behind the setting "Cost of AI
 * answers": what the notebook's model calls cost in all, where it went by
 * kind, and the notebook's cap, which the analyst sets here and the
 * notebook keeps.
 */
export function CostBlock(props: { model: EpiModel }): JSX.Element {
  const { model } = props;
  const cost = model.cost();
  const record = model.costRecord();
  const cap = model.costCap();
  const reached = capReached(cost.usd, cap);
  const shown = cap === null ? '' : cap.toFixed(2);
  const [text, setText] = React.useState(shown);
  const [open, setOpen] = React.useState(false);
  // The field follows a cap that changes elsewhere, as Go on raises it.
  React.useEffect(() => setText(shown), [shown]);
  const id = React.useId();
  const parsed = parseCap(text);
  const changed = parsed.ok && parsed.value !== cap;
  const share = cap === null ? 0 : cap > 0 ? Math.min(1, cost.usd / cap) : 1;
  const kinds = COST_KINDS.filter(kind => record[kind]);
  return (
    <div className="jp-Epi-block jp-Epi-cost">
      <div className="jp-Epi-block-head" title={COST_HELP}>
        <span>Cost</span>
        <span className="jp-Epi-big">
          <Usd value={cost.usd} />
        </span>
      </div>
      {cap !== null && (
        <div
          className={`jp-Epi-cost-meter${reached ? ' jp-mod-reached' : ''}`}
          role="meter"
          aria-label="What the model calls cost, against the cap"
          aria-valuemin={0}
          aria-valuemax={cap}
          aria-valuenow={Math.min(cost.usd, cap)}
        >
          <span style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
      )}
      <div className={`jp-Epi-caption${reached ? ' jp-Epi-cost-reached' : ''}`}>
        {cap === null ? (
          'No cap on this notebook.'
        ) : (
          <>
            <Usd value={cost.usd} /> of <Usd value={cap} />
            {reached
              ? ': an answer that needs a model waits until you go on.'
              : '.'}
          </>
        )}
      </div>
      {kinds.length > 0 && (
        <>
          <button
            type="button"
            className="jp-Epi-cost-fold"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? (
              <caretDownIcon.react tag="span" />
            ) : (
              <caretRightIcon.react tag="span" />
            )}
            Where it went
          </button>
          {open && (
            <table className="jp-Epi-cost-kinds">
              <tbody>
                {kinds.map(kind => (
                  <tr key={kind}>
                    <th scope="row">{KIND_LABELS[kind]}</th>
                    <Calls sum={record[kind]!} />
                    <td>
                      <Usd value={record[kind]!.usd} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <form
        className="jp-Epi-cost-cap"
        onSubmit={event => {
          event.preventDefault();
          if (parsed.ok && changed) {
            model.setCostCap(parsed.value);
          }
        }}
      >
        <label htmlFor={id}>Cap, in US dollars</label>
        <InputGroup
          id={id}
          className="jp-Epi-cost-input"
          type="text"
          inputMode="decimal"
          value={text}
          placeholder="No cap"
          aria-invalid={!parsed.ok}
          onChange={event => setText(event.target.value)}
        />
        <Button
          type="submit"
          small
          className="jp-Epi-button jp-mod-styled jp-mod-accept"
          disabled={!changed}
        >
          Set
        </Button>
        {cap !== null && (
          <button
            type="button"
            className="jp-Epi-link"
            onClick={() => model.setCostCap(null)}
          >
            Remove
          </button>
        )}
      </form>
      {!parsed.ok && (
        <div className="jp-Epi-caption jp-Epi-cost-invalid" role="alert">
          A cap is a number of US dollars, such as 2 or 0.50.
        </div>
      )}
      {cost.unpriced > 0 && (
        <div className="jp-Epi-caption jp-Epi-cost-unpriced" title={COST_HELP}>
          {unpricedText(cost.unpriced)}
        </div>
      )}
    </div>
  );
}

/**
 * The Cost section's body in Cell details: how the cell's code came to be,
 * with the cost of the answer or the run that wrote it, and what models did
 * for the cell, with what each part cost.
 */
export function CellCost(props: {
  writer: Segment[];
  parts: ICellPart[];
}): JSX.Element {
  const { writer, parts } = props;
  return (
    <>
      <p className="jp-Epi-caption jp-Epi-details-cost">
        <CostText segments={writer} />
      </p>
      {parts.length > 0 && (
        <table className="jp-Epi-cost-kinds jp-Epi-cost-parts">
          <caption>What models did for this cell</caption>
          <tbody>
            {parts.map(part => (
              <tr key={part.kind}>
                <th scope="row">{part.label}</th>
                {part.sum ? (
                  <>
                    <Calls sum={part.sum} />
                    <td>
                      <Usd value={part.sum.usd} />
                    </td>
                  </>
                ) : (
                  <td colSpan={2} className="jp-Epi-cost-none">
                    cost not recorded
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/**
 * Why an answer did not start at the notebook's cap, or why a run stopped
 * there, with the way past the cap. A run cannot go on from where it
 * stopped: its button asks the question again, and says so.
 */
export function CapNote(props: {
  model: EpiModel;
  onGoOn: () => void;
  /** An agent's run that the cap stopped, rather than an answer that did not start. */
  stopped?: boolean;
}): JSX.Element {
  const { model } = props;
  const total = model.cost().usd;
  const cap = model.costCap();
  const numbers =
    cap === null ? (
      <Usd value={total} />
    ) : (
      <>
        <Usd value={total} /> of <Usd value={cap} />
      </>
    );
  return (
    <div className="jp-Epi-capnote">
      <span className="jp-Epi-capnote-text">
        {props.stopped ? (
          <>
            Stopped at the notebook's cap: {numbers}. Go on asks the question
            again from the start, and the cells of this run stay.
          </>
        ) : (
          <>The notebook's cap is reached: {numbers}.</>
        )}
      </span>
      <Button
        small
        className="jp-Epi-button jp-mod-styled jp-mod-accept"
        onClick={props.onGoOn}
      >
        {GO_ON_LABEL}
      </Button>
    </div>
  );
}
