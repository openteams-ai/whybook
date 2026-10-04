import type { IEditorServices } from '@jupyterlab/codeeditor';
import {
  ToolbarButtonComponent,
  fastForwardIcon
} from '@jupyterlab/ui-components';
import * as React from 'react';
import * as ReactDOM from 'react-dom';

import type { EpiModel } from '../model/epimodel';
import { SECTIONS } from '../model/epimodel';
import { WIDTH_STEPS, ZOOM_STEPS } from '../model/spacedetail';
import type {
  Detail,
  MapDetail,
  Mode,
  QuestionType,
  ViewKind
} from '../tokens';
import { Bench } from './bench';
import {
  CellLabel,
  CloseButton,
  CopyButton,
  KEPT_SEARCHES,
  cellElement,
  flash,
  questionKeys,
  scrollBehavior,
  useDismiss,
  useModel,
  useQuestionFocus
} from './common';
import { RightPanel } from './exploration';
import { LinearView } from './linear';
import { MapView } from './map';
import { usePopoverPlace } from './popoverplace';
import { LAYOUT_ICONS, Segmented } from './segmented';
import { useDetailFollowsWidth } from './spacedetail';
import { useDragScroll } from './dragscroll';
import {
  AskContent,
  ContentsSection,
  DecisionHeading,
  DecisionReason,
  QuestionsSection,
  VariablesSection,
  askMode,
  askTitle,
  inPopover
} from './variables';

// From the most detail to the least: Code shows every cell as it is, Bench
// groups them into cards by section, and Map draws what they use as a graph.
const VIEWS: { id: ViewKind; label: string; title: string }[] = [
  {
    id: 'linear',
    label: 'Code',
    title:
      "Every cell in the notebook's order, one to one: its code in an editor, its outputs in full, and its questions"
  },
  { id: 'bench', label: 'Bench', title: 'Cells as cards, grouped by section' },
  { id: 'map', label: 'Map', title: 'Cells and what they use, as a graph' }
];

// What each mode changes: the order of the questions offered, and what the
// AI is asked for when it proposes more. From exploration to the finished
// analysis: Wonder looks for what else is there, Do carries the analysis on,
// and Report builds what goes into a report.
const MODES: { id: Mode; label: string; title: string }[] = [
  {
    id: 'wonder',
    label: 'Wonder',
    title:
      'Look for what else is there: causal and association questions, and a change from the kind asked last, rank first; AI proposes new directions'
  },
  {
    id: 'do',
    label: 'Do',
    title:
      'Carry on with the analysis: data quality and descriptive questions, and more of the kind asked last, rank first; AI proposes next steps as actions'
  },
  {
    id: 'report',
    label: 'Report',
    title:
      'Build a report: association and model questions rank first; AI proposes effects, comparisons and model checks'
  }
];

type Layout = 'sidebars' | 'variables-here' | 'all-here';

function layoutOf(model: EpiModel): Layout {
  const settings = model.settings;
  return settings.variablesPlacement === 'document' &&
    settings.explorationPlacement === 'document'
    ? 'all-here'
    : settings.variablesPlacement === 'document'
      ? 'variables-here'
      : 'sidebars';
}

/*
 * The view's controls. They are items of the JupyterLab toolbar of the
 * panel, next to the kernel name and status.
 */

export function ViewSwitch(props: { model: EpiModel }): JSX.Element {
  const { model } = props;
  useModel(model);
  return (
    <Segmented
      toolbar
      className="jp-Epi-views"
      label="View"
      value={model.view}
      onChange={view => model.setView(view)}
      options={VIEWS.map(view => ({
        value: view.id,
        label: view.label,
        title: view.title
      }))}
    />
  );
}

export function ModeSwitch(props: { model: EpiModel }): JSX.Element {
  const { model } = props;
  useModel(model);
  return (
    <Segmented
      toolbar
      className="jp-Epi-modes"
      label="Mode"
      value={model.mode}
      onChange={mode => model.setMode(mode)}
      options={MODES.map(mode => ({
        value: mode.id,
        label: mode.label,
        title: mode.title
      }))}
    />
  );
}

const LAYOUTS: { value: Layout; title: string }[] = [
  { value: 'sidebars', title: 'Panels in the sidebars' },
  { value: 'variables-here', title: 'Variables beside the notebook' },
  { value: 'all-here', title: 'All panels beside the notebook' }
];

export function LayoutSelect(props: { model: EpiModel }): JSX.Element {
  const { model } = props;
  useModel(model);
  const settings = model.settings;
  const setLayout = (value: Layout) => {
    settings.set(
      'variablesPlacement',
      value === 'sidebars' ? 'sidebar' : 'document'
    );
    settings.set(
      'explorationPlacement',
      value === 'all-here' ? 'document' : 'sidebar'
    );
  };
  return (
    <Segmented
      toolbar
      className="jp-Epi-layout"
      label="Layout: where the panels go"
      value={layoutOf(model)}
      onChange={setLayout}
      options={LAYOUTS.map(layout => ({
        ...layout,
        icon: LAYOUT_ICONS[layout.value]
      }))}
    />
  );
}

const DETAILS: { value: Detail; label: string; title: string }[] = [
  {
    value: 'overview',
    label: 'Overview',
    title:
      'every table and every printed text as a tile, and plots as thumbnails'
  },
  {
    value: 'compact',
    label: 'Compact',
    title:
      'no table in full, printed text in full up to 3 lines, and plots 340 px wide'
  },
  {
    value: 'full',
    label: 'Full',
    title:
      'small tables in full, printed text in full up to 10 lines, and plots up to 640 px wide; in the Code view, every output as in the notebook'
  }
];

/** The levels of the map, from the cells alone to the bench's Overview. */
const MAP_DETAILS: { value: MapDetail; label: string; title: string }[] = [
  { value: 'none', label: 'None', title: 'the cells alone, without outputs' },
  {
    value: 'minimal',
    label: 'Minimal',
    title:
      "one line of small tiles per cell: a table's size, a plot's kind and title, a text's line count"
  },
  {
    value: 'overview',
    label: 'Overview',
    title:
      'the outputs as at Overview on the bench: a table as a tile with its description and headline, a plot as a thumbnail'
  }
];

/**
 * The rule of the level of detail that follows the space, for the slider's
 * tooltip: what sets the level, and how long a level the analyst picks holds.
 */
export function followRule(map: boolean, picked: boolean): string {
  const percent = (zoom: number) => `${Math.round(zoom * 100)}%`;
  const rule = map
    ? `The zoom sets the level: None below ${percent(ZOOM_STEPS[0])}, Minimal from ${percent(ZOOM_STEPS[0])}, Overview from ${percent(ZOOM_STEPS[1])}.`
    : `The width of the column of cells sets the level: Overview when narrow, Compact from ${WIDTH_STEPS[0]} px, Full from ${WIDTH_STEPS[1]} px.`;
  const space = map ? 'the zoom' : 'the width';
  return picked
    ? `You picked this level. It holds until ${space} reaches another level. ${rule}`
    : `${rule} A level you pick holds until ${space} reaches another level.`;
}

/**
 * The level of detail of the outputs, in the toolbar. On the bench and in
 * the Code view it goes from tiles only to tables in full. On the map it goes
 * from the cells alone to the tiles of the bench's Overview. With the setting
 * "Level of detail follows the space", it shows the level in force, which
 * the width of the view or the zoom of the map sets.
 */
export function DetailSlider(props: { model: EpiModel }): JSX.Element {
  const { model } = props;
  useModel(model);
  const map = model.view === 'map';
  const levels: { value: string; label: string; title: string }[] = map
    ? MAP_DETAILS
    : DETAILS;
  const value = map ? model.mapDetail : model.detail;
  const index = Math.max(
    0,
    levels.findIndex(level => level.value === value)
  );
  const current = levels[index];
  const what = map ? 'the outputs on the map' : 'the outputs';
  const space = model.spaceDetail;
  const title = `Level of detail of ${what}: ${current.label}, ${current.title}`;
  return (
    <label
      className="jp-Epi-detail"
      title={
        space.follows
          ? `${title}. ${followRule(map, map ? space.mapPicked : space.picked)}`
          : title
      }
    >
      <span className="jp-Epi-detail-label">Detail</span>
      <input
        type="range"
        min={0}
        max={levels.length - 1}
        step={1}
        value={index}
        aria-label={`Level of detail of ${what}`}
        aria-valuetext={current.label}
        onChange={event => {
          const picked = Number(event.currentTarget.value);
          if (map) {
            model.pickMapDetail(MAP_DETAILS[picked].value);
          } else {
            model.pickDetail(DETAILS[picked].value);
          }
        }}
      />
      <span className="jp-Epi-detail-value">{current.label}</span>
    </label>
  );
}

export function RunAllButton(props: { model: EpiModel }): JSX.Element {
  const { model } = props;
  return (
    <ToolbarButtonComponent
      className="jp-Epi-runall"
      icon={fastForwardIcon}
      label="Run all"
      tooltip="Run every cell in order; branches run in parallel"
      onClick={() => void model.runAll()}
    />
  );
}

/**
 * The questions of the current request, next to where the user dropped or clicked.
 */
function Popover(props: {
  model: EpiModel;
  visible: boolean;
}): JSX.Element | null {
  const { model, visible } = props;
  const ask = model.ask;
  const box = React.useRef<HTMLDivElement>(null);
  const show = visible && !!ask && inPopover(model, ask);
  // The first question takes the keyboard focus, and it goes back on close.
  useQuestionFocus(box, model, show);
  const close = () => model.dismissAsk();
  // A click or keyboard focus elsewhere closes the questions. A click in the
  // Questions section, as on its switches of Click mode, keeps them, and the
  // Ask menu opens from here. The questions of a drop or a pick also stay
  // while the analyst uses the search of Variables or Contents, from which
  // they picked: clearing it leaves them open, though the row of the target
  // may leave the list (design iteration 1.83).
  const keep = '.jp-Epi-questions, .jp-Epi-placemenu';
  useDismiss(box, () => show && close(), {
    keep: ask?.kind === 'drop' ? `${keep}, ${KEPT_SEARCHES}` : keep
  });
  // Inside the window, below the menu bar: above the pointer when there is
  // more room there, and with a list that scrolls when the popover is taller
  // than the room. It is placed again when the model's questions make it
  // grow (./popoverplace.ts).
  usePopoverPlace(box, ask?.anchor, show);
  if (!show || !ask) {
    return null;
  }
  const mode = ask.kind === 'drop' ? askMode(ask) : null;
  return ReactDOM.createPortal(
    <div
      className="jp-Epi-popover"
      role="dialog"
      aria-label="Questions"
      ref={box}
      onMouseDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      onKeyDown={questionKeys}
    >
      <div className="jp-Epi-ask-head">
        {ask.kind === 'decision' ? (
          <DecisionHeading ask={ask} />
        ) : (
          <code>{askTitle(model)}</code>
        )}
        {mode && (
          <span className={`jp-Epi-pill${mode.strong ? ' jp-mod-strong' : ''}`}>
            {mode.label}
          </span>
        )}
        {ask.kind === 'cells' && (
          <span className="jp-Epi-caption">
            {ask.cells.length > 1
              ? `${ask.cells.length} cells selected`
              : 'ranked for this cell'}
          </span>
        )}
        {ask.kind === 'note' && (
          <span className="jp-Epi-caption">
            {ask.claim ? 'the words selected' : 'the whole text'}
          </span>
        )}
        {ask.kind === 'note' && ask.claim && (
          // Selecting words asks about them; copying them needs a button.
          <CopyButton
            label="Copy the words selected"
            copy={() => ({ text: ask.claim! })}
          />
        )}
        <CloseButton label="Close the questions" onClick={close} />
      </div>
      {ask.kind === 'decision' && <DecisionReason ask={ask} />}
      <AskContent model={model} />
      {ask.kind === 'drop' && (
        <div className="jp-Epi-ask-foot">
          <label className="jp-Epi-parallel-switch">
            <input
              type="checkbox"
              className="jp-mod-styled"
              checked={ask.modifiers.parallel}
              disabled={ask.loading}
              onChange={() => model.toggleParallel()}
            />{' '}
            Explore in parallel
          </label>
          <span className="jp-Epi-caption">
            Runs on pick, no confirmation. Shift+drop always branches · Alt+drop
            explores in parallel.
          </span>
        </div>
      )}
      {ask.kind === 'cells' && (
        <div className="jp-Epi-popover-foot">
          <button
            className="jp-Epi-link"
            onClick={() => model.setView('linear')}
          >
            Open in Code
          </button>
          <button
            className="jp-Epi-link"
            onClick={() => model.setView('bench')}
          >
            Open on the bench
          </button>
          <span className="jp-Epi-caption">Drag a box to select more</span>
        </div>
      )}
    </div>,
    document.body
  );
}

/**
 * Scroll the view to a cell and flash it. False when the view does not draw
 * the cell, as when its section is collapsed.
 */
function bringIntoView(root: HTMLElement | null, cellId: string): boolean {
  const element = cellElement(root, cellId);
  if (!element || !root) {
    return false;
  }
  // A card taller than the view shows its head; a shorter one, all of it.
  const tall = element.getBoundingClientRect().height > root.clientHeight;
  element.scrollIntoView({
    block: tall ? 'start' : 'center',
    inline: 'nearest',
    behavior: scrollBehavior()
  });
  flash(element);
  return true;
}

/** Whether the whole element shows in the scrolled area of the view. */
function inSight(root: HTMLElement | null, element: Element): boolean {
  if (!root) {
    return true;
  }
  const box = element.getBoundingClientRect();
  const view = root.getBoundingClientRect();
  return box.top >= view.top && box.bottom <= view.bottom;
}

export interface IDocumentProps {
  model: EpiModel;
  editorServices: IEditorServices | null;
  openFile: (path: string, line: number | null) => void;
  isVisible: () => boolean;
}

/**
 * A way back to the cell the analyst worked on last, once it scrolls out of
 * the bench or the Code view: a button at the edge that the cell went past.
 */
function BackToCell(props: {
  model: EpiModel;
  main: React.RefObject<HTMLDivElement>;
}): JSX.Element | null {
  const { model, main } = props;
  const cellId = model.currentCell;
  const [where, setWhere] = React.useState<'above' | 'below' | null>(null);
  React.useEffect(() => {
    setWhere(null);
    const root = main.current;
    const element = cellId ? cellElement(root, cellId) : null;
    if (!root || !element) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) =>
        setWhere(
          entry.isIntersecting
            ? null
            : entry.boundingClientRect.top <
                (entry.rootBounds?.top ?? root.getBoundingClientRect().top)
              ? 'above'
              : 'below'
        ),
      { root }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [cellId, main, model.view]);
  const cell = cellId ? model.cell(cellId) : null;
  if (!where || !cell) {
    return null;
  }
  return (
    <button
      className={`jp-Epi-backtocell jp-mod-${where}`}
      title="Scroll back to the cell you worked on last"
      onClick={() => model.showCell(cell.id)}
    >
      <span aria-hidden="true">{where === 'above' ? '↑' : '↓'}</span>
      <CellLabel cell={cell} />
      <span className="jp-Epi-backtocell-title">{cell.title}</span>
    </button>
  );
}

export function DocumentView(props: IDocumentProps): JSX.Element {
  const { model } = props;
  useModel(model);
  const settings = model.settings;
  const leftHere = settings.variablesPlacement === 'document';
  const rightHere = settings.explorationPlacement === 'document';
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      model.arm(null);
      model.dismissAsk();
    }
  };
  // A link to a cell, as in the cell details: the bench and the Code view
  // scroll to it and flash it. The map moves its camera to it instead.
  const main = React.useRef<HTMLDivElement>(null);
  // The width of the view's column, for the level of detail that follows the
  // space (a trial, behind its setting).
  useDetailFollowsWidth(main, model);
  // The bench and the lists of the panels scroll while a drag nears their
  // edges (design iteration 1.77).
  useDragScroll();
  // A file that the model asks to open, such as a module the agent wrote.
  React.useEffect(() => {
    const open = (_: EpiModel, path: string) => props.openFile(path, null);
    model.fileOpenRequested.connect(open);
    return () => {
      model.fileOpenRequested.disconnect(open);
    };
  }, [model, props.openFile]);
  // The type of question lit from a badge or the Exploration panel, as an
  // attribute that the style reads, so that no cell draws again.
  const root = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const light = (_: EpiModel, type: QuestionType | null) => {
      if (type) {
        root.current?.setAttribute('data-lit-type', type);
      } else {
        root.current?.removeAttribute('data-lit-type');
      }
    };
    model.litTypeChanged.connect(light);
    return () => {
      model.litTypeChanged.disconnect(light);
    };
  }, [model]);
  // A cell to show once the bench has drawn it: its section was collapsed.
  const waiting = React.useRef<string | null>(null);
  React.useEffect(() => {
    const show = (_: EpiModel, cellId: string) => {
      waiting.current = null;
      if (model.view === 'map' || bringIntoView(main.current, cellId)) {
        return;
      }
      // A cell in a collapsed section of the bench: the section opens.
      const cell = model.cell(cellId);
      if (
        model.view === 'bench' &&
        cell &&
        model.collapsed.has(cell.sectionId)
      ) {
        waiting.current = cellId;
        model.toggleSection(cell.sectionId);
      }
    };
    model.cellShown.connect(show);
    return () => {
      model.cellShown.disconnect(show);
    };
  }, [model]);
  // The first drawing after the section opened has the cell.
  React.useEffect(() => {
    const cellId = waiting.current;
    if (cellId) {
      waiting.current = null;
      bringIntoView(main.current, cellId);
    }
  });
  // "Go to the cells" in the Questions section: the first target of the
  // pick takes the keyboard focus.
  React.useEffect(() => {
    const go = () => {
      main.current?.querySelector<HTMLElement>('.jp-Epi-dropzone')?.focus();
    };
    model.targetsRequested.connect(go);
    return () => {
      model.targetsRequested.disconnect(go);
    };
  }, [model]);
  // The targets of a pick are one Tab stop: the one the focus was on last,
  // else the first. The arrow keys move between them (PickZone).
  React.useEffect(() => {
    const zones = Array.from(
      main.current?.querySelectorAll<HTMLElement>('.jp-Epi-dropzone') ?? []
    );
    const stop =
      zones.find(zone => zone.dataset.stop === 'true') ?? zones[0] ?? null;
    zones.forEach(zone => {
      zone.tabIndex = zone === stop ? 0 : -1;
    });
  });
  // A cell the map asked to show on the bench, once the bench has drawn.
  React.useEffect(() => {
    if (model.view === 'map') {
      return;
    }
    const cellId = model.takePendingShow();
    if (cellId) {
      requestAnimationFrame(() => model.showCell(cellId));
    }
  }, [model, model.view]);
  // The strip of an agent's run that the Running panel or the history of
  // runs opened the view on, once the view has drawn it: after the notebook
  // loads, in a view that opened for it. The strip of a run that the analyst
  // just started comes into sight only when it is out of sight, as at the
  // end of the notebook for a question from the kernel's menu (1.73).
  React.useEffect(() => {
    const key = model.stripToShow;
    if (!key || model.isLoading()) {
      return;
    }
    const ifHidden = model.stripIfHidden;
    const cell = model.cell(key);
    if (model.view === 'map') {
      model.stripShown();
      if (cell && !ifHidden) {
        model.showCell(key);
      }
      return;
    }
    const strip = main.current?.querySelector(
      `[data-strip-id="${CSS.escape(key)}"]`
    );
    if (strip) {
      model.stripShown();
      if (ifHidden && inSight(main.current, strip)) {
        return;
      }
      // A strip taller than the view shows its head.
      const tall =
        !!main.current &&
        strip.getBoundingClientRect().height >
          main.current.getBoundingClientRect().height;
      strip.scrollIntoView({
        block: tall ? 'start' : 'center',
        inline: 'nearest',
        behavior: scrollBehavior()
      });
      flash(strip);
      return;
    }
    // A strip in a collapsed section: the section opens, and the next
    // drawing has the strip.
    if (model.view === 'bench' && cell && model.collapsed.has(cell.sectionId)) {
      model.toggleSection(cell.sectionId);
      return;
    }
    // The view shows no strip for the run, as when its cell was deleted.
    model.stripShown();
    if (cell && !ifHidden) {
      model.showCell(key);
    }
  });
  let body: JSX.Element;
  if (model.view === 'map') {
    body = <MapView model={model} />;
  } else if (model.view === 'linear') {
    body = (
      <LinearView
        model={model}
        editorServices={props.editorServices}
        openFile={props.openFile}
      />
    );
  } else {
    body = (
      <Bench
        model={model}
        editorServices={props.editorServices}
        openFile={props.openFile}
      />
    );
  }
  return (
    <div
      ref={root}
      className={`jp-Epi-document jp-mod-${model.interaction}`}
      onKeyDown={onKeyDown}
    >
      <div className="jp-Epi-body">
        {leftHere && (
          <div className="jp-Epi-docpanel jp-mod-left">
            {/* A section moved to another panel stays there. */}
            {!settings.moved.has(SECTIONS.variables) && (
              <VariablesSection model={model} />
            )}
            {!settings.moved.has(SECTIONS.contents) && (
              <ContentsSection model={model} />
            )}
            {!settings.moved.has(SECTIONS.questions) && (
              <QuestionsSection model={model} />
            )}
          </div>
        )}
        <div className="jp-Epi-mainwrap">
          <div className="jp-Epi-main" ref={main}>
            {body}
          </div>
          {model.view !== 'map' && <BackToCell model={model} main={main} />}
        </div>
        {rightHere && (
          <div className="jp-Epi-docpanel jp-mod-right">
            <RightPanel
              model={model}
              width={260}
              editorServices={props.editorServices}
            />
          </div>
        )}
      </div>
      <Popover model={model} visible={props.isVisible()} />
    </div>
  );
}
