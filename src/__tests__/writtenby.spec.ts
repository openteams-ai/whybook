import {
  cellWrittenBy,
  codeWriter,
  describeBy,
  noteFor,
  withNote,
  writtenBy
} from '../model/writtenby';
import type { IFrameNote, ITableNote, IWrittenBy } from '../tokens';

const AT = '2026-09-24T21:00:00.000Z';
const by = (choice: string, model: string | null = null): IWrittenBy => ({
  choice,
  model,
  at: AT
});
const label = (description: string, choice?: string): ITableNote => ({
  description,
  headline: '',
  ...(choice ? { by: by(choice) } : {})
});

describe('writtenBy', () => {
  it('records the choice, the model that answered and its file', () => {
    const record = writtenBy(
      'gemma-4-e2b',
      'Gemma 4 E2B',
      'ggml-org/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_0.gguf'
    );
    expect(record).toMatchObject({
      choice: 'gemma-4-e2b',
      model: 'Gemma 4 E2B',
      file: 'ggml-org/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_0.gguf'
    });
    expect(Number.isNaN(Date.parse(record.at))).toBe(false);
    expect(writtenBy('remote', undefined)).not.toHaveProperty('file');
  });
});

describe('noteFor', () => {
  it('asks the chosen model when nothing is kept', () => {
    expect(noteFor<ITableNote>(null, 'remote')).toEqual({
      note: null,
      ask: true
    });
  });

  it("shows the chosen model's labels without asking", () => {
    const entry = { ...label('weekly means', 'remote') };
    expect(noteFor(entry, 'remote')).toEqual({ note: entry, ask: false });
  });

  it("shows another model's labels while the chosen model writes its own", () => {
    const entry = label('weekly means', 'qwen3.5-0.8b');
    const { note, ask } = noteFor(entry, 'gemma-4-e2b');
    expect(note?.description).toBe('weekly means');
    expect(ask).toBe(true);
  });

  it('finds the labels of the chosen model among the earlier ones', () => {
    const entry = {
      ...label('local words', 'gemma-4-e2b'),
      earlier: [label('wide sample', 'remote')]
    };
    expect(noteFor(entry, 'remote')).toEqual({
      note: label('wide sample', 'remote'),
      ask: false
    });
  });

  it('asks a local model, and not the remote one, about labels with no record', () => {
    const entry = label('model coefficients');
    expect(noteFor(entry, 'remote')).toEqual({ note: entry, ask: false });
    expect(noteFor(entry, 'gemma-4-e2b')).toEqual({ note: entry, ask: true });
  });

  it("keeps a script's labels for the remote model, as the demos have them", () => {
    const entry = label('model coefficients', 'script');
    expect(noteFor(entry, 'remote')).toEqual({ note: entry, ask: false });
    expect(noteFor(entry, 'gemma-4-e2b')).toEqual({ note: entry, ask: true });
  });

  it('leaves out a summary of other columns', () => {
    const entry: IFrameNote & { earlier?: IFrameNote[] } = {
      summary: 'One row per patient.',
      key: 'old',
      by: by('remote')
    };
    expect(noteFor(entry, 'remote', note => note.key === 'new')).toEqual({
      note: null,
      ask: true
    });
  });
});

describe('withNote', () => {
  it('keeps the newest first and one earlier note per other model', () => {
    let entry = withNote(null, label('first', 'remote'));
    entry = withNote(entry, label('second', 'gemma-4-e2b'));
    entry = withNote(entry, label('third', 'remote'));
    expect(entry.description).toBe('third');
    expect(entry.earlier?.map(note => note.description)).toEqual(['second']);
  });

  it('keeps a note with no record once, and at most four earlier notes', () => {
    let entry = withNote(label('old'), label('a', 'm1'));
    for (const choice of ['m2', 'm3', 'm4', 'm5']) {
      entry = withNote(entry, label(choice, choice));
    }
    expect(entry.description).toBe('m5');
    expect(entry.earlier?.map(note => note.description)).toEqual([
      'm4',
      'm3',
      'm2',
      'a'
    ]);
    expect(withNote(label('old'), label('a', 'm1')).earlier).toEqual([
      label('old')
    ]);
  });
});

describe('describeBy', () => {
  it('names the model and the day', () => {
    expect(describeBy(by('remote', 'claude-opus-5-5'))).toMatch(
      /^Written by the remote AI model, claude-opus-5-5 on .*2026/
    );
    expect(describeBy(by('gemma-4-e2b', 'Gemma 4 E2B'), 'Proposed')).toMatch(
      /^Proposed by Gemma 4 E2B, a local model on /
    );
    expect(
      describeBy({ choice: 'script', model: 'make_later.py', at: '' })
    ).toBe(
      "Written by make_later.py from the table's numbers, in place of an AI model"
    );
    expect(describeBy(by('jev'), 'Chosen')).toMatch(
      /^Chosen by Jev, by TypeSafe/
    );
  });

  it('says when the notebook does not record the model', () => {
    expect(describeBy(null)).toBe(
      'Written by an AI model; the notebook does not record which'
    );
    expect(describeBy({ choice: 'remote', model: null, at: '' })).toBe(
      'Written by the remote AI model'
    );
  });
});

describe('cellWrittenBy', () => {
  it('reads a cell written before the view kept the choice as remote', () => {
    expect(
      cellWrittenBy({ agent: 'claude', model: 'claude-opus-5-5' })
    ).toEqual({ choice: 'remote', model: 'claude-opus-5-5', at: '' });
    expect(cellWrittenBy(undefined)).toBeNull();
  });
});

describe('codeWriter', () => {
  it('names the analyst only for code that the view did not write', () => {
    expect(codeWriter({})).toBe('You wrote the code.');
    expect(codeWriter({ written_by: 'user' })).toBe('You wrote the code.');
    // A template's code, or a model's from before the view named the model,
    // as in the demos: the cell's chips mark its values as the AI's.
    expect(codeWriter({ written_by: 'agent' })).toBe(
      'The view wrote the code, from a template or with an AI model; the notebook does not record which.'
    );
    expect(
      codeWriter({
        written_by: 'agent',
        generated_by: { agent: 'claude', model: 'a model', choice: 'remote' }
      })
    ).toBe('Written by the remote AI model, a model');
  });

  it("says that a template's cell had no model call, since the view marks it", () => {
    expect(codeWriter({ written_by: 'agent', template: true })).toBe(
      'The view wrote the code from a template, with no model call.'
    );
  });
});
