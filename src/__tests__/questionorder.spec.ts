import { orderByScores, runnableFirst } from '../model/questionorder';
import type { IOption } from '../tokens';

function option(id: string, probability: number | null): IOption {
  return {
    id,
    text: `Question ${id}`,
    type: 'descriptive',
    origin: 'template',
    probability,
    reasons: [`rule for ${id}`],
    placement: null
  };
}

describe('orderByScores', () => {
  const rules = [option('a', 0.9), option('b', 0.6), option('c', null)];

  it("puts the model's best question first, with both numbers in its reasons", () => {
    const sorted = orderByScores(rules, { a: 0.2, b: 0.7, c: 0.5 }, 'Gemma');
    expect(sorted.map(item => item.id)).toEqual(['b', 'c', 'a']);
    expect(sorted[0].probability).toBe(0.7);
    expect(sorted[0].reasons).toEqual([
      'rule for b',
      'Gemma gives 70%; the rules gave 60%'
    ]);
    // A question that the rules did not score.
    expect(sorted[1].reasons[1]).toBe('Gemma gives 50%');
  });

  it("keeps the rules' order for ties, and for the questions the model left out", () => {
    const sorted = orderByScores(
      [...rules, option('d', 0.1)],
      { c: 0.4, d: 0.4 },
      'Jev'
    );
    expect(sorted.map(item => item.id)).toEqual(['c', 'd', 'a', 'b']);
    expect(sorted[2]).toBe(rules[0]);
  });

  it('leaves the list as it is with no scores', () => {
    expect(orderByScores(rules, {}, 'Gemma')).toEqual(rules);
  });
});

describe('runnableFirst', () => {
  // A question with code runs without a model; one without needs AI.
  const ai = (id: string) => option(id, 0.9);
  const runs = (id: string) => ({ ...option(id, 0.5), code: 'x' });
  const list = [ai('a'), ai('b'), runs('c'), ai('d'), runs('e')];

  it('puts the questions that run first when no model answers, each group in its order', () => {
    expect(runnableFirst(list, true).map(item => item.id)).toEqual([
      'c',
      'e',
      'a',
      'b',
      'd'
    ]);
  });

  it('leaves the order to the ranking when a model answers', () => {
    expect(runnableFirst(list, false)).toBe(list);
  });
});
