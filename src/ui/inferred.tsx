import * as React from 'react';

import type { EpiModel } from '../model/epimodel';
import type { IInferred, InferredKind } from '../model/inferred';
import { chipText, chipTitle } from '../model/inferred';
import type { IOption } from '../tokens';
import { AITag } from './common';

/**
 * The outcome and the unit that the questions below take from the notebook,
 * each as a chip that says where it came from (design iterations 1.59 and
 * 1.64): "outcome pain_score · inferred from [5]", "unit home_id · inferred
 * from meter_readings", or "outcome kwh_import · inferred by AI" with the AI
 * tag. A click on a chip lists the other candidates, and a click on one of
 * them makes it the analyst's choice, and asks the questions again: there is
 * no select to fill in. A value that the notebook sets by hand shows no chip.
 */
export function InferredChips(props: {
  model: EpiModel;
  options: IOption[];
}): JSX.Element | null {
  const { model, options } = props;
  const [open, setOpen] = React.useState<InferredKind | null>(null);
  const lists = model.inferred();
  const label = (cellId: string) => model.cell(cellId)?.label ?? null;
  const chips: { kind: InferredKind; entry: IInferred; others: IInferred[] }[] =
    [];
  for (const kind of ['outcome', 'unit'] as const) {
    const column = options.map(option => option.uses?.[kind]).find(Boolean);
    const hand = kind === 'outcome' ? lists.hand.outcome : lists.hand.unit;
    const list = kind === 'outcome' ? lists.outcomes : lists.units;
    const entry = list.find(item => item.column === column);
    if (!column || hand === column || !entry) {
      continue;
    }
    chips.push({
      kind,
      entry,
      others: list.filter(item => item.column !== column)
    });
  }
  if (!chips.length) {
    return null;
  }
  const shown = chips.find(chip => chip.kind === open);
  return (
    <div className="jp-Epi-inferred">
      <div className="jp-Epi-inferred-chips">
        {chips.map(({ kind, entry }) => (
          <button
            key={kind}
            className={`jp-Epi-inferred-chip${open === kind ? ' jp-mod-open' : ''}`}
            aria-expanded={open === kind}
            title={`${chipTitle(kind, entry, label)} Click to see the other ${kind}s found.`}
            onClick={() => setOpen(open === kind ? null : kind)}
          >
            <ChipWords kind={kind} entry={entry} label={label} />
          </button>
        ))}
      </div>
      {shown && (
        <div
          className="jp-Epi-inferred-others"
          role="group"
          aria-label={`Other ${shown.kind}s`}
        >
          {shown.others.length ? (
            <>
              <span className="jp-Epi-caption">Other {shown.kind}s found:</span>
              {shown.others.map(entry => (
                <button
                  key={entry.column}
                  className="jp-Epi-inferred-chip jp-mod-other"
                  title={`${chipTitle(shown.kind, entry, label)} Click to take it instead.`}
                  onClick={() => {
                    setOpen(null);
                    model.pickInferred(shown.kind, {
                      column: entry.column,
                      frame: entry.frame
                    });
                  }}
                >
                  <ChipWords kind={shown.kind} entry={entry} label={label} />
                </button>
              ))}
            </>
          ) : (
            <span className="jp-Epi-caption">
              No other {shown.kind} was found in the code, or by an AI model.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The words of a chip, with the AI tag after them for what a model named:
 * the tag follows the last word when the words wrap.
 */
function ChipWords(props: {
  kind: InferredKind;
  entry: IInferred;
  label: (cellId: string) => string | null;
}): JSX.Element {
  const { kind, entry, label } = props;
  return entry.by === 'model' ? (
    <span>
      <span className="jp-Epi-ai">{chipText(kind, entry, label)}</span>
      <AITag by={entry.model} verb="Named" />
    </span>
  ) : (
    <span>{chipText(kind, entry, label)}</span>
  );
}
