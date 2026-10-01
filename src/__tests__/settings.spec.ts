/**
 * The settings of the view as the plugin reads them (src/model/settings.ts),
 * from the settings that JupyterLab composes through the schema.
 */
import { DEFAULT_MODELS } from '../model/models';
import { readSettings } from '../model/settings';
import { composed } from './fakes/settings-fake';

function read(raw: string) {
  const { composite, user } = composed(raw);
  return readSettings(composite, user);
}

describe('readSettings', () => {
  it('reads the defaults of the schema when nothing is saved', () => {
    expect(read('{}')).toEqual({
      interaction: 'drag',
      variablesPlacement: 'sidebar',
      explorationPlacement: 'sidebar',
      capacity: 8,
      mapColumns: 'contents',
      detail: 'full',
      mapDetail: 'minimal',
      detailFollowsSpace: false,
      minimap: false,
      guessFirst: true,
      offeredQuestions: 12,
      stripsClose: 'elsewhere',
      models: DEFAULT_MODELS,
      jsonCheck: 'fast',
      keepDataLocal: false,
      zeroDataRetention: true,
      customLocalModels: [],
      answers: 'agent',
      agentView: 'strip',
      showCost: false,
      modelQuestions: 'always',
      findDefaults: true,
      exploredOrder: 'auto'
    });
  });

  it('reads "Questions from a model" as always, unless the analyst chose otherwise', () => {
    expect(read('{"modelQuestions": "no-template"}').modelQuestions).toBe(
      'no-template'
    );
    expect(read('{"modelQuestions": "never"}').modelQuestions).toBe('never');
    expect(read('{"modelQuestions": "always"}').modelQuestions).toBe('always');
  });

  it('reads aiWhenNoTemplate: false, which modelQuestions replaced, as never', () => {
    const { composite } = composed('{"aiWhenNoTemplate": false}');
    // JupyterLab fills modelQuestions in with its default.
    expect(composite.modelQuestions).toBe('always');
    expect(read('{"aiWhenNoTemplate": false}').modelQuestions).toBe('never');
    // Until 30 September the switch was on by default: a saved true is the
    // new default.
    expect(read('{"aiWhenNoTemplate": true}').modelQuestions).toBe('always');
    // A choice saved since wins over the switch.
    expect(
      read('{"aiWhenNoTemplate": false, "modelQuestions": "no-template"}')
        .modelQuestions
    ).toBe('no-template');
  });

  it('reads "Find more defaults with AI" as on unless it is turned off, since 1 October 2026', () => {
    expect(read('{}').findDefaults).toBe(true);
    expect(read('{"findDefaults": true}').findDefaults).toBe(true);
    expect(read('{"findDefaults": false}').findDefaults).toBe(false);
    // Without the schema's default, as in a settings file of an older version.
    expect(readSettings({}, null).findDefaults).toBe(true);
    expect(readSettings({ findDefaults: false }, null).findDefaults).toBe(
      false
    );
  });

  it('reads mapOutputs: false, which mapDetail replaced, as no outputs on the map', () => {
    const { composite } = composed('{"mapOutputs": false}');
    // JupyterLab fills mapDetail in with its default.
    expect(composite.mapDetail).toBe('minimal');
    expect(read('{"mapOutputs": false}').mapDetail).toBe('none');
    expect(read('{"mapOutputs": true}').mapDetail).toBe('minimal');
    expect(
      read('{"mapOutputs": false, "mapDetail": "overview"}').mapDetail
    ).toBe('overview');
  });

  it('reads a saved models.tableLabels for Labels and captions', () => {
    const raw = '{"models": {"tableLabels": "gemma-4-e2b"}}';
    expect(read(raw).models?.labels).toBe('gemma-4-e2b');
  });
});
