import {
  customId,
  customIds,
  customSpec,
  readCustomModels
} from '../model/custommodels';

describe('the ids of the local models of the settings', () => {
  it('come from the names, as whybook/server/local_models.py writes them', () => {
    // The same names as test_local_models.py, with the same ids.
    expect(customId('My Llama 3.2 (3B)')).toBe('custom:my-llama-3.2-3b');
    expect(customId('  Qwen3   8B, mine!  ')).toBe('custom:qwen3-8b-mine');
    expect(customId('???')).toBe('custom:model');
  });

  it('take the next free number for a name that repeats', () => {
    const models = [
      { name: 'My Llama 3.2 (3B)', repo: 'a/b', file: 'c.gguf' },
      { name: 'My Llama 3.2 (3B)', path: '/models/tiny.gguf' }
    ];
    expect(customIds(models)).toEqual([
      'custom:my-llama-3.2-3b',
      'custom:my-llama-3.2-3b-2'
    ]);
    expect(customSpec(models, 'custom:my-llama-3.2-3b-2')).toBe(models[1]);
    expect(customSpec(models, 'gemma-4-e2b')).toBeUndefined();
  });

  it('are given only to the entries of the settings that have a name', () => {
    expect(
      readCustomModels([
        { name: 'Tiny', path: '/models/tiny.gguf' },
        { name: ' ' },
        { repo: 'a/b' },
        3
      ])
    ).toEqual([{ name: 'Tiny', path: '/models/tiny.gguf' }]);
    expect(readCustomModels(undefined)).toEqual([]);
  });
});
