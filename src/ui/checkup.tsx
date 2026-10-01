/**
 * The Check-up section at the end of the Exploration panel: a prototype of
 * design iterations 1.67, 1.68 (D) and 1.70, which the plugin of
 * ../checkup.ts adds to the view.
 */
import {
  Button,
  caretDownIcon,
  caretRightIcon
} from '@jupyterlab/ui-components';
import * as React from 'react';

import { checkupIcon } from '../icons';
import type {
  Checkup,
  ICheckupFinding,
  ICheckupQuestion
} from '../model/checkup';
import { CHECKUP_GROUPS, checkupOf, checkupQuestions } from '../model/checkup';
import type { EpiModel } from '../model/epimodel';
import type { IOption } from '../tokens';
import {
  AITag,
  ProgressBar,
  aiOffReason,
  flash,
  scrollBehavior,
  stageText,
  useModel,
  useSeconds
} from './common';

/** Draw again when the check-up changes. */
function useCheckup(checkup: Checkup): void {
  const [, setVersion] = React.useState(0);
  React.useEffect(() => {
    const update = () => setVersion(value => value + 1);
    checkup.changed.connect(update);
    return () => {
      checkup.changed.disconnect(update);
    };
  }, [checkup]);
}

/**
 * The Check-up section: one folded line at the end of the Exploration
 * panel, with the day of the last check-up in grey, and no note before the
 * first. Open, it shows what the rules find in four groups, and the
 * questions that a model or an agent answers, each with Ask. Nothing in it
 * moves, counts or takes a colour until the analyst opens it (1.70).
 *
 * Its head shows the icon of the Check-up beside the name, the icon that a
 * notebook's tab fades into (1.68). Opened from the tab, the section comes
 * into sight and is outlined for a moment, so that the eye finds it.
 */
export function CheckupSection(props: { model: EpiModel }): JSX.Element {
  const { model } = props;
  useModel(model);
  const checkup = checkupOf(model);
  useCheckup(checkup);
  const ref = React.useRef<HTMLDivElement>(null);
  const open = checkup.isOpen;
  React.useEffect(() => {
    const section = ref.current;
    if (open && checkup.takeReveal() && section) {
      section.scrollIntoView({
        block: 'start',
        behavior: scrollBehavior()
      });
      flash(section);
    }
  });
  const note = checkup.note();
  const Icon = open ? caretDownIcon : caretRightIcon;
  return (
    <div className="jp-Epi-block jp-Epi-checkup" ref={ref}>
      <button
        className="jp-Epi-block-head jp-Epi-checkup-head"
        aria-expanded={open}
        onClick={() => checkup.toggle()}
      >
        <span className="jp-Epi-checkup-title">
          <Icon.react tag="span" className="jp-Epi-checkup-caret" />
          <checkupIcon.react tag="span" className="jp-Epi-checkup-icon" />
          <span>Check-up</span>
        </span>
        {note.text && (
          <span
            className={`jp-Epi-section-count${note.hint ? ' jp-mod-hint' : ''}`}
            title={note.title}
          >
            {note.text}
          </span>
        )}
      </button>
      {open && <CheckupBody checkup={checkup} />}
    </div>
  );
}

/** The four groups of 1.67, with what the rules find now. */
function CheckupBody(props: { checkup: Checkup }): JSX.Element {
  const { checkup } = props;
  const model = checkup.model;
  const found = checkup.findings();
  // A kernel of another language: the view reads no names of its cells.
  const unread = model.unsupported('analysis');
  const questions = [...checkupQuestions.values()];
  return (
    <div className="jp-Epi-checkup-body">
      {CHECKUP_GROUPS.map(group => {
        const findings = found[group.id];
        // Run times, and the questions that reproduce the notebook in
        // another kernel, need no names read from the cells.
        const needsNames = group.id !== 'speed' && group.id !== 'reproduce';
        const note = unread && needsNames ? unread : found.notes[group.id];
        return (
          <section key={group.id} className="jp-Epi-checkup-group">
            <div className="jp-Epi-checkup-name">{group.label}</div>
            {!unread || !needsNames ? (
              <Findings model={model} findings={findings} />
            ) : null}
            {note && <div className="jp-Epi-caption">{note}</div>}
            {(group.id === 'review' || group.id === 'gaps') &&
              found.repeated[group.id] > 0 &&
              !unread && (
                <div className="jp-Epi-caption">
                  Worth asking next suggests {found.repeated[group.id]} more.
                </div>
              )}
            {questions
              .filter(question => question.group === group.id)
              .map(question => (
                <AddedQuestion
                  key={question.id}
                  model={model}
                  question={question}
                />
              ))}
            {group.id === 'review' && <ReviewerQuestion checkup={checkup} />}
          </section>
        );
      })}
    </div>
  );
}

/** What the rules found in a group: a click on a line shows its cell. */
function Findings(props: {
  model: EpiModel;
  findings: ICheckupFinding[];
}): JSX.Element | null {
  const { model, findings } = props;
  if (!findings.length) {
    return null;
  }
  return (
    <ul className="jp-Epi-checkup-found">
      {findings.map(finding => (
        <li key={finding.id}>
          {finding.cellId ? (
            <button
              className="jp-Epi-checkup-line"
              title="Show the cell"
              onClick={() => model.showCell(finding.cellId!)}
            >
              {finding.text}
            </button>
          ) : (
            <span className="jp-Epi-checkup-line">{finding.text}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** A question of the check-up that a model or an agent answers: what answers it, what it costs, and Ask. */
function QuestionCard(props: {
  text: string;
  how: string;
  cost: string;
  needsAI: boolean;
  /** Why Ask is off, or null. */
  off: string | null;
  onAsk: (() => void) | null;
  /** The words of the button: Ask, or Ask again once it answered. */
  askLabel?: string;
  children?: React.ReactNode;
}): JSX.Element {
  const { off } = props;
  return (
    <div className="jp-Epi-next jp-Epi-checkup-question">
      <div className="jp-Epi-next-text">{props.text}</div>
      <div className="jp-Epi-next-foot">
        <span className="jp-Epi-next-why">
          {props.how}
          <span className={props.needsAI ? 'jp-Epi-needs' : undefined}>
            {' '}
            · {props.cost}
          </span>
        </span>
        <Button
          small
          className="jp-Epi-button jp-mod-styled jp-mod-accept"
          disabled={!!off || !props.onAsk}
          title={off ?? undefined}
          onClick={() => props.onAsk?.()}
        >
          {props.askLabel ?? 'Ask'}
        </Button>
      </div>
      {props.children}
    </div>
  );
}

/**
 * A question that another part of the view answers, such as "Would I get
 * the same results in R?", which the agent of 1.69 answers in a notebook of
 * its own. Until that part fills it in, it shows, and Ask is off.
 */
function AddedQuestion(props: {
  model: EpiModel;
  question: ICheckupQuestion;
}): JSX.Element | null {
  const { model, question } = props;
  const ask = question.ask;
  // A question without words for this notebook does not show: "Would I get
  // the same results in R?" shows in the notebooks it is offered for.
  const text = question.text(model);
  if (!text) {
    return null;
  }
  // A question that needs AI is off, with the reason, without a model.
  const off = question.needsAI ? aiOffReason(model) : null;
  return (
    <QuestionCard
      text={text}
      how={question.how}
      cost={question.cost}
      needsAI={question.needsAI}
      off={ask ? (off ? `Needs an AI model: ${off}` : null) : 'Not built yet'}
      onAsk={ask ? () => ask(model) : null}
    >
      {!ask && <div className="jp-Epi-caption">Not built yet.</div>}
    </QuestionCard>
  );
}

/**
 * "What would a reviewer ask?": one call to the model of More questions,
 * when the analyst presses Ask. Its questions show under it, each asked
 * with one click as other questions of the view are.
 */
function ReviewerQuestion(props: { checkup: Checkup }): JSX.Element {
  const { checkup } = props;
  const model = checkup.model;
  const review = checkup.review;
  const asking = review.status === 'asking';
  const seconds = useSeconds(review.started ?? undefined, asking);
  const off = asking ? 'The model is asking' : checkup.reviewOff();
  const local = model.keepDataLocal;
  return (
    <QuestionCard
      text="What would a reviewer ask?"
      how={
        local
          ? 'A model reads the code and the titles of the cells; the outputs stay on this machine'
          : 'A model reads the code of the cells, their titles and what their outputs show'
      }
      cost="needs AI · one call"
      needsAI
      off={off}
      onAsk={() => void checkup.askReviewer()}
      askLabel={review.status === 'done' ? 'Ask again' : 'Ask'}
    >
      {asking && (
        <div className="jp-Epi-checkup-asking" role="status">
          <ProgressBar value={null} label="A model asks as a reviewer" wide />
          <span className="jp-Epi-caption">
            {stageText(review.stage, seconds)}
          </span>
        </div>
      )}
      {!asking && off && <div className="jp-Epi-caption">{off}</div>}
      {review.status === 'failed' && review.error && review.error !== off && (
        <div className="jp-Epi-error">{review.error}</div>
      )}
      {review.status === 'done' && review.questions.length === 0 && (
        <div className="jp-Epi-caption">
          The model asked nothing more <AITag by={review.by} verb="Asked" />
        </div>
      )}
      {review.questions.length > 0 && (
        <ul className="jp-Epi-checkup-review">
          {review.questions.map(option => (
            <ReviewRow key={option.id} model={model} option={option} />
          ))}
        </ul>
      )}
    </QuestionCard>
  );
}

/**
 * A question that the model asked as a reviewer: its words with the AI tag,
 * the cell it is about and why, and Ask, which asks it as the view's other
 * questions are asked. Without a model, Ask is off, with the reason.
 */
function ReviewRow(props: { model: EpiModel; option: IOption }): JSX.Element {
  const { model, option } = props;
  const off = aiOffReason(model);
  const cell = option.placement?.cell
    ? model.cell(option.placement.cell)
    : null;
  return (
    <li className="jp-Epi-checkup-asked">
      <span className="jp-Epi-checkup-asked-text">
        <span className="jp-Epi-ai">{option.text}</span>{' '}
        <AITag by={option.by} verb="Asked" />
      </span>
      <span className="jp-Epi-next-foot">
        <span className="jp-Epi-next-why">
          {cell ? `About ${cell.label}. ` : ''}
          {option.effect}
        </span>
        <Button
          small
          minimal
          className="jp-Epi-button"
          disabled={!!off}
          title={off ? `Needs an AI model: ${off}` : undefined}
          aria-label={`Ask: ${option.text}`}
          onClick={() => void model.apply(option)}
        >
          Ask
        </Button>
      </span>
    </li>
  );
}
