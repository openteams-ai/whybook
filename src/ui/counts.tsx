import * as React from 'react';

/**
 * The counts under the questions asked: pivots, subanalyses, open
 * assumptions and, when the guess before a result is on, guesses. A count
 * of one takes the singular: "1 pivot".
 */
export function ExplorationCounts(props: {
  pivots: number;
  branches: number;
  assumptions: number;
  guesses: number | null;
}): JSX.Element {
  const count = (value: number, one: string, many: string) => (
    <>
      <span className="jp-Epi-big">{value}</span>
      <span>{value === 1 ? one : many}</span>
    </>
  );
  return (
    <div className="jp-Epi-block jp-Epi-numbers">
      <div>{count(props.pivots, 'pivot', 'pivots')}</div>
      <div>{count(props.branches, 'subanalysis', 'subanalyses')}</div>
      <div>
        {count(props.assumptions, 'open assumption', 'open assumptions')}
      </div>
      {props.guesses !== null && (
        <div title="Results you guessed before seeing them">
          {count(props.guesses, 'guess', 'guesses')}
        </div>
      )}
    </div>
  );
}
