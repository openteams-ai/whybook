import type { ICodeCellModel } from '@jupyterlab/cells';
import type { CodeEditor, IEditorServices } from '@jupyterlab/codeeditor';
import { caretDownIcon, caretRightIcon } from '@jupyterlab/ui-components';
import * as React from 'react';

import { cellType } from '../model/agent';
import { dataLinks } from '../model/datalinks';
import type { EpiModel, IEpiCell } from '../model/epimodel';
import { askImage, imagePickOf } from '../model/imageask';
import { codeMimeType } from '../model/languages';
import { outputsOf } from '../model/notebook';
import { askedLine, guessWho } from '../model/person';
import { cellWrittenBy, codeWriter, describeBy } from '../model/writtenby';
import type { IPerson } from '../tokens';
import {
  AITag,
  CellLabel,
  DecisionChips,
  GuessChip,
  LabelledText,
  TypeBadge,
  anchorAbove,
  anchorBelow,
  useModel,
  useWidth
} from './common';
import { CellCost } from './cost';
import { FullOutput } from './outputs';
import { TableQuestions } from './tablequestions';

/**
 * Cell details, the second tab of the right panel: all that the view knows
 * of one cell, in one place. It follows the cell the analyst worked on last
 * on the bench or in the Code view, and the cell picked on the map. Its outputs
 * open in full on the map, where the cells show tiles; on the bench, where
 * the outputs show in place, they start closed, unless a miniature opened
 * one of them.
 */
export function CellDetails(props: {
  model: EpiModel;
  width: number;
  /** For the cell's code, in an editor that cannot change it. */
  editorServices: IEditorServices | null;
}): JSX.Element {
  const { model } = props;
  useModel(model);
  const host = React.useRef<HTMLDivElement>(null);
  const width = useWidth(host, props.width);
  const cell = model.currentCell ? model.cell(model.currentCell) : null;
  return (
    <div className="jp-Epi-details" ref={host}>
      {cell ? (
        <DetailsOf
          key={cell.id}
          model={model}
          cell={cell}
          width={width}
          editorServices={props.editorServices}
        />
      ) : (
        <>
          <div className="jp-Epi-panel-head">Cell details</div>
          <div className="jp-Epi-caption">
            Click a cell, on the bench, in the Code view or on the map, to see
            all of it here: its outputs, the question it answers, who wrote it,
            and the cells that make the names it uses or use the names it makes.
          </div>
        </>
      )}
    </div>
  );
}

/** The link of Cell details to the cell in the view in front, by view. */
const SHOW_HERE: Record<EpiModel['view'], string> = {
  bench: 'Show on the bench',
  map: 'Show on the map',
  linear: 'Show in the Code view'
};

function DetailsOf(props: {
  model: EpiModel;
  cell: IEpiCell;
  width: number;
  editorServices: IEditorServices | null;
}): JSX.Element {
  const { model, cell, width } = props;
  const meta = cell.meta;
  const analysis = cell.analysis;
  const onMap = model.view === 'map';
  const opened =
    model.selectedOutput?.cellId === cell.id
      ? model.selectedOutput.index
      : null;
  const job = model.jobs.jobFor(cell.id);
  const written = cellWrittenBy(meta.generated_by);
  const source = cell.model.sharedModel.getSource();
  // A markdown cell: its place, the code around it and its questions, in
  // place of what only code has.
  const text = cell.type === 'markdown';
  // The map shows code and texts, and not the heading of a section.
  const onMapToo = !text || model.isNote(cell);
  const toBench = model.view !== 'bench';
  const toMap = model.view !== 'map' && onMapToo;
  // A cell of an agent's run shows the type of its own step.
  const badge = cellType(meta);
  return (
    <>
      <div className="jp-Epi-panel-head jp-Epi-details-head">
        {text ? (
          <span className="jp-Epi-label">Text</span>
        ) : (
          <CellLabel cell={cell} />
        )}
        <span className="jp-Epi-details-title">{cell.title}</span>
        {badge && <TypeBadge type={badge} />}
      </div>
      {/* The view in front, named, on a line of its own; the others under it. */}
      <div className="jp-Epi-details-links">
        {(model.view !== 'map' || onMapToo) && (
          <button
            className="jp-Epi-link"
            onClick={() => model.showCell(cell.id)}
            title="Bring the cell into sight and outline it for a moment"
          >
            {SHOW_HERE[model.view]}
          </button>
        )}
        {(toBench || toMap) && (
          <span className="jp-Epi-details-elsewhere">
            {toBench && (
              <button
                className="jp-Epi-link"
                onClick={() => model.showIn('bench', cell.id)}
              >
                Show on the bench
              </button>
            )}
            {toMap && (
              <button
                className="jp-Epi-link"
                onClick={() => model.showIn('map', cell.id)}
              >
                Show on the map
              </button>
            )}
          </span>
        )}
      </div>

      {text && <TextDetails model={model} cell={cell} />}

      {cell.type === 'code' && (
        <DetailsSection
          title="Outputs"
          count={outputsOf(cell.model).length}
          open={onMap || opened !== null}
        >
          <DetailsOutputs
            model={model}
            cell={cell}
            width={width}
            opened={opened}
          />
        </DetailsSection>
      )}

      {(meta.question || meta.guess) && (
        <DetailsSection title="Question" open>
          {meta.question && (
            <p className="jp-Epi-details-question">
              <LabelledText
                model={model}
                text={model.questionText(meta.question)}
                refs={meta.question.refs}
              />{' '}
              {meta.question.by && (
                <AITag by={meta.question.by} verb="Proposed" />
              )}
            </p>
          )}
          <AskedCaption meta={meta} user={model.person} />
        </DetailsSection>
      )}

      {(meta.written_by || written) && (
        <DetailsSection title="Written by" open>
          <p className="jp-Epi-caption">
            {text ? textWriter(meta) : codeWriter(meta)}
            {/* With the setting on, the cost has a section of its own. */}
            {!model.settings.showCost &&
              typeof meta.generated_by?.cost_usd === 'number' &&
              meta.generated_by.cost_usd > 0 &&
              `, for ${meta.generated_by.cost_usd.toFixed(3)} US dollars`}
          </p>
          {meta.summary && <p className="jp-Epi-caption">{meta.summary}</p>}
          <RunLink model={model} cellId={cell.id} />
        </DetailsSection>
      )}

      {model.settings.showCost && (
        <DetailsSection title="Cost" open>
          <CellCost {...model.costOf(cell)} />
        </DetailsSection>
      )}

      {analysis && (
        <DetailsSection title="Data" open>
          <DataLinks model={model} cell={cell} />
          {Object.entries(analysis.columns).map(([frame, columns]) => (
            <Names key={frame} label={`Columns of ${frame}`} names={columns} />
          ))}
          {analysis.formulas.length > 0 && (
            <Names label="Formulas" names={analysis.formulas} />
          )}
          {analysis.attachments.length > 0 && (
            <Names
              label="Code from files"
              names={analysis.attachments.map(
                attachment => `${attachment.file}: ${attachment.symbol}`
              )}
            />
          )}
        </DetailsSection>
      )}

      {cell.decisions.length > 0 && (
        <DetailsSection title="Decisions" count={cell.decisions.length} open>
          <DecisionChips
            decisions={cell.decisions}
            waiting={model.defaultsWaiting(cell)}
            onClick={(decision, event) =>
              void model.askDecision(
                cell.id,
                decision,
                anchorBelow(event.currentTarget)
              )
            }
          />
        </DetailsSection>
      )}

      {(meta.assumptions ?? []).length > 0 && (
        <DetailsSection
          title="Assumptions"
          count={meta.assumptions!.length}
          open
        >
          <ul className="jp-Epi-details-list">
            {meta.assumptions!.map((assumption, index) => (
              <li key={index}>{assumption.text}</li>
            ))}
          </ul>
        </DetailsSection>
      )}

      {cell.type === 'code' && (
        <DetailsSection title="Run" open>
          <p className="jp-Epi-caption">
            {job?.status === 'running'
              ? `Running${job.progress !== null && job.progress !== undefined ? `, ${Math.round(job.progress * 100)}%` : ''}${job.slot !== null && job.slot !== undefined ? ` in parallel run ${job.slot + 1}` : ''}.`
              : job?.status === 'queued'
                ? 'Waiting to run.'
                : cell.count
                  ? `Ran as number ${cell.count} of this kernel.`
                  : 'Not run in this kernel yet.'}
          </p>
          {cell.branchOf && (
            <CellLinks
              model={model}
              label="Branch of"
              cells={[model.cell(cell.branchOf)].filter(isCell)}
            />
          )}
          <CellLinks
            model={model}
            label="Branches"
            cells={cell.branches.map(id => model.cell(id)).filter(isCell)}
          />
        </DetailsSection>
      )}

      {source.trim() && (
        <DetailsSection title={text ? 'Source' : 'Code'} open={onMap}>
          <DetailsCode
            model={model}
            cell={cell}
            editorServices={props.editorServices}
          />
        </DetailsSection>
      )}
    </>
  );
}

function isCell(cell: IEpiCell | null | undefined): cell is IEpiCell {
  return !!cell;
}

/**
 * The way from a cell that an agent's run wrote to the run (design
 * iteration 1.73): its question, and a link that shows the run's strip,
 * drawn again from the notebook's record when it was closed.
 */
function RunLink(props: {
  model: EpiModel;
  cellId: string;
}): JSX.Element | null {
  const { model, cellId } = props;
  const id = model.runs.history ? model.runOf(cellId) : null;
  if (!id) {
    return null;
  }
  const question =
    model.runHistory().find(row => row.id === id)?.question ?? null;
  return (
    <p className="jp-Epi-caption jp-Epi-details-run">
      {question ? `In the agent's run for "${question}". ` : ''}
      <button className="jp-Epi-link" onClick={() => void model.openRun(id)}>
        Show the agent's run
      </button>
    </p>
  );
}

/**
 * Who asked the question of a cell, and whose guess of the result it keeps:
 * "You" and "Your" for the user of the page, `user` (../model/person.ts).
 */
function AskedCaption(props: {
  meta: IEpiCell['meta'];
  user: IPerson | null;
}): JSX.Element {
  const { meta, user } = props;
  const asked = askedLine(meta, user);
  return (
    <p className="jp-Epi-caption">
      {asked}
      {meta.guess && (
        <>
          {asked ? ' ' : ''}
          {guessWho(meta, user)} before the result:{' '}
          <GuessChip guess={meta.guess.value} />
        </>
      )}
    </p>
  );
}

/** Who wrote a markdown cell, in the words of "Written by". */
function textWriter(meta: IEpiCell['meta']): string {
  const written = cellWrittenBy(meta.generated_by);
  return written ? describeBy(written) : 'You wrote the text.';
}

/**
 * What the details show of a markdown cell: where it is among the sections,
 * the code cells just before and after it, and its questions, as the bench
 * offers them on the text.
 */
function TextDetails(props: { model: EpiModel; cell: IEpiCell }): JSX.Element {
  const { model, cell } = props;
  const { intro, sections } = model.sections();
  const section = sections.find(item => item.id === cell.sectionId);
  const place =
    intro?.id === cell.id
      ? "The introduction, under the notebook's title."
      : section && section.number > 0
        ? section.id === cell.id
          ? `The heading of §${section.number} ${section.title}, with ${section.cells.length} ${section.cells.length === 1 ? 'cell' : 'cells'}.`
          : `A text in §${section.number} ${section.title}.`
        : null;
  const code = model.codeCells();
  const before = code.filter(item => item.index < cell.index).slice(-1);
  const after = code.filter(item => item.index > cell.index).slice(0, 1);
  const body = model.isNote(cell);
  return (
    <DetailsSection title="Text" open>
      {place && <p className="jp-Epi-caption">{place}</p>}
      <CellLinks model={model} label="Code before" cells={before} />
      <CellLinks model={model} label="Code after" cells={after} />
      {body ? (
        <p className="jp-Epi-caption">
          <button
            className="jp-Epi-link"
            onClick={event =>
              void model.askNote(cell.id, anchorAbove(event.currentTarget))
            }
          >
            Questions about this text
          </button>
          . Select words in it, on the bench or in the Code view, to ask about
          those alone.
        </p>
      ) : (
        <p className="jp-Epi-caption">
          A heading alone: it has no text to ask about.
        </p>
      )}
    </DetailsSection>
  );
}

/** The label of a cell, which shows it in the view and in the details. */
function CellLink(props: { model: EpiModel; cell: IEpiCell }): JSX.Element {
  const { model, cell } = props;
  return (
    <button
      className="jp-Epi-link jp-Epi-cell-link"
      title={`Show ${cell.label} ${cell.title}, and its details`}
      onClick={() => model.showCell(cell.id)}
    >
      {cell.label}
    </button>
  );
}

/** The first cells of a list, and a button for the rest. */
function CellList(props: {
  model: EpiModel;
  cells: IEpiCell[];
  first?: number;
}): JSX.Element {
  const { model, cells, first = 3 } = props;
  const [all, setAll] = React.useState(false);
  const shown =
    all || cells.length <= first + 1 ? cells : cells.slice(0, first);
  return (
    <>
      {shown.map((cell, index) => (
        <React.Fragment key={cell.id}>
          {index > 0 && (index === cells.length - 1 ? ' and ' : ', ')}
          <CellLink model={model} cell={cell} />
        </React.Fragment>
      ))}
      {shown.length < cells.length && (
        <>
          {' and '}
          <button className="jp-Epi-link" onClick={() => setAll(true)}>
            {cells.length - shown.length} more
          </button>
        </>
      )}
    </>
  );
}

/** The names a cell uses and defines, each with the cells it links to. */
function DataLinks(props: {
  model: EpiModel;
  cell: IEpiCell;
}): JSX.Element | null {
  const { model, cell } = props;
  const { uses, defines } = dataLinks(model, cell);
  const names = (list: string[]) =>
    list.map((name, index) => (
      <React.Fragment key={name}>
        {index > 0 && (index === list.length - 1 ? ' and ' : ', ')}
        <code>{name}</code>
      </React.Fragment>
    ));
  const count = (cells: IEpiCell[]) =>
    cells.length === 1 ? '1 later cell' : `${cells.length} later cells`;
  return (
    <>
      {uses.length > 0 && (
        <div className="jp-Epi-details-names">
          <span className="jp-Epi-details-label">Uses</span>
          <span className="jp-Epi-details-namelinks">
            {uses.map(link => (
              <span key={link.names[0]}>
                {names(link.names)}
                {link.cells.length > 0 && (
                  <>
                    {link.imported ? ', imported in ' : ' from '}
                    <CellLink model={model} cell={link.cells[0]} />
                  </>
                )}
              </span>
            ))}
          </span>
        </div>
      )}
      {defines.length > 0 && (
        <div className="jp-Epi-details-names">
          <span className="jp-Epi-details-label">Defines</span>
          <span className="jp-Epi-details-namelinks">
            {defines.map(link => (
              <span key={link.names[0]}>
                {names(link.names)}
                {link.imported
                  ? `, imported here, ${link.cells.length ? `used in ${count(link.cells)}` : 'not used later'}`
                  : link.cells.length > 0
                    ? ', used in '
                    : ', not used later'}
                {!link.imported && link.cells.length > 0 && (
                  <CellList model={model} cells={link.cells} />
                )}
              </span>
            ))}
          </span>
        </div>
      )}
    </>
  );
}

/** A part of the details, with its title as the toggle. */
function DetailsSection(props: {
  title: string;
  count?: number;
  open: boolean;
  children: React.ReactNode;
}): JSX.Element {
  const [open, setOpen] = React.useState(props.open);
  // A change of view, or an output opened from its miniature, opens the
  // part again when its default says so.
  React.useEffect(() => setOpen(props.open), [props.open]);
  const Icon = open ? caretDownIcon : caretRightIcon;
  return (
    <section className="jp-Epi-details-section">
      <button
        className="jp-Epi-details-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon.react tag="span" />
        {props.title}
        {props.count !== undefined && (
          <span className="jp-Epi-details-count">{props.count}</span>
        )}
      </button>
      {open && <div className="jp-Epi-details-body">{props.children}</div>}
    </section>
  );
}

function Names(props: { label: string; names: string[] }): JSX.Element | null {
  if (!props.names.length) {
    return null;
  }
  return (
    <div className="jp-Epi-details-names">
      <span className="jp-Epi-details-label">{props.label}</span>
      <span>
        {props.names.map(name => (
          <code key={name}>{name}</code>
        ))}
      </span>
    </div>
  );
}

function CellLinks(props: {
  model: EpiModel;
  label: string;
  cells: IEpiCell[];
}): JSX.Element | null {
  const { model } = props;
  if (!props.cells.length) {
    return null;
  }
  return (
    <div className="jp-Epi-details-names">
      <span className="jp-Epi-details-label">{props.label}</span>
      <span className="jp-Epi-details-cells">
        {props.cells.map(cell => (
          <button
            key={cell.id}
            className="jp-Epi-link jp-Epi-cell-link"
            title={`Show ${cell.label} ${cell.title}, and its details`}
            onClick={() => model.showCell(cell.id)}
          >
            {cell.label} {cell.title}
          </button>
        ))}
      </span>
    </div>
  );
}

/**
 * Every output of the cell in full, as the notebook shows it: a table asks
 * from its headers and row labels, and a plot from a box or a click. An
 * output opened from its miniature comes into sight first.
 */
function DetailsOutputs(props: {
  model: EpiModel;
  cell: IEpiCell;
  width: number;
  opened: number | null;
}): JSX.Element {
  const { model, cell, width, opened } = props;
  const outputs = outputsOf(cell.model);
  const list = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (opened === null) {
      return;
    }
    const element = list.current?.querySelector(`[data-output="${opened}"]`);
    element?.scrollIntoView({ block: 'nearest' });
  }, [opened]);
  if (!outputs.length) {
    return <div className="jp-Epi-caption">No outputs.</div>;
  }
  const region =
    model.ask?.kind === 'region' && model.ask.cellId === cell.id
      ? { x0: model.ask.x0, x1: model.ask.x1, y: model.ask.y }
      : null;
  const leftOf = (anchor: { x: number; y: number }) => ({
    x: list.current?.getBoundingClientRect().left ?? anchor.x,
    y: anchor.y,
    side: 'left' as const
  });
  return (
    <div className="jp-Epi-details-outputs" ref={list}>
      {outputs.map((output, index) => (
        <div
          key={index}
          data-output={index}
          className={`jp-Epi-details-output${index === opened ? ' jp-mod-opened' : ''}`}
        >
          <TableQuestions
            model={model}
            cellId={cell.id}
            output={output}
            index={index}
            opensLeft
          >
            <FullOutput
              output={output}
              rendermime={model.rendermime}
              width={width - 16}
              selection={region}
              onSelect={(plot, x0, x1, anchor, y) =>
                // The questions open to the left of the panel, next to the plot.
                void model.askRegion(cell.id, plot, x0, x1, leftOf(anchor), y)
              }
              pick={imagePickOf(model, cell.id)}
              onAskImage={(pick, anchor) =>
                askImage(model, cell.id, pick, leftOf(anchor))
              }
            />
          </TableQuestions>
        </div>
      ))}
    </div>
  );
}

/**
 * The cell's code, highlighted as in the notebook, in a CodeMirror editor
 * that cannot change it. It follows the notebook's editor settings, line
 * numbers included, and shows each change made elsewhere at once.
 */
function DetailsCode(props: {
  model: EpiModel;
  cell: IEpiCell;
  editorServices: IEditorServices | null;
}): JSX.Element {
  const { model, cell, editorServices } = props;
  const host = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!host.current || !editorServices) {
      return;
    }
    const cellModel = cell.model as ICodeCellModel;
    if (!cellModel.mimeType || cellModel.mimeType === 'text/plain') {
      cellModel.mimeType =
        cell.type === 'markdown'
          ? 'text/x-ipythongfm'
          : codeMimeType(model.notebook, editorServices.mimeTypeService);
    }
    const config = () => ({
      ...model.settings.cellEditors[
        cell.type === 'markdown' ? 'markdown' : 'code'
      ],
      lineWrap: true,
      readOnly: true
    });
    let editor: CodeEditor.IEditor | null = null;
    try {
      editor = editorServices.factoryService.newInlineEditor({
        host: host.current,
        model: cellModel,
        config: config()
      });
    } catch (error) {
      console.warn('Could not show the code in an editor', error);
    }
    const follow = () => editor?.setOptions(config());
    model.settings.changed.connect(follow);
    return () => {
      model.settings.changed.disconnect(follow);
      editor?.dispose();
    };
  }, [cell.id, editorServices]);
  if (!editorServices) {
    return (
      <pre className="jp-Epi-details-code">
        {cell.model.sharedModel.getSource()}
      </pre>
    );
  }
  return <div className="jp-Epi-details-editor" ref={host} />;
}
