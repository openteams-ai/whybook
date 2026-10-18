import { Dialog, ReactWidget } from '@jupyterlab/apputils';
import * as React from 'react';

import type { IServerStatus } from '../model/api';
import type { ModelChoices } from '../model/models';
import type { IWay, WayId } from '../model/ways';
import {
  blockedReason,
  currentWay,
  LOCAL_EXTRA_COMMAND,
  needsOf,
  WAYS
} from '../model/ways';

/** What the screen reads: the server's status, and the analyst's settings as they are. */
export interface IWaysState {
  status: IServerStatus | null;
  keepDataLocal: boolean;
  models: ModelChoices;
}

/** The title of the screen, and of its command. */
export const WAYS_TITLE = 'Three ways to use models';

/** The machine of each way, drawn as on the website: a laptop, a small desktop, a rack. */
function WayIcon(props: { way: WayId }): JSX.Element {
  return (
    <svg className="jp-Epi-way-icon" viewBox="0 0 48 48" aria-hidden="true">
      {props.way === 'remote' ? (
        <>
          <rect x="9" y="10" width="30" height="20" rx="2" />
          <path d="M4 35h40l-3 4H7z" />
        </>
      ) : props.way === 'data-stays-here' ? (
        <>
          <path d="M9 22l4-5h22l4 5" />
          <rect x="7" y="22" width="34" height="10" rx="3" />
          <circle cx="34" cy="27" r="1.3" />
        </>
      ) : (
        <>
          <rect x="9" y="7" width="30" height="11" rx="2" />
          <rect x="9" y="21" width="30" height="11" rx="2" />
          <path d="M14 12.5h9M14 26.5h9M17 32v6M31 32v6M12 38h24" />
          <circle cx="33" cy="12.5" r="1.3" />
          <circle cx="33" cy="26.5" r="1.3" />
        </>
      )}
    </svg>
  );
}

/**
 * One way as a large button: the machine it suits, its name, who it is for,
 * what it needs on this server, and what leaves the machine. The whole card
 * takes the click of its button. A way that cannot be chosen here says why
 * in place of the button's action, such as the line that installs the local
 * models.
 */
function WayCard(props: {
  way: IWay;
  state: IWaysState;
  now: boolean;
  onChoose: (way: WayId) => void;
}): JSX.Element {
  const { way, state } = props;
  const blocked = blockedReason(way.id, state.status);
  const facts = `jp-Epi-way-${way.id}-facts`;
  return (
    <div
      className={`jp-Epi-way${blocked ? ' jp-mod-blocked' : ''}`}
      data-way={way.id}
    >
      <div className="jp-Epi-way-machine">
        <WayIcon way={way.id} />
        <span>{way.machine}</span>
        {props.now && (
          <span
            className="jp-Epi-way-mark"
            title="Your settings make this way true now"
          >
            Now
          </span>
        )}
      </div>
      <div className="jp-Epi-way-head">
        <button
          type="button"
          className="jp-Epi-way-button"
          disabled={blocked !== null}
          aria-describedby={facts}
          onClick={() => props.onChoose(way.id)}
        >
          {way.name}
        </button>
      </div>
      <div className="jp-Epi-way-facts" id={facts}>
        <p className="jp-Epi-way-summary">{way.summary}</p>
        <dl>
          <dt>For</dt>
          <dd>{way.audience}</dd>
          <dt>Needs</dt>
          <dd>
            <ul>
              {needsOf(way.id, state.status, state.models).map(need => (
                <li key={need}>{need}</li>
              ))}
            </ul>
          </dd>
          <dt>Leaves this machine</dt>
          <dd>{way.leaves}</dd>
        </dl>
      </div>
      {blocked && (
        <p className="jp-Epi-way-blocked">
          <WithCommand text={blocked} />
        </p>
      )}
    </div>
  );
}

/** A text with the command that installs the local models set in the code font. */
function WithCommand(props: { text: string }): JSX.Element {
  const parts = props.text.split(LOCAL_EXTRA_COMMAND);
  return (
    <>
      {parts.map((part, index) => (
        <React.Fragment key={index}>
          {index > 0 && <code>{LOCAL_EXTRA_COMMAND}</code>}
          {part}
        </React.Fragment>
      ))}
    </>
  );
}

/**
 * The three ways side by side, each a large button. A press sets the
 * settings of that way, and the AI models panel opens at its next step. The
 * screen does not start a download and does not call a model.
 */
export function ThreeWays(
  props: IWaysState & { onChoose: (way: WayId) => void }
): JSX.Element {
  const now = currentWay(props.status, props.keepDataLocal, props.models);
  return (
    <div className="jp-Epi-ways">
      <p className="jp-Epi-ways-lead">
        Choose where models run, and what leaves this machine. A way sets
        Whybook&apos;s AI settings, then the AI models panel shows what is left
        to do. Nothing downloads, and no model is called, until you ask there.
      </p>
      <div className="jp-Epi-ways-list">
        {WAYS.map(way => (
          <WayCard
            key={way.id}
            way={way}
            state={props}
            now={now === way.id}
            onChoose={props.onChoose}
          />
        ))}
      </div>
      <p className="jp-Epi-ways-note">
        Decide later does not change a setting. The AI models panel and the
        command palette open this screen again.
      </p>
    </div>
  );
}

/** The body of the screen's dialog. */
class WaysBody extends ReactWidget {
  constructor(
    private readonly _state: IWaysState,
    private readonly _choose: (way: WayId) => void
  ) {
    super();
    this.addClass('jp-Epi-ways-body');
  }

  render(): JSX.Element {
    return <ThreeWays {...this._state} onChoose={this._choose} />;
  }
}

/**
 * Show the screen in a JupyterLab dialog, and give the way that the analyst
 * pressed, or null for "Decide later", Escape or the dialog's close button.
 */
export async function showThreeWays(state: IWaysState): Promise<WayId | null> {
  let chosen: WayId | null = null;
  const dialog = new Dialog<void>({
    title: WAYS_TITLE,
    body: new WaysBody(state, way => {
      chosen = way;
      dialog.resolve(0);
    }),
    // "Decide later" takes the focus, so that no way has it, and Enter does
    // not change a setting.
    buttons: [Dialog.cancelButton({ label: 'Decide later' })]
  });
  dialog.addClass('jp-Epi-ways-dialog');
  // JupyterLab's dialog takes Enter for its own buttons, before the
  // button that has the focus sees it: Enter on a way presses that way.
  const enter = (event: KeyboardEvent) => {
    const active = document.activeElement;
    if (
      event.key === 'Enter' &&
      active instanceof HTMLButtonElement &&
      active.classList.contains('jp-Epi-way-button') &&
      dialog.node.contains(active)
    ) {
      event.preventDefault();
      event.stopPropagation();
      active.click();
    }
  };
  document.addEventListener('keydown', enter, true);
  // The dialog disposes itself when it resolves.
  const closed = dialog.launch();
  try {
    await closed;
  } finally {
    document.removeEventListener('keydown', enter, true);
  }
  return chosen;
}
