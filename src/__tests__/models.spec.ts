import type { IServerStatus } from '../model/api';
import type { ModelChoices } from '../model/models';
import {
  aiReady,
  aiSummary,
  cannotRun,
  choiceLabel,
  choicesFor,
  DEFAULT_MODELS,
  LOCAL_GROUPS,
  modelAvailable,
  NOT_MEASURED,
  readModels,
  withDataPolicy
} from '../model/models';
import { composed } from './fakes/settings-fake';

const STATUS: IServerStatus = {
  ranker: 'heuristic',
  jev_configured: false,
  claude_available: true,
  describe_tables: true,
  remote_model: null,
  local_models: [
    {
      id: 'gemma-4-e2b',
      label: 'Gemma 4 E2B',
      kind: 'local',
      tier: 'recommended',
      size_mb: 2841,
      note: 'descriptions right for 25 of 32 test tables, headlines for 25, none false',
      repo: 'ggml-org/gemma-4-E2B-it-GGUF',
      available: true,
      reason: null,
      downloadable: false
    },
    {
      id: 'minicpm5-2b',
      label: 'MiniCPM5 2B',
      kind: 'local',
      tier: 'smaller',
      size_mb: 1561,
      note: 'descriptions right for 25 of 32 test tables, headlines for 26, none false',
      repo: 'openbmb/MiniCPM5-2B-GGUF',
      available: false,
      reason:
        'not downloaded: hf download openbmb/MiniCPM5-2B-GGUF MiniCPM5-2B-Q4_K_M.gguf',
      downloadable: true
    }
  ],
  jev: {
    available: false,
    reason: 'needs a TypeSafe API key on the server: TYPESAFE_API_KEY'
  }
};

/**
 * The models of the settings that JupyterLab gives the plugin for a saved
 * text: the composite, with every default of the schema, and the analyst's own.
 */
function saved(models: Record<string, unknown>): ModelChoices {
  const { composite, user } = composed(JSON.stringify({ models }));
  return readModels(composite.models, user.models);
}

describe('readModels', () => {
  it('fills in the defaults and keeps what the settings hold', () => {
    expect(readModels(undefined, undefined)).toEqual(DEFAULT_MODELS);
    expect(saved({})).toEqual(DEFAULT_MODELS);
    expect(saved({ labels: 'gemma-4-e2b', ranking: 'remote' })).toEqual({
      ...DEFAULT_MODELS,
      labels: 'gemma-4-e2b',
      ranking: 'remote'
    });
  });
});

describe('readModels, from the settings of an earlier version', () => {
  it('reads the model of table labels as the model of labels and captions', () => {
    const { composite } = composed(
      '{"models": {"tableLabels": "gemma-4-e2b"}}'
    );
    // JupyterLab fills labels in with its default, which the analyst never chose.
    expect((composite.models as any).labels).toBe(DEFAULT_MODELS.labels);
    expect(saved({ tableLabels: 'gemma-4-e2b' }).labels).toBe('gemma-4-e2b');
    expect(saved({ tableLabels: 'gemma-4-e2b', labels: 'off' }).labels).toBe(
      'off'
    );
  });

  it('gives a model that the view dropped the step down in its place', () => {
    expect(saved({ tableLabels: 'qwen3.5-0.8b' }).labels).toBe('minicpm5-2b');
    expect(
      saved({ labels: 'qwen3.5-0.8b', typed: 'qwen3.5-0.8b' })
    ).toMatchObject({ labels: 'minicpm5-2b', typed: 'minicpm5-2b' });
  });
});

describe('modelAvailable', () => {
  it('needs the remote model set up and allowed, or the local file', () => {
    expect(modelAvailable(STATUS, 'remote', 'cells')).toBe(true);
    const turnedOff = { ...STATUS, describe_tables: false };
    expect(modelAvailable(turnedOff, 'remote', 'labels')).toBe(false);
    // The server's switch covers table labels only.
    expect(modelAvailable(turnedOff, 'remote', 'cells')).toBe(true);
    expect(modelAvailable(STATUS, 'gemma-4-e2b')).toBe(true);
    expect(modelAvailable(STATUS, 'minicpm5-2b')).toBe(false);
    expect(modelAvailable(STATUS, 'off')).toBe(false);
    expect(modelAvailable(null, 'remote')).toBe(false);
  });

  it('always runs the rules, and Jev only with a key on the server', () => {
    expect(modelAvailable(STATUS, 'rules', 'typed')).toBe(true);
    expect(modelAvailable(STATUS, 'jev', 'typed')).toBe(false);
    const keyed = { ...STATUS, jev: { available: true, reason: null } };
    expect(modelAvailable(keyed, 'jev', 'typed')).toBe(true);
  });

  it('turns a task off with its setting', () => {
    const models = { ...DEFAULT_MODELS, cells: 'off' };
    expect(aiReady(STATUS, models, 'cells')).toBe(false);
    expect(aiReady(STATUS, models, 'questions')).toBe(true);
  });
});

describe('choicesFor', () => {
  it('offers local models only for tasks that can use them', () => {
    expect(choicesFor(STATUS, 'cells').map(choice => choice.id)).toEqual([
      'remote',
      'off'
    ]);
    const labels = choicesFor({ ...STATUS, describe_tables: false }, 'labels');
    expect(labels.map(choice => [choice.id, choice.available])).toEqual([
      ['remote', false],
      ['gemma-4-e2b', true],
      ['minicpm5-2b', false],
      ['off', true]
    ]);
    expect(labels[0].reason).toBe(
      'turned off on the server: c.Whybook.describe_tables'
    );
    expect(labels[1].note).toBe(
      '2.8 GB; descriptions right for 25 of 32 test tables, headlines for 25, none false'
    );
    // A missing model the server can fetch, with where it comes from.
    expect(labels[2].download).toBe(1561);
    expect(labels[2].source).toBe('openbmb/MiniCPM5-2B-GGUF');
    // The local models go under the heading of their machine.
    expect(labels.map(choice => choice.group)).toEqual([
      undefined,
      LOCAL_GROUPS.recommended,
      LOCAL_GROUPS.smaller,
      undefined
    ]);
  });

  it('offers the models of the settings after the five, with their own note', () => {
    const custom = {
      ...STATUS,
      local_models: [
        ...STATUS.local_models!,
        {
          id: 'custom:llama-3.2-3b',
          label: 'Llama 3.2 3B',
          kind: 'local' as const,
          tier: 'custom' as const,
          size_mb: null,
          note: 'added in the settings; not measured',
          repo: 'ggml-org/Llama-3.2-3B-GGUF',
          available: false,
          reason: 'not downloaded',
          downloadable: true
        }
      ]
    };
    for (const task of ['labels', 'typed', 'ranking', 'questions'] as const) {
      const last = choicesFor(custom, task).find(
        choice => choice.id === 'custom:llama-3.2-3b'
      )!;
      expect(last.group).toBe(LOCAL_GROUPS.custom);
      // With no size known, Download shows none.
      expect([last.note, last.download]).toEqual([
        'added in the settings; not measured',
        0
      ]);
    }
  });

  it('offers for more questions every local model, with what was measured of each', () => {
    const questions = choicesFor(STATUS, 'questions');
    expect(questions.map(choice => choice.id)).toEqual([
      'remote',
      'gemma-4-e2b',
      'minicpm5-2b',
      'off'
    ]);
    expect(questions[1].note).toMatch(/about 45 s/);
    expect(questions[2].note).toBe(`1.6 GB; ${NOT_MEASURED}`);
  });

  it('offers the rules, the local models and Jev, greyed, for typed questions', () => {
    const typed = choicesFor(STATUS, 'typed');
    expect(typed.map(choice => [choice.id, choice.available])).toEqual([
      ['rules', true],
      ['gemma-4-e2b', true],
      ['minicpm5-2b', false],
      ['jev', false]
    ]);
    // Each local model with what it did on this task.
    expect(typed[1].note).toMatch(/69% of 120 test questions/);
    expect(typed[3].reason).toBe(
      'needs a TypeSafe API key on the server: TYPESAFE_API_KEY'
    );
    const jev = choicesFor(null, 'typed').find(choice => choice.id === 'jev');
    expect(jev?.reason).toBe('the server did not answer');
  });

  it('offers the rules, the remote model, the local models and Jev for the order of questions', () => {
    const ranking = choicesFor(STATUS, 'ranking');
    expect(ranking.map(choice => [choice.id, choice.available])).toEqual([
      ['rules', true],
      ['remote', true],
      ['gemma-4-e2b', true],
      ['minicpm5-2b', false],
      ['jev', false]
    ]);
    expect(ranking[2].note).toMatch(/45% of them, against 57% with the rules/);
    // The remote model's prompt predicts the next question, as measured.
    expect(ranking[1].note).toMatch(/61% of them, against 57% with the rules/);
    expect(ranking[0].note).toMatch(
      /52.5% of them, against 29.5% with the rules alone and 25.3% in a random order/
    );
    // Jev orders questions through Cloudflare too, as the ranker did before TypeSafe.
    const cloudflare = { ...STATUS, jev_configured: true };
    expect(modelAvailable(cloudflare, 'jev', 'ranking')).toBe(true);
    expect(modelAvailable(cloudflare, 'jev', 'typed')).toBe(false);
    // The rules are no model; Jev without a key cannot run.
    expect(aiSummary(STATUS, { ...DEFAULT_MODELS, ranking: 'rules' })).toBe(
      'AI: remote'
    );
    expect(aiSummary(STATUS, { ...DEFAULT_MODELS, ranking: 'jev' })).toBe(
      'AI: remote · 1 cannot run'
    );
  });

  it('names the remote model when the server sets one', () => {
    const [remote] = choicesFor({ ...STATUS, remote_model: 'opus' }, 'cells');
    expect(remote.label).toBe('Remote AI model: opus');
    expect(remote.note).toMatch(/leave the machine$/);
  });
});

describe('aiSummary', () => {
  it('says where the data goes, and how many chosen models cannot run', () => {
    expect(aiSummary(STATUS, DEFAULT_MODELS)).toBe('AI: remote');
    expect(
      aiSummary(STATUS, { ...DEFAULT_MODELS, labels: 'gemma-4-e2b' })
    ).toBe('AI: remote and local');
    expect(
      aiSummary(STATUS, {
        cells: 'off',
        questions: 'off',
        labels: 'off',
        typed: 'rules'
      })
    ).toBe('AI: off');
    // Jev runs away from the machine; without a key it cannot run.
    expect(
      aiSummary(STATUS, {
        cells: 'off',
        questions: 'off',
        labels: 'off',
        typed: 'jev'
      })
    ).toBe('AI: remote · 1 cannot run');
    expect(
      aiSummary(STATUS, { ...DEFAULT_MODELS, labels: 'minicpm5-2b' })
    ).toBe('AI: remote and local · 1 cannot run');
  });
});

describe('no model connected', () => {
  // The server's status before the analyst connects a model: nothing is
  // wrong, and the remote choice waits.
  const unconnected: IServerStatus = {
    ...STATUS,
    claude_available: false,
    claude: {
      available: false,
      cli: null,
      credential: null,
      reason: 'no model is connected',
      setup: 'Connect one in the AI models panel.',
      provider: 'none',
      model: null,
      label: 'No model connected',
      local: false
    }
  };

  it('marks the remote choice as waiting, with no fault to fix', () => {
    const [remote] = choicesFor(unconnected, 'cells');
    expect(remote.available).toBe(false);
    expect(remote.waiting).toBe(true);
    expect(choicesFor(STATUS, 'cells')[0].waiting).toBe(false);
  });

  it('says in the status bar that no model is connected, and counts only the choices that cannot run', () => {
    expect(aiSummary(unconnected, DEFAULT_MODELS)).toBe(
      'AI: no model connected'
    );
    expect(
      aiSummary(unconnected, { ...DEFAULT_MODELS, labels: 'gemma-4-e2b' })
    ).toBe('AI: local · no model connected');
    expect(
      aiSummary(unconnected, { ...DEFAULT_MODELS, labels: 'minicpm5-2b' })
    ).toBe('AI: local · no model connected · 1 cannot run');
  });
});

describe('withDataPolicy', () => {
  it('keeps the data here by the setting, or by the server whatever the setting says', () => {
    expect(withDataPolicy(STATUS, false)).toBe(STATUS);
    expect(withDataPolicy(STATUS, true)?.keep_data_local).toBe(true);
    const fixed = { ...STATUS, keep_data_local: true };
    expect(withDataPolicy(fixed, false)).toBe(fixed);
    expect(withDataPolicy(null, true)).toBeNull();
  });

  it('takes the remote model from labels alone, and says so in the status bar', () => {
    const local = withDataPolicy(STATUS, true);
    const remote = (task: 'labels' | 'cells' | 'questions' | 'ranking') =>
      choicesFor(local, task).find(choice => choice.id === 'remote');
    expect(remote('labels')?.available).toBe(false);
    expect(remote('labels')?.reason).toMatch(
      /^the data stays on this machine, and the remote model would read the table/
    );
    // Cells, more questions and their order read names and kinds only.
    expect(remote('cells')?.available).toBe(true);
    expect(remote('questions')?.available).toBe(true);
    expect(remote('ranking')?.available).toBe(true);
    expect(
      aiReady(local, { ...DEFAULT_MODELS, labels: 'gemma-4-e2b' }, 'labels')
    ).toBe(true);
    expect(aiSummary(local, { ...DEFAULT_MODELS, labels: 'gemma-4-e2b' })).toBe(
      'AI: remote and local, data stays here'
    );
  });
});

describe('the remote model without a CLI or a credential', () => {
  const missing: IServerStatus = {
    ...STATUS,
    claude_available: false,
    claude: {
      available: false,
      cli: '/opt/claude',
      credential: null,
      reason:
        'the Claude Code CLI on the server has no credential: no ANTHROPIC_API_KEY and no login',
      setup:
        'Set ANTHROPIC_API_KEY where the server starts and restart it, or run claude in a terminal to log in, then reload the page.'
    }
  };

  it("cannot run, with the server's reason and one line on how to set it up", () => {
    expect(aiReady(missing, DEFAULT_MODELS, 'cells')).toBe(false);
    const remote = choicesFor(missing, 'cells')[0];
    expect(remote.available).toBe(false);
    expect(cannotRun(remote)).toBe(
      'Cannot run: the Claude Code CLI on the server has no credential: no ANTHROPIC_API_KEY and no login. Set ANTHROPIC_API_KEY where the server starts and restart it, or run claude in a terminal to log in, then reload the page.'
    );
  });

  it('names a model that cannot run as such in the list, but not the chosen one, whose reason shows under the select', () => {
    const remote = choicesFor(missing, 'labels')[0];
    // The chosen option fills the select: "(cannot run)" was cut to "(car".
    expect(choiceLabel(remote, 'remote')).toBe('Remote AI model');
    expect(choiceLabel(remote, 'off')).toBe('Remote AI model (cannot run)');
  });
});
