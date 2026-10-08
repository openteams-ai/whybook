import type { ISessionContext } from '@jupyterlab/apputils';
import { Toolbar } from '@jupyterlab/apputils';
import type { IEditorServices } from '@jupyterlab/codeeditor';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import { ABCWidgetFactory, DocumentWidget } from '@jupyterlab/docregistry';
import type { INotebookModel } from '@jupyterlab/notebook';
import type { IRenderMime, IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { ServerConnection } from '@jupyterlab/services';
import { ReactWidget } from '@jupyterlab/ui-components';
import type { Message } from '@lumino/messaging';
import type { ISignal } from '@lumino/signaling';
import { Signal } from '@lumino/signaling';
import * as React from 'react';

import { epiIcon } from './icons';
import type { EpiSettings } from './model/epimodel';
import { EpiModel } from './model/epimodel';
import { followKernel } from './model/kernelmeta';
import type { AgentRuns } from './model/runs';
import { aiSummary, modelName, TASKS } from './model/models';
import type { IPlotPayload } from './tokens';
import { PLOT_MIME, PROGRESS_MIME } from './tokens';
import { PARALLEL_HELP, ProgressBar, useModel } from './ui/common';
import {
  DocumentView,
  DetailSlider,
  LayoutSelect,
  ModeSwitch,
  RunAllButton,
  ViewSwitch
} from './ui/document';
import { coverage } from './ui/exploration';
import { AIButton } from './ui/aipanel';
import { askGuard } from './ui/guard';
import { bindWidgetManager } from './model/ipywidgets';
import { EpiPlot } from './ui/plot';

/**
 * The name of the widget factory, shown in the "Open With" menu.
 */
export const FACTORY = 'Whybook';

/** The events that count as the analyst's use of the view or its panels. */
const USE_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel'];

export class EpiContent extends ReactWidget {
  constructor(options: EpiContent.IOptions) {
    super();
    this.addClass('jp-Epi');
    this.model = new EpiModel({
      context: options.context,
      rendermime: options.rendermime.clone({
        resolver: options.context.urlResolver
      }),
      serverSettings: options.serverSettings,
      settings: options.settings,
      runs: options.runs,
      askGuard
    });
    this._editorServices = options.editorServices;
    this._openFile = options.openFile;
    void bindWidgetManager(options.context, this.model.rendermime);
    // Whether the notebook is in use sets how often the view reads its
    // kernel (src/model/refresh.ts).
    this.model.isVisible = () =>
      this.isVisible && document.visibilityState === 'visible';
    for (const type of USE_EVENTS) {
      this.node.addEventListener(type, this._onUse, { passive: true });
    }
    document.addEventListener('visibilitychange', this._onTabVisibility);
  }

  readonly model: EpiModel;

  render(): JSX.Element {
    return (
      <DocumentView
        model={this.model}
        editorServices={this._editorServices}
        openFile={(path, line) =>
          this._openFile(this.model.context.path, path, line)
        }
        isVisible={() => this.isVisible}
      />
    );
  }

  protected onAfterShow(msg: Message): void {
    super.onAfterShow(msg);
    this.model.shown();
    this.update();
  }

  protected onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg);
    if (this.isVisible) {
      this.model.shown();
    }
  }

  protected onAfterHide(msg: Message): void {
    super.onAfterHide(msg);
    this.update();
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    for (const type of USE_EVENTS) {
      this.node.removeEventListener(type, this._onUse);
    }
    document.removeEventListener('visibilitychange', this._onTabVisibility);
    this.model.dispose();
    super.dispose();
  }

  private _onUse = (): void => {
    this.model.noteUse();
  };

  /** The browser tab came back: the view shows again if its panel does. */
  private _onTabVisibility = (): void => {
    if (document.visibilityState === 'visible' && this.isVisible) {
      this.model.shown();
    }
  };

  private _editorServices: IEditorServices | null;
  private _openFile: (
    notebookPath: string,
    path: string,
    line: number | null
  ) => void;
}

export namespace EpiContent {
  export interface IOptions {
    context: DocumentRegistry.IContext<INotebookModel>;
    rendermime: IRenderMimeRegistry;
    serverSettings: ServerConnection.ISettings;
    settings: EpiSettings;
    editorServices: IEditorServices | null;
    openFile: (notebookPath: string, path: string, line: number | null) => void;
    /** The agents' runs of every open notebook, which its views share. */
    runs?: AgentRuns;
  }
}

export class EpiPanel extends DocumentWidget<EpiContent, INotebookModel> {}

/**
 * Opens notebooks in the question-driven view. It uses the notebook model
 * factory, so this view and a classic view of the same file share one model
 * and one kernel session.
 */
export class EpiFactory extends ABCWidgetFactory<EpiPanel, INotebookModel> {
  constructor(options: EpiFactory.IOptions) {
    super(options);
    this._options = options;
  }

  protected createNewWidget(
    context: DocumentRegistry.IContext<INotebookModel>
  ): EpiPanel {
    const content = new EpiContent({ ...this._options, context });
    const panel = new EpiPanel({ context, content });
    panel.title.icon = epiIcon;
    // The notebook names its kernel, as JupyterLab's notebook panel writes it.
    followKernel(context);
    // The view's controls sit in the panel's JupyterLab toolbar.
    const model = content.model;
    const items: [string, JSX.Element][] = [
      ['epi-view', <ViewSwitch model={model} />],
      ['epi-mode', <ModeSwitch model={model} />],
      ['epi-layout', <LayoutSelect model={model} />],
      ['epi-detail', <DetailSlider model={model} />],
      ['epi-run-all', <RunAllButton model={model} />],
      [
        'epi-ai',
        <AIButton model={model} openSettings={this._options.openSettings} />
      ]
    ];
    for (const [name, element] of items) {
      panel.toolbar.addItem(name, ReactWidget.create(element));
    }
    panel.toolbar.addItem('spacer', Toolbar.createSpacerItem());
    // JupyterLab's toolbar measures an item once, and keeps that width when
    // the item's text changes. The kernel's name grows from "No Kernel" once
    // the kernel starts, and a toolbar with no room left wrapped it onto a
    // row under the notebook, where it could not be clicked. At a fixed width
    // (style/base.css) the measure holds, and the name goes into the
    // toolbar's overflow menu when there is no room for it.
    const kernelName = Toolbar.createKernelNameItem(
      context.sessionContext,
      this._options.sessionDialogs,
      this.translator
    );
    kernelName.addClass('jp-Epi-kernelname');
    panel.toolbar.addItem('kernelName', kernelName);
    panel.toolbar.addItem(
      'kernelStatus',
      Toolbar.createKernelStatusItem(context.sessionContext, this.translator)
    );
    return panel;
  }

  private _options: EpiFactory.IOptions;
}

export namespace EpiFactory {
  export interface IOptions extends DocumentRegistry.IWidgetFactoryOptions<EpiPanel> {
    rendermime: IRenderMimeRegistry;
    serverSettings: ServerConnection.ISettings;
    settings: EpiSettings;
    editorServices: IEditorServices | null;
    sessionDialogs?: ISessionContext.IDialogs;
    openFile: (notebookPath: string, path: string, line: number | null) => void;
    /** Open JupyterLab's settings editor at the view's settings. */
    openSettings: () => void;
    /** The agents' runs of every open notebook, which its views share. */
    runs?: AgentRuns;
  }
}

/**
 * The model of the Whybook view that is current in the main area.
 */
export class CurrentModel {
  get model(): EpiModel | null {
    return this._model;
  }

  set model(model: EpiModel | null) {
    if (model !== this._model) {
      this._model = model;
      this._changed.emit(model);
    }
  }

  get changed(): ISignal<this, EpiModel | null> {
    return this._changed;
  }

  private _model: EpiModel | null = null;
  private _changed = new Signal<this, EpiModel | null>(this);
}

function useCurrent(current: CurrentModel): EpiModel | null {
  const [model, setModel] = React.useState(current.model);
  React.useEffect(() => {
    const update = (_: CurrentModel, value: EpiModel | null) => setModel(value);
    current.changed.connect(update);
    // The view can change between the first render and this subscription.
    setModel(current.model);
    return () => {
      current.changed.disconnect(update);
    };
  }, [current]);
  return model;
}

function Following(props: {
  current: CurrentModel;
  render: (model: EpiModel) => JSX.Element;
}): JSX.Element {
  const model = useCurrent(props.current);
  useModel(model);
  if (!model) {
    return (
      <div className="jp-Epi-empty jp-Epi-sidebar-empty">
        Open a notebook with Open With › Whybook, or create one from Whybook in
        the launcher, to use this panel.
      </div>
    );
  }
  return props.render(model);
}

/**
 * A sidebar section that shows a part of the current Whybook view.
 */
export class FollowingWidget extends ReactWidget {
  constructor(
    private _current: CurrentModel,
    private _render: (model: EpiModel) => JSX.Element
  ) {
    super();
    this.addClass('jp-Epi');
    this.addClass('jp-Epi-sidebar');
    this.node.addEventListener('keydown', this._onKeyDown);
    for (const type of USE_EVENTS) {
      this.node.addEventListener(type, this._onUse, { passive: true });
    }
  }

  render(): JSX.Element {
    return <Following current={this._current} render={this._render} />;
  }

  dispose(): void {
    this.node.removeEventListener('keydown', this._onKeyDown);
    for (const type of USE_EVENTS) {
      this.node.removeEventListener(type, this._onUse);
    }
    super.dispose();
  }

  /** Work in a panel is use of the notebook that the panel follows. */
  private _onUse = (): void => {
    this._current.model?.noteUse();
  };

  /**
   * Escape cancels a pick or closes the questions, as it does in the view.
   */
  private _onKeyDown = (event: KeyboardEvent): void => {
    const model = this._current.model;
    if (event.key !== 'Escape' || !model || (!model.armed && !model.ask)) {
      return;
    }
    event.stopPropagation();
    model.arm(null);
    model.dismissAsk();
  };
}

function StatusItem(props: {
  current: CurrentModel;
  onExplore: () => void;
}): JSX.Element | null {
  const model = useCurrent(props.current);
  useModel(model);
  if (!model) {
    return null;
  }
  const jobs = model.jobs;
  const longest = jobs.longest;
  // The columns a cell uses are read only in the languages that analyse cells.
  const rows = model.unsupported('analysis')
    ? []
    : coverage(model).filter(row => row.label !== 'Derived');
  const explored = rows
    .slice(0, 2)
    .map(
      row =>
        `${row.used.toLocaleString()}/${row.total.toLocaleString()} ${row.label.split(' ')[0]}`
    )
    .join(' · ');
  const serial = jobs.parallel === false;
  return (
    <div className="jp-Epi-status">
      <span
        className="jp-Epi-status-runs"
        title={
          serial
            ? (jobs.serialReason ??
              'This kernel has no subshells: branches run one after another in the main shell')
            : `${jobs.busy} of ${jobs.capacity} parallel runs busy${jobs.queued ? `, ${jobs.queued} queued` : ''}. ${PARALLEL_HELP}`
        }
      >
        {serial ? 'Parallel off' : `Parallel ${jobs.busy}/${jobs.capacity}`}
        {jobs.queued ? ` · ${jobs.queued} queued` : ''}
      </span>
      {longest && (
        <span className="jp-Epi-status-job" title={longest.text}>
          {longest.label}{' '}
          <ProgressBar value={longest.progress} label={longest.text} />
        </span>
      )}
      {explored && (
        <button className="jp-Epi-link" onClick={props.onExplore}>
          explored {explored}
        </button>
      )}
    </div>
  );
}

export class StatusWidget extends ReactWidget {
  constructor(
    private _current: CurrentModel,
    private _onExplore: () => void
  ) {
    super();
    this.addClass('jp-Epi-statusbar');
  }

  render(): JSX.Element {
    return <StatusItem current={this._current} onExplore={this._onExplore} />;
  }
}

function AIItem(props: { current: CurrentModel }): JSX.Element | null {
  const model = useCurrent(props.current);
  useModel(model);
  if (!model) {
    return null;
  }
  const { settings } = model;
  const status = model.policyStatus;
  const pending = model.tableNotes.pending;
  const title = TASKS.map(
    task => `${task.label}: ${modelName(status, settings.models[task.id])}`
  ).join('\n');
  return (
    <span
      className="jp-Epi-status-models"
      title={`${title}\nClick to choose in the settings.`}
    >
      {aiSummary(status, settings.models)}
      {pending ? ` · labelling ${pending}` : ''}
    </span>
  );
}

/**
 * The status bar item that says which models the view uses, and opens their
 * settings on a click.
 */
export class AIStatusWidget extends ReactWidget {
  constructor(
    private _current: CurrentModel,
    private _open: () => void
  ) {
    super();
    this.addClass('jp-Epi-statusbar');
    this.addClass('jp-mod-highlighted');
    this.node.addEventListener('click', this._open);
  }

  render(): JSX.Element {
    return <AIItem current={this._current} />;
  }

  dispose(): void {
    this.node.removeEventListener('click', this._open);
    super.dispose();
  }
}

/**
 * Renders Whybook plots and progress reports in classic notebook views.
 */
class PlotRenderer extends ReactWidget implements IRenderMime.IRenderer {
  constructor(private _mimeType: string) {
    super();
    this.addClass('jp-Epi-mimeplot');
  }

  renderModel(model: IRenderMime.IMimeModel): Promise<void> {
    this._data = model.data[this._mimeType];
    this.update();
    return Promise.resolve();
  }

  render(): JSX.Element | null {
    const data = this._data;
    if (!data) {
      return null;
    }
    if (this._mimeType === PLOT_MIME) {
      const payload = data as IPlotPayload;
      return (
        <div>
          <div className="jp-Epi-fullplot-title">{payload.title}</div>
          <EpiPlot payload={payload} width={480} height={260} />
        </div>
      );
    }
    // What whybook.progress displays.
    const report = data as { fraction?: number | null; stage?: string | null };
    return (
      <div className="jp-Epi-job">
        <ProgressBar
          value={report.fraction ?? null}
          label={report.stage ?? 'progress'}
          wide
        />
        <span>{report.stage}</span>
        <span className="jp-Epi-percent">
          {Math.round((report.fraction ?? 0) * 100)}%
        </span>
      </div>
    );
  }

  private _data: unknown = null;
}

export const plotRendererFactory: IRenderMime.IRendererFactory = {
  safe: true,
  mimeTypes: [PLOT_MIME, PROGRESS_MIME],
  defaultRank: 40,
  createRenderer: options => new PlotRenderer(options.mimeType)
};
