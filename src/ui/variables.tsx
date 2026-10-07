import {
  Button,
  InputGroup,
  caretDownIcon,
  caretRightIcon
} from '@jupyterlab/ui-components';
import * as React from 'react';

import { barsText } from '../model/bars';
import { excerpt } from '../model/claims';
import {
  allCalls,
  callChoice,
  callName,
  callsOf,
  sourceNote
} from '../model/decisions';
import type {
  Ask,
  EpiModel,
  IDecisionAsk,
  IDropAsk,
  IMissing,
  INoteAsk
} from '../model/epimodel';
import { pythonString } from '../model/kernel';
import {
  axisValues,
  estimateText,
  numberText,
  pValueText,
  rangeText,
  shareText
} from '../model/numbers';
import { runnableFirst } from '../model/questionorder';
import { triesValues, valuesCaption, valuesWhy } from '../model/rulesfirst';
import { constantText } from '../model/values';
import type { IColumn, IItem, IOption, ITerm, IVariable } from '../tokens';
import {
  AIOffNote,
  AITag,
  CloseButton,
  OptionRow,
  OptionRows,
  OrderNote,
  OwnQuestion,
  ProgressBar,
  aiOffReason,
  anchorOf,
  arrowKeys,
  carriesItem,
  dragItem,
  itemName,
  modifiersOf,
  pointerOn,
  questionKeys,
  setDragItem,
  stageText,
  useModel,
  useQuestionFocus
} from './common';
import { InferredChips } from './inferred';
import type { ISegment } from './segmented';
import { Segmented } from './segmented';
import { TableAskContent } from './tablequestions';

const ROW_HEIGHT = 28;

function shortType(variable: IVariable): string {
  if (variable.selection) {
    return 'Selection';
  }
  const type = variable.type ?? variable.kind;
  return type.split('.').pop() ?? type;
}

export function shapeOf(variable: IVariable): string {
  if (variable.kind === 'dataframe') {
    return `${(variable.rows ?? 0).toLocaleString()} × ${(variable.n_columns ?? 0).toLocaleString()}`;
  }
  if (variable.kind === 'constant') {
    return constantText(variable);
  }
  if (variable.shape) {
    return variable.shape.join(' × ');
  }
  if (variable.rows !== undefined) {
    return variable.rows.toLocaleString();
  }
  if (variable.length !== undefined) {
    // A string longer than the list shows its value comes as its length.
    const [one, many] =
      variable.type === 'builtins.str'
        ? ['character', 'characters']
        : ['item', 'items'];
    return `${variable.length.toLocaleString()} ${variable.length === 1 ? one : many}`;
  }
  return '';
}

export function columnMeta(column: IColumn): string {
  const parts: string[] = [];
  if (column.levels && column.levels.length === 2 && column.kind === 'binary') {
    parts.push(column.levels.join(' / '));
  } else if (column.tag === 'ord' && column.levels?.length) {
    parts.push(
      `${column.levels[0]}–${column.levels[column.levels.length - 1]}`
    );
  } else if (
    (column.tag === 'cat' || column.tag === 'ord') &&
    column.unique !== undefined
  ) {
    parts.push(`${column.unique} levels`);
  } else if (
    (column.tag === 'int' || column.tag === 'num') &&
    typeof column.min === 'number' &&
    typeof column.max === 'number'
  ) {
    // Values in text (src/model/numbers.ts): the kernel lists six significant figures.
    parts.push(rangeText(column.min, column.max));
  }
  if (column.missing && column.rows) {
    parts.push(`${shareText(column.missing / column.rows)} NA`);
  }
  return parts.join(' · ');
}

/**
 * Props that make an element a drag source, a drop target and a pick target.
 */
function itemHandlers(model: EpiModel, item: IItem) {
  return {
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      setDragItem(event, item);
      model.arm(item);
    },
    onDragEnd: () => {
      if (model.armed && model.armed.name === item.name) {
        model.arm(null);
      }
    },
    onDragOver: (event: React.DragEvent) => {
      if (carriesItem(event)) {
        event.preventDefault();
      }
    },
    onDrop: (event: React.DragEvent) => {
      const source = dragItem(event);
      if (!source) {
        return;
      }
      event.preventDefault();
      model.arm(null);
      void model.askDrop(
        source,
        { item },
        modifiersOf(event, model),
        anchorOf(event)
      );
    },
    onClick: (event: React.MouseEvent) => {
      model.pick(
        item,
        modifiersOf(event, model),
        event.detail === 0 ? null : anchorOf(event)
      );
    }
  };
}

function VariableRow(props: {
  model: EpiModel;
  variable: IVariable;
  /** 0 for the one row of the list where Tab stops, -1 for the others. */
  tabIndex: number;
  onFocus: () => void;
  /** A name of an agent's run, under the head of the run. */
  inRun?: boolean;
}): JSX.Element {
  const { model, variable } = props;
  const item: IItem = {
    kind: 'variable',
    name: variable.name,
    label: variable.name
  };
  const armed =
    model.armed?.kind === 'variable' && model.armed.name === variable.name;
  const classes = ['jp-Epi-item', 'jp-Epi-variable'];
  if (props.inRun) {
    classes.push('jp-mod-inrun');
  }
  if (armed) {
    classes.push('jp-mod-armed');
  } else if (model.selected === variable.name) {
    classes.push('jp-mod-selected');
  }
  if (variable.stale) {
    classes.push('jp-mod-stale');
  }
  return (
    <button
      className={classes.join(' ')}
      {...itemHandlers(model, item)}
      aria-pressed={armed}
      title={
        variable.stale
          ? `${variable.type ?? variable.kind}, from the last run: not in the kernel`
          : variable.type
      }
      data-variable={variable.name}
      tabIndex={props.tabIndex}
      onFocus={props.onFocus}
    >
      <span className="jp-Epi-item-name">{variable.name}</span>
      <span className="jp-Epi-item-type">{shortType(variable)}</span>
      <span className="jp-Epi-item-shape">{shapeOf(variable)}</span>
    </button>
  );
}

export function VariablesSection(props: { model: EpiModel }): JSX.Element {
  const { model } = props;
  useModel(model);
  const [query, setQuery] = React.useState('');
  // The runs whose names show, unfolded.
  const [unfolded, setUnfolded] = React.useState<ReadonlySet<string>>(
    () => new Set()
  );
  const variables = model.variables();
  const matches = (variable: IVariable) =>
    !query || variable.name.toLowerCase().includes(query.toLowerCase());
  // The names that an agent's run made for its own steps, which no later
  // cell outside the run reads, go under the run, folded (design iteration
  // 1.83, ../model/runnames.ts). A search shows those it finds.
  const runGroups = model.runNames();
  const ofRuns = new Set(runGroups.flatMap(group => group.names));
  const byName = new Map(variables.map(variable => [variable.name, variable]));
  const groups = runGroups
    .map(group => ({
      ...group,
      variables: group.names
        .map(name => byName.get(name))
        .filter(
          (variable): variable is IVariable => !!variable && matches(variable)
        )
    }))
    .filter(group => group.variables.length > 0);
  const isOpen = (run: string) => !!query || unfolded.has(run);
  const toggle = (run: string) =>
    setUnfolded(current => {
      const next = new Set(current);
      if (!next.delete(run)) {
        next.add(run);
      }
      return next;
    });
  const shown = variables.filter(
    variable => !ofRuns.has(variable.name) && matches(variable)
  );
  const kernel = model.sessionContext.session?.kernel;
  // A kernel that the view saw start held nothing, and is not read before
  // something runs in it. A kernel of a language without the listing keeps
  // its note.
  const listed =
    !!model.bridge.snapshot ||
    (model.bridge.startedEmpty && !model.unsupported('variables'));
  const live = model.liveCount();
  const stale = variables.length - live;
  // The list is one Tab stop, and the arrow keys move inside it: the row the
  // focus was on last, else the picked or selected one, else the first. The
  // head of a run's names is a row too.
  const [current, setCurrent] = React.useState<string | null>(null);
  const stops = [
    ...shown.map(variable => variable.name),
    ...groups.flatMap(group => [
      runRowId(group.run),
      ...(isOpen(group.run)
        ? group.variables.map(variable => variable.name)
        : [])
    ])
  ];
  const stop =
    stops.find(id => id === current) ??
    stops.find(id => id === model.armed?.name || id === model.selected) ??
    stops[0];
  return (
    <div className="jp-Epi-section jp-Epi-variables">
      <div className="jp-Epi-section-head">
        <span className="jp-Epi-head-label">Variables</span>
        <span className="jp-Epi-section-count">
          {model.refreshing && (
            <span className="jp-Epi-spinner" aria-label="Refreshing" />
          )}
          {live} in kernel
        </span>
      </div>
      <InputGroup
        className="jp-Epi-search"
        type="text"
        rightIcon="ui-components:search"
        aria-label="Filter variables"
        placeholder="Filter variables"
        value={query}
        onChange={event => setQuery(event.target.value)}
      />
      {stale > 0 && (
        <div className="jp-Epi-stale-note">
          {kernel
            ? `${stale} from the last run, not in the kernel.`
            : `No kernel is running: the ${stale} below are from the last run.`}{' '}
          <button className="jp-Epi-link" onClick={() => void model.runAll()}>
            Run all
          </button>
        </div>
      )}
      <div
        className="jp-Epi-list"
        role="list"
        aria-busy={model.reading}
        onKeyDown={arrowKeys('.jp-Epi-variable, .jp-Epi-rungroup-head')}
      >
        {!kernel && variables.length === 0 && (
          <div className="jp-Epi-empty">
            No kernel. Start one from the toolbar.
          </div>
        )}
        {kernel && !listed && variables.length === 0 && (
          <div className="jp-Epi-empty">
            {model.unsupported('variables') ?? 'Reading the kernel…'}
          </div>
        )}
        {kernel && listed && variables.length === 0 && (
          <div className="jp-Epi-empty">
            No variables yet. Run a cell that loads data, or drag a data file
            from the file browser onto the notebook to start from it.
          </div>
        )}
        {shown.map(variable => (
          <VariableRow
            key={variable.name}
            model={model}
            variable={variable}
            tabIndex={variable.name === stop ? 0 : -1}
            onFocus={() => setCurrent(variable.name)}
          />
        ))}
        {groups.length > 0 && (
          <div className="jp-Epi-rungroups-label">
            Made by agents&apos; runs for their own steps
          </div>
        )}
        {groups.map(group => {
          const open = isOpen(group.run);
          const Caret = open ? caretDownIcon : caretRightIcon;
          const id = runRowId(group.run);
          const count = group.variables.length;
          return (
            <React.Fragment key={id}>
              <button
                className="jp-Epi-rungroup-head"
                aria-expanded={open}
                data-run={group.run}
                tabIndex={id === stop ? 0 : -1}
                onFocus={() => setCurrent(id)}
                onClick={() => toggle(group.run)}
                title={`${count} ${count === 1 ? 'name' : 'names'} that the agent's run made while it answered "${group.question || 'a question'}". No later cell uses ${count === 1 ? 'it' : 'them'}: a name that a later cell uses goes back to the list above.`}
              >
                <Caret.react tag="span" className="jp-Epi-rungroup-caret" />
                <span className="jp-Epi-rungroup-question">
                  {group.question || 'An agent’s run'}
                </span>
                <span className="jp-Epi-rungroup-count">{count}</span>
              </button>
              {open &&
                group.variables.map(variable => (
                  <VariableRow
                    key={variable.name}
                    model={model}
                    variable={variable}
                    inRun
                    tabIndex={variable.name === stop ? 0 : -1}
                    onFocus={() => setCurrent(variable.name)}
                  />
                ))}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

/** The id of the head of a run's names among the rows of Variables. */
function runRowId(run: string): string {
  return `run:${run}`;
}

function ColumnRow(props: {
  model: EpiModel;
  column: IColumn;
  used: boolean;
  /** 0 for the one row of the list where Tab stops, -1 for the others. */
  tabIndex: number;
  onFocus: () => void;
}): JSX.Element {
  const { model, column, used } = props;
  const item: IItem = {
    kind: 'column',
    name: column.name,
    label: column.label,
    parent: column.parent
  };
  const armed =
    model.armed?.kind === 'column' && model.armed.name === column.name;
  return (
    <button
      className={`jp-Epi-item jp-Epi-column${armed ? ' jp-mod-armed' : ''}`}
      {...itemHandlers(model, item)}
      aria-pressed={armed}
      title={`${column.label} · ${column.dtype ?? column.tag}`}
      tabIndex={props.tabIndex}
      onFocus={props.onFocus}
    >
      <span className="jp-Epi-column-tag">{column.tag}</span>
      <span className="jp-Epi-item-name">{column.label}</span>
      <span className="jp-Epi-item-shape">{columnMeta(column)}</span>
      <span
        className={`jp-Epi-used${used ? ' jp-mod-used' : ''}`}
        title={used ? 'Used in the analysis' : 'Not used yet'}
      />
    </button>
  );
}

/**
 * A list that renders only the rows in view, for frames with thousands of columns.
 */
function VirtualList<T>(props: {
  items: T[];
  height: number;
  render: (item: T) => JSX.Element;
  keyOf: (item: T) => string;
  onKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void;
}): JSX.Element {
  const [top, setTop] = React.useState(0);
  const { items, height } = props;
  if (items.length * ROW_HEIGHT <= height) {
    return (
      <div className="jp-Epi-list" onKeyDown={props.onKeyDown}>
        {items.map(item => (
          <React.Fragment key={props.keyOf(item)}>
            {props.render(item)}
          </React.Fragment>
        ))}
      </div>
    );
  }
  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - 5);
  const last = Math.min(
    items.length,
    Math.ceil((top + height) / ROW_HEIGHT) + 5
  );
  return (
    <div
      className="jp-Epi-list jp-mod-virtual"
      style={{ height }}
      onScroll={event => setTop((event.target as HTMLElement).scrollTop)}
      onKeyDown={props.onKeyDown}
    >
      <div style={{ height: items.length * ROW_HEIGHT, position: 'relative' }}>
        {items.slice(first, last).map((item, index) => (
          <div
            key={props.keyOf(item)}
            style={{
              position: 'absolute',
              top: (first + index) * ROW_HEIGHT,
              left: 0,
              right: 0
            }}
          >
            {props.render(item)}
          </div>
        ))}
      </div>
    </div>
  );
}

function FrameContents(props: {
  model: EpiModel;
  variable: IVariable;
}): JSX.Element {
  const { model, variable } = props;
  const [query, setQuery] = React.useState('');
  const [group, setGroup] = React.useState<string | null>(null);
  const columns = variable.columns ?? [];
  const used = model.used().get(variable.name) ?? new Set<string>();
  const total = variable.n_columns ?? columns.length;
  const wide = columns.length > 12;
  let listed = columns;
  if (group && variable.groups) {
    const members = new Set(
      variable.groups.find(g => g.label === group)?.columns ?? []
    );
    listed = listed.filter(column => members.has(column.label));
  }
  if (query) {
    listed = listed.filter(column =>
      column.label.toLowerCase().includes(query.toLowerCase())
    );
  } else if (wide) {
    // Columns already in the analysis first, then the rest in frame order.
    listed = [
      ...listed.filter(c => used.has(c.label)),
      ...listed.filter(c => !used.has(c.label))
    ];
  }
  const repr = variable.groups
    ? `grouped by ${variable.grouped_by ?? 'group'}`
    : variable.selection
      ? `rows of ${variable.selection.of}`
      : 'column list';
  const who = variable.groups
    ? 'metadata'
    : variable.selection
      ? 'from a plot selection'
      : 'metadata';
  let caption = `${total.toLocaleString()} columns`;
  if (variable.stale && columns.length < total) {
    caption = `${columns.length.toLocaleString()} of ${total.toLocaleString()} columns, as the notebook kept them`;
  } else if (query) {
    caption = `${listed.length.toLocaleString()} match · searching all ${total.toLocaleString()}`;
  } else if (wide && !group) {
    caption = `${total.toLocaleString()} columns, used ones first · scroll or search`;
  } else if (group) {
    caption = `${listed.length.toLocaleString()} ${group} columns`;
  }
  const visible =
    !query && wide && !group
      ? listed.slice(0, Math.max(10, listed.length))
      : listed;
  // One Tab stop, as in Variables: the row the focus was on last, else the
  // picked column, else the first.
  const [current, setCurrent] = React.useState<string | null>(null);
  const stop =
    visible.find(column => column.name === current)?.name ??
    visible.find(column => column.name === model.armed?.name)?.name ??
    visible[0]?.name;
  return (
    <div className="jp-Epi-contents-frame">
      <InputGroup
        className="jp-Epi-search"
        type="text"
        rightIcon="ui-components:search"
        aria-label="Search columns"
        placeholder={`Search ${total.toLocaleString()} columns`}
        value={query}
        onChange={event => setQuery(event.target.value)}
      />
      <div className="jp-Epi-repr">
        <span>Shown as</span>
        <span className="jp-Epi-repr-label">{repr}</span>
        <span className="jp-Epi-repr-who">{who}</span>
      </div>
      {variable.selection?.where && (
        <div className="jp-Epi-caption">where {variable.selection.where}</div>
      )}
      {variable.groups && (
        <div className="jp-Epi-groups">
          {variable.groups.map(g => {
            const count = g.columns.filter(c => used.has(c)).length;
            return (
              <button
                key={g.label}
                className={`jp-Epi-group${group === g.label ? ' jp-mod-active' : ''}${count ? ' jp-mod-used' : ''}`}
                onClick={() => setGroup(group === g.label ? null : g.label)}
              >
                {g.label}{' '}
                <span>{(g.total ?? g.columns.length).toLocaleString()}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="jp-Epi-caption">{caption}</div>
      <VirtualList
        items={visible}
        height={Math.min(visible.length, 12) * ROW_HEIGHT}
        keyOf={column => column.name}
        onKeyDown={arrowKeys('.jp-Epi-column')}
        render={column => (
          <ColumnRow
            model={model}
            column={column}
            used={used.has(column.label)}
            tabIndex={column.name === stop ? 0 : -1}
            onFocus={() => setCurrent(column.name)}
          />
        )}
      />
    </div>
  );
}

/**
 * A model's summary of the frame, under its columns: what one row is and what
 * the frame holds. It is asked for when the frame is selected, once.
 */
function FrameSummary(props: {
  model: EpiModel;
  variable: IVariable;
}): JSX.Element | null {
  const { model, variable } = props;
  const notes = model.frameNotes;
  const note = notes.note(variable);
  const ready = model.aiReady('labels');
  // Asks when the frame has no summary, or only one of another model.
  React.useEffect(() => {
    if (ready && !variable.stale) {
      notes.request(variable);
    }
  }, [
    variable.name,
    note === null,
    note?.by?.choice,
    ready,
    model.settings.models.labels
  ]);
  const pending = notes.state(variable) === 'pending';
  if (note) {
    return (
      <div className="jp-Epi-framesummary">
        <span className="jp-Epi-ai">{note.summary}</span>
        <AITag by={note.by ?? null} />
        {pending && (
          <ProgressBar
            value={null}
            label="The chosen AI model is summarising the frame"
            wide
          />
        )}
      </div>
    );
  }
  if (pending) {
    return (
      <div className="jp-Epi-framesummary">
        <ProgressBar value={null} label="AI is summarising the frame" wide />
      </div>
    );
  }
  return null;
}

function ConstantCard(props: {
  model: EpiModel;
  variable: IVariable;
}): JSX.Element {
  const { model, variable } = props;
  // No cell sets it: its value comes from a module, as a default.
  const defaulted = model.variableCells(variable.name).made.length === 0;
  const where = variable.defined_in
    ? `${variable.defined_in.file}${variable.defined_in.line ? ':' + variable.defined_in.line : ''}`
    : null;
  return (
    <div className={`jp-Epi-card${defaulted ? ' jp-mod-open' : ''}`}>
      <div className="jp-Epi-card-value" title={variable.value}>
        {constantText(variable)}
      </div>
      <div>
        {shortType(variable)}
        {where ? (
          <>
            {' '}
            · defined in <code>{where}</code>
          </>
        ) : null}
        {defaulted ? ', never set by you' : ''}
      </div>
    </div>
  );
}

/**
 * The cells around the variable in Contents, the same for every kind: the
 * cells that make it or import it, and the cells that use it. Each label
 * shows its cell in the view.
 */
function VariableCells(props: {
  model: EpiModel;
  variable: IVariable;
}): JSX.Element | null {
  const { model, variable } = props;
  const { made, imported, used } = model.variableCells(variable.name);
  const parts = [
    { label: 'Made by', cells: made },
    { label: 'Imported in', cells: imported },
    { label: 'Used by', cells: used }
  ].filter(part => part.cells.length);
  if (!parts.length) {
    return null;
  }
  return (
    <div className="jp-Epi-varcells">
      {parts.map((part, index) => (
        <span key={part.label}>
          {index > 0 && ' · '}
          {part.label}{' '}
          {part.cells.map((cell, at) => (
            <React.Fragment key={cell.id}>
              {at > 0 && (at === part.cells.length - 1 ? ' and ' : ', ')}
              <button
                className="jp-Epi-link jp-Epi-cell-link"
                title={`Show ${cell.label} ${cell.title} in the view`}
                onClick={() => model.showCell(cell.id)}
              >
                {cell.label}
              </button>
            </React.Fragment>
          ))}
        </span>
      ))}
    </div>
  );
}

/** A term's coefficient and interval, with the same decimals for all three. */
function termText(term: ITerm): { coef: string; interval: string } {
  const has = (value: number | null | undefined): value is number =>
    typeof value === 'number';
  if (!has(term.coef)) {
    return {
      coef: '',
      interval:
        has(term.lo) && has(term.hi)
          ? `${numberText(term.lo)}, ${numberText(term.hi)}`
          : ''
    };
  }
  const shown = estimateText(term.coef, term.lo, term.hi);
  return {
    coef: shown.estimate,
    interval:
      shown.lo !== null && shown.hi !== null ? `${shown.lo}, ${shown.hi}` : ''
  };
}

function ModelTable(props: { variable: IVariable }): JSX.Element {
  const { variable } = props;
  const terms = variable.terms ?? [];
  // A column of p-values when the model gives them.
  const withP = terms.some(term => typeof term.p === 'number');
  return (
    <div className="jp-Epi-model">
      {variable.formula && (
        <div className="jp-Epi-formula">{variable.formula}</div>
      )}
      <div className="jp-Epi-caption">
        {variable.model_class ?? 'model'}
        {variable.nobs ? ` · ${variable.nobs.toLocaleString()} rows` : ''}
        {variable.converged === false ? ' · did not converge' : ''}
      </div>
      <table className="jp-Epi-table">
        <thead>
          <tr>
            <th>term</th>
            <th>coef</th>
            <th>95% CI</th>
            {withP && <th>p</th>}
          </tr>
        </thead>
        <tbody>
          {terms.map(term => {
            const shown = termText(term);
            return (
              <tr key={term.term}>
                <td>{term.term}</td>
                <td>{shown.coef}</td>
                <td>{shown.interval}</td>
                {withP && (
                  <td>
                    {typeof term.p === 'number' ? pValueText(term.p) : ''}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ContentsSection(props: { model: EpiModel }): JSX.Element {
  const { model } = props;
  useModel(model);
  const name = model.selected;
  const variable = name ? model.variable(name) : null;
  let body: React.ReactNode;
  if (!variable) {
    body = (
      <div className="jp-Epi-empty">
        Select a variable to see what is inside.
      </div>
    );
  } else if (variable.kind === 'dataframe') {
    body = (
      <>
        <FrameContents key={variable.name} model={model} variable={variable} />
        <FrameSummary model={model} variable={variable} />
      </>
    );
  } else if (variable.kind === 'constant') {
    body = <ConstantCard model={model} variable={variable} />;
  } else if (variable.kind === 'model') {
    body = <ModelTable variable={variable} />;
  } else {
    body = (
      <div className="jp-Epi-card">
        <div>{variable.type}</div>
        <div>{shapeOf(variable)}</div>
      </div>
    );
  }
  // In Click mode a click on a variable shows it here, and Pick picks all
  // of it as the source of a question (design iteration 1.77). Once picked,
  // the button stays, pressed, so that the keyboard focus stays on it, and
  // a second press lets go of the pick.
  const picked =
    model.armed?.kind === 'variable' && !!name && model.armed.name === name;
  const pickable =
    model.interaction === 'click' && !!variable && (!model.armed || picked);
  return (
    <div className="jp-Epi-section jp-Epi-contents">
      {/* With a variable selected, the head is its name alone (design iteration 1.11). */}
      <div className={`jp-Epi-section-head${name ? '' : ' jp-mod-empty'}`}>
        <span className="jp-Epi-head-label">Contents</span>
        {name && <code>{name}</code>}
        {pickable && name && (
          <button
            className="jp-Epi-link jp-Epi-contents-pick"
            title={
              picked
                ? `${name} is picked: click a cell, a variable or a column as the target, or press again to let go of it`
                : `Pick ${name} as the source of a question, then click a cell, a variable or a column as the target`
            }
            aria-label={`Pick ${name}`}
            aria-pressed={picked}
            onClick={() =>
              model.arm(picked ? null : { kind: 'variable', name, label: name })
            }
          >
            {picked ? 'Picked' : 'Pick'}
          </button>
        )}
      </div>
      {variable?.stale && (
        <div className="jp-Epi-stale-note">
          From the last run, not in the kernel now.{' '}
          <button
            className="jp-Epi-link"
            onClick={event => model.askData(variable.name, anchorOf(event))}
          >
            Run the cells that make it
          </button>
        </div>
      )}
      {body}
      {variable && <VariableCells model={model} variable={variable} />}
    </div>
  );
}

function CapacityMeter(props: {
  model: EpiModel;
  planned: number;
}): JSX.Element {
  const { model, planned } = props;
  if (model.jobs.parallel === false) {
    return (
      <div className="jp-Epi-capacity jp-Epi-unsupported">
        This kernel has no subshells: the branches run one after another.
      </div>
    );
  }
  const capacity = model.jobs.capacity;
  const busy = model.jobs.busy;
  const free = Math.max(0, capacity - busy);
  const queued = Math.max(0, planned - free);
  return (
    <div className="jp-Epi-capacity">
      <span className="jp-Epi-slots" aria-label="Parallel runs">
        {Array.from({ length: capacity }, (_, index) => (
          <span
            key={index}
            className={
              index < busy
                ? 'jp-mod-busy'
                : index < busy + planned
                  ? 'jp-mod-planned'
                  : ''
            }
          />
        ))}
      </span>
      <span>
        {busy} running · {free} free, of {capacity} parallel runs
        {queued ? ` · ${queued} will queue` : ''}
      </span>
    </div>
  );
}

/**
 * The current question request: a field for a question of one's own, then
 * the questions offered. The drop popover and the Questions section both
 * show it.
 */
export function AskContent(props: {
  model: EpiModel;
  compact?: boolean;
}): JSX.Element | null {
  const { model } = props;
  const ask = model.ask;
  if (!ask) {
    return null;
  }
  const unsupported = model.askUnsupported(ask);
  if (unsupported) {
    // The view checks the numbers of a text itself, in any language.
    return (
      <div className="jp-Epi-askbody">
        {ask.kind === 'note' && <NoteAskContent model={model} ask={ask} />}
        <div className="jp-Epi-caption jp-Epi-unsupported">{unsupported}</div>
      </div>
    );
  }
  if (ask.missing) {
    return <MissingContent model={model} missing={ask.missing} />;
  }
  const parallel = ask.kind === 'drop' && ask.result?.mode === 'parallel';
  if (ask.kind === 'decision') {
    return (
      <div className="jp-Epi-askbody">
        <DecisionWhere model={model} ask={ask} />
        <DecisionValue key={ask.id} model={model} ask={ask} />
        <DecisionKind ask={ask} />
        <AskOptions model={model} ask={ask} />
      </div>
    );
  }
  // The field keeps its place while the questions load, so typing goes on.
  return (
    <div className="jp-Epi-askbody">
      <AIOffNote model={model} />
      <OwnQuestion
        key={ask.id}
        model={model}
        onAsk={(text, how) => void model.askOwn(text, 'request', how)}
        places={model.ownPlaces(ask)}
        parallel={ask.kind === 'drop' && !ask.loading}
        placeholder={
          parallel ? 'Your own question, as one more branch' : undefined
        }
      />
      <AskOptions model={model} ask={ask} />
    </div>
  );
}

/**
 * Where a what-if value goes, for a chip that stands for several calls:
 * `inner join ×2` offers both merges, the merge with homes or the merge with
 * weather. The values offered and a value typed go there.
 */
function DecisionWhere(props: {
  model: EpiModel;
  ask: IDecisionAsk;
}): JSX.Element | null {
  const { model, ask } = props;
  const decision = ask.decision;
  const calls = callsOf(decision);
  if (calls.length < 2) {
    return null;
  }
  const all = allCalls(decision);
  const options: ISegment<string>[] = [
    {
      value: 'all',
      label: all.charAt(0).toUpperCase() + all.slice(1),
      title: `The value goes into ${all}`
    },
    ...calls.map((call, index) => ({
      value: String(index),
      label: callChoice(decision, call),
      title: `The value goes into ${callName(decision, call, true)} alone`
    }))
  ];
  return (
    <div className="jp-Epi-where">
      <span className="jp-Epi-caption">Where the value goes</span>
      <Segmented
        value={ask.where === null ? 'all' : String(ask.where)}
        options={options}
        onChange={value =>
          void model.setDecisionWhere(value === 'all' ? null : Number(value))
        }
        label="Where the value goes"
      />
    </div>
  );
}

/**
 * Another value for a decision, typed as in Python: it runs in a branch of
 * the cell, as the values offered below do.
 */
function DecisionValue(props: {
  model: EpiModel;
  ask: IDecisionAsk;
}): JSX.Element {
  const { model, ask } = props;
  const [value, setValue] = React.useState('');
  return (
    <form
      className="jp-Epi-own jp-Epi-ownbox jp-Epi-valuebox"
      onSubmit={event => {
        event.preventDefault();
        if (value.trim()) {
          void model.tryDecisionValue(value.trim());
        }
      }}
    >
      <div className="jp-Epi-own-row">
        <InputGroup
          className="jp-Epi-own-input"
          type="text"
          value={value}
          aria-label={`Another value for ${ask.decision.name}`}
          placeholder={`Another value for ${ask.decision.name}, as in Python`}
          onChange={event => setValue(event.target.value)}
        />
        <Button
          type="submit"
          small
          className="jp-Epi-button jp-mod-styled jp-mod-accept"
          disabled={!value.trim()}
        >
          Try
        </Button>
      </div>
      {ask.valueError && <div className="jp-Epi-error">{ask.valueError}</div>}
    </form>
  );
}

/**
 * The first line of the popover of a chip: the name and the value as code,
 * where the value comes from, and, for a default that a model flagged, who
 * flagged it. `header = 'infer' · default in pandas 3.0.6 · flagged as
 * important by AI` (design iteration 1.86). A default of the view's own
 * list has no last part; any other decision says what the server's note
 * says, such as "defaulted in prep.py:31".
 */
export function DecisionHeading(props: { ask: IDecisionAsk }): JSX.Element {
  const { ask } = props;
  const { decision } = ask;
  const where = sourceNote(decision, ask.note);
  return (
    <span className="jp-Epi-decision-line">
      <code>{`${decision.name} = ${decision.value}`}</code>
      {where && <span className="jp-Epi-caption"> · {where}</span>}
      {decision.found && (
        <span className="jp-Epi-caption">
          {' · flagged as important by '}
          <AITag by={decision.found.by} verb="Flagged as important" />
        </span>
      )}
    </span>
  );
}

/**
 * The reason under the first line of a chip's popover: the model's for a
 * default that it flagged, the view's own list's for a default that the list
 * holds.
 */
export function DecisionReason(props: {
  ask: IDecisionAsk;
}): JSX.Element | null {
  const note = props.ask.decision.note?.trim();
  if (!note) {
    return null;
  }
  return (
    <div className="jp-Epi-caption jp-Epi-decision-reason">
      {`${note.charAt(0).toUpperCase()}${note.slice(1)}${/[.!?]$/.test(note) ? '' : '.'}`}
    </div>
  );
}

/**
 * Where the values offered for a constant come from, in one short line: the
 * kind of constant that the rules read, "A count of days: common lengths of
 * time.", "Analysing…" with a bar while a model suggests values, or, with no
 * model, how the values were chosen. After a model answered the values say
 * it with their AI tag, and the line is not drawn (../model/rulesfirst.ts).
 */
function DecisionKind(props: { ask: IDecisionAsk }): JSX.Element | null {
  const { ask } = props;
  const values = ask.values;
  const text =
    values && !ask.loading && !ask.error ? valuesCaption(values) : '';
  if (!values || !text) {
    return null;
  }
  return (
    <div
      className={`jp-Epi-caption jp-Epi-valuekind jp-mod-${values.by}`}
      role={values.by === 'asking' ? 'status' : undefined}
      title={valuesWhy(values)}
    >
      {text}
      {values.by === 'asking' && (
        <span className="jp-Epi-modelwait">
          <ProgressBar
            value={null}
            label={`An AI model suggests values of ${ask.decision.name}`}
            wide
          />
        </span>
      )}
    </div>
  );
}

/**
 * The offered questions a request shows, best first, as many as the
 * settings allow; with 0, the analyst types every question. While no AI
 * model answers, the questions that run come first.
 */
function offered(model: EpiModel, options: IOption[]): IOption[] {
  return runnableFirst(options, !!model.aiOff()).slice(
    0,
    Math.max(0, model.settings.offeredQuestions)
  );
}

/** Says why no question is offered, when the settings turn them off. */
function OfferedOff(props: { model: EpiModel }): JSX.Element | null {
  return props.model.settings.offeredQuestions > 0 ? null : (
    <div className="jp-Epi-caption jp-Epi-offered-off">
      Offered questions are off in the settings: type your question above.
    </div>
  );
}

/** The questions offered for a request, by the kind of request. */
function AskOptions(props: { model: EpiModel; ask: Ask }): JSX.Element {
  const { model, ask } = props;
  if (ask.loading) {
    return (
      <div className="jp-Epi-ask">
        <ProgressBar value={null} label="Ranking questions" wide />
      </div>
    );
  }
  if (ask.error) {
    return <div className="jp-Epi-error">{ask.error}</div>;
  }
  if (ask.kind === 'drop') {
    return <DropAskContent model={model} ask={ask} />;
  }
  if (ask.kind === 'cells' || ask.kind === 'decision') {
    // What-if values of a decision are not questions: the setting leaves
    // them. While a model suggests values, the half below and above wait.
    const options =
      ask.kind === 'decision'
        ? ask.values?.by === 'asking'
          ? ask.options.filter(option => !triesValues(option))
          : ask.options
        : offered(model, ask.options);
    return (
      <div className="jp-Epi-ask" {...pointerOn(model, ask)}>
        {ask.kind === 'cells' && <OfferedOff model={model} />}
        {ask.kind === 'cells' && <OrderNote list={ask} />}
        <OptionRows model={model} options={options}>
          {option => (
            <OptionRow
              option={option}
              placement={model.placementFor(option)}
              onApply={() => void model.apply(option)}
              aiOff={aiOffReason(model)}
            />
          )}
        </OptionRows>
      </div>
    );
  }
  if (ask.kind === 'note') {
    return <NoteAskContent model={model} ask={ask} />;
  }
  if (ask.kind === 'table') {
    return <TableAskContent model={model} ask={ask} />;
  }
  if (ask.kind === 'image') {
    // A point or an area of a picture: the AI reads the picture, unless the
    // data stays on this machine, where only questions with code are offered.
    const local = model.keepDataLocal;
    const options = local
      ? ask.options.filter(option => option.code)
      : ask.options;
    return (
      <div className="jp-Epi-ask">
        <OfferedOff model={model} />
        {local && options.length < ask.options.length && (
          <div className="jp-Epi-caption">
            The data stays on this machine, so no question here sends the
            picture to the remote model.
          </div>
        )}
        <OptionRows model={model} options={offered(model, options)}>
          {option => (
            <OptionRow
              option={option}
              placement={model.placementFor(option)}
              onApply={() => void model.apply(option)}
              aiOff={aiOffReason(model)}
            />
          )}
        </OptionRows>
      </div>
    );
  }
  const summary = ask.summary;
  return (
    <div className="jp-Epi-ask">
      {summary && (
        <>
          <div className="jp-Epi-caption">
            {summary.rows.toLocaleString()} rows
            {summary.units !== undefined
              ? ` · ${summary.units.toLocaleString()} ${(summary.unit ?? 'unit').replace(/_id$/, '')}s`
              : ''}
          </div>
          <div className="jp-Epi-seen">{summary.seen}</div>
        </>
      )}
      <OfferedOff model={model} />
      <OptionRows model={model} options={offered(model, ask.options)}>
        {option => (
          <OptionRow
            option={option}
            placement={model.placementFor(option)}
            onApply={() => void model.apply(option)}
            aiOff={aiOffReason(model)}
          />
        )}
      </OptionRows>
      <button className="jp-Epi-keep" onClick={() => model.keepSelection(ask)}>
        Keep selection as a variable
      </button>
    </div>
  );
}

/**
 * The numbers a text states, each with the output that shows it, then the
 * questions about the text.
 */
function NoteAskContent(props: {
  model: EpiModel;
  ask: INoteAsk;
}): JSX.Element {
  const { model, ask } = props;
  const { checked, skipped } = ask.numbers;
  const label = (cellId: string) => model.cell(cellId)?.label ?? '?';
  const words = ask.claim ? 'these words' : 'this text';
  return (
    <div className="jp-Epi-ask" {...pointerOn(model, ask)}>
      {checked.length > 0 && (
        <div className="jp-Epi-claimnumbers">
          <div className="jp-Epi-caption">
            The numbers in {words}, and the outputs that show them:
          </div>
          <ul className="jp-Epi-claimnumbers-list">
            {checked.map(number => {
              const shown = number.found.slice(0, 3);
              return (
                <li
                  key={number.text}
                  className={shown.length ? '' : 'jp-mod-missing'}
                >
                  <span className="jp-Epi-claimnumbers-value">
                    {number.text}
                  </span>
                  {shown.length ? (
                    <span className="jp-Epi-claimnumbers-found">
                      {shown.map(found => (
                        <button
                          key={`${found.cellId}:${found.output}`}
                          className="jp-Epi-link"
                          onClick={() =>
                            model.showOutput(found.cellId, found.output)
                          }
                          title="Show this output"
                        >
                          {label(found.cellId)} shows {found.shown}
                        </button>
                      ))}
                      {number.found.length > shown.length &&
                        `and ${number.found.length - shown.length} more`}
                    </span>
                  ) : (
                    <span>
                      {number.inCode.length
                        ? `no output; in the code of ${number.inCode.map(label).join(', ')}`
                        : 'no output shows it'}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {skipped.length > 0 && (
        <div className="jp-Epi-caption">
          Not checked: {skipped.join(', ')}. Whole numbers under 100 show in too
          many outputs for a match to mean much.
        </div>
      )}
      <OfferedOff model={model} />
      <OrderNote list={ask} />
      <OptionRows model={model} options={offered(model, ask.options)}>
        {option => (
          <OptionRow
            option={option}
            placement={model.placementFor(option)}
            onApply={() => void model.apply(option)}
            aiOff={aiOffReason(model)}
          />
        )}
      </OptionRows>
    </div>
  );
}

function DropAskContent(props: {
  model: EpiModel;
  ask: IDropAsk;
}): JSX.Element {
  const { model, ask } = props;
  const result = ask.result!;
  const parallel = result.mode === 'parallel';
  return (
    <div className="jp-Epi-ask" {...pointerOn(model, ask)}>
      {ask.columns && <ColumnFilter model={model} ask={ask} />}
      {result.note && <div className="jp-Epi-joinnote">{result.note}</div>}
      {!parallel && <OfferedOff model={model} />}
      <OrderNote list={ask} />
      <ModelLine ask={ask} />
      {parallel && (
        <div className="jp-Epi-caption">
          Run several at once. Each becomes a branch that runs in parallel, on
          the kernel's data without copying it.
        </div>
      )}
      <InferredChips model={model} options={offered(model, result.options)} />
      <OptionRows model={model} options={offered(model, result.options)}>
        {option => (
          <OptionRow
            option={option}
            placement={model.placementFor(option)}
            onApply={() => void model.apply(option)}
            checked={parallel ? ask.checked.includes(option.id) : undefined}
            onToggle={
              parallel ? () => model.toggleChecked(option.id) : undefined
            }
            aiOff={aiOffReason(model)}
            note={
              parallel && ask.checked.includes(option.id)
                ? subshellNote(model, ask, option.id)
                : undefined
            }
          />
        )}
      </OptionRows>
      {parallel && (
        <div className="jp-Epi-parallel-foot">
          <CapacityMeter model={model} planned={ask.checked.length} />
          <Button
            small
            className="jp-Epi-button jp-mod-styled jp-mod-accept"
            disabled={!ask.checked.length}
            onClick={() => void model.startParallel()}
          >
            Start {ask.checked.length} branch
            {ask.checked.length === 1 ? '' : 'es'}
          </Button>
        </div>
      )}
      {!parallel &&
        (ask.target.item || ask.target.cellId) &&
        ask.fromModel !== 'asking' &&
        model.aiReady('questions') &&
        model.settings.offeredQuestions > 0 && (
          <button
            className="jp-Epi-more"
            disabled={ask.claudeStage !== null}
            onClick={() => void model.moreFromClaude()}
          >
            {ask.claudeStage
              ? `AI is ${ask.claudeStage}…`
              : 'More questions from AI'}
          </button>
        )}
    </div>
  );
}

/**
 * The questions that the model chosen for More questions writes for a drop
 * or a click, next to the templates' (../model/rulesfirst.ts): a bar while
 * it works, then its questions in the list with the AI tag, none of which
 * runs until the analyst picks it. Where no template fits, the line says so,
 * and why no model answers. Where templates fit, the line shows only while
 * the model works, or when it failed.
 */
function ModelLine(props: { ask: IDropAsk }): JSX.Element | null {
  const { ask } = props;
  if (!ask.fromModel || !ask.result) {
    return null;
  }
  const fromTemplates = ask.result.options.filter(
    option => option.origin === 'template'
  );
  const none = !!ask.noTemplate;
  const first = fromTemplates.length
    ? 'Every template question here needs AI'
    : 'No template has a question for this';
  const classes = `jp-Epi-caption jp-Epi-modelline${none ? ' jp-Epi-notemplate' : ''}`;
  switch (ask.fromModel) {
    case 'asking':
      return (
        <div className={`${classes} jp-mod-asking`} role="status">
          {none
            ? `${first}: an AI model writes more.`
            : 'An AI model adds questions that the templates miss.'}
          <span className="jp-Epi-modelwait">
            <span>{stageText(ask.claudeStage, null)}…</span>
            <ProgressBar
              value={null}
              label="An AI model writes questions"
              wide
            />
          </span>
        </div>
      );
    case 'done':
      return none ? (
        <div className={`${classes} jp-mod-done`}>
          {first}, so an AI model suggested the questions marked AI. None runs
          until you pick it.
        </div>
      ) : null;
    case 'off':
      return (
        <div className={`${classes} jp-mod-off`}>
          {first}. {ask.fromModelNote}
        </div>
      );
    case 'failed':
      return (
        <div className={`${classes} jp-mod-off`}>
          {none
            ? `${first}. The AI model could not suggest questions: ${ask.fromModelNote}`
            : `An AI model could not add questions: ${ask.fromModelNote}`}
        </div>
      );
  }
}

/**
 * What to run when the kernel lacks the data a request needs.
 */
function MissingContent(props: {
  model: EpiModel;
  missing: IMissing;
}): JSX.Element {
  const { model, missing } = props;
  const labels = (missing.plan ?? []).map(id => model.cell(id)?.label ?? '?');
  const names = missing.names.join(', ');
  const forCell = missing.from === 'cell';
  const planText =
    (labels.length === 1
      ? `Run ${labels[0]}`
      : `Run ${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`) +
    (forCell ? ' first' : '');
  // The cell the questions change uses names that the kernel lacks.
  const uses = forCell
    ? `${missing.cell ?? 'The cell'} uses ${names || 'names'}, which ${missing.names.length === 1 ? 'is' : 'are'} not in the kernel${missing.noKernel ? ': no kernel is running' : ''}.`
    : null;
  return (
    <div className="jp-Epi-ask jp-Epi-missing">
      <div className="jp-Epi-joinnote">
        {uses ??
          (missing.noKernel
            ? 'No kernel is running'
            : `${names} is not in the kernel`)}
        {forCell
          ? null
          : missing.from === 'variable'
            ? ': Whybook shows what the notebook kept from the last run.'
            : ': this output is from an earlier run, and its rows are not there to read.'}
      </div>
      {missing.running && (
        <ProgressBar value={null} label="Running the cells" wide />
      )}
      {!missing.running && missing.plan === null && (
        <ProgressBar value={null} label="Reading the cells" wide />
      )}
      {!missing.running && missing.plan !== null && (
        <>
          <div className="jp-Epi-caption">
            {missing.nothingRan
              ? 'Nothing has run in this kernel yet.'
              : `The cells that make ${names}, read from their code:`}
            {labels.length > 0 &&
              !missing.nothingRan &&
              ` ${labels.join(', ')}.`}
          </div>
          <div className="jp-Epi-missing-actions">
            {labels.length > 0 && (
              <Button
                small
                className={`jp-Epi-button${missing.nothingRan ? ' jp-mod-minimal' : ' jp-mod-styled jp-mod-accept'}`}
                minimal={missing.nothingRan}
                onClick={() => void model.runMissing(false)}
              >
                {planText}
              </Button>
            )}
            <Button
              small
              className={`jp-Epi-button${missing.nothingRan || labels.length === 0 ? ' jp-mod-styled jp-mod-accept' : ''}`}
              minimal={!(missing.nothingRan || labels.length === 0)}
              onClick={() => void model.runMissing(true)}
            >
              Run all
            </Button>
          </div>
          {missing.unresolved.length > 0 && (
            <div className="jp-Epi-caption">
              No cell defines {missing.unresolved.join(', ')}: a magic, a %run
              or a star import may.{' '}
              {model.aiReady('cells') && !missing.claude && (
                <button
                  className="jp-Epi-link"
                  onClick={() => void model.askClaudeForMissing()}
                >
                  Ask AI where they come from
                </button>
              )}
            </div>
          )}
          {missing.claude?.stage && (
            <ProgressBar
              value={null}
              label={`AI is ${missing.claude.stage}`}
              wide
            />
          )}
          {missing.claude?.reason && (
            <div className="jp-Epi-seen">{missing.claude.reason}</div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The columns of a frame clicked in the map: filter, then pick one to ask
 * about it instead.
 */
function ColumnFilter(props: { model: EpiModel; ask: IDropAsk }): JSX.Element {
  const { model, ask } = props;
  const [query, setQuery] = React.useState('');
  const frame = model.variable(ask.source.name);
  const columns = frame?.columns ?? [];
  const shown = columns
    .filter(c => c.label.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 6);
  return (
    <div className="jp-Epi-columnfilter">
      <InputGroup
        className="jp-Epi-search"
        type="text"
        rightIcon="ui-components:search"
        aria-label={`Filter the columns of ${ask.source.name}`}
        placeholder={`Filter ${columns.length.toLocaleString()} columns`}
        value={query}
        onChange={event => setQuery(event.target.value)}
      />
      {query && (
        <div className="jp-Epi-columnfilter-list">
          {shown.map(column => {
            const item: IItem = {
              kind: 'column',
              name: `${ask.source.name}[${pythonString(column.label)}]`,
              label: column.label,
              parent: ask.source.name
            };
            return (
              <button
                key={column.label}
                className="jp-Epi-tree-row"
                onClick={() =>
                  void model.askDrop(
                    item,
                    { item },
                    { branch: false, parallel: false },
                    ask.anchor,
                    { popover: true }
                  )
                }
              >
                <span className="jp-Epi-column-tag">{column.tag}</span>
                <span className="jp-Epi-tree-name">{column.label}</span>
              </button>
            );
          })}
          {shown.length === 0 && (
            <div className="jp-Epi-empty">No column matches.</div>
          )}
        </div>
      )}
    </div>
  );
}

function subshellNote(
  model: EpiModel,
  ask: IDropAsk,
  optionId: string
): string {
  const position = ask.checked.indexOf(optionId);
  if (model.jobs.parallel === false) {
    return `turn ${position + 1} of ${ask.checked.length}`;
  }
  const free = Math.max(0, model.jobs.capacity - model.jobs.busy);
  // Numbered from 1, as the branch cells show them.
  return position < free
    ? `parallel run ${model.jobs.busy + position + 1}`
    : 'queued';
}

export function askTitle(model: EpiModel): string {
  const ask = model.ask;
  if (!ask) {
    return '';
  }
  if (ask.kind === 'drop') {
    if (ask.result) {
      return ask.result.title;
    }
    if (!ask.target.cellId && !ask.target.item) {
      return `${itemName(ask.source)} into the notebook`;
    }
    const target = ask.target.cellId
      ? (model.cell(ask.target.cellId)?.label ?? 'a cell')
      : itemName(ask.target.item!);
    return `${itemName(ask.source)} onto ${target}`;
  }
  if (ask.kind === 'decision') {
    return `${ask.decision.name} = ${ask.decision.value}`;
  }
  if (ask.kind === 'cells') {
    return ask.cells
      .map(id => {
        const cell = model.cell(id);
        return !cell
          ? '?'
          : cell.type === 'markdown'
            ? model.noteLabel(cell)
            : cell.label;
      })
      .join(' + ');
  }
  if (ask.kind === 'note') {
    const cell = model.cell(ask.cellId);
    return ask.claim
      ? `“${excerpt(ask.claim, 48)}”`
      : cell
        ? `Text of ${model.noteLabel(cell)}`
        : 'Text';
  }
  if (ask.kind === 'table' || ask.kind === 'image') {
    return ask.title;
  }
  if (ask.values) {
    return barsText(ask.plot.x.label, ask.values);
  }
  // Dates read in the unit of the plot's own dates, not of the pointer.
  const y = ask.y
    ? `, ${ask.plot.y?.label ?? ask.plot.source.y} ${rangeText(ask.y[0], ask.y[1], ask.plot.y, axisValues(ask.plot, 'y'))}`
    : '';
  return `${ask.plot.x.label} ${rangeText(ask.x0, ask.x1, ask.plot.x, axisValues(ask.plot, 'x'))}${y}`;
}

export function askMode(ask: IDropAsk): { label: string; strong: boolean } {
  if (ask.modifiers.parallel) {
    return { label: 'Alt · parallel exploration', strong: true };
  }
  if (ask.modifiers.branch) {
    return { label: 'Shift · always branch', strong: true };
  }
  return { label: 'Rules pick edit, new cell or branch', strong: false };
}

/**
 * Whether the questions of a request show in a popover: a request asked
 * with the pointer shows them beside where it was asked, in Drag and in
 * Click alike (design iteration 1.77). A request with no place, as one
 * asked from the keyboard, shows them in the Questions section alone.
 */
export function inPopover(model: EpiModel, ask: Ask): boolean {
  return !!ask.anchor;
}

export function QuestionsSection(props: { model: EpiModel }): JSX.Element {
  const { model } = props;
  useModel(model);
  const click = model.interaction === 'click';
  const armed = model.armed;
  // The section shows the questions that no popover shows, once: those of
  // a popover stay in the popover (design iteration 1.77).
  const shown = !!model.ask && !inPopover(model, model.ask);
  // The section has the keyboard focus of the questions it shows.
  const block = React.useRef<HTMLDivElement>(null);
  useQuestionFocus(block, model, shown);
  return (
    <div className="jp-Epi-section jp-Epi-questions">
      <div className="jp-Epi-section-head">
        <span className="jp-Epi-head-label">Questions</span>
        <span className="jp-Epi-ask-by">Ask by</span>
        <Segmented
          className="jp-Epi-toggle"
          label="How to ask"
          value={model.interaction}
          onChange={value => model.settings.set('interaction', value)}
          options={[
            {
              value: 'drag',
              label: 'Drag',
              title: 'Drag variables and columns onto cells'
            },
            {
              value: 'click',
              label: 'Click',
              title: 'Click a variable or a column, then a target'
            }
          ]}
        />
      </div>
      {!shown && !armed && (
        <div className="jp-Epi-instructions">
          {click ? (
            <>
              <p>
                <b>Click</b> a column to pick it, or a variable to see what is
                inside, and <b>Pick</b> in Contents to pick all of it. Then
                click a <b>cell</b>, a variable or a column as the target. Click
                the same item again to ask about it alone.
              </p>
              <p>
                Everything works from the keyboard: Tab to an item and press
                Enter to pick it, then Enter on another item, or Go to the
                cells, where the arrow keys move between cells. The questions
                open with the focus on the first one: the arrow keys move, Enter
                asks, Escape closes.
              </p>
              <p>
                A plot, a picture and a table are one Tab stop each: the arrow
                keys move between bars, points, headers or places, and Enter
                asks about the one marked. In the menu of Ask, the arrow keys
                move and Enter picks.
              </p>
            </>
          ) : (
            <>
              <p>
                <b>Drag</b> a variable or a column onto a cell, another variable
                or a column. Drop it on itself to profile or reshape it.
              </p>
              <p>
                <kbd>Shift</kbd>+drop always branches. <kbd>Alt</kbd>+drop
                explores in parallel. Clicking a column picks it without
                dragging.
              </p>
            </>
          )}
        </div>
      )}
      {click && (
        <div className="jp-Epi-switches">
          <label>
            <input
              type="checkbox"
              className="jp-mod-styled"
              checked={model.pickModifiers.branch}
              onChange={event =>
                model.setPickModifier('branch', event.target.checked)
              }
            />{' '}
            Always branch
          </label>
          <label>
            <input
              type="checkbox"
              className="jp-mod-styled"
              checked={model.pickModifiers.parallel}
              onChange={event =>
                model.setPickModifier('parallel', event.target.checked)
              }
            />{' '}
            Explore in parallel
          </label>
        </div>
      )}
      {armed && (
        <div className="jp-Epi-picked">
          <b>{itemName(armed)}</b> → pick a target: a cell, a variable or a
          column, or {itemName(armed)} again.
          {/* The map has no targets of a pick: its cells ask about themselves. */}
          {model.view !== 'map' && (
            <button
              className="jp-Epi-link"
              title="Put the keyboard focus on the first cell to pick; the arrow keys move between cells"
              onClick={() => model.requestTargets()}
            >
              Go to the cells
            </button>
          )}
          <button className="jp-Epi-link" onClick={() => model.arm(null)}>
            cancel
          </button>
        </div>
      )}
      {shown && model.ask && (
        <div className="jp-Epi-ask-block" ref={block} onKeyDown={questionKeys}>
          <div className="jp-Epi-ask-head">
            {model.ask.kind === 'decision' ? (
              <DecisionHeading ask={model.ask} />
            ) : (
              <code>{askTitle(model)}</code>
            )}
            {model.ask.kind === 'drop' && (
              <span
                className={`jp-Epi-pill${askMode(model.ask).strong ? ' jp-mod-strong' : ''}`}
              >
                {askMode(model.ask).label}
              </span>
            )}
            <CloseButton
              label="Close the questions"
              onClick={() => model.dismissAsk()}
            />
          </div>
          {model.ask.kind === 'decision' && <DecisionReason ask={model.ask} />}
          <AskContent model={model} />
          <div className="jp-Epi-caption">Runs on pick, no confirmation.</div>
        </div>
      )}
    </div>
  );
}
