/**
 * A string that looks like a secret, such as a token that a cell reads from
 * the environment: the kernel lists its length and not its text, the notebook
 * keeps no text of it, and Contents shows it hidden.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import type { NotebookModel } from '@jupyterlab/notebook';

import type { IStoredVariable } from '../model/restore';
import {
  listing,
  looksSecret,
  storedVariable,
  toStore
} from '../model/restore';
import { constantText } from '../model/values';
import type { IVariable } from '../tokens';
import { fakeModel } from './fakes/model-fake';

const TOKEN = 'hf_' + 'Q'.repeat(34);

/** The token as an earlier version of the kernel code listed it, and as kept. */
const oldToken: IVariable & IStoredVariable = {
  name: 'HF_TOKEN',
  label: 'HF_TOKEN',
  kind: 'constant',
  type: 'builtins.str',
  value: `'${TOKEN}'`,
  cell: 'c1'
};

/** The token as the kernel lists it now. */
const secret: IVariable = {
  name: 'hf',
  label: 'hf',
  kind: 'constant',
  type: 'str',
  secret: true,
  length: 37
};

const constant: IVariable = {
  name: 'MIN_DAYS',
  label: 'MIN_DAYS',
  kind: 'constant',
  type: 'builtins.int',
  value: '14'
};

/**
 * The cases that the server, the kernel's listing and its analysis of cells
 * agree on (whybook/server/tests/test_secret_names.py).
 */
const CASES: {
  name: string;
  value: string | number | boolean;
  secret: boolean;
}[] = JSON.parse(
  readFileSync(
    join(__dirname, '../../whybook/server/tests/data/secret_names.json'),
    'utf8'
  )
).cases;

/** A value as the kernel lists it: Python's repr of a string, a number or a flag. */
function listed(value: string | number | boolean): string {
  if (typeof value === 'string') {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  return String(value);
}

describe('looksSecret', () => {
  for (const item of CASES) {
    it(`reads ${item.name}=${listed(item.value)} as the server and the kernel do`, () => {
      expect(looksSecret(item.name, listed(item.value))).toBe(item.secret);
    });
  }

  it('reads no secret in a name alone', () => {
    expect(looksSecret('HF_TOKEN')).toBe(false);
  });
});

describe('what the notebook keeps of a secret', () => {
  it('keeps the length of a secret that the kernel lists, and no text', () => {
    expect(storedVariable(secret, 'c1')).toEqual({ ...secret, cell: 'c1' });
  });

  it('drops the text of a kept string whose name looks like a secret', () => {
    const kept = storedVariable(oldToken, 'c1');
    expect(JSON.stringify(kept)).not.toContain(TOKEN);
    expect(kept).toMatchObject({ secret: true, length: 37 });
    // A number of that name is no secret.
    const limit = { ...constant, name: 'token_limit', label: 'token_limit' };
    expect(storedVariable(limit, 'c1').value).toBe('14');
  });

  it('shows a kept secret from the last run without its text', () => {
    const [shown] = listing(null, [oldToken], () => false);
    expect(shown.stale).toBe(true);
    expect(shown.value).toBeUndefined();
    expect(constantText(shown)).toBe('hidden, 37 characters');
  });

  it('forgets a kept variable whose cell is gone from the notebook', () => {
    const kept = [
      storedVariable(constant, 'c1'),
      storedVariable({ ...constant, name: 'N', label: 'N' }, 'c2')
    ];
    const shown = listing(
      null,
      kept,
      () => false,
      cellId => cellId !== 'c1'
    );
    expect(shown.map(variable => variable.name)).toEqual(['N']);
    expect(
      toStore(
        listing(
          [constant],
          kept,
          () => false,
          () => false
        ),
        kept,
        () => null
      )
    ).toEqual([storedVariable(constant, 'c1')]);
  });

  it('replaces the text of an old notebook once the kernel lists the name as secret', () => {
    const next = toStore(
      [{ ...secret, name: 'HF_TOKEN', label: 'HF_TOKEN' }],
      [oldToken],
      () => null
    );
    expect(JSON.stringify(next)).not.toContain(TOKEN);
    expect(next).toEqual([
      { ...secret, name: 'HF_TOKEN', label: 'HF_TOKEN', cell: 'c1' }
    ]);
  });
});

describe('the view model keeps no secret in the notebook', () => {
  function keeping(stored: IStoredVariable[], cells = [{ id: 'c1' }]) {
    const { nb, model } = fakeModel(cells, { variables: stored });
    return { nb, model };
  }

  function kept(nb: NotebookModel): IStoredVariable[] {
    return (nb.getMetadata('whybook') as any).variables;
  }

  it('drops the text of an old notebook when the kernel lists nothing yet', () => {
    const { nb, model } = keeping([oldToken, storedVariable(constant, 'c1')]);
    model._keep('variables');
    expect(JSON.stringify(nb.toJSON())).not.toContain(TOKEN);
    expect(kept(nb).map(variable => variable.name)).toEqual([
      'HF_TOKEN',
      'MIN_DAYS'
    ]);
  });

  it('forgets a kept token once its cell is gone', () => {
    const { nb, model } = keeping([oldToken], [{ id: 'c2' }]);
    model._keep('variables');
    expect(kept(nb)).toEqual([]);
  });

  it('keeps the listing of the kernel without the text of a secret', () => {
    const { nb, model } = keeping([oldToken]);
    model.bridge.snapshot = {
      variables: [{ ...secret, name: 'HF_TOKEN', label: 'HF_TOKEN' }, constant],
      packages: {}
    };
    model.sessionContext.session = { kernel: {} };
    model._keep('variables');
    expect(JSON.stringify(nb.toJSON())).not.toContain(TOKEN);
    expect(kept(nb).map(variable => [variable.name, variable.value])).toEqual([
      ['HF_TOKEN', undefined],
      ['MIN_DAYS', '14']
    ]);
  });
});

describe('constantText', () => {
  it('shows the value of a constant, and only the length of a secret', () => {
    expect(constantText(constant)).toBe('14');
    expect(constantText(secret)).toBe('hidden, 37 characters');
    expect(constantText({ ...secret, length: 1 })).toBe('hidden, 1 character');
    expect(constantText({ ...secret, length: undefined })).toBe('hidden');
  });
});
