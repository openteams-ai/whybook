/**
 * The setting rankingPrompt: what a remote model is asked when it orders the
 * offered questions (research/ranking-placement.md, "The prompt: what the
 * analyst asks next, or should ask").
 */
// The fake first: it quiets the warnings of JupyterLab's modules in jest.
import { fakeModel } from './fakes/model-fake';

import { readSettings } from '../model/settings';
import type { IOption, StreamEvent } from '../tokens';
import { composed } from './fakes/settings-fake';

function option(id: string): IOption {
  return {
    id,
    text: `Question ${id}`,
    type: 'descriptive',
    origin: 'template',
    probability: 0.5,
    reasons: [],
    placement: null
  };
}

/** A view whose questions a remote model orders, and the bodies of its requests. */
function orderingModel(prompt?: 'next' | 'should') {
  const { model } = fakeModel([{ id: 'c1', source: 'x = 1' }]);
  model.settings.models = { ...model.settings.models, ranking: 'remote' };
  if (prompt) {
    model.settings.rankingPrompt = prompt;
  }
  model.aiReady = () => true;
  model.serverContext = () => ({ mode: 'wonder' });
  model._pointed = new WeakSet();
  model._emit = () => undefined;
  const bodies: any[] = [];
  model.api = {
    rankQuestions: async (
      body: unknown,
      onEvent: (event: StreamEvent) => void
    ) => {
      bodies.push(body);
      onEvent({
        type: 'result',
        scores: { b: 0.9, a: 0.1 },
        model: 'fake',
        elapsed: 0.1
      });
    }
  };
  return { model, bodies };
}

async function order(model: any): Promise<IOption[]> {
  const list: any = { order: null };
  let shown: IOption[] = [];
  const options = [option('a'), option('b')];
  await model._orderByModel(
    list,
    () => options,
    (sorted: IOption[]) => {
      shown = sorted;
    },
    null
  );
  return shown;
}

describe('rankingPrompt', () => {
  it('reads as what the analyst asks next, unless the analyst chose what they should ask', () => {
    const read = (raw: string) => {
      const { composite, user } = composed(raw);
      return readSettings(composite, user).rankingPrompt;
    };
    expect(read('{}')).toBe('next');
    expect(read('{"rankingPrompt": "should"}')).toBe('should');
    expect(read('{"rankingPrompt": "next"}')).toBe('next');
  });

  it('sends no prompt by default, so the server asks what the analyst asks next', async () => {
    const { model, bodies } = orderingModel();
    expect((await order(model)).map(item => item.id)).toEqual(['b', 'a']);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].prompt).toBeUndefined();
    expect(bodies[0].model).toBe('remote');
  });

  it('asks what the analyst should ask when the setting says so', async () => {
    const { model, bodies } = orderingModel('should');
    expect((await order(model)).map(item => item.id)).toEqual(['b', 'a']);
    expect(bodies[0].prompt).toBe('should');
  });
});
