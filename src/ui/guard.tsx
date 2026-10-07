import { Dialog, showDialog } from '@jupyterlab/apputils';
import { HTMLSelect, ReactWidget } from '@jupyterlab/ui-components';
import * as React from 'react';

import type { ILocalModel } from '../model/api';
import type { EpiModel } from '../model/epimodel';
import type {
  GuardAnswer,
  GuardMode,
  IGuardEvent,
  IGuardMemory,
  IGuardSettings
} from '../model/guard';
import {
  byWords,
  DEFAULT_POLICY,
  excerpts,
  flagsByRule,
  heldWords,
  markedParts,
  SUGGESTED_GUARD_MODEL
} from '../model/guard';
import { HelpButton, useModel } from './common';
import { Segmented } from './segmented';

/**
 * The review guard's question, as a JupyterLab dialog (design iteration
 * 1.45, variant B): the whole text that would leave the machine, or the code
 * that would run, with the flagged parts marked; what each rule found and
 * which guard found it; and "Why is this fine?", kept for the session. The
 * text has no line numbers.
 */
export async function askGuard(
  event: IGuardEvent
): Promise<{ answer: GuardAnswer; note: string }> {
  const body = new GuardBody(event);
  const privacy = event.guard === 'privacy';
  const stop = Dialog.cancelButton({
    label: privacy ? "Don't send" : "Don't run"
  });
  const buttons = privacy
    ? event.choices.includes('mask')
      ? [
          stop,
          Dialog.warnButton({ label: 'Send as it is' }),
          Dialog.okButton({ label: 'Send without the marked parts' })
        ]
      : [stop, Dialog.warnButton({ label: 'Send as it is' })]
    : [
        stop,
        event.decision === 'reject'
          ? Dialog.warnButton({ label: 'Run anyway' })
          : Dialog.okButton({ label: 'Run' })
      ];
  const result = await showDialog({
    title: privacy
      ? 'Send this to a model on another machine?'
      : event.what === 'a cell' || event.what === 'the cell of an answer'
        ? 'Run this cell?'
        : 'Run this code?',
    body,
    buttons,
    // Enter takes the choice that sends or runs nothing flagged.
    defaultButton: buttons.length === 3 ? 2 : 0,
    hasClose: false
  });
  const label = result.button.label;
  const answer: GuardAnswer =
    label === 'Send without the marked parts'
      ? 'mask'
      : label === 'Send as it is'
        ? 'send'
        : label === 'Run' || label === 'Run anyway'
          ? 'run'
          : 'stop';
  return { answer, note: answer === 'stop' ? '' : body.note };
}

/** The body of the guard's dialog, which keeps the analyst's note. */
class GuardBody extends ReactWidget {
  constructor(private readonly _event: IGuardEvent) {
    super();
    this.addClass('jp-Epi-guard-dialog');
  }

  note = '';

  render(): JSX.Element {
    return (
      <GuardQuestion
        event={this._event}
        onNote={note => {
          this.note = note;
        }}
      />
    );
  }
}

function GuardQuestion(props: {
  event: IGuardEvent;
  onNote: (note: string) => void;
}): JSX.Element {
  const { event } = props;
  const privacy = event.guard === 'privacy';
  const groups = flagsByRule(event.flags);
  const marked = event.flags.some(flag => flag.text);
  const [note, setNote] = React.useState('');
  const [whole, setWhole] = React.useState(false);
  // A step's result arrives as one line of JSON: it shows indented.
  const shown = React.useMemo(() => readable(event.text), [event.text]);
  const pieces = whole ? null : excerpts(shown, event.flags);
  const lineCount = shown.split('\n').length;
  const text = React.useRef<HTMLPreElement>(null);
  React.useEffect(() => {
    // The whole text opens at its first flagged part.
    const box = text.current;
    const first = box?.querySelector('mark');
    if (box && first instanceof HTMLElement) {
      box.scrollTop = Math.max(0, first.offsetTop - box.offsetTop - 40);
    }
  }, [whole]);
  const marks = (part: string) =>
    markedParts(part, event.flags).map((piece, index) =>
      piece.flag ? (
        <mark
          key={index}
          className={`jp-Epi-guard-mark jp-mod-${
            piece.flag.kind === 'personal column' ? 'context' : piece.flag.level
          }`}
          title={
            piece.flag.kind === 'personal column'
              ? 'A column that holds personal details: it is not masked'
              : piece.flag.rule
          }
        >
          {piece.text}
        </mark>
      ) : (
        <React.Fragment key={index}>{piece.text}</React.Fragment>
      )
    );
  const lead = privacy
    ? `${capital(event.what)} would go to ${event.to ?? 'the remote model'}, a model on another machine. ${
        marked
          ? 'The guard flagged the parts below.'
          : 'A guard model flagged the text as a whole.'
      }`
    : `The AI wrote ${event.what}, which would run in this notebook\u2019s kernel. ${
        event.sandboxed
          ? 'The kernel runs in the sandbox: the network and the files outside the notebook\u2019s folder are out of its reach.'
          : 'The kernel runs outside the sandbox: the code reaches every file, program and network address that you can.'
      }`;
  return (
    <div className="jp-Epi-guard-question">
      <p className="jp-Epi-guard-lead">{lead}</p>
      <ul className="jp-Epi-guard-findings">
        {groups.map(group => (
          <li key={group.rule} className={`jp-mod-${group.level}`}>
            <span className="jp-Epi-guard-level">
              {group.level === 'reject' ? 'Likely wrong:' : 'Might be fine:'}
            </span>{' '}
            {group.rule}.
            {group.parts.length > 0 && (
              <span className="jp-Epi-guard-parts">
                {' '}
                Flagged: {group.parts.slice(0, 6).join(', ')}
                {group.parts.length > 6 ? ', and more' : ''}.
              </span>
            )}
            <span className="jp-Epi-guard-by">
              {' '}
              Found by {group.by.map(byWords).join(' and ')}
              {group.by.some(by => by !== 'rules' && by !== 'the remote model')
                ? ', on this machine'
                : ''}
              .
            </span>
          </li>
        ))}
      </ul>
      <div className="jp-Epi-guard-caption">
        {privacy ? 'The text that would leave this machine' : 'The code'}
        {pieces
          ? `: the lines with flagged parts, of ${lineCount}`
          : lineCount > 14
            ? `, ${lineCount} lines`
            : ''}
      </div>
      <pre className="jp-Epi-guard-text" ref={text}>
        {pieces
          ? pieces.map((piece, index) => (
              <React.Fragment key={index}>
                {piece.skippedBefore && (
                  <span className="jp-Epi-guard-gap">{'\u22ef\n'}</span>
                )}
                {marks(piece.text)}
                {'\n'}
                {piece.skippedAfter && (
                  <span className="jp-Epi-guard-gap">{'\u22ef'}</span>
                )}
              </React.Fragment>
            ))
          : marks(shown)}
      </pre>
      {(pieces || whole) && (
        <button
          className="jp-Epi-link jp-Epi-guard-whole"
          onClick={() => setWhole(!whole)}
        >
          {whole
            ? 'Show only the lines with flagged parts'
            : `Show all of the text (${lineCount} lines)`}
        </button>
      )}
      {event.review && (
        <div className="jp-Epi-guard-review">
          <b>The remote model, in a call of its own:</b> {event.review}
        </div>
      )}
      {event.model_note && (
        <div className="jp-Epi-guard-note">
          The guard model did not read this: {event.model_note}.
        </div>
      )}
      <label className="jp-Epi-guard-why">
        <span>
          Why is this fine?{' '}
          <span className="jp-Epi-guard-optional">(optional)</span>
        </span>
        <textarea
          className="jp-mod-styled"
          rows={2}
          value={note}
          placeholder={
            privacy
              ? 'For example: the data is synthetic, or these are study IDs of outliers that the report names.'
              : 'For example: this folder holds no secrets.'
          }
          onChange={change => {
            setNote(change.currentTarget.value);
            props.onNote(change.currentTarget.value);
          }}
        />
      </label>
      <div className="jp-Epi-guard-hint">
        {privacy
          ? 'The guard keeps your answer for this session, and does not ask again about the same parts.'
          : 'The guard keeps your answer for this session, and does not ask again about the same code.'}
      </div>
    </div>
  );
}

/** A text of one long line of JSON, indented one space a level; any other text as it is. */
function readable(text: string): string {
  const trimmed = text.trim();
  if (
    trimmed.includes('\n') ||
    trimmed.length < 160 ||
    !/^[[{]/.test(trimmed)
  ) {
    return text;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 1);
  } catch {
    return text;
  }
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const MODES: { value: GuardMode; label: string; title: string }[] = [
  {
    value: 'ask',
    label: 'Ask',
    title: 'The guard asks you, and the work waits for your answer'
  },
  {
    value: 'reject',
    label: 'Reject',
    title:
      'The guard holds back what it flagged, and the work goes on without it'
  },
  { value: 'none', label: 'None', title: 'Nothing is checked' }
];

/** What each mode does, under the choice. */
const MODE_WORDS: Record<GuardMode, string> = {
  ask: 'Ask: the guard shows you what it flagged, and the work waits for your answer.',
  reject:
    'Reject: the guard holds back what it flagged and tells you, and the work goes on without it. A prompt goes with the flagged parts masked; flagged code does not run.',
  none: 'None: nothing is checked. Prompts leave this machine as they are, and code that the AI wrote runs as it is.'
};

const GUARD_HELP =
  'The review guard checks what Whybook would send to a model on another machine, and code that an AI wrote before it runs. Rules check on this machine, in at most a few hundredths of a second. A guard model, also on this machine, can read what the rules cannot: it takes a few seconds for each check.';

/**
 * The review guard in the AI models panel: the mode, the two guards with
 * what each checks, the guard models, the notebook's data, the policy, and
 * what the guard kept in this session. The words are long on purpose: the
 * owner asked for check boxes that say what they do, to be cut later.
 */
export function GuardSection(props: { model: EpiModel }): JSX.Element {
  const { model } = props;
  useModel(model);
  const guard = model.settings.guard;
  const set = (patch: Partial<IGuardSettings>) =>
    model.settings.setGuard(patch);
  const mode = model.guardMode;
  const off = mode === 'none';
  // A mode that the server sets keeps both guards on.
  const privacyOn = guard.privacy || model.guardFixed;
  const executionOn = guard.execution || model.guardFixed;
  const [help, setHelp] = React.useState(false);
  const [memory, setMemory] = React.useState<IGuardMemory | null>(null);
  const [showing, setShowing] = React.useState<'answers' | 'held' | null>(null);
  React.useEffect(() => {
    model
      .guardMemory()
      .then(found => setMemory(memoryOf(found)))
      .catch(() => setMemory(null));
  }, [model, model.guardHeld.length]);
  const guards = model.status?.guard_models ?? [];
  const change = (next: Promise<IGuardMemory>) => {
    next.then(found => setMemory(memoryOf(found))).catch(() => undefined);
  };
  return (
    <div className="jp-Epi-guard-section">
      <div className="jp-Epi-guard-head">
        <span className="jp-Epi-tasklabel">
          <span className="jp-Epi-guard-title">Review guard</span>
          <HelpButton
            label="Review guard"
            text={GUARD_HELP}
            open={help}
            onToggle={() => setHelp(!help)}
          />
        </span>
        <Segmented
          label="Review guard"
          value={mode}
          options={MODES.map(option => ({
            value: option.value,
            label: option.label,
            title: option.title
          }))}
          onChange={value => {
            if (!model.guardFixed) {
              set({ mode: value });
            }
          }}
        />
      </div>
      {help && <div className="jp-Epi-help-text">{GUARD_HELP}</div>}
      <div className="jp-Epi-guard-mode">{MODE_WORDS[mode]}</div>
      {model.guardFixed && (
        <div className="jp-Epi-aipanel-note">
          Fixed on the server, with both guards on: c.Whybook.review_guard
        </div>
      )}
      <fieldset className="jp-Epi-guard-group" disabled={off}>
        <legend>Data privacy: what leaves this machine</legend>
        <Check
          id="jp-Epi-guard-privacy"
          checked={privacyOn}
          disabled={model.guardFixed}
          onChange={value => set({ privacy: value })}
          label="Check every prompt before it goes to a model on another machine."
          detail="Rules look for identifiers of people and households, names, ages, dates, health details, contact details, small counts and keys, in at most a few hundredths of a second. A model that runs on this machine reads every prompt, unchecked."
        />
        <ModelCheck
          id="jp-Epi-guard-privacy-model"
          disabled={!privacyOn}
          value={guard.privacyModel}
          models={guards}
          suggested={SUGGESTED_GUARD_MODEL.privacy}
          onChange={value => set({ privacyModel: value })}
          label="Also have a guard model on this machine read each prompt against your privacy policy."
          detail="It reads what the rules cannot, such as an ID written out in words, and takes a few seconds for each prompt."
          model={model}
        />
        <Check
          id="jp-Epi-guard-synthetic"
          checked={model.guardSynthetic}
          onChange={value => model.setGuardSynthetic(value)}
          label="The data of this notebook is synthetic: its identifiers and values may leave this machine."
          detail="Kept in the notebook. The guard then checks prompts only for keys and passwords."
        />
        <button className="jp-Epi-link" onClick={() => void editPolicy(model)}>
          {guard.policy.trim()
            ? 'Edit your privacy policy'
            : 'Edit the privacy policy (the default now)'}
        </button>
      </fieldset>
      <fieldset className="jp-Epi-guard-group" disabled={off}>
        <legend>Execution safety: code that the AI wrote</legend>
        <Check
          id="jp-Epi-guard-execution"
          checked={executionOn}
          disabled={model.guardFixed}
          onChange={value => set({ execution: value })}
          label="Check code that the AI wrote before it runs."
          detail="Rules look for the network, secrets, files outside the notebook's folder, deletes, shell commands, installs, hidden code and text that addresses the reviewer."
        />
        <div
          className={`jp-Epi-guard-kernel${model.sandboxed ? ' jp-mod-sandboxed' : ''}`}
        >
          {model.sandboxed
            ? 'This notebook’s kernel runs in the sandbox, so the guard allows what the sandbox stops: the network, files outside the folder, installs and shell commands.'
            : 'This notebook’s kernel runs outside the sandbox, so the guard asks about more, and rejects what could reach your files, your keys or the network. A kernel such as “Python 3 (sandboxed)” needs fewer questions.'}
        </div>
        <ModelCheck
          id="jp-Epi-guard-execution-model"
          disabled={!executionOn}
          value={guard.executionModel}
          models={guards}
          suggested={SUGGESTED_GUARD_MODEL.execution}
          onChange={value => set({ executionModel: value })}
          label="Also have a guard model on this machine read the code."
          detail="It takes a few seconds for each cell."
          model={model}
        />
        <Check
          id="jp-Epi-guard-remote"
          checked={guard.remoteReview}
          disabled={!executionOn}
          onChange={value => set({ remoteReview: value })}
          label="Also have the remote model review the code, in a call of its own."
          detail="The call reads the code and the code policy, nothing of the analysis. It costs one more call for each cell."
        />
      </fieldset>
      <div className="jp-Epi-guard-memory">
        <button
          className="jp-Epi-link"
          disabled={!memory?.answers.length}
          onClick={() => setShowing(showing === 'answers' ? null : 'answers')}
        >
          {countWords(memory?.answers.length ?? 0, 'answer')} remembered in this
          session
        </button>
        {' · '}
        <button
          className="jp-Epi-link"
          disabled={!memory?.held.length}
          onClick={() => setShowing(showing === 'held' ? null : 'held')}
        >
          {countWords(memory?.held.length ?? 0, 'item')} held back
        </button>
      </div>
      {showing === 'answers' && memory && (
        <ul className="jp-Epi-guard-list">
          {memory.answers.map(item => (
            <li key={item.index}>
              <span>
                {item.guard === 'privacy' ? 'Sent' : 'Ran'}:{' '}
                {item.flags.map(flag => flag.text).join(', ') ||
                  'what a guard model flagged'}
                {item.note ? `, with your note “${item.note}”` : ''}
              </span>
              <button
                className="jp-Epi-link"
                onClick={() =>
                  change(model.guardMemory({ forget: item.index }))
                }
              >
                Forget
              </button>
            </li>
          ))}
          <li>
            <button
              className="jp-Epi-link"
              onClick={() => change(model.guardMemory({ forget: 'all' }))}
            >
              Forget all
            </button>
          </li>
        </ul>
      )}
      {showing === 'held' && memory && (
        <ul className="jp-Epi-guard-list">
          {memory.held.map((item, index) => (
            <li key={index}>
              <span>
                {heldWords({
                  type: 'guard_held',
                  guard: item.guard,
                  what: item.what,
                  flags: item.flags,
                  reason: item.reason,
                  masked: item.masked
                })}
              </span>
              {item.flags.some(flag => flag.text) && (
                <button
                  className="jp-Epi-link"
                  onClick={() =>
                    change(
                      model.guardMemory({
                        allow: { guard: item.guard, flags: item.flags }
                      })
                    )
                  }
                >
                  Allow for this session
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The server's answer, with a list where it has none. */
function memoryOf(
  found: Partial<IGuardMemory> | null | undefined
): IGuardMemory {
  return {
    answers: Array.isArray(found?.answers) ? found.answers : [],
    held: Array.isArray(found?.held) ? found.held : []
  };
}

function countWords(count: number, noun: string): string {
  return `${count === 0 ? 'No' : count} ${noun}${count === 1 ? '' : 's'}`;
}

/** A check box with a sentence that says what it does, and a line of detail under it. */
function Check(props: {
  id: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  detail: string;
  disabled?: boolean;
}): JSX.Element {
  // The box changes on the click: the settings answer on a later frame.
  const [checked, setChecked] = React.useState(props.checked);
  React.useEffect(() => setChecked(props.checked), [props.checked]);
  return (
    <div className="jp-Epi-guard-check">
      <input
        type="checkbox"
        id={props.id}
        checked={checked}
        disabled={props.disabled}
        onChange={event => {
          setChecked(event.currentTarget.checked);
          props.onChange(event.currentTarget.checked);
        }}
      />
      <label htmlFor={props.id}>
        {props.label}
        <span className="jp-Epi-guard-detail">{props.detail}</span>
      </label>
    </div>
  );
}

/** The guard model that a guard reads with: a check box, and the model to use when it is on. */
function ModelCheck(props: {
  id: string;
  value: string;
  models: ILocalModel[];
  /** The model listed first, and chosen unless another one is on this machine already. */
  suggested: string;
  onChange: (value: string) => void;
  label: string;
  detail: string;
  disabled: boolean;
  model: EpiModel;
}): JSX.Element {
  const models = [...props.models].sort(
    (a, b) =>
      Number(b.id === props.suggested) - Number(a.id === props.suggested)
  );
  const first = models.find(entry => entry.available) ?? models[0];
  const [last, setLast] = React.useState(props.value || first?.id || '');
  const chosen = models.find(entry => entry.id === (props.value || last));
  const [downloading, setDownloading] = React.useState<string | null>(null);
  const download = (id: string) => {
    setDownloading('Downloading…');
    void props.model.api
      .downloadModel(id, event => {
        if (event.type === 'progress' && typeof event.progress === 'number') {
          setDownloading(`Downloading: ${Math.round(event.progress * 100)}%`);
        } else if (event.type === 'error') {
          setDownloading(event.message ?? 'The download failed');
        } else if (event.type === 'result') {
          setDownloading(null);
          props.model.refreshStatus();
        }
      })
      .catch(error => setDownloading(String(error)));
  };
  return (
    <div className="jp-Epi-guard-modelcheck">
      <Check
        id={props.id}
        checked={!!props.value}
        disabled={props.disabled || !models.length}
        onChange={on => props.onChange(on ? last : '')}
        label={props.label}
        detail={props.detail}
      />
      {models.length > 0 && (
        <div className="jp-Epi-guard-modelrow">
          <HTMLSelect
            aria-label="Guard model"
            value={props.value || last}
            disabled={props.disabled}
            onChange={event => {
              const next = event.currentTarget.value;
              setLast(next);
              if (props.value) {
                props.onChange(next);
              }
            }}
          >
            {models.map(entry => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
                {entry.size_mb
                  ? ` (${(entry.size_mb / 1000).toFixed(1)} GB)`
                  : ''}
              </option>
            ))}
          </HTMLSelect>
          {chosen && !chosen.available && (
            <span className="jp-Epi-guard-download">
              {downloading ?? (
                <>
                  Not on this machine.{' '}
                  {chosen.downloadable ? (
                    <button
                      className="jp-Epi-link"
                      onClick={() => download(chosen.id)}
                    >
                      Download
                    </button>
                  ) : (
                    chosen.reason
                  )}
                </>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** The privacy policy in the analyst's words, in a dialog: the default until the analyst saves one. */
async function editPolicy(model: EpiModel): Promise<void> {
  const body = new PolicyBody(
    model.settings.guard.policy.trim() || DEFAULT_POLICY
  );
  const result = await showDialog({
    title: 'Privacy policy',
    body,
    buttons: [
      Dialog.cancelButton(),
      Dialog.createButton({ label: 'Use the default' }),
      Dialog.okButton({ label: 'Save' })
    ],
    defaultButton: 2
  });
  if (result.button.label === 'Use the default') {
    model.settings.setGuard({ policy: '' });
  } else if (result.button.accept) {
    const text = body.text.trim();
    model.settings.setGuard({ policy: text === DEFAULT_POLICY ? '' : text });
  }
}

class PolicyBody extends ReactWidget {
  constructor(public text: string) {
    super();
    this.addClass('jp-Epi-guard-policy');
  }

  render(): JSX.Element {
    return (
      <PolicyEditor
        text={this.text}
        onChange={text => {
          this.text = text;
        }}
      />
    );
  }
}

function PolicyEditor(props: {
  text: string;
  onChange: (text: string) => void;
}): JSX.Element {
  const [text, setText] = React.useState(props.text);
  return (
    <div className="jp-Epi-guard-policyeditor">
      <p>
        What may leave this machine, in your words. The guard models read the
        lines that start with &ldquo;Reject:&rdquo; and &ldquo;Ask&rdquo; as two
        questions, and the lines that start with &ldquo;Fine:&rdquo; as what is
        fine. The rules do not read the policy.
      </p>
      <textarea
        className="jp-mod-styled"
        rows={12}
        value={text}
        onChange={event => {
          setText(event.currentTarget.value);
          props.onChange(event.currentTarget.value);
        }}
      />
    </div>
  );
}
