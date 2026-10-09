/**
 * The review guard in the view (src/model/guard.ts): its settings, the
 * object each request carries, the marks of its dialog, and what the API
 * client does with the server's questions and notices.
 */
import type { ServerConnection } from '@jupyterlab/services';

import { Api } from '../model/api';
import type { IGuardEvent, IGuardFlag, IGuardHeld } from '../model/guard';
import {
  DEFAULT_GUARD,
  flaggedLines,
  flagsByRule,
  guardBody,
  heldWords,
  levelWords,
  markedParts,
  marksByRule,
  readGuard
} from '../model/guard';
import { readSettings } from '../model/settings';
import { requestAPI, streamAPI } from '../request';
import type { StreamEvent } from '../tokens';
import { composed } from './fakes/settings-fake';

jest.mock('../request', () => ({
  requestAPI: jest.fn(),
  streamAPI: jest.fn()
}));

const stream = streamAPI as jest.Mock;
const request = requestAPI as jest.Mock;
const server = {} as ServerConnection.ISettings;

const ID: IGuardFlag = {
  kind: 'identifier',
  text: 'P042',
  rule: 'an identifier next to age',
  level: 'reject',
  by: 'rules'
};
const AGE: IGuardFlag = { ...ID, kind: 'age', text: 'age 41' };

describe('the settings of the review guard', () => {
  it('asks, with both guards and the rules alone, when nothing is saved', () => {
    const { composite, user } = composed('{}');
    expect(readSettings(composite, user).guard).toEqual(DEFAULT_GUARD);
    expect(DEFAULT_GUARD).toEqual({
      mode: 'ask',
      privacy: true,
      privacyModel: '',
      execution: true,
      executionModel: '',
      remoteReview: false,
      policy: ''
    });
  });

  it('reads what the analyst saved, and an unknown mode as ask', () => {
    const { composite, user } = composed(
      JSON.stringify({
        reviewGuard: 'reject',
        guardPrivacy: false,
        guardExecutionModel: 'dynaguard-4b',
        guardRemoteReview: true,
        privacyPolicy: '- Reject: any postcode'
      })
    );
    expect(readSettings(composite, user).guard).toEqual({
      ...DEFAULT_GUARD,
      mode: 'reject',
      privacy: false,
      executionModel: 'dynaguard-4b',
      remoteReview: true,
      policy: '- Reject: any postcode'
    });
    expect(readGuard({ reviewGuard: 'yolo' }).mode).toBe('ask');
  });
});

describe('guardBody', () => {
  it('sends what the view chose and what the notebook tells, with null for the defaults', () => {
    const body = guardBody(DEFAULT_GUARD, {
      session: 'view-1',
      sandboxed: true,
      folder: 'studies/pain',
      language: 'python',
      synthetic: false,
      unit: 'patient_id',
      columns: [{ name: 'stage', levels: ['I', 'IV'] }]
    });
    expect(body).toEqual({
      mode: 'ask',
      privacy: true,
      privacy_model: null,
      execution: true,
      execution_model: null,
      remote_review: false,
      policy: null,
      sandboxed: true,
      folder: 'studies/pain',
      language: 'python',
      session: 'view-1',
      dataset: {
        synthetic: false,
        unit: 'patient_id',
        columns: [{ name: 'stage', levels: ['I', 'IV'] }]
      }
    });
  });
});

describe('the marks of the dialog', () => {
  it('marks every place of each flagged part, the longest first, and leaves a flag without text out', () => {
    const parts = markedParts('P042, age 41; P042 again', [
      { ...ID, text: '42' },
      ID,
      AGE,
      { ...ID, text: '', by: 'DynaGuard 4B' }
    ]);
    expect(parts.map(part => [part.text, part.flag?.kind ?? null])).toEqual([
      ['P042', 'identifier'],
      [', ', null],
      ['age 41', 'age'],
      ['; ', null],
      ['P042', 'identifier'],
      [' again', null]
    ]);
  });

  it('lists each rule once, the strictest first, with its parts and its guards', () => {
    const ask: IGuardFlag = {
      kind: 'identifier',
      text: 'P187',
      rule: 'an identifier of a person or a household',
      level: 'ask',
      by: 'rules'
    };
    const model: IGuardFlag = { ...ID, text: '', by: 'DynaGuard 4B' };
    expect(flagsByRule([ask, ID, AGE, model])).toEqual([
      {
        rule: 'an identifier next to age',
        level: 'reject',
        parts: ['P042', 'age 41'],
        by: ['rules', 'DynaGuard 4B']
      },
      {
        rule: 'an identifier of a person or a household',
        level: 'ask',
        parts: ['P187'],
        by: ['rules']
      }
    ]);
  });

  it('words each level as what it means for sending the text or running the code', () => {
    expect([
      levelWords('privacy', 'reject'),
      levelWords('privacy', 'ask'),
      levelWords('execution', 'reject'),
      levelWords('execution', 'ask')
    ]).toEqual([
      'Should not leave this machine:',
      'Might be fine to send:',
      'Should not run:',
      'Might be fine to run:'
    ]);
  });

  it('counts the lines that hold a flagged part, and the places that each rule marks', () => {
    const ask: IGuardFlag = {
      kind: 'identifier',
      text: 'P187',
      rule: 'an identifier of a person or a household',
      level: 'ask',
      by: 'rules'
    };
    const text = 'P042, age 41\nno one\nP187 and P187\nP042 again';
    expect(flaggedLines(text, [ID, AGE, ask])).toEqual([0, 2, 3]);
    // A flag of the whole text marks no line.
    expect(flaggedLines(text, [{ ...ID, text: '' }])).toEqual([]);
    expect(marksByRule(text, [ID, AGE, ask])).toEqual(
      new Map([
        ['an identifier next to age', 3],
        ['an identifier of a person or a household', 2]
      ])
    );
  });

  it('lists a part once when another part of its rule holds it', () => {
    const call: IGuardFlag = {
      kind: 'network',
      text: 'pd.read_csv("https://example.org/a.csv")',
      rule: 'reaches the network',
      level: 'reject',
      by: 'rules'
    };
    const address: IGuardFlag = {
      ...call,
      text: '"https://example.org/a.csv"'
    };
    expect(flagsByRule([call, address])[0].parts).toEqual([call.text]);
  });

  it('says what the guard held back, masked or not', () => {
    const held: IGuardHeld = {
      type: 'guard_held',
      guard: 'privacy',
      what: 'the result of [20]',
      flags: [ID],
      reason: 'an identifier next to age',
      masked: true,
      to: 'OpenRouter: x'
    };
    expect(heldWords(held)).toBe(
      'The review guard masked parts of the result of [20] before it went to OpenRouter: x: an identifier next to age.'
    );
    expect(heldWords({ ...held, masked: false, what: 'a prompt' })).toBe(
      'The review guard held back a prompt: an identifier next to age.'
    );
    expect(
      heldWords({
        ...held,
        guard: 'execution',
        what: 'a cell',
        reason: 'reaches the network'
      })
    ).toBe('The review guard did not run a cell: it reaches the network.');
  });
});

describe('Api, with the review guard', () => {
  const QUESTION: IGuardEvent = {
    type: 'guard',
    id: 'q1',
    guard: 'privacy',
    what: 'a prompt',
    decision: 'ask',
    flags: [ID],
    reason: 'an identifier',
    text: 'P042',
    masked: '[identifier]',
    sandboxed: false,
    choices: ['send', 'mask', 'stop'],
    to: 'OpenRouter: x'
  };

  beforeEach(() => {
    stream.mockReset();
    request.mockReset();
    request.mockResolvedValue({ ok: true });
  });

  it('carries the guard in every request that can reach a model', async () => {
    stream.mockResolvedValue(undefined);
    const api = new Api(server, { guard: () => ({ mode: 'reject' }) });
    await api.solve({ question: { text: 'q' } }, () => {});
    await api.agent({ question: { text: 'q' } }, () => {});
    await api.claudeQuestions({ model: 'remote' }, () => {});
    // More questions come in the background, beside the templates' questions.
    expect(stream.mock.calls.map(call => call[2].guard)).toEqual([
      { mode: 'reject' },
      { mode: 'reject' },
      { mode: 'reject', background: true }
    ]);
    // A request that nobody waits on says so: the guard holds it back without a question.
    await api.describeTables({ tables: [] }, () => {});
    await api.titleCells({ cells: [] }, () => {});
    expect(stream.mock.calls.slice(3).map(call => call[2].guard)).toEqual([
      { mode: 'reject', background: true },
      { mode: 'reject', background: true }
    ]);
    // A request that reaches no model goes without it.
    await api.agentStop('r1');
    expect(JSON.parse(request.mock.calls[0][2].body)).toEqual({ run: 'r1' });
  });

  it('asks the analyst a question of the guard, posts the answer, and passes neither the question nor a ping on', async () => {
    const events: StreamEvent[] = [];
    let asked: IGuardEvent | null = null;
    stream.mockImplementation(async (_endpoint, _server, _body, onEvent) => {
      onEvent({ type: 'ping' });
      onEvent(QUESTION as unknown as StreamEvent);
      onEvent({ type: 'result', cell: { code: 'x' } });
    });
    const api = new Api(server, {
      onGuard: async event => {
        asked = event;
        return { answer: 'mask', note: 'outliers' };
      }
    });
    await api.solve({ question: { text: 'q' } }, event => events.push(event));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(asked).toEqual(QUESTION);
    expect(events.map(event => event.type)).toEqual(['result']);
    expect(request).toHaveBeenCalledWith('guard/answer', server, {
      method: 'POST',
      body: JSON.stringify({ id: 'q1', answer: 'mask', note: 'outliers' })
    });
  });

  it('answers stop when no dialog can ask', async () => {
    stream.mockImplementation(async (_endpoint, _server, _body, onEvent) => {
      onEvent(QUESTION as unknown as StreamEvent);
    });
    await new Api(server).solve({}, () => {});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(JSON.parse(request.mock.calls[0][2].body).answer).toBe('stop');
  });

  it("tells what the guard held back, and passes it on to an agent's run alone", async () => {
    const held: IGuardHeld[] = [];
    const notice = {
      type: 'guard_held',
      guard: 'execution',
      what: 'a cell',
      flags: [],
      reason: 'reaches the network',
      masked: false
    };
    stream.mockImplementation(async (_endpoint, _server, _body, onEvent) => {
      onEvent(notice);
      onEvent({ type: 'ping' });
    });
    const api = new Api(server, { onGuardHeld: event => held.push(event) });
    const agentEvents: StreamEvent[] = [];
    const solveEvents: StreamEvent[] = [];
    await api.agent({}, event => agentEvents.push(event));
    await api.solve({}, event => solveEvents.push(event));
    expect(held).toHaveLength(2);
    expect(agentEvents.map(event => event.type)).toEqual([
      'guard_held',
      'ping'
    ]);
    expect(solveEvents).toEqual([]);
  });
});
