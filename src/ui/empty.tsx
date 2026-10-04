import type { LabIcon } from '@jupyterlab/ui-components';
import {
  Button,
  fileIcon,
  folderIcon,
  jsonIcon,
  spreadsheetIcon
} from '@jupyterlab/ui-components';
import * as React from 'react';

import { databaseIcon, epiIcon } from '../icons';
import type { EpiModel, INearbyFile } from '../model/epimodel';
import type { IItem } from '../tokens';
import {
  anchorOf,
  carriesItem,
  dragItem,
  modifiersOf,
  setDragItem
} from './common';

function sizeOf(bytes: number | null): string {
  if (bytes === null) {
    return '';
  }
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function iconOf(file: INearbyFile): LabIcon {
  if (file.database) {
    return databaseIcon;
  }
  if (/\.(csv|tsv|xlsx|xls)$/i.test(file.name)) {
    return spreadsheetIcon;
  }
  return /\.jsonl?$/i.test(file.name) ? jsonIcon : fileIcon;
}

/**
 * What the view shows while the notebook's file loads: the outline of two
 * cells and a line that says so, in place of the start of an empty notebook.
 */
export function LoadingCells(): JSX.Element {
  return (
    <div className="jp-Epi-loading" role="status">
      {[0, 1].map(index => (
        <div key={index} className="jp-Epi-loading-cell" aria-hidden="true">
          <span className="jp-Epi-loading-line jp-mod-title" />
          <span className="jp-Epi-loading-line" />
          <span className="jp-Epi-loading-line jp-mod-short" />
        </div>
      ))}
      <div className="jp-Epi-loading-note">Loading the notebook…</div>
    </div>
  );
}

/**
 * What a notebook with no code shows: where an analysis starts from, the
 * file browser and the Databases panel, and the data files next to the
 * notebook, which start one with a click or a drag.
 */
export function EmptyStart(props: { model: EpiModel }): JSX.Element {
  const { model } = props;
  const [files, setFiles] = React.useState<INearbyFile[] | null>(null);
  React.useEffect(() => {
    let current = true;
    model
      .nearbyData()
      .then(found => current && setFiles(found))
      .catch(() => current && setFiles([]));
    return () => {
      current = false;
    };
  }, [model.context.path]);
  const start = (file: INearbyFile, event: React.MouseEvent) => {
    if (file.database) {
      model.settings.requestPanel('databases');
    } else {
      model.askFileDrop([file.path], {}, anchorOf(event));
    }
  };
  const [over, setOver] = React.useState(false);
  return (
    <div
      className={`jp-Epi-start${over ? ' jp-mod-over' : ''}`}
      // A file offered here, or a table from Databases, dropped on the card.
      onDragOver={event => {
        if (carriesItem(event)) {
          event.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={event => {
        setOver(false);
        const item = dragItem(event);
        if (item?.kind === 'file' && item.path) {
          event.preventDefault();
          event.stopPropagation();
          model.askFileDrop([item.path], {}, anchorOf(event));
        } else if (item?.kind === 'table') {
          event.preventDefault();
          event.stopPropagation();
          void model.askDrop(
            item,
            {},
            modifiersOf(event, model),
            anchorOf(event)
          );
        }
      }}
    >
      <div className="jp-Epi-start-art" aria-hidden="true">
        <folderIcon.react tag="span" className="jp-Epi-start-source" />
        <span className="jp-Epi-start-arrow" />
        <epiIcon.react tag="span" className="jp-Epi-start-view" />
        <span className="jp-Epi-start-arrow jp-mod-back" />
        <databaseIcon.react tag="span" className="jp-Epi-start-source" />
      </div>
      <h2 className="jp-Epi-start-title">Start from your data</h2>
      <p className="jp-Epi-start-text">
        Drag a data file from the file browser, or a table from the Databases
        panel, and drop it here. Whybook then offers to load it, profile it, or
        join it to the data you have.
      </p>
      <div className="jp-Epi-start-actions">
        <Button
          small
          className="jp-Epi-button"
          onClick={() => model.settings.requestPanel('files')}
        >
          <folderIcon.react tag="span" elementPosition="center" />
          Show files
        </Button>
        <Button
          small
          className="jp-Epi-button"
          onClick={() => model.settings.requestPanel('databases')}
        >
          <databaseIcon.react tag="span" elementPosition="center" />
          Show databases
        </Button>
      </div>
      {files !== null && files.length > 0 && (
        <div className="jp-Epi-start-near">
          <div className="jp-Epi-caption">
            Data next to this notebook: click a file to start from it, or drag
            it here.
          </div>
          <div className="jp-Epi-start-files">
            {files.map(file => {
              const item: IItem = {
                kind: 'file',
                name: file.path,
                label: file.name,
                path: file.path
              };
              const Icon = iconOf(file);
              return (
                <button
                  key={file.path}
                  className="jp-Epi-start-file"
                  draggable={!file.database}
                  onDragStart={event => setDragItem(event, item)}
                  onClick={event => start(file, event)}
                  title={
                    file.database
                      ? `${file.path}: its tables are in the Databases panel`
                      : `Start from ${file.path}`
                  }
                >
                  <Icon.react tag="span" className="jp-Epi-start-file-icon" />
                  <span className="jp-Epi-start-file-name">{file.name}</span>
                  <span className="jp-Epi-start-file-size">
                    {sizeOf(file.size)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
