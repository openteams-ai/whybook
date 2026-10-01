import { countAsked } from '../model/asked';
import type { IAskedQuestion } from '../tokens';

const question = (id: string): IAskedQuestion => ({
  id,
  text: `Question ${id}`,
  type: 'association'
});

describe('countAsked', () => {
  it('counts a question once its cell ran without an error', () => {
    const { asked, failed } = countAsked(
      [question('a'), question('b'), question('c')],
      [
        { question: question('a'), ran: true, failed: false },
        { question: question('b'), ran: true, failed: true },
        // Still written or run: no count yet.
        { question: question('c'), ran: false, failed: false }
      ]
    );
    expect(asked.map(q => q.id)).toEqual(['a']);
    expect(failed.map(q => q.id)).toEqual(['b']);
  });

  it('keeps a question whose answer the AI could not write out, and counts an answer without a cell of its own', () => {
    const { asked, failed } = countAsked(
      [
        // "Claude Code not found": no cell was added.
        { ...question('failed'), outcome: 'failed' },
        // An edit in place, or a preview: the log says that it ran.
        { ...question('edit'), outcome: 'ran' },
        // An edge of the causal diagram: no cell ran for it.
        question('edge')
      ],
      []
    );
    expect(asked.map(q => q.id)).toEqual(['edit']);
    expect(failed.map(q => q.id)).toEqual(['failed']);
  });

  it('counts a failed answer whose cell ran again without an error', () => {
    const { asked, failed } = countAsked(
      [{ ...question('a'), outcome: 'failed' }],
      [{ question: question('a'), ran: true, failed: false }]
    );
    expect(asked.map(q => q.id)).toEqual(['a']);
    expect(failed).toEqual([]);
  });

  it("counts the questions of a notebook's cells that the log does not keep, as the demos have", () => {
    const { asked } = countAsked(
      [],
      [{ question: question('demo'), ran: true, failed: false }]
    );
    expect(asked.map(q => q.id)).toEqual(['demo']);
  });
});
