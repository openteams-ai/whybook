import {
  guessPlace,
  guessType,
  keywordType,
  ownOption,
  wordPlace
} from '../model/own';
import type { IPlacement } from '../tokens';

describe('guessType', () => {
  it('sorts a typed question by its words', () => {
    expect(guessType('Does the tariff cause the drop in peak use?')).toBe(
      'causal'
    );
    expect(guessType('Are there impossible readings?')).toBe('quality');
    expect(guessType('Was there any dropout here?')).toBe('quality');
    expect(guessType('Do the residuals look like noise?')).toBe('model');
    expect(guessType('Is sleep related to pain?')).toBe('association');
    expect(guessType('How many patients are in each arm?')).toBe('descriptive');
  });

  it('tells a question the keywords do not type from a descriptive one', () => {
    expect(keywordType('How many patients are in each arm?')).toBeNull();
    expect(keywordType('Is sleep related to pain?')).toBe('association');
  });
});

describe('ownOption', () => {
  it('is an option without code, placed where the request puts its questions', () => {
    const placement = {
      kind: 'new' as const,
      cell: 'lmm',
      label: 'new cell after [5]'
    };
    expect(ownOption('Is sleep related to pain?', placement)).toEqual({
      id: 'own:Is sleep related to pain?',
      text: 'Is sleep related to pain?',
      type: 'association',
      origin: 'user',
      probability: null,
      reasons: ['your own question'],
      effect: 'AI writes the cell',
      placement,
      code: null
    });
  });
});

describe('guessPlace', () => {
  it('reads a change, a variant or a look from the first words', () => {
    expect(guessPlace('Add age as a covariate')).toBe('edit');
    expect(guessPlace('Also drop readings above 200 kWh a day')).toBe('edit');
    expect(guessPlace('What if we let the week slope vary by patient?')).toBe(
      'branch'
    );
    expect(
      guessPlace('Refit without the three most influential patients')
    ).toBe('branch');
    expect(guessPlace('Show the first rows of weekly')).toBe('preview');
    expect(guessPlace('Is sleep related to pain?')).toBeNull();
  });

  it('reads the words after an opener, typed or spoken', () => {
    expect(guessPlace('So, add age as a covariate')).toBe('edit');
    expect(guessPlace('Can you show the first rows of weekly?')).toBe(
      'preview'
    );
    expect(guessPlace("I'd like to try a log scale for pain")).toBe('branch');
    expect(guessPlace('Okay so let’s drop readings above 200')).toBe('edit');
    expect(guessPlace('Um, is sleep related to pain?')).toBeNull();
    // A word that only starts like an opener stays whole.
    expect(guessPlace('Sort the rows by date')).toBe('edit');
  });
});

describe('wordPlace', () => {
  const places: IPlacement[] = [
    { kind: 'new', cell: 'lmm', label: 'new cell after [5]' },
    { kind: 'edit', cell: 'lmm', label: 'edit [5] in place' },
    { kind: 'branch', cell: 'lmm', label: 'branch of [5] · runs in parallel' },
    { kind: 'preview', cell: null, label: 'a preview in the sidebar' }
  ];

  it('picks the place the words suggest, when the request offers it', () => {
    expect(wordPlace('Add age as a covariate', places)?.kind).toBe('edit');
    // Words that choose no place leave it to the model or the default.
    expect(wordPlace('Is sleep related to pain?', places)).toBeNull();
    // A request without an edit has no place for these words.
    expect(
      wordPlace('Add age as a covariate', [places[0], places[3]])
    ).toBeNull();
    expect(wordPlace('anything', [])).toBeNull();
  });
});
