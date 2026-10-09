/**
 * The chip of a fit's iteration limit (design iteration 1.116). The kernel
 * lists max_iter of LogisticRegression() with `when: 'not_converged'`, and the
 * view shows it, and counts it as an open assumption, only on a cell whose fit
 * stopped before it converged: the finance video's scorecard stopped at
 * max_iter = 100 with a ConvergenceWarning, and no chip named the limit.
 */
import './fakes/quiet';

import type * as nbformat from '@jupyterlab/nbformat';

import { countOpenAssumptions, defaultMatters } from '../model/assumptions';
import { stoppedBeforeConverging } from '../model/logs';
import type { IDecision } from '../tokens';
import { benchModel } from './fakes/bench-fake';

const C: IDecision = {
  name: 'C',
  value: '1.0',
  provenance: 'library_default',
  param: 'C',
  function: 'LogisticRegression',
  note: 'L2 regularisation is on by default',
  calls: [{ line: 1, col: 12 }]
};

const LIMIT: IDecision = {
  name: 'max_iter',
  value: '100',
  provenance: 'library_default',
  param: 'max_iter',
  function: 'LogisticRegression',
  note: 'the fit stops after this many iterations, whether it has converged or not',
  calls: [{ line: 1, col: 12 }],
  when: 'not_converged'
};

/** What scikit-learn 1.9.1 printed for the scorecard, cut to its first lines. */
const WARNING =
  '/site-packages/sklearn/linear_model/_logistic.py:599: ConvergenceWarning: ' +
  'lbfgs failed to converge after 100 iteration(s) (status=1):\n' +
  'STOP: TOTAL NO. OF ITERATIONS REACHED LIMIT\n';

function fit(outputs: nbformat.IOutput[]) {
  return benchModel([
    {
      id: 'fit',
      source: 'scorecard = LogisticRegression().fit(X, y)',
      count: 4,
      meta: { decisions: [C, LIMIT] },
      outputs
    }
  ]);
}

const names = (decisions: IDecision[]) =>
  decisions.map(decision => decision.name);

describe('stoppedBeforeConverging', () => {
  it('reads a warning, a summary or the listing, and a fit that converged in the end wins', () => {
    expect(stoppedBeforeConverging([WARNING], [])).toBe(true);
    expect(stoppedBeforeConverging(['    converged: False'], [])).toBe(true);
    expect(stoppedBeforeConverging([''], [false])).toBe(true);
    expect(stoppedBeforeConverging(['fitted'], [null])).toBe(false);
    // A MixedLM that tried again: the warning, then a summary that says it converged.
    expect(
      stoppedBeforeConverging(
        [
          'ConvergenceWarning: Maximum Likelihood optimization failed to converge. Check mle_retvals',
          'Converged: Yes'
        ],
        []
      )
    ).toBe(false);
    expect(stoppedBeforeConverging([WARNING], [true])).toBe(false);
  });
});

describe('the chip of an iteration limit', () => {
  it('shows only on a cell whose fit stopped before it converged', () => {
    const stopped = fit([
      { output_type: 'stream', name: 'stderr', text: WARNING }
    ]).model;
    expect(names(stopped.cells()[0].decisions)).toEqual(['C', 'max_iter']);
    const converged = fit([
      { output_type: 'stream', name: 'stdout', text: 'fitted\n' }
    ]).model;
    expect(names(converged.cells()[0].decisions)).toEqual(['C']);
  });

  it('goes when the outputs that showed the warning go', () => {
    const { nb, model } = fit([
      { output_type: 'stream', name: 'stderr', text: WARNING }
    ]);
    expect(names(model.cells()[0].decisions)).toEqual(['C', 'max_iter']);
    const cell = nb.cells.get(0) as unknown as {
      outputs: { clear(): void };
    };
    cell.outputs.clear();
    expect(names(model.cells()[0].decisions)).toEqual(['C']);
  });

  it('is an open assumption, with the sign that the server gives too', () => {
    expect(defaultMatters(LIMIT, [], new Map())).toBe(
      'the fit stopped at max_iter = 100, before it converged'
    );
    expect(countOpenAssumptions([{ decisions: [C, LIMIT] }], [])).toBe(1);
    expect(countOpenAssumptions([{ decisions: [C] }], [])).toBe(0);
  });
});
