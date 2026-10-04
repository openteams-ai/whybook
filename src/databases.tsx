import type { ServerConnection } from '@jupyterlab/services';
import {
  Button,
  ReactWidget,
  caretDownIcon,
  caretRightIcon,
  lockIcon,
  refreshIcon,
  tableRowsIcon
} from '@jupyterlab/ui-components';
import * as React from 'react';

import { databaseIcon } from './icons';
import type { EpiModel } from './model/epimodel';
import { requestAPI } from './request';
import type { IItem } from './tokens';
import { setDragItem, useModel } from './ui/common';

interface IDatabase {
  path: string;
  name: string;
  size: number;
}

interface ITable {
  name: string;
  kind: 'table' | 'view';
  rows: number | null;
  columns: { name: string; type: string }[];
}

interface IListing {
  databases: IDatabase[];
  complete: boolean;
  depth: number;
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The SQLite files under the server's root, their tables and columns. A
 * table drags onto the Whybook view like a file from the file browser;
 * in the Click way of asking, a click picks it.
 */
function Databases(props: {
  settings: ServerConnection.ISettings;
  model: () => EpiModel | null;
  subscribe: (update: () => void) => () => void;
}): JSX.Element {
  const [listing, setListing] = React.useState<IListing | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [tables, setTables] = React.useState<Record<string, ITable[] | string>>(
    {}
  );
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const [, setVersion] = React.useState(0);
  React.useEffect(() => props.subscribe(() => setVersion(v => v + 1)), []);
  const model = props.model();
  useModel(model);

  const refresh = async () => {
    setError(null);
    setListing(null);
    setTables({});
    try {
      setListing(await requestAPI<IListing>('databases', props.settings));
    } catch (reason) {
      setError(String(reason));
    }
  };
  React.useEffect(() => {
    void refresh();
  }, []);

  const toggle = async (key: string, path?: string) => {
    const next = new Set(open);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setOpen(next);
    if (path && !(path in tables)) {
      try {
        const described = await requestAPI<{ tables: ITable[] }>(
          `databases/tables?path=${encodeURIComponent(path)}`,
          props.settings
        );
        setTables(current => ({ ...current, [path]: described.tables }));
      } catch (reason) {
        setTables(current => ({ ...current, [path]: String(reason) }));
      }
    }
  };

  const itemOf = (database: IDatabase, table: ITable): IItem => ({
    kind: 'table',
    name: `${database.path}::${table.name}`,
    label: table.name,
    path: database.path,
    table: table.name
  });

  const pickable = model?.interaction === 'click';
  const armed = model?.armed;

  return (
    <div className="jp-Epi-section jp-Epi-databases">
      <div className="jp-Epi-section-head">
        <span>Databases</span>
        <Button
          minimal
          small
          className="jp-Epi-databases-refresh"
          title="Look for SQLite files again"
          aria-label="Look for SQLite files again"
          onClick={() => void refresh()}
        >
          <refreshIcon.react tag="span" elementPosition="center" />
        </Button>
      </div>
      {error && <div className="jp-Epi-error">{error}</div>}
      {!listing && !error && (
        <div className="jp-Epi-empty">Looking for SQLite files…</div>
      )}
      {listing && listing.databases.length === 0 && (
        <div className="jp-Epi-databases-empty">
          <databaseIcon.react
            className="jp-Epi-databases-icon"
            tag="div"
            height="40px"
            width="40px"
          />
          <p className="jp-Epi-databases-title">No SQLite database found</p>
          <p>
            The panel lists SQLite files (.sqlite, .sqlite3, .db, .db3) up to{' '}
            {listing.depth} folders below the server's root. Drag a table from
            here onto a notebook in Whybook to start an analysis from it.
          </p>
          <p className="jp-Epi-caption">
            Only SQLite for now: other databases need a connector that is not
            built yet.
          </p>
        </div>
      )}
      {listing && listing.databases.length > 0 && (
        <ul className="jp-Epi-tree" role="tree" aria-label="Databases">
          {listing.databases.map(database => {
            const expanded = open.has(database.path);
            const content = tables[database.path];
            return (
              <li key={database.path} role="treeitem" aria-expanded={expanded}>
                <button
                  className="jp-Epi-tree-row"
                  onClick={() => void toggle(database.path, database.path)}
                  title={database.path}
                >
                  {expanded ? (
                    <caretDownIcon.react tag="span" />
                  ) : (
                    <caretRightIcon.react tag="span" />
                  )}
                  <databaseIcon.react tag="span" />
                  <span className="jp-Epi-tree-name">{database.name}</span>
                  <span className="jp-Epi-tree-meta">
                    {formatSize(database.size)}
                  </span>
                </button>
                {expanded && content === undefined && (
                  <div className="jp-Epi-empty">Reading the tables…</div>
                )}
                {expanded && typeof content === 'string' && (
                  <div className="jp-Epi-error">{content}</div>
                )}
                {expanded && Array.isArray(content) && (
                  <ul role="group">
                    {content.map(table => {
                      const key = `${database.path}::${table.name}`;
                      const item = itemOf(database, table);
                      const picked =
                        armed?.kind === 'table' && armed.name === item.name;
                      return (
                        <li
                          key={key}
                          role="treeitem"
                          aria-expanded={open.has(key)}
                        >
                          <div
                            className={`jp-Epi-tree-row jp-mod-table${picked ? ' jp-mod-armed' : ''}`}
                            data-database={database.path}
                            data-table={table.name}
                            draggable
                            tabIndex={0}
                            title={
                              pickable
                                ? `Click to pick ${table.name}, then a cell`
                                : `Drag ${table.name} onto the notebook or onto a cell`
                            }
                            onDragStart={event => setDragItem(event, item)}
                            onClick={() => {
                              if (pickable && model) {
                                model.arm(picked ? null : item);
                              }
                            }}
                            onKeyDown={event => {
                              if (event.key === 'Enter' && pickable && model) {
                                model.arm(picked ? null : item);
                              }
                            }}
                          >
                            <button
                              className="jp-Epi-tree-caret"
                              aria-label={`Columns of ${table.name}`}
                              onClick={event => {
                                event.stopPropagation();
                                void toggle(key);
                              }}
                            >
                              {open.has(key) ? (
                                <caretDownIcon.react tag="span" />
                              ) : (
                                <caretRightIcon.react tag="span" />
                              )}
                            </button>
                            <tableRowsIcon.react tag="span" />
                            <span className="jp-Epi-tree-name">
                              {table.name}
                            </span>
                            <span className="jp-Epi-tree-meta">
                              {table.kind === 'view' ? 'view · ' : ''}
                              {table.rows === null
                                ? 'many rows'
                                : `${table.rows.toLocaleString()} rows`}
                            </span>
                          </div>
                          {open.has(key) && (
                            <ul role="group" className="jp-Epi-tree-columns">
                              {table.columns.map(column => (
                                <li key={column.name} role="treeitem">
                                  <span className="jp-Epi-tree-name">
                                    {column.name}
                                  </span>
                                  <span className="jp-Epi-tree-meta">
                                    {column.type.toLowerCase()}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {listing && listing.databases.length > 0 && (
        <div className="jp-Epi-caption jp-Epi-databases-foot">
          <lockIcon.react tag="span" /> Opened read-only. Drag a table onto the
          notebook or onto a cell{pickable ? ', or click it, then a cell' : ''}.
          {listing.complete
            ? ''
            : ' The search stopped early: not every file is listed.'}
        </div>
      )}
    </div>
  );
}

/**
 * The Databases side panel, under the file browser: the two places an
 * analysis starts from.
 */
export class DatabasesPanel extends ReactWidget {
  constructor(
    private _settings: ServerConnection.ISettings,
    private _model: () => EpiModel | null,
    private _subscribe: (update: () => void) => () => void
  ) {
    super();
    this.id = 'epi-databases';
    this.addClass('jp-Epi');
    this.addClass('jp-Epi-sidebar');
    this.title.icon = databaseIcon;
    this.title.caption = 'Databases';
  }

  render(): JSX.Element {
    return (
      <Databases
        settings={this._settings}
        model={this._model}
        subscribe={this._subscribe}
      />
    );
  }
}
