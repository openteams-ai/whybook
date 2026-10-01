import { KernelMessage } from '@jupyterlab/services';

/**
 * How far a running cell is, and what it does.
 */
export interface IProgressReport {
  fraction: number | null;
  stage: string | null;
}

/**
 * The last tqdm bar in a text: `bootstrap:  40%|████      | 16/40 [00:01<00:01]`
 * gives 0.4 and "bootstrap". tqdm redraws its bar after a carriage return,
 * so the last line with a bar is the current one.
 */
export function tqdmText(text: string): IProgressReport | null {
  const lines = text.split(/[\r\n]/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^(?:(.*?):\s*)?(\d{1,3})%\|.*\|/.exec(lines[i].trim());
    if (match) {
      return {
        fraction: Math.min(Number(match[2]), 100) / 100,
        stage: match[1]?.trim() || null
      };
    }
  }
  return null;
}

const BAR_MODELS = ['FloatProgressModel', 'IntProgressModel'];

interface IBar {
  min: number;
  max: number;
  value: number;
  stage: string | null;
}

/**
 * Progress from what a library already shows while a cell runs: a tqdm bar
 * printed to stderr, or the progress widget of tqdm.auto, ipywidgets or any
 * other library. The code in the cell stays as it is, and its outputs keep
 * the library's own bar.
 *
 * The widgets are read from the messages of the run: the kernel opens a
 * progress widget with its minimum and maximum, then sends each new value.
 * With several bars, the first one that is not full is reported: the outer
 * loop of nested bars, or the loop that runs now of bars one after another.
 */
export class RunProgress {
  /**
   * Read one message of the run. Returns the progress when it changed.
   */
  read(msg: KernelMessage.IIOPubMessage): IProgressReport | null {
    if (KernelMessage.isStreamMsg(msg) && msg.content.name === 'stderr') {
      const report = tqdmText(msg.content.text ?? '');
      if (report && !this._bars.size) {
        return report;
      }
      return null;
    }
    if (KernelMessage.isCommOpenMsg(msg)) {
      const state = widgetState(msg.content.data);
      if (state && (BAR_MODELS as unknown[]).includes(state._model_name)) {
        this._bars.set(msg.content.comm_id, {
          min: numberOr(state.min, 0),
          max: numberOr(state.max, 100),
          value: numberOr(state.value, 0),
          stage: null
        });
        return this._report();
      }
      return null;
    }
    if (
      KernelMessage.isCommMsgMsg(msg) &&
      msg.content.data?.method === 'update'
    ) {
      const bar = this._bars.get(msg.content.comm_id);
      if (!bar) {
        return null;
      }
      const state = widgetState(msg.content.data) ?? {};
      bar.min = numberOr(state.min, bar.min);
      bar.max = numberOr(state.max, bar.max);
      bar.value = numberOr(state.value, bar.value);
      return this._report();
    }
    if (
      KernelMessage.isDisplayDataMsg(msg) &&
      msg.content.data?.['text/plain']
    ) {
      // tqdm.auto shows its widget with its text bar as the plain text: the
      // text names the stage of the bar that opened last.
      const text = tqdmText(String(msg.content.data['text/plain']));
      const bar = [...this._bars.values()].reverse().find(item => !item.stage);
      if (text?.stage && bar) {
        bar.stage = text.stage;
        return this._report();
      }
    }
    return null;
  }

  private _report(): IProgressReport | null {
    const bars = [...this._bars.values()];
    const bar =
      bars.find(item => item.value < item.max) ?? bars[bars.length - 1];
    if (!bar) {
      return null;
    }
    const span = bar.max - bar.min;
    const fraction =
      span > 0 ? Math.min(Math.max((bar.value - bar.min) / span, 0), 1) : null;
    return { fraction, stage: bar.stage };
  }

  private _bars = new Map<string, IBar>();
}

/** The state of a widget that a comm message carries, as ipywidgets sends it. */
interface IWidgetState {
  _model_name?: unknown;
  min?: unknown;
  max?: unknown;
  value?: unknown;
}

function widgetState(
  data: { state?: unknown } | undefined
): IWidgetState | undefined {
  return data?.state as IWidgetState | undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
