import type * as nbformat from '@jupyterlab/nbformat';
import type { IOutputModel, IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { MimeModel } from '@jupyterlab/rendermime';
import { Widget } from '@lumino/widgets';
import * as React from 'react';

import type { IImagePick } from '../model/imageask';
import type { IOutputText } from '../model/logs';
import { SHORT_TEXT_LINES, outputText } from '../model/logs';
import { outputKind } from '../model/notebook';
import { ninejsChart, ninejsPlace } from '../model/ninejs';
import { svgRatio } from '../model/outputs';
import { PLOTLY_MIME, watchPlotly } from '../model/plotly';
import type { IAnchor, IPlotPayload } from '../tokens';
import { plotPayload } from '../tokens';
import type { ICopied } from './common';
import { CopyButton, svgToPng } from './common';
import { IMAGE_MIMES, ImageBrush } from './imagebrush';
import { EpiPlot } from './plot';

export type OutputLike = Pick<
  IOutputModel,
  'type' | 'data' | 'metadata' | 'trusted'
> & {
  toJSON?: () => nbformat.IOutput;
  setData?: IOutputModel['setData'];
};

function firstText(data: unknown): string {
  const value = Array.isArray(data) ? data.join('') : String(data ?? '');
  return value.split('\n').find(line => line.trim().length > 0) ?? '';
}

export function plotOf(output: OutputLike): IPlotPayload | null {
  return plotPayload(output.data);
}

interface IBoundaryProps {
  /** The output drawn: another output in the same place draws again. */
  output: unknown;
  children?: React.ReactNode;
}

interface IBoundaryState {
  failed: boolean;
  error: string;
  output: unknown;
}

/**
 * An output that throws while it draws, such as a plot payload of another
 * version, shows a short line in its place, and the rest of the view stays.
 */
export class OutputBoundary extends React.Component<
  IBoundaryProps,
  IBoundaryState
> {
  constructor(props: IBoundaryProps) {
    super(props);
    this.state = { failed: false, error: '', output: props.output };
  }

  static getDerivedStateFromError(error: unknown): Partial<IBoundaryState> {
    return { failed: true, error: String(error) };
  }

  static getDerivedStateFromProps(
    props: IBoundaryProps,
    state: IBoundaryState
  ): Partial<IBoundaryState> | null {
    return props.output === state.output
      ? null
      : { failed: false, error: '', output: props.output };
  }

  componentDidCatch(error: unknown): void {
    console.warn('Could not draw an output', error);
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <div className="jp-Epi-error" title={this.state.error}>
          This output could not be drawn
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * A small tile for one output: a thumbnail for plots and images, a label for the rest.
 */
export function Miniature(props: IMiniatureProps): JSX.Element {
  return (
    <OutputBoundary output={props.output}>
      <MiniatureBody {...props} />
    </OutputBoundary>
  );
}

interface IMiniatureProps {
  output: IOutputModel;
  active: boolean;
  onClick: () => void;
  title?: string;
  /** Draws a library's chart; without it a chart shows its kind. */
  rendermime?: IRenderMimeRegistry;
}

function MiniatureBody(props: IMiniatureProps): JSX.Element | null {
  const { output, active, onClick } = props;
  const kind = outputKind(output);
  if (kind === 'progress') {
    return null;
  }
  let content: React.ReactNode = kind;
  const data = output.data;
  if (kind === 'plot') {
    const payload = plotOf(output)!;
    content = <EpiPlot payload={payload} width={150} height={52} thumbnail />;
  } else if (
    kind === 'image' ||
    (kind === 'chart' && typeof data['image/png'] === 'string')
  ) {
    // Plotly and Vega keep a picture of a chart they drew in its output.
    const src =
      typeof data['image/png'] === 'string'
        ? `data:image/png;base64,${data['image/png']}`
        : typeof data['image/jpeg'] === 'string'
          ? `data:image/jpeg;base64,${data['image/jpeg']}`
          : `data:image/svg+xml,${encodeURIComponent(data['image/svg+xml'] as string)}`;
    content = <img src={src} alt="" />;
  } else if (kind === 'chart' && props.rendermime) {
    // The library draws the chart at the notebook's size, scaled down here.
    content = (
      <span className="jp-Epi-miniature-chart">
        <RenderedOutput output={output} rendermime={props.rendermime} />
      </span>
    );
  } else if (kind === 'error') {
    content = (output.toJSON() as nbformat.IError).ename;
  } else if (kind === 'text') {
    content = (
      <span className="jp-Epi-miniature-text">
        {firstText(data['text/plain'])}
      </span>
    );
  }
  return (
    <button
      className={`jp-Epi-miniature jp-mod-${kind}${active ? ' jp-mod-active' : ''}`}
      onClick={onClick}
      title={
        props.title ??
        (kind === 'plot' ? plotOf(output)!.title : `Show this ${kind} in full`)
      }
    >
      {content}
    </button>
  );
}

/**
 * Changes each time more text streams into the output. JupyterLab appends a
 * stream's text to the same output model, so the model does not change.
 */
function useStreamVersion(output: IOutputModel): number {
  const [version, setVersion] = React.useState(0);
  React.useEffect(() => {
    const text = output.streamText;
    if (!text) {
      return;
    }
    const bump = () => setVersion(value => value + 1);
    text.changed.connect(bump);
    return () => {
      text.changed.disconnect(bump);
    };
  }, [output]);
  return version;
}

/**
 * A stream or plain-text output in a bench card. A short one shows in full,
 * each Python warning cut to its category and message; a click on it shows
 * the text as printed. A longer one is a tile with its size and one line:
 * the last of a log, the first of a result. An output of IPython's messages
 * about its history database alone does not show.
 */
export function TextOutput(props: {
  output: IOutputModel;
  active: boolean;
  onOpen: () => void;
  /** Printed lines shown in full; longer text is a tile. */
  limit?: number;
  /**
   * The warnings that a fit printed before it tried again and converged:
   * they fold into one line, which a click opens (design iteration 1.77).
   */
  fold?: (line: string) => boolean;
}): JSX.Element | null {
  const { output, active, onOpen, limit = SHORT_TEXT_LINES, fold } = props;
  // A tqdm bar on stderr redraws itself in the same output.
  const version = useStreamVersion(output);
  const text = React.useMemo(() => outputText(output.data), [output, version]);
  const [unfolded, setUnfolded] = React.useState(false);
  if (!text) {
    return <Miniature output={output} active={active} onClick={onOpen} />;
  }
  const folded = fold ? text.lines.filter(fold) : [];
  if (folded.length) {
    const rest = { ...text, lines: text.lines.filter(line => !fold!(line)) };
    return (
      <div className="jp-Epi-foldwrap">
        <button
          className="jp-Epi-foldedwarnings"
          aria-expanded={unfolded}
          title={
            unfolded
              ? 'Hide the warnings'
              : 'The fit printed these warnings, tried again and converged: show them'
          }
          onClick={() => setUnfolded(!unfolded)}
        >
          {folded.length} convergence warning{folded.length === 1 ? '' : 's'},
          then the fit converged
        </button>
        {unfolded && (
          <pre className="jp-Epi-textoutput jp-mod-stderr">
            {folded.join('\n')}
          </pre>
        )}
        {rest.lines.length > 0 && (
          <TextLines
            text={{ ...rest, warnings: text.warnings - folded.length }}
            active={active}
            onOpen={onOpen}
            limit={limit}
          />
        )}
      </div>
    );
  }
  return (
    <TextLines text={text} active={active} onOpen={onOpen} limit={limit} />
  );
}

/** The lines of a text output: in full when short, else a tile. */
function TextLines(props: {
  text: IOutputText;
  active: boolean;
  onOpen: () => void;
  limit: number;
}): JSX.Element | null {
  const { text, active, onOpen, limit } = props;
  const { lines, total, warnings, stream } = text;
  if (!lines.length) {
    // Only IPython's messages about its history database.
    return null;
  }
  const stderr = stream === 'stderr' ? ' jp-mod-stderr' : '';
  if (lines.length <= limit) {
    return warnings ? (
      <button
        className={`jp-Epi-textoutput${stderr}${active ? ' jp-mod-active' : ''}`}
        onClick={onOpen}
        title="Warnings cut to their message: click for the text as printed"
      >
        {lines.join('\n')}
      </button>
    ) : (
      <div className="jp-Epi-copyable jp-Epi-textwrap">
        <pre className={`jp-Epi-textoutput${stderr}`}>{lines.join('\n')}</pre>
        <CopyButton
          className="jp-Epi-copy-corner"
          label="Copy this text"
          copy={() => ({ text: lines.join('\n') })}
        />
      </div>
    );
  }
  const shown = stream ? lines[lines.length - 1] : lines[0];
  return (
    <button
      className={`jp-Epi-miniature jp-Epi-logtile${stderr}${active ? ' jp-mod-active' : ''}`}
      onClick={onOpen}
      title={stream ? 'Show the whole log' : 'Show this text in full'}
    >
      <span className="jp-Epi-logtile-kind">{stream ? 'Log' : 'Text'}</span>
      <span className="jp-Epi-logtile-size">
        {total.toLocaleString()} line{total === 1 ? '' : 's'}
        {warnings ? ` · ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}
      </span>
      <span className="jp-Epi-logtile-line">{shown}</span>
    </button>
  );
}

/**
 * Render one output with the registry, honouring the notebook's trust.
 * `onRendered` gets the node the renderer draws in, and returns a function
 * to call when the output goes.
 */
export function RenderedOutput(props: {
  output: OutputLike;
  rendermime: IRenderMimeRegistry;
  onRendered?: (host: HTMLElement) => () => void;
}): JSX.Element {
  const { output, rendermime } = props;
  const host = React.useRef<HTMLDivElement>(null);
  const onRendered = React.useRef(props.onRendered);
  onRendered.current = props.onRendered;
  // A layout effect: its cleanup runs before React removes the host node.
  React.useLayoutEffect(() => {
    const mimeType = rendermime.preferredMimeType(
      output.data,
      output.trusted ? 'any' : 'ensure'
    );
    if (!mimeType || !host.current) {
      return;
    }
    const renderer = rendermime.createRenderer(mimeType);
    void renderer.renderModel(
      new MimeModel({
        data: output.data,
        metadata: output.metadata,
        trusted: output.trusted,
        // Plotly and Vega add a picture of the chart they drew to its output,
        // and the notebook saves it: the file then shows the chart anywhere.
        callback: options => output.setData?.(options)
      })
    );
    Widget.attach(renderer, host.current);
    const stop = onRendered.current?.(host.current);
    return () => {
      stop?.();
      if (renderer.isAttached && !renderer.node.isConnected) {
        // The host left the page first (a panel moved): Lumino cannot detach it.
        renderer.clearFlag(Widget.Flag.IsAttached);
      }
      renderer.dispose();
    };
  }, [output, rendermime]);
  return <div className="jp-Epi-rendered" ref={host} />;
}

/**
 * Fits a chart that draws in an iframe, as ninejs does, to the width the
 * level of detail gives it. The iframe fills the width, and its height
 * follows the proportions of its SVG; ninejs sets a height for about 640 px.
 */
function fitFrames(host: HTMLElement): () => void {
  const fit = () => {
    for (const frame of Array.from(host.querySelectorAll('iframe'))) {
      const ratio = svgRatio(frame.getAttribute('srcdoc'));
      if (ratio && frame.clientWidth > 0) {
        frame.style.height = `${Math.ceil(frame.clientWidth * ratio) + 8}px`;
      }
    }
  };
  fit();
  const observer = new ResizeObserver(fit);
  observer.observe(host);
  return () => observer.disconnect();
}

/**
 * An output in full: an interactive plot for epi plots, the registry otherwise.
 */
export function FullOutput(props: {
  output: OutputLike;
  rendermime: IRenderMimeRegistry;
  width: number;
  selection?: { x0: number; x1: number; y?: [number, number] | null } | null;
  /** `y` is the range of y of a box on a Plotly chart. */
  onSelect?: (
    plot: IPlotPayload,
    x0: number,
    x1: number,
    anchor: { x: number; y: number },
    y?: [number, number] | null
  ) => void;
  /** The point or area of a picture that the open questions are about. */
  pick?: IImagePick | null;
  /** A click or a drag on a picture that cannot ask about rows. */
  onAskImage?: (pick: IImagePick, anchor: IAnchor) => void;
}): JSX.Element {
  const box = React.useRef<HTMLDivElement>(null);
  return (
    <div className="jp-Epi-copyable" ref={box}>
      <OutputBoundary output={props.output}>
        <FullOutputBody {...props} />
      </OutputBoundary>
      <CopyButton
        className="jp-Epi-copy-corner"
        label="Copy this output"
        copy={() => outputCopy(props.output, box.current)}
      />
    </div>
  );
}

/** A PNG picture held in an output as base64 text. */
function base64Png(value: unknown): Blob | null {
  if (typeof value !== 'string') {
    return null;
  }
  const binary = atob(value.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}

/**
 * What a copy of an output holds: its text, its HTML (a table pastes into a
 * spreadsheet), and a picture of a plot or an image.
 */
export async function outputCopy(
  output: OutputLike,
  node: HTMLElement | null
): Promise<ICopied> {
  const data = output.data;
  const printed = outputText(data);
  const joined = (value: unknown) =>
    Array.isArray(value)
      ? value.join('')
      : typeof value === 'string'
        ? value
        : '';
  const plot = plotOf(output);
  let png = base64Png(data['image/png']);
  const svg = node?.querySelector('svg.jp-Epi-plot') as SVGSVGElement | null;
  if (!png && plot && svg) {
    png = await svgToPng(svg, node?.querySelector('.jp-Epi-fullplot-title'));
  }
  return {
    text: printed
      ? printed.lines.join('\n')
      : joined(data['text/plain']) || (plot?.title ?? ''),
    html: joined(data['text/html']) || undefined,
    png
  };
}

function FullOutputBody(props: {
  output: OutputLike;
  rendermime: IRenderMimeRegistry;
  width: number;
  selection?: { x0: number; x1: number; y?: [number, number] | null } | null;
  onSelect?: (
    plot: IPlotPayload,
    x0: number,
    x1: number,
    anchor: { x: number; y: number },
    y?: [number, number] | null
  ) => void;
  pick?: IImagePick | null;
  onAskImage?: (pick: IImagePick, anchor: IAnchor) => void;
}): JSX.Element {
  const plot = plotOf(props.output);
  const onSelect = React.useRef(props.onSelect);
  onSelect.current = props.onSelect;
  if (plot) {
    return (
      <div className="jp-Epi-fullplot">
        <div className="jp-Epi-fullplot-title">{plot.title}</div>
        <EpiPlot
          payload={plot}
          width={props.width}
          height={Math.round(props.width * 0.55)}
          selection={props.selection}
          onSelect={
            props.onSelect
              ? (x0, x1, anchor, y) => props.onSelect!(plot, x0, x1, anchor, y)
              : undefined
          }
        />
        {props.onSelect && plot.kind === 'bars' && (
          <div className="jp-Epi-hint">
            Click a bar, or drag across bars, to ask about them. Each bar maps
            to rows of {plot.source.frame ?? 'its frame'}.
          </div>
        )}
        {props.onSelect && plot.select === 'x' && plot.kind !== 'bars' && (
          <div className="jp-Epi-hint">
            Click or drag across the plot to select. Every mark maps to rows of{' '}
            {plot.source.frame ?? 'its frame'}.
          </div>
        )}
        {props.onSelect && plot.select === 'xy' && (
          <div className="jp-Epi-hint">
            Drag a box around points, or click one, to ask about them. Every
            point is a row of {plot.source.frame ?? 'its frame'}.
          </div>
        )}
      </div>
    );
  }
  const live =
    props.rendermime.preferredMimeType(
      props.output.data,
      props.output.trusted ? 'any' : 'ensure'
    ) === PLOTLY_MIME;
  if (props.onSelect && props.output.data[PLOTLY_MIME] && live) {
    // A Plotly chart as Plotly draws it, in Box Select: a box asks about the
    // rows in it.
    return (
      <>
        <RenderedOutput
          output={props.output}
          rendermime={props.rendermime}
          onRendered={host =>
            watchPlotly(host, (chart, x0, x1, anchor, y) =>
              onSelect.current?.(chart, x0, x1, anchor, y)
            )
          }
        />
        <div className="jp-Epi-hint">
          Drag a box over points to ask about their rows. The chart's toolbar
          has zoom and pan.
        </div>
      </>
    );
  }
  if (props.onSelect && props.output.data[PLOTLY_MIME]) {
    // A notebook that is not trusted gets the picture that Plotly saved:
    // Plotly draws the chart again only for outputs the notebook trusts.
    return (
      <>
        <RenderedOutput output={props.output} rendermime={props.rendermime} />
        <div className="jp-Epi-hint">
          A picture of the chart, as the notebook saved it. Run the cell, or
          trust the notebook, to draw the chart again and ask about the rows in
          a box.
        </div>
      </>
    );
  }
  // A ninejs chart, in its own frame: a box on a layer over it asks about the
  // rows in the box, through the Axes that the kernel's hook describes. A
  // chart whose frame is not drawn as the view expects shows as ninejs ships
  // it (src/model/ninejs.ts).
  const nine =
    props.onSelect && props.output.trusted
      ? ninejsChart(props.output.data)
      : null;
  if (nine) {
    return (
      <ImageBrush
        data={props.output.data}
        mime="text/html"
        selection={props.selection}
        onSelect={props.onSelect}
        locate={host => ninejsPlace(host, nine)}
        cover
      >
        <RenderedOutput
          output={props.output}
          rendermime={props.rendermime}
          onRendered={fitFrames}
        />
      </ImageBrush>
    );
  }
  // A picture, as the registry draws it: a matplotlib figure with its Axes
  // asks about rows, and any other picture about a point or an area of it.
  const shown = props.rendermime.preferredMimeType(
    props.output.data,
    props.output.trusted ? 'any' : 'ensure'
  );
  if (
    shown &&
    IMAGE_MIMES.includes(shown) &&
    (props.onSelect || props.onAskImage)
  ) {
    return (
      <ImageBrush
        data={props.output.data}
        mime={shown}
        selection={props.selection}
        pick={props.pick}
        onSelect={props.onSelect}
        onAskImage={props.onAskImage}
      >
        <RenderedOutput output={props.output} rendermime={props.rendermime} />
      </ImageBrush>
    );
  }
  return (
    <RenderedOutput
      output={props.output}
      rendermime={props.rendermime}
      onRendered={fitFrames}
    />
  );
}

/**
 * Plain nbformat outputs, as a preview holds them.
 */
export function PlainOutputs(props: {
  outputs: nbformat.IOutput[];
  rendermime: IRenderMimeRegistry;
  width: number;
}): JSX.Element {
  return (
    <div className="jp-Epi-plain-outputs">
      {props.outputs.map((output, index) => {
        const data =
          output.output_type === 'stream'
            ? {
                'application/vnd.jupyter.stdout': (output as nbformat.IStream)
                  .text
              }
            : output.output_type === 'error'
              ? {
                  'application/vnd.jupyter.stderr': (
                    output as nbformat.IError
                  ).traceback.join('\n')
                }
              : (output as nbformat.IDisplayData).data;
        const like: OutputLike = {
          type: output.output_type,
          data,
          // A stream or an error has none.
          metadata:
            (output.metadata as nbformat.OutputMetadata | undefined) ?? {},
          trusted: true
        };
        return (
          <FullOutput
            key={index}
            output={like}
            rendermime={props.rendermime}
            width={props.width}
          />
        );
      })}
    </div>
  );
}
