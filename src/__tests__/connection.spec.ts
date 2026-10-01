import {
  filterExample,
  filterModels,
  messageOf,
  OPENROUTER_POLL,
  SignIns
} from '../model/connection';
import { choicesFor, modelAvailable, remoteLabel } from '../model/models';
import type { IConnectionState, IServerStatus } from '../model/api';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const flush = async () => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
};

function state(signedIn: boolean): IConnectionState {
  return {
    connection: {
      provider: 'claude-code',
      model: null,
      base_url: null,
      local: false
    },
    readiness: {
      available: true,
      cli: 'claude',
      credential: 'x',
      reason: null,
      setup: null
    },
    providers: [
      {
        id: 'openrouter',
        label: 'OpenRouter',
        local: false,
        base_url: 'https://openrouter.ai/api/v1',
        signin: 'openrouter',
        needs_key: true,
        dev_only: false,
        signed_in: signedIn,
        key_from: signedIn ? 'openrouter' : null,
        saved: null,
        installed: true
      }
    ],
    huggingface_signin: true,
    models_installed: true
  };
}

describe('SignIns', () => {
  it('polls Hugging Face at its interval until the code is approved', async () => {
    const polls: string[] = [];
    const answers: any[] = [
      { status: 'pending', interval: 5 },
      { status: 'pending', interval: 10 },
      { status: 'done' }
    ];
    const done: string[] = [];
    const signIns = new SignIns(
      {
        huggingFaceSignIn: async () => ({
          flow: 'f1',
          user_code: 'WDJB-MJHT',
          verification_uri: 'https://huggingface.co/oauth/device',
          verification_uri_complete:
            'https://huggingface.co/oauth/device?user_code=WDJB-MJHT',
          expires_in: 900,
          interval: 5
        }),
        huggingFacePoll: async (flow: string) => {
          polls.push(flow);
          return answers.shift();
        }
      } as any,
      provider => done.push(provider)
    );
    await signIns.startHuggingFace();
    expect(signIns.huggingFace?.user_code).toBe('WDJB-MJHT');
    jest.advanceTimersByTime(4999);
    expect(polls).toEqual([]);
    jest.advanceTimersByTime(1);
    await flush();
    jest.advanceTimersByTime(5000);
    await flush();
    // Hugging Face asked to slow down: the next poll waits 10 seconds.
    jest.advanceTimersByTime(9999);
    await flush();
    expect(polls).toHaveLength(2);
    jest.advanceTimersByTime(1);
    await flush();
    expect(polls).toEqual(['f1', 'f1', 'f1']);
    expect(done).toEqual(['huggingface']);
    expect(signIns.huggingFace).toBeNull();
    expect(signIns.signedIn).toBe('huggingface');
  });

  it('says why when the code expires, and keeps no flow', async () => {
    const signIns = new SignIns(
      {
        huggingFaceSignIn: async () => ({
          flow: 'f2',
          user_code: 'ABCD',
          verification_uri: 'https://huggingface.co/oauth/device',
          verification_uri_complete: null,
          expires_in: 900,
          interval: 5
        }),
        huggingFacePoll: async () => ({ status: 'expired' })
      } as any,
      () => undefined
    );
    await signIns.startHuggingFace();
    jest.advanceTimersByTime(5000);
    await flush();
    expect(signIns.huggingFace).toBeNull();
    expect(signIns.error).toBe(
      'The code expired before it was approved: sign in again.'
    );
  });

  it('opens openrouter.ai before the server answers, and waits for the key', async () => {
    const tab = { opener: {} as any, location: { href: '' }, close: jest.fn() };
    let signedIn = false;
    const done: string[] = [];
    const signIns = new SignIns(
      {
        openRouterSignIn: async () => ({
          state: 's1',
          url: 'https://openrouter.ai/auth?code_challenge=c',
          mode: 'callback'
        }),
        connection: async () => state(signedIn)
      } as any,
      provider => done.push(provider)
    );
    const opened = jest.fn(() => tab as unknown as Window);
    await signIns.startOpenRouter(opened);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(tab.location.href).toBe(
      'https://openrouter.ai/auth?code_challenge=c'
    );
    expect(tab.opener).toBeNull();
    jest.advanceTimersByTime(OPENROUTER_POLL);
    await flush();
    expect(done).toEqual([]);
    signedIn = true;
    jest.advanceTimersByTime(OPENROUTER_POLL);
    await flush();
    expect(done).toEqual(['openrouter']);
    expect(signIns.openRouter).toBeNull();
  });

  it('takes a pasted code where OpenRouter cannot come back, and closes the tab when the server fails', async () => {
    const codes: string[][] = [];
    const done: string[] = [];
    const signIns = new SignIns(
      {
        openRouterSignIn: async () => ({
          state: 's2',
          url: 'https://openrouter.ai/auth',
          mode: 'code'
        }),
        openRouterCode: async (s: string, code: string) => {
          codes.push([s, code]);
          return state(true);
        }
      } as any,
      provider => done.push(provider)
    );
    await signIns.startOpenRouter(() => null);
    expect(signIns.openRouter).toEqual({ state: 's2', mode: 'code' });
    await signIns.pasteOpenRouterCode('the-code');
    expect(codes).toEqual([['s2', 'the-code']]);
    expect(done).toEqual(['openrouter']);

    const tab = { close: jest.fn() };
    const failing = new SignIns(
      {
        openRouterSignIn: async () => {
          throw new Error('Error: the server is down');
        }
      } as any,
      () => undefined
    );
    await failing.startOpenRouter(() => tab as unknown as Window);
    expect(tab.close).toHaveBeenCalled();
    expect(failing.error).toBe('the server is down');
  });
});

describe('the connected model in the choices', () => {
  const status = (
    claude: Partial<NonNullable<IServerStatus['claude']>>,
    extra: Partial<IServerStatus> = {}
  ): IServerStatus => ({
    ranker: 'heuristic',
    jev_configured: false,
    claude_available: true,
    claude: {
      available: true,
      cli: null,
      credential: 'x',
      reason: null,
      setup: null,
      ...claude
    },
    ...extra
  });

  it('names a model on this machine as such, and lets it read the tables that stay here', () => {
    const local = status(
      { provider: 'ollama', label: 'Ollama: qwen3:8b', local: true },
      {
        remote_model: 'Ollama: qwen3:8b',
        keep_data_local: true,
        describe_tables: false
      }
    );
    expect(remoteLabel(local)).toBe('Ollama: qwen3:8b, on this machine');
    expect(modelAvailable(local, 'remote', 'labels')).toBe(true);
    const [remote] = choicesFor(local, 'labels');
    expect(remote.note).toMatch(/stay on this machine$/);
    const hosted = status(
      { provider: 'openrouter', label: 'OpenRouter: a/b', local: false },
      { remote_model: 'OpenRouter: a/b', keep_data_local: true }
    );
    expect(remoteLabel(hosted)).toBe('Remote AI model: OpenRouter: a/b');
    expect(modelAvailable(hosted, 'remote', 'labels')).toBe(false);
    expect(choicesFor(hosted, 'cells')[0].note).toMatch(/leave the machine$/);
  });
});

describe('filterModels', () => {
  const models = [
    {
      id: 'anthropic/claude-sonnet-5',
      label: 'Anthropic: Claude Sonnet 5',
      note: null
    },
    {
      id: 'anthropic/claude-haiku-4.5',
      label: 'Anthropic: Claude Haiku 4.5',
      note: null
    },
    {
      id: 'openai/gpt-oss-120b:free',
      label: 'OpenAI: gpt-oss-120b (free)',
      note: 'free'
    }
  ];

  it('keeps the models whose id or name holds every word typed', () => {
    expect(filterModels(models, 'claude sonnet').map(m => m.id)).toEqual([
      'anthropic/claude-sonnet-5'
    ]);
    expect(filterModels(models, 'FREE').map(m => m.id)).toEqual([
      'openai/gpt-oss-120b:free'
    ]);
    expect(filterModels(models, 'anthropic', 1)).toHaveLength(1);
  });

  it('finds models with the example of the placeholder, typed as it is written', () => {
    // As whybook/server/providers.py lists the models of Hugging Face's router.
    const routed = [
      ['novita', 'Novita'],
      ['scaleway', 'Scaleway']
    ].map(([id, company]) => ({
      id: `Qwen/Qwen3-32B:${id}`,
      label: `Qwen/Qwen3-32B on ${company}`,
      note: null
    }));
    expect(filterExample('openrouter')).toBe('Claude Sonnet');
    expect(
      filterModels(models, filterExample('openrouter')).map(m => m.id)
    ).toEqual(['anthropic/claude-sonnet-5']);
    expect(filterExample('huggingface')).toBe('Qwen Scaleway');
    expect(
      filterModels(routed, filterExample('huggingface')).map(m => m.id)
    ).toEqual(['Qwen/Qwen3-32B:scaleway']);
  });

  it('words an error by its message', () => {
    expect(messageOf(new Error('Error: OpenRouter: sign in first'))).toBe(
      'OpenRouter: sign in first'
    );
    expect(messageOf('plain')).toBe('plain');
  });
});
