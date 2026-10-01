/**
 * A markdown cell on the bench and in the Code view (NoteCard) is drawn as
 * JupyterLab's notebook draws it: untrusted, so that the sanitizer removes
 * scripts and event handlers, whatever the notebook's trust.
 */
import * as React from 'react';
import { Sanitizer } from '@jupyterlab/apputils';
import type { IRenderMime } from '@jupyterlab/rendermime';
import { RenderMimeRegistry } from '@jupyterlab/rendermime';
import { standardRendererFactories } from '@jupyterlab/rendermime';

import { NoteCard } from '../ui/bench';
import { benchModel } from './fakes/bench-fake';
import { mount, settle } from './fakes/bench-render';

// JupyterLab's parser, marked, is an ES module that jest does not load here.
// It passes HTML through as it is, and makes plain tags of the rest, so the
// texts below give the HTML that marked makes of their markdown.
const passThrough = { render: async (source: string) => source };

function registry(
  options: Partial<RenderMimeRegistry.IOptions> = {}
): RenderMimeRegistry {
  return new RenderMimeRegistry({
    initialFactories: standardRendererFactories,
    sanitizer: new Sanitizer(),
    markdownParser: passThrough,
    ...options
  });
}

async function drawn(
  source: string,
  rendermime: RenderMimeRegistry,
  variant: 'bench' | 'linear' = 'bench'
) {
  const { model } = benchModel(
    [
      { id: 't', type: 'markdown', source },
      { id: 'a', source: 'x = 1', count: 1 }
    ],
    { rendermime }
  );
  const view = await mount(
    <NoteCard
      model={model}
      cell={model.cell('t')!}
      editorServices={null}
      variant={variant}
    />
  );
  await settle(60);
  return { view, model };
}

describe('A markdown cell on the bench and in the Code view', () => {
  afterEach(() => {
    delete (window as any).__whybookRan;
  });

  it('keeps no script or event handler of a notebook that nobody trusted', async () => {
    const { view, model } = await drawn(
      '## Notes\n\n' +
        '<img src="missing.png" onerror="window.__whybookRan = 1">\n\n' +
        '<script>window.__whybookRan = 2</script>\n',
      registry()
    );
    const img = view.host.querySelector('img');
    const found = {
      img: !!img,
      onerror: img?.getAttribute('onerror') ?? null,
      script: view.host.querySelector('script')?.textContent ?? null,
      ran: (window as any).__whybookRan ?? null
    };
    await view.unmount();
    model.dispose();
    expect(found).toEqual({
      img: true,
      onerror: null,
      script: null,
      ran: null
    });
  });

  it('still draws headings, lists, links, tables, code, math and pictures', async () => {
    const typeset: HTMLElement[] = [];
    const latexTypesetter: IRenderMime.ILatexTypesetter = {
      typeset: (element: HTMLElement) => {
        typeset.push(element);
      }
    };
    // The notebook's own folder, as the view's registry resolves it.
    const resolver = new RenderMimeRegistry.UrlResolver({
      path: 'study/pain.ipynb',
      contents: {
        getDownloadUrl: async (path: string) => `/files/${path}`,
        driveName: () => ''
      } as any
    });
    const { view, model } = await drawn(
      [
        '<h2>Results</h2>',
        '<ul><li>week 3: pain drops</li><li>week 6: it stays low</li></ul>',
        '<p>See <a href="https://example.org/study">the protocol</a>,',
        '<code>weekly.mean()</code> and $\\beta_1 = -0.4$.</p>',
        '<table><thead><tr><th>arm</th><th>pain</th></tr></thead>',
        '<tbody><tr><td>A</td><td>3.1</td></tr></tbody></table>',
        '<p><img src="figures/pain.png" alt="pain by week"></p>'
      ].join('\n'),
      registry({ latexTypesetter, resolver }),
      'linear'
    );
    const host = view.host;
    const found = {
      // JupyterLab adds a ¶ link to each heading.
      heading: host.querySelector('h2')?.firstChild?.textContent,
      items: host.querySelectorAll('li').length,
      link: host.querySelector('a[href^="https:"]')?.textContent,
      code: host.querySelector('code')?.textContent,
      math: host.textContent?.includes('$\\beta_1 = -0.4$'),
      typeset: typeset.some(node => node.textContent?.includes('\\beta_1')),
      cell: host.querySelector('td:last-child')?.textContent,
      picture: host.querySelector('img')?.getAttribute('src')
    };
    await view.unmount();
    model.dispose();
    expect(found).toEqual({
      heading: 'Results',
      items: 2,
      link: 'the protocol',
      code: 'weekly.mean()',
      math: true,
      typeset: true,
      cell: '3.1',
      // Under the folder where jest runs, which is the root in a browser.
      picture: expect.stringMatching(/^\/files\/.*study\/figures\/pain\.png/)
    });
  });
});
