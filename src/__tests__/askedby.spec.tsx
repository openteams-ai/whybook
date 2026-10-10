/**
 * Who asked a question, from JupyterLab's user. A question that the analyst
 * asks records the username and the display name of the page's user beside
 * `asked_by`, and the guess records the same, when the server gives a real
 * identity, such as JupyterHub's user. jupyter_server gives a login by token
 * or password an anonymous user, with a random username, and such a user
 * records no one. Cell details reads "You asked it." when the notebook
 * records the user of the page, the person's name when it records another
 * person, and "A person asked it." when it records no one: an anonymous
 * user, an older notebook, the demos. The guess before the result follows
 * the same rule.
 */
import './fakes/quiet';

import { RenderMimeRegistry } from '@jupyterlab/rendermime';
import type { User } from '@jupyterlab/services';
import { ServerConnection } from '@jupyterlab/services';
import { Signal } from '@lumino/signaling';
import * as React from 'react';

import { EpiSettings } from '../model/epimodel';
import type { IOption } from '../tokens';
import { CellDetails } from '../ui/details';
import { EpiContent } from '../widgets';
import type { IBenchCell } from './fakes/bench-fake';
import { benchModel } from './fakes/bench-fake';
import { mount, settle } from './fakes/bench-render';

/** A user of a server with its own login, whose display name is not the name. */
const LOVELACE = {
  username: 'alovelace',
  name: 'Ada Lovelace',
  display_name: 'Ada',
  initials: 'AL',
  color: 'var(--jp-collaborator-color1)'
};

/** A user of JupyterHub: the hub's name is the username, the name and the display name. */
const HUB = {
  username: 'ghopper',
  name: 'ghopper',
  display_name: 'ghopper',
  initials: 'G',
  color: 'var(--jp-collaborator-color2)'
};

/**
 * The user that jupyter_server 2.21.1 gives a login by token or password
 * (`generate_anonymous_user`): a username of `uuid.uuid4().hex` and the name
 * of a moon of Jupiter.
 */
const ANONYMOUS = {
  username: 'ff6b535cf0144b9eb42c0c09743ad59f',
  name: 'Anonymous Callirrhoe',
  display_name: 'Anonymous Callirrhoe',
  initials: 'AC',
  color: 'var(--jp-collaborator-color3)'
};

/** The same anonymous user, renamed through /api/me: the username stays. */
const RENAMED = { ...ANONYMOUS, name: 'Grace', display_name: 'Grace' };

/** The user of the login handlers of before jupyter_server 2.0, on a server without a login. */
const LEGACY = {
  username: 'anonymous',
  name: 'anonymous',
  display_name: 'anonymous',
  initials: 'A',
  color: 'var(--jp-collaborator-color4)'
};

/** JupyterLab's user, as `app.serviceManager.user` holds it after /api/me. */
function pageUser(identity: Record<string, unknown> | null): {
  user: User.IManager;
  become: (next: Record<string, unknown> | null) => void;
} {
  const changed = new Signal<unknown, unknown>({});
  const fake = { identity, userChanged: changed };
  return {
    user: fake as unknown as User.IManager,
    // The poll of /api/me brought another identity.
    become: next => {
      fake.identity = next;
      changed.emit({ identity: next, permissions: {} });
    }
  };
}

const CELLS: IBenchCell[] = [
  {
    id: 'a',
    source: 'import pandas as pd\ndiary = pd.read_csv("diary.csv")',
    count: 1
  },
  { id: 'b', source: 'whybook.hist(diary, "pain_score")', count: 2 }
];

/** "Does pain_score differ between the arms?", asked about [2]: a template's new cell. */
const DIFFER: IOption = {
  id: 'q:differ',
  text: 'Does pain_score differ between the arms?',
  type: 'association',
  origin: 'template',
  probability: null,
  reasons: [],
  placement: { kind: 'new', cell: 'b', label: 'new cell after [2]' },
  code: 'whybook.compare_levels(diary, "pain_score", "arm")'
};

/** A template that edits [2] in place. */
const EDIT: IOption = {
  ...DIFFER,
  id: 'q:bins',
  text: 'Use 40 bins',
  placement: { kind: 'edit', cell: 'b', label: 'edit [2] in place' },
  code: 'whybook.hist(diary, "pain_score", bins=40)'
};

/** A view model of these cells, for a page of this user, whose runs end at once. */
function asking(user: User.IManager | undefined, cells = CELLS) {
  const bench = benchModel(cells, { user });
  const model = bench.model as any;
  model.jobs.run = async () => ({ ok: true, error: null });
  model._listed = async () => undefined;
  model.refresh = async () => undefined;
  return { nb: bench.nb, model };
}

/** The `whybook` metadata of a cell. */
function metaOf(model: any, cellId: string): Record<string, any> {
  return model.cell(cellId).model.getMetadata('whybook');
}

/**
 * An agent's run for a question about [2], with a stream that the test
 * feeds, as in runhistory.spec.tsx: one cell, then the answer. The id of the
 * cell that the run added.
 */
async function agentAnswer(model: any): Promise<string> {
  const text = 'Is pain lower in the treated arm?';
  const stream: {
    deliver: (event: Record<string, unknown>) => void;
    finish: () => void;
  } = { deliver: () => undefined, finish: () => undefined };
  const posted: unknown[] = [];
  model.aiReady = () => true;
  model._run = async (cell: { executionCount: number | null }) => {
    cell.executionCount = 3;
    return { ok: true, error: null };
  };
  model.api = {
    agent: (
      _body: unknown,
      onEvent: (event: Record<string, unknown>) => void,
      signal: AbortSignal
    ) => {
      stream.deliver = onEvent;
      return new Promise<void>((resolve, reject) => {
        stream.finish = resolve;
        signal.addEventListener('abort', () =>
          reject(new DOMException('The request was aborted', 'AbortError'))
        );
      });
    },
    agentResult: async (body: unknown) => {
      posted.push(body);
    },
    agentStop: jest.fn(async () => undefined)
  };
  const placement = { kind: 'new', cell: 'b', label: 'new cell after [2]' };
  const strip = {
    cellId: 'b',
    question: { id: 'q:lower', text, type: 'causal' },
    guess: null,
    text,
    action: 'New cell after [2]',
    placement,
    status: 'writing',
    stage: null,
    elapsed: null,
    started: Date.now(),
    thinking: null,
    before: null,
    after: null,
    insertedId: null,
    error: null,
    showDiff: false
  };
  model.strips.set('b', strip);
  const ending = model._agent(
    {
      id: 'q:lower',
      text,
      type: 'causal',
      origin: 'user',
      probability: null,
      reasons: [],
      placement: null,
      code: null
    },
    placement,
    model.cell('b'),
    strip,
    null,
    async () => undefined
  );
  await settle();
  stream.deliver({ type: 'started', run: 'r1', keep_local: false });
  await settle();
  stream.deliver({
    type: 'tool',
    run: 'r1',
    call: 'c1',
    name: 'run_cell',
    input: {
      code: 'diary.groupby("arm").pain_score.mean()',
      title: 'Mean pain by arm',
      why: 'compare the arms'
    }
  });
  for (let i = 0; i < 50 && !posted.length; i++) {
    await settle(10);
  }
  stream.deliver({
    type: 'result',
    answer: 'Yes: pain is lower in the treated arm [3].',
    cells: ['[3]'],
    follow_up: [],
    model: 'claude-opus-5-5',
    provider: 'anthropic',
    cost_usd: 0.05,
    elapsed: 12
  });
  await settle();
  stream.finish();
  await ending;
  await settle();
  return (strip as any).agent.steps[0].cells[0];
}

/** The line under the question in Cell details, with the guess after it. */
function questionCaption(host: Element): string | null {
  const section = Array.from(
    host.querySelectorAll('.jp-Epi-details-section')
  ).find(
    item =>
      item.querySelector('.jp-Epi-details-toggle')?.textContent === 'Question'
  );
  const caption = section?.querySelector(
    '.jp-Epi-details-body > .jp-Epi-caption'
  );
  return caption?.textContent?.trim() ?? null;
}

/** What Cell details reads under the question of each cell. */
async function captions(model: any, cellIds: string[]): Promise<string[]> {
  const details = await mount(
    <CellDetails model={model} width={260} editorServices={null} />
  );
  const lines: string[] = [];
  try {
    for (const id of cellIds) {
      model.setCurrentCell(id);
      await settle();
      lines.push(questionCaption(details.host) ?? '(no line)');
    }
  } finally {
    await details.unmount();
  }
  return lines;
}

const QUESTION = {
  id: 'q:arm',
  text: 'Does arm change the trajectory of pain?',
  type: 'causal'
};

/** The metadata of a cell that answers QUESTION, from a template. */
function answered(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    title: 'Mixed model: does arm change the trajectory of pain',
    question: QUESTION,
    asked_by: 'user',
    written_by: 'agent',
    template: true,
    ...extra
  };
}

const ADA = { username: 'alovelace', name: 'Ada' };
const GRACE = { username: 'ghopper', name: 'Grace Hopper' };
const guess = (person?: Record<string, string>) => ({
  question: QUESTION.id,
  value: 'higher',
  at: '2026-10-10T12:00:00.000Z',
  ...(person ? { person } : {})
});

describe('who asked a question', () => {
  it('records the username and the display name of a real user, with the question and with the guess', async () => {
    for (const [identity, person] of [
      [LOVELACE, ADA],
      [HUB, { username: 'ghopper', name: 'ghopper' }]
    ] as const) {
      const { model } = asking(pageUser(identity).user);
      await model.apply(DIFFER);
      const strip = model.strips.get('b');
      model.setGuess('b', 'higher');
      const meta = metaOf(model, strip.insertedId);
      expect(meta.asked_by).toBe('user');
      expect(meta.asked_by_person).toEqual(person);
      expect(meta.guess).toMatchObject({ value: 'higher', person });
      model.dispose();
    }
  });

  it("records the person with the cells of an agent's run, and no one for an anonymous user", async () => {
    for (const [identity, person] of [
      [LOVELACE, ADA],
      [ANONYMOUS, undefined]
    ] as const) {
      const { model } = asking(pageUser(identity).user);
      const added = await agentAnswer(model);
      const meta = metaOf(model, added);
      expect(meta.agent).toMatchObject({ run: 'r1', step: 1 });
      expect(meta.asked_by).toBe('user');
      expect(meta.asked_by_person).toEqual(person);
      model.dispose();
    }
  });

  it('keeps the person with the guess of an answer that edits a cell in place', async () => {
    // [2] answered another person's question before.
    const cells = [
      CELLS[0],
      { ...CELLS[1], meta: answered({ asked_by_person: GRACE }) }
    ];
    const { model } = asking(pageUser(LOVELACE).user, cells);
    await model.apply(EDIT);
    model.setGuess('b', 'lower');
    const meta = metaOf(model, 'b');
    // The cell keeps its question, and who asked it.
    expect(meta.asked_by_person).toEqual(GRACE);
    expect(meta.guess).toMatchObject({ value: 'lower', person: ADA });
    expect(await captions(model, ['b'])).toEqual([
      'Grace Hopper asked it. Your guess before the result: expected lower'
    ]);
    model.dispose();
  });

  it('records no one for an anonymous user, or a page without a user, and Cell details reads "A person asked it."', async () => {
    for (const identity of [ANONYMOUS, RENAMED, LEGACY, null]) {
      const { model } = asking(pageUser(identity).user);
      await model.apply(DIFFER);
      const added = model.strips.get('b').insertedId;
      model.setGuess('b', 'higher');
      const meta = metaOf(model, added);
      expect(meta.asked_by).toBe('user');
      expect(meta).not.toHaveProperty('asked_by_person');
      expect(meta.guess).not.toHaveProperty('person');
      expect(await captions(model, [added])).toEqual([
        'A person asked it. Their guess before the result: expected higher'
      ]);
      model.dispose();
    }
  });
});

describe('the line of Cell details under a question', () => {
  const CELLS_ASKED: IBenchCell[] = [
    { id: 'mine', meta: answered({ asked_by_person: ADA }), count: 1 },
    { id: 'grace', meta: answered({ asked_by_person: GRACE }), count: 2 },
    // The demos, and the notebooks of older versions.
    { id: 'demo', meta: answered({}), count: 3 },
    { id: 'agent', meta: answered({ asked_by: 'agent' }), count: 4 }
  ];
  const IDS = ['mine', 'grace', 'demo', 'agent'];

  it('reads "You" for the user of the page, the name of another person, and "A person" when the notebook records no one', async () => {
    const { model } = asking(pageUser(LOVELACE).user, CELLS_ASKED);
    expect(await captions(model, IDS)).toEqual([
      'You asked it.',
      'Grace Hopper asked it.',
      'A person asked it.',
      'An AI model asked it.'
    ]);
    model.dispose();
  });

  it("names the person who asked for an anonymous user of the page, and for a page without JupyterLab's user", async () => {
    for (const user of [pageUser(ANONYMOUS).user, undefined]) {
      const { model } = asking(user, CELLS_ASKED);
      expect(await captions(model, IDS)).toEqual([
        'Ada asked it.',
        'Grace Hopper asked it.',
        'A person asked it.',
        'An AI model asked it.'
      ]);
      model.dispose();
    }
  });

  it('reads "You" once the server gives the identity of the page\'s user', async () => {
    const page = pageUser(null);
    const { model } = asking(page.user, CELLS_ASKED);
    const details = await mount(
      <CellDetails model={model} width={260} editorServices={null} />
    );
    try {
      model.setCurrentCell('mine');
      await settle();
      expect(questionCaption(details.host)).toBe('Ada asked it.');
      page.become(LOVELACE);
      await settle();
      expect(questionCaption(details.host)).toBe('You asked it.');
    } finally {
      await details.unmount();
      model.dispose();
    }
  });
});

describe('the guess before the result, in Cell details', () => {
  it('is the guess of the person who guessed, by the same rule', async () => {
    const cells: IBenchCell[] = [
      {
        id: 'mine',
        meta: answered({ asked_by_person: ADA, guess: guess(ADA) }),
        count: 1
      },
      {
        id: 'grace',
        meta: answered({ asked_by_person: GRACE, guess: guess(GRACE) }),
        count: 2
      },
      { id: 'demo', meta: answered({ guess: guess() }), count: 3 },
      // Answers that edited a cell in place: the cell keeps its question,
      // or has none, and the guess is about the question of the edit.
      {
        id: 'edited',
        meta: answered({ asked_by_person: GRACE, guess: guess(ADA) }),
        count: 4
      },
      { id: 'mine-edit', meta: { guess: guess(ADA) }, count: 5 },
      { id: 'grace-edit', meta: { guess: guess(GRACE) }, count: 6 },
      { id: 'old-edit', meta: { guess: guess() }, count: 7 }
    ];
    const { model } = asking(pageUser(LOVELACE).user, cells);
    expect(
      await captions(
        model,
        cells.map(cell => cell.id)
      )
    ).toEqual([
      'You asked it. Your guess before the result: expected higher',
      'Grace Hopper asked it. Their guess before the result: expected higher',
      'A person asked it. Their guess before the result: expected higher',
      'Grace Hopper asked it. Your guess before the result: expected higher',
      'Your guess before the result: expected higher',
      "Grace Hopper's guess before the result: expected higher",
      "A person's guess before the result: expected higher"
    ]);
    model.dispose();
  });
});

describe("JupyterLab's user", () => {
  // Whybook's widget factory makes this widget for each notebook, in
  // JupyterLab and on a page of Notebook 7, with the user of src/index.ts.
  it("reaches the model of a notebook's widget", async () => {
    // jest cannot load the manager of ipywidgets, and the widget says so.
    const info = jest
      .spyOn(console, 'info')
      .mockImplementation(() => undefined);
    const bench = benchModel(CELLS);
    bench.model.dispose();
    const context = bench.context;
    const page = pageUser(null);
    const content = new EpiContent({
      context: { ...context, urlResolver: undefined } as any,
      rendermime: new RenderMimeRegistry(),
      serverSettings: ServerConnection.makeSettings({
        baseUrl: 'http://localhost:1/',
        fetch: () => Promise.reject(new Error('no server in the tests'))
      }),
      settings: new EpiSettings(),
      editorServices: null,
      openFile: () => undefined,
      user: page.user
    });
    try {
      // The page's user is not known before /api/me answers.
      expect(content.model.person).toBeNull();
      page.become(LOVELACE);
      expect(content.model.person).toEqual(ADA);
      await settle();
    } finally {
      content.dispose();
      info.mockRestore();
    }
  });
});
