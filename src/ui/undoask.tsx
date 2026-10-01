import { Button } from '@jupyterlab/ui-components';
import * as React from 'react';

import type { EpiModel, IStrip } from '../model/epimodel';

/** "[5]", "[5] and helpers.py", "[5], [6] and helpers.py". */
function listed(items: string[]): string {
  return items.length > 1
    ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
    : (items[0] ?? '');
}

/** Put the focus on a cell's card, as the bench does when a control of the card goes. */
function focusCell(root: ParentNode, cellId: string | null): void {
  const cell = Array.from(
    root.querySelectorAll<HTMLElement>('[data-cell-id]')
  ).find(element => cellId !== null && element.dataset.cellId === cellId);
  if (!cell) {
    return;
  }
  if (!cell.hasAttribute('tabindex')) {
    cell.setAttribute('tabindex', '-1');
  }
  cell.focus({ preventScroll: true });
}

/**
 * The question that Undo of an answer, or Remove of an agent's run, asks
 * when the analyst changed what the answer wrote: one line in the strip,
 * not a dialog. The focus goes to the question when it opens. Keep, and
 * Escape, close it and give the focus back to the button that asked; Undo
 * anyway gives it to the cell of the answer.
 */
export function UndoAsk(props: {
  /** What the analyst changed: the labels of cells, and the names of files. */
  changed: string[];
  verb: 'Undo' | 'Remove';
  /** The button that asked, which takes the focus back on Keep. */
  back: React.RefObject<HTMLElement>;
  /** The cell that takes the focus after Undo anyway, if it is there. */
  cell: string | null;
  onConfirm: () => void;
  onKeep: () => void;
}): JSX.Element {
  const { changed, verb, back, cell, onConfirm, onKeep } = props;
  const question = React.useRef<HTMLDivElement>(null);
  const textId = React.useId();
  React.useEffect(() => {
    question.current?.focus();
  }, []);
  const keep = () => {
    onKeep();
    back.current?.focus();
  };
  const confirm = () => {
    // The strip goes with the answer: the cell's element stays.
    const root = question.current?.closest('.jp-Epi') ?? document;
    onConfirm();
    focusCell(root, cell);
  };
  return (
    <div
      ref={question}
      className="jp-Epi-capnote jp-Epi-undoask"
      role="group"
      aria-labelledby={textId}
      tabIndex={-1}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          keep();
        }
      }}
    >
      <span id={textId} className="jp-Epi-capnote-text">
        You changed {listed(changed)} since this answer.{' '}
        {verb === 'Undo'
          ? 'Undo removes your changes too.'
          : 'Remove deletes your changes too.'}
      </span>
      <Button
        small
        className="jp-Epi-button jp-mod-styled jp-mod-warn"
        onClick={confirm}
      >
        {verb} anyway
      </Button>
      <Button small className="jp-Epi-button jp-mod-styled" onClick={keep}>
        Keep
      </Button>
    </div>
  );
}

/** The question of a strip's Undo, while the strip asks it. */
export function StripUndoAsk(props: {
  model: EpiModel;
  strip: IStrip;
  /** The strip's Undo button. */
  back: React.RefObject<HTMLElement>;
}): JSX.Element | null {
  const { model, strip, back } = props;
  if (!strip.undoAsk) {
    return null;
  }
  // The cell that the question was about stays; an added cell goes.
  const cell =
    strip.cellId !== strip.insertedId ? strip.cellId : strip.placement.cell;
  return (
    <UndoAsk
      changed={strip.undoAsk}
      verb="Undo"
      back={back}
      cell={cell}
      onConfirm={() => model.undo(strip.cellId, true)}
      onKeep={() => model.dismissUndo(strip.cellId)}
    />
  );
}
