/**
 * The size that the view writes under a miniature of a table, "5 × 64": only
 * when the output does not show its own line of the size, as pandas'
 * "5 rows × 64 columns" under a table that it cuts (src/model/tables.ts,
 * src/ui/tables.tsx).
 */
import './fakes/quiet';

import * as React from 'react';
import { Sanitizer } from '@jupyterlab/apputils';
import {
  OutputModel,
  RenderMimeRegistry,
  standardRendererFactories
} from '@jupyterlab/rendermime';

import { TableOutput } from '../ui/tables';
import { benchModel } from './fakes/bench-fake';
import { mount, settle } from './fakes/bench-render';

function rendermime(): RenderMimeRegistry {
  return new RenderMimeRegistry({
    initialFactories: standardRendererFactories,
    sanitizer: new Sanitizer()
  });
}

/** A frame as pandas writes it: an index of <th>, values in <td>, and what follows the table. */
function frameHtml(rows: number, columns: number, after = ''): string {
  const head = Array.from({ length: columns }, (_, i) => `<th>c${i}</th>`);
  const body = Array.from(
    { length: rows },
    (_, r) =>
      `<tr><th>${r}</th>${Array.from({ length: columns }, (_, c) => `<td>${r * c}</td>`).join('')}</tr>`
  );
  return (
    '<div><table border="1" class="dataframe">' +
    `<thead><tr style="text-align: right;"><th></th>${head.join('')}</tr></thead>` +
    `<tbody>${body.join('')}</tbody></table>${after}</div>`
  );
}

/**
 * The table drawn as a miniature in a card 1,000 px wide, when it is 1,200
 * px wide at full size and `height` px tall: the level it shows at, and the
 * view's line of its size under it, or null.
 */
async function drawn(
  html: string,
  height: number
): Promise<{ level: string; caption: string | null }> {
  const { model } = benchModel([{ id: 'a', source: 'nhefs.head()' }], {
    rendermime: rendermime()
  });
  const output = new OutputModel({
    value: {
      output_type: 'execute_result',
      execution_count: 1,
      metadata: {},
      data: { 'text/html': html, 'text/plain': 'nhefs' }
    }
  });
  const width = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetWidth'
  )!;
  const tall = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetHeight'
  )!;
  const sized = (full: number, other: PropertyDescriptor) => ({
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('jp-Epi-tableoutput-content')
        ? full
        : other.get!.call(this);
    }
  });
  Object.defineProperty(
    HTMLElement.prototype,
    'offsetWidth',
    sized(1200, width)
  );
  Object.defineProperty(
    HTMLElement.prototype,
    'offsetHeight',
    sized(height, tall)
  );
  try {
    const view = await mount(
      <TableOutput
        model={model}
        cellId="a"
        output={output}
        available={1000}
        active={false}
        onOpen={() => undefined}
        detail="full"
      />
    );
    await settle();
    const level = view.host.querySelector('.jp-Epi-tableoutput')!.className;
    const caption =
      view.host.querySelector('.jp-Epi-tableoutput-caption')?.textContent ??
      null;
    await view.unmount();
    return { level, caption };
  } finally {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width);
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', tall);
    model.dispose();
  }
}

describe('the size under a miniature of a table', () => {
  it('is not written under a table whose output shows its size, as pandas does under nhefs.head()', async () => {
    // [1] of the NHEFS video: nhefs.head() of 64 columns, which pandas cuts
    // and writes "5 rows × 64 columns" under.
    const head = frameHtml(5, 20, '<p>5 rows × 64 columns</p>');
    expect(await drawn(head, 150)).toEqual({
      level: 'jp-Epi-tableoutput jp-mod-miniature',
      caption: null
    });
  });

  it('is written where the miniature cuts off the line of pandas, or where the output writes none', async () => {
    // 60 rows are taller than a miniature: its line goes with its last rows.
    const long = frameHtml(60, 20, '<p>1,629 rows × 64 columns</p>');
    expect(await drawn(long, 900)).toEqual({
      level: 'jp-Epi-tableoutput jp-mod-miniature',
      caption: '1,629 × 64'
    });
    // A table that pandas does not cut has no line of its size.
    expect((await drawn(frameHtml(8, 20), 200)).caption).toBe('8 × 20');
  });

  it('is not written under a table whose size R writes in its caption, or polars above it', async () => {
    const r =
      '<table class="dataframe"><caption>A data.frame: 1629 × 64</caption>' +
      '<thead><tr><th></th><th scope=col>seqn</th><th scope=col>qsmk</th></tr>' +
      '<tr><th></th><th scope=col>&lt;int&gt;</th><th scope=col>&lt;int&gt;</th></tr></thead>' +
      '<tbody><tr><th scope=row>1</th><td>233</td><td>0</td></tr>' +
      '<tr><th scope=row>2</th><td>235</td><td>0</td></tr></tbody></table>';
    expect((await drawn(r, 900)).caption).toBeNull();
    const polars =
      '<div><small>shape: (1_629, 64)</small><table border="1" class="dataframe"><thead><tr><th>seqn</th><th>qsmk</th></tr><tr><td>i64</td><td>i64</td></tr></thead><tbody><tr><td>233</td><td>0</td></tr></tbody></table></div>';
    expect((await drawn(polars, 900)).caption).toBeNull();
  });
});
