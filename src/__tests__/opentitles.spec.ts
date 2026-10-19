/**
 * A card's title is the first line of its cell's code (firstLine in
 * src/model/notebook.ts). A call written over several lines left titles such
 * as "corpus = pl.DataFrame(": a line of code that leaves a bracket open now
 * closes it after an ellipsis. A bracket in a string or a comment does not
 * count, and a comment, a text and an error message stay as they are.
 */
import './fakes/quiet';

import { PYTHON, R, SAS } from '../model/languages';
import { firstLine } from '../model/notebook';
import { benchModel } from './fakes/bench-fake';

describe('the title of a line of code that leaves a bracket open', () => {
  it('closes the bracket after an ellipsis', () => {
    expect(
      firstLine('corpus = pl.DataFrame(\n    {"text": texts}\n)', PYTHON)
    ).toBe('corpus = pl.DataFrame(…)');
    expect(firstLine('(alta\n    .filter(pl.col("x") > 1)\n)', PYTHON)).toBe(
      '(alta…)'
    );
    expect(firstLine('df <- read.csv(\n  "visits.csv"\n)', R)).toBe(
      'df <- read.csv(…)'
    );
  });

  it('closes every bracket it leaves open, the last one opened first', () => {
    expect(firstLine('x = f(a, [1,\n  2])', PYTHON)).toBe('x = f(a, [1,…])');
    expect(firstLine('params = {\n  "alpha": 0.1}', PYTHON)).toBe(
      'params = {…}'
    );
  });

  it('leaves a line whose brackets close as it is', () => {
    expect(firstLine('weekly = diary.groupby("week").mean()', PYTHON)).toBe(
      'weekly = diary.groupby("week").mean()'
    );
    expect(firstLine('for name in names:\n    print(name)', PYTHON)).toBe(
      'for name in names:'
    );
  });

  it('does not count a bracket in a string', () => {
    expect(firstLine('label = "pain (0 to 10"', PYTHON)).toBe(
      'label = "pain (0 to 10"'
    );
    expect(firstLine("plt.title('Pain (weekly)'", PYTHON)).toBe(
      "plt.title('Pain (weekly)'…)"
    );
    expect(firstLine('query("""select (a\nfrom t)""")', PYTHON)).toBe(
      'query("""select (a…)'
    );
    expect(firstLine('print("a \\" (b", x', PYTHON)).toBe(
      'print("a \\" (b", x…)'
    );
  });

  it('closes the brackets before a comment at the end of the line, and does not count a bracket in the comment', () => {
    expect(firstLine('model = smf.ols(  # (the formula', PYTHON)).toBe(
      'model = smf.ols(…)  # (the formula'
    );
    expect(firstLine('fit = f(x)  # (see below', PYTHON)).toBe(
      'fit = f(x)  # (see below'
    );
  });

  it('leaves out a backslash that continues the line, which the ellipsis stands for', () => {
    expect(
      firstLine(
        'pd.DataFrame(data=[r], columns=["Mean"],  \\\n  index=[0])',
        PYTHON
      )
    ).toBe('pd.DataFrame(data=[r], columns=["Mean"],…)');
  });

  it('leaves a comment, a text and an error message as they are', () => {
    expect(firstLine('# Load the data (from S3\nx = 1', PYTHON)).toBe(
      'Load the data (from S3'
    );
    expect(firstLine('/* Visits (by arm */\nproc freq;', SAS)).toBe(
      'Visits (by arm'
    );
    // Without a language: the first line of a text, or of an error.
    expect(firstLine('Results (first pass\nmore')).toBe('Results (first pass');
    expect(firstLine('ValueError: Length mismatch (expected 3\n...')).toBe(
      'ValueError: Length mismatch (expected 3'
    );
  });

  it('closes a bracket that the cut at 100 characters leaves open', () => {
    const line = `x = f(${'a, '.repeat(60)}b)`;
    expect(firstLine(line, PYTHON)).toBe(`${line.slice(0, 100)}…)`);
  });
});

describe('the card of a call written over several lines', () => {
  it('has the closed title on the bench', () => {
    const { model } = benchModel({
      cells: [
        {
          cell_type: 'code',
          id: 'a',
          source: 'corpus = pl.DataFrame(\n    {"text": texts}\n)',
          metadata: {},
          outputs: [],
          execution_count: null
        },
        {
          cell_type: 'code',
          id: 'b',
          source: 'corpus.with_columns(\n    pl.col("text").str.len_chars()\n)',
          metadata: {},
          outputs: [],
          execution_count: null
        }
      ],
      metadata: {
        kernelspec: {
          name: 'python3',
          display_name: 'Python 3',
          language: 'python'
        }
      },
      nbformat: 4,
      nbformat_minor: 5
    });
    const titles = model.codeCells().map(cell => cell.title);
    model.dispose();
    expect(titles).toEqual([
      'corpus = pl.DataFrame(…)',
      'corpus.with_columns(…)'
    ]);
  });
});
