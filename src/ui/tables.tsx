import type { IOutputModel } from '@jupyterlab/rendermime';
import { tableRowsIcon } from '@jupyterlab/ui-components';
import * as React from 'react';

import type { EpiModel } from '../model/epimodel';
import type { ITableInfo } from '../model/tables';
import {
  MINIATURE_HEIGHT,
  htmlOf,
  tableInfo,
  tableKey,
  tableLevel,
  tableText
} from '../model/tables';
import type { Detail, ITableNote } from '../tokens';
import { AITag, CopyButton, ProgressBar, laidOut } from './common';
import { RenderedOutput } from './outputs';
import { useTableQuestions } from './tablequestions';

function dimensions(info: ITableInfo): { text: string; title: string } | null {
  if (info.rows === null || info.columns === null) {
    return info.tables > 1
      ? { text: `${info.tables} tables`, title: `${info.tables} tables` }
      : null;
  }
  return {
    text: `${info.rows.toLocaleString()} × ${info.columns.toLocaleString()}`,
    title: `${info.rows.toLocaleString()} rows, ${info.columns.toLocaleString()} columns`
  };
}

/**
 * The table's icon with its size, and the AI's labels when there are some:
 * what the table holds, and the result to see first.
 */
function TableTile(props: {
  dims: { text: string; title: string } | null;
  note: ITableNote | null;
  pending: boolean;
  active: boolean;
  onOpen: () => void;
}): JSX.Element {
  const { dims, note, pending, active, onOpen } = props;
  return (
    <button
      className={`jp-Epi-miniature jp-mod-table jp-Epi-tabletile${active ? ' jp-mod-active' : ''}`}
      onClick={onOpen}
      title="Show this table in full"
    >
      <span className="jp-Epi-tabletile-kind">
        <tableRowsIcon.react tag="span" className="jp-Epi-tabletile-icon" />
        Table
      </span>
      {dims && (
        <span className="jp-Epi-tabletile-dims" title={dims.title}>
          {dims.text}
        </span>
      )}
      {note?.description && (
        <span className="jp-Epi-tabletile-description jp-Epi-ai">
          {note.description}
          {!note.headline && <AITag by={note.by ?? null} />}
        </span>
      )}
      {note?.headline && (
        <span className="jp-Epi-tabletile-headline jp-Epi-ai">
          {note.headline}
          <AITag by={note.by ?? null} />
        </span>
      )}
      {pending && (
        <ProgressBar value={null} label="AI is describing the table" wide />
      )}
    </button>
  );
}

/**
 * A table output in a bench card, as large as the room allows: in full when
 * it is small and fits, as a miniature while its text stays readable, and
 * otherwise as a tile. The table renders once and stays in the page at every
 * level, hidden behind a tile, so a change of width changes only its scale.
 */
export function TableOutput(props: {
  model: EpiModel;
  cellId: string;
  output: IOutputModel;
  /** The width the card has for its outputs, in pixels. */
  available: number;
  active: boolean;
  onOpen: () => void;
  /** The level of detail, when it is not the bench's: the map's Overview. */
  detail?: Detail;
}): JSX.Element {
  const { model, cellId, output, available, active, onOpen } = props;
  const detail = props.detail ?? model.detail;
  const html = htmlOf(output);
  const info = React.useMemo(() => tableInfo(html), [html]);
  const key = React.useMemo(() => tableKey(output), [html]);
  const content = React.useRef<HTMLDivElement>(null);
  const [natural, setNatural] = React.useState<{
    width: number;
    height: number;
    fontPx: number;
  } | null>(null);
  React.useLayoutEffect(() => {
    const node = content.current;
    if (!node) {
      return;
    }
    // The renderer fills the node later, so its size is read on every change.
    const measure = () => {
      const table = node.querySelector('table');
      // A card far from the window is measured once it comes near.
      if (!table || !laidOut(node) || node.offsetWidth === 0) {
        return;
      }
      const width = node.offsetWidth;
      const height = node.offsetHeight;
      const fontPx = parseFloat(window.getComputedStyle(table).fontSize) || 13;
      setNatural(current =>
        current &&
        current.width === width &&
        current.height === height &&
        current.fontPx === fontPx
          ? current
          : { width, height, fontPx }
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const fit = natural ? tableLevel(info, natural, available, detail) : null;
  const level = fit?.level ?? 'measuring';
  // A table in full asks questions from its headers and row labels; a click
  // on a miniature opens it instead.
  useTableQuestions(content, {
    model,
    cellId,
    output,
    enabled: level === 'inline'
  });
  const note = level === 'tile' ? model.tableNotes.note(cellId, key) : null;
  // Asks when the tile has no labels, or only labels of another model.
  React.useEffect(() => {
    if (level === 'tile') {
      model.tableNotes.request(cellId, output);
    }
  }, [
    level,
    key,
    note?.by?.choice,
    note === null,
    model.status,
    model.settings.models.labels
  ]);

  const miniature = level === 'miniature' && natural !== null;
  const scale = fit?.scale ?? 1;
  const clipped = miniature && natural.height * scale > MINIATURE_HEIGHT + 1;
  const dims = dimensions(info);
  const open = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen();
    }
  };
  // A table in full or as a miniature has a copy button at its corner. The
  // box around the table stays at every level, so the table is not drawn again.
  const copyable = level === 'inline' || miniature;
  return (
    <div className={`jp-Epi-tableoutput jp-mod-${level}`}>
      <div
        className={`jp-Epi-tableoutput-box${copyable ? ' jp-Epi-copyable' : ''}`}
      >
        <div
          className={`jp-Epi-tableoutput-frame${miniature && active ? ' jp-mod-active' : ''}`}
          style={
            miniature
              ? {
                  width: Math.ceil(natural.width * scale),
                  height: Math.min(
                    Math.ceil(natural.height * scale),
                    MINIATURE_HEIGHT
                  )
                }
              : undefined
          }
          role={miniature ? 'button' : undefined}
          tabIndex={miniature ? 0 : undefined}
          title={miniature ? 'Show this table in full' : undefined}
          aria-label={
            miniature
              ? `Table${dims ? `, ${dims.title}` : ''}: show it in full`
              : undefined
          }
          onClick={miniature ? onOpen : undefined}
          onKeyDown={miniature ? open : undefined}
        >
          <div
            ref={content}
            className="jp-Epi-tableoutput-content"
            style={miniature ? { transform: `scale(${scale})` } : undefined}
          >
            <RenderedOutput output={output} rendermime={model.rendermime} />
          </div>
          {clipped && <div className="jp-Epi-tableoutput-fade" />}
        </div>
        {copyable && (
          <CopyButton
            className="jp-Epi-copy-corner"
            label="Copy this table"
            copy={() => ({ text: tableText(output), html: htmlOf(output) })}
          />
        )}
      </div>
      {miniature && dims && (
        <div className="jp-Epi-tableoutput-caption" title={dims.title}>
          {dims.text}
        </div>
      )}
      {level === 'tile' && (
        <TableTile
          dims={dims}
          note={note}
          pending={model.tableNotes.state(key) === 'pending'}
          active={active}
          onOpen={onOpen}
        />
      )}
    </div>
  );
}
