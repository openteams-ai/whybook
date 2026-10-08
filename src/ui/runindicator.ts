import type { ISessionContext } from '@jupyterlab/apputils';
import type { Notebook } from '@jupyterlab/notebook';
import { ExecutionIndicator } from '@jupyterlab/notebook';
import type { ITranslator } from '@jupyterlab/translation';

import type { JobManager } from '../model/jobs';

/**
 * JupyterLab's execution indicator, the kernel's status in the notebook
 * toolbar, with the cells of the view's runs: a disc while a run goes on,
 * which empties as its cells finish, and "Executed 2/5 cells" in its tooltip.
 */
export function createRunIndicator(
  key: object,
  sessionContext: ISessionContext,
  jobs: JobManager,
  translator?: ITranslator
): ExecutionIndicator {
  const indicator = new ExecutionIndicator(translator);
  const own = indicator.model;
  const model = new RunIndicatorModel(key, sessionContext, jobs);
  indicator.model = model;
  own.dispose();
  indicator.disposed.connect(() => model.dispose());
  return indicator;
}

/**
 * The indicator's model, read from the view's job manager instead of the
 * kernel's messages. JupyterLab's model counts the execute requests that the
 * notebook's connection sends, and shows the kernel as idle 150 ms after the
 * last of them finished: the view sends the cells of a run one at a time, so
 * from a run's second cell on it showed the kernel as idle. It also does not
 * count the cells that run in subshells.
 */
export class RunIndicatorModel extends ExecutionIndicator.Model {
  /** `key` stands for the notebook, which the indicator uses only as a key. */
  constructor(key: object, sessionContext: ISessionContext, jobs: JobManager) {
    super();
    this._key = key;
    this._sessionContext = sessionContext;
    this._jobs = jobs;
    jobs.changed.connect(this._update, this);
    sessionContext.statusChanged.connect(this._update, this);
    sessionContext.connectionStatusChanged.connect(this._update, this);
    this.displayOption = {
      showOnToolBar: true,
      showProgress: true,
      showJumpToCell: false
    };
  }

  get currentNotebook(): Notebook | null {
    return this._key as Notebook;
  }

  executionState(): ExecutionIndicator.IExecutionState | undefined {
    const run = this._jobs.tally.run;
    const running = this._jobs.tally.running;
    const status = this._sessionContext.kernelDisplayStatus;
    // A run's cells keep the kernel busy, also when a request of the view in
    // a subshell, such as the Variables panel's, has just turned it idle.
    const kernelStatus = running && status === 'idle' ? 'busy' : status;
    const end = run?.finished ?? Date.now();
    const remaining = run && running ? run.total - run.done : 0;
    return {
      executionStatus: running ? 'busy' : 'idle',
      kernelStatus,
      totalTime: run ? Math.floor((end - run.started) / 1000) : 0,
      interval: 0,
      timeout: 0,
      // The indicator reads only the size of this set.
      scheduledCell: new Set(
        Array.from({ length: remaining }, (_, index) => String(index))
      ),
      scheduledCellNumber: run?.total ?? 0,
      needReset: false
    };
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._stopClock();
    this._jobs.changed.disconnect(this._update, this);
    this._sessionContext.statusChanged.disconnect(this._update, this);
    this._sessionContext.connectionStatusChanged.disconnect(this._update, this);
    super.dispose();
  }

  /** Draw again, and count the seconds while a run goes on. */
  private _update(): void {
    if (this._jobs.tally.running) {
      this._clock ??= window.setInterval(
        () => this.stateChanged.emit(void 0),
        1000
      );
    } else {
      this._stopClock();
    }
    this.stateChanged.emit(void 0);
  }

  private _stopClock(): void {
    if (this._clock !== null) {
      window.clearInterval(this._clock);
      this._clock = null;
    }
  }

  private _key: object;
  private _sessionContext: ISessionContext;
  private _jobs: JobManager;
  private _clock: number | null = null;
}
