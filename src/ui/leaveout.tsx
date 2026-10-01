import { Button } from '@jupyterlab/ui-components';
import * as React from 'react';

import type { EpiModel } from '../model/epimodel';
import type { ICuts, IEnd, IExtremes } from '../model/leaveout';
import { rowsUpTo, ruleText, valueText } from '../model/leaveout';

function countText(rows: number): string {
  return `${rows.toLocaleString('en-US')} ${rows === 1 ? 'row' : 'rows'}`;
}

/**
 * The choices of one end: none, or every value up to one of those listed,
 * "0 or less, 5 rows". A cut takes the values before it too: a row of 2.1
 * does not stay while a row of 0 goes.
 */
function EndChoices(props: {
  label: string;
  name: string;
  ends: IEnd[];
  words: 'or less' | 'or more';
  picked: number | null;
  onPick: (index: number | null) => void;
}): JSX.Element {
  const { label, name, ends, words, picked, onPick } = props;
  return (
    <div
      className="jp-Epi-leaveout-end"
      role="radiogroup"
      aria-label={`${label}: which go`}
    >
      <span className="jp-Epi-leaveout-label">{label}</span>
      <label>
        <input
          type="radio"
          name={name}
          checked={picked === null}
          onChange={() => onPick(null)}
        />
        keep all
      </label>
      {ends.map((end, index) => (
        <label key={end.value}>
          <input
            type="radio"
            name={name}
            checked={picked === index}
            onChange={() => onPick(index)}
          />
          {`${valueText(end.value)} ${words}, ${countText(rowsUpTo(ends, index))}`}
        </label>
      ))}
    </div>
  );
}

/**
 * "Leave out these rows" under the quick look of a number (design iteration
 * 1.85): the analyst picks how far in from each end the rows go, and a cell
 * makes the clean frame, in the place that a kept quick look takes.
 */
export function LeaveOutRows(props: {
  model: EpiModel;
  extremes: IExtremes;
}): JSX.Element {
  const { model, extremes } = props;
  const [open, setOpen] = React.useState(false);
  const [cuts, setCuts] = React.useState<ICuts>({ low: null, high: null });
  const id = React.useId();
  if (!open) {
    return (
      <Button
        small
        className="jp-Epi-button jp-mod-styled jp-Epi-leaveout-open"
        onClick={() => setOpen(true)}
      >
        Leave out these rows
      </Button>
    );
  }
  const picked = cuts.low !== null || cuts.high !== null;
  const rows =
    (cuts.low === null ? 0 : rowsUpTo(extremes.lowest, cuts.low)) +
    (cuts.high === null ? 0 : rowsUpTo(extremes.highest, cuts.high));
  return (
    <fieldset className="jp-Epi-leaveout">
      <legend>
        Leave out the rows of {extremes.frame} where {extremes.column} is
      </legend>
      <EndChoices
        label="Lowest"
        name={`${id}-low`}
        ends={extremes.lowest}
        words="or less"
        picked={cuts.low}
        onPick={low => setCuts({ ...cuts, low })}
      />
      <EndChoices
        label="Highest"
        name={`${id}-high`}
        ends={extremes.highest}
        words="or more"
        picked={cuts.high}
        onPick={high => setCuts({ ...cuts, high })}
      />
      <p className="jp-Epi-leaveout-rule" aria-live="polite">
        {picked
          ? `${countText(rows)} go: ${ruleText(extremes, cuts)}.`
          : 'Pick the values that go.'}
      </p>
      <div className="jp-Epi-leaveout-actions">
        <Button
          small
          className="jp-Epi-button jp-mod-styled jp-mod-accept"
          disabled={!picked}
          onClick={() => void model.leaveOutRows(extremes, cuts)}
        >
          Write the cell
        </Button>
        <Button
          small
          className="jp-Epi-button jp-mod-styled"
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </fieldset>
  );
}
