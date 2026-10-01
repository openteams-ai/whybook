/**
 * Settings whose choices JupyterLab's settings editor shows as cards
 * (design iteration 1.78): a card for each choice with its picture, its
 * title and one short line; the saved choice checked; a pick, a click or an
 * arrow key, saved through the form as the editor saves its own fields. The
 * form here is JupyterLab's FormComponent, which the settings editor draws.
 * Also the short descriptions of every setting.
 */
import './fakes/quiet';

import * as fs from 'fs';
import * as path from 'path';
import * as React from 'react';

import { FormComponent } from '@jupyterlab/ui-components';

import {
  addSettingCards,
  choiceCardsRenderer,
  readChoices
} from '../ui/settingcards';
import { SETTING_PICTURES } from '../ui/settingpictures';
import { mount, step } from './fakes/bench-render';

const SCHEMA_DIR = path.join(__dirname, '..', '..', 'schema');

/** The schema of each plugin, by its id in the settings registry. */
const SCHEMAS: Record<string, any> = Object.fromEntries(
  fs
    .readdirSync(SCHEMA_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => [
      `whybook:${name.replace(/\.json$/, '')}`,
      JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf-8'))
    ])
);

/** The last of the values that the form gave. */
function last(changes: any[]): any {
  return changes[changes.length - 1];
}

/** A validator that finds no error, in place of the editor's ajv one. */
const validator: any = {
  validateFormData: () => ({ errors: [], errorSchema: {} }),
  toErrorList: () => [],
  isValid: () => true,
  rawValidation: () => ({ errors: [] })
};

/**
 * One setting in JupyterLab's form, as the settings editor draws it: the
 * field of the cards for the key, the editor's id prefix and its defaults.
 */
async function drawSetting(plugin: string, key: string, saved: unknown) {
  const property = SCHEMAS[plugin].properties[key];
  const changes: any[] = [];
  const view = await mount(
    <div className="jp-SettingsPanel">
      <div className="jp-SettingsForm">
        <FormComponent
          validator={validator}
          schema={{ type: 'object', properties: { [key]: property } }}
          formData={{ [key]: saved } as any}
          uiSchema={{ [key]: { 'ui:field': key } }}
          fields={{
            [key]: choiceCardsRenderer(
              SETTING_PICTURES[`${plugin}.${key}`]
            ) as any
          }}
          formContext={{ defaultFormData: { [key]: property.default } }}
          idPrefix={`jp-SettingsEditor-${plugin}`}
          liveValidate
          onChange={event => changes.push(event.formData)}
        />
      </div>
    </div>
  );
  const cards = () =>
    Array.from(view.host.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  return { view, changes, cards };
}

describe('A setting with choices, as cards', () => {
  it('shows a card for each choice, with its picture, its title and its line', async () => {
    const { view, cards } = await drawSetting(
      'whybook:plugin',
      'outputDetail',
      'full'
    );
    const group = view.host.querySelector('[role="radiogroup"]')!;
    expect(group.id).toBe('jp-SettingsEditor-whybook:plugin_outputDetail');
    // The group is named by the setting's title, drawn once, and described
    // by its description, above the cards.
    const title = document.getElementById(
      group.getAttribute('aria-labelledby')!
    );
    expect(title?.textContent).toBe('Level of detail of outputs');
    expect(
      view.host.textContent!.split('Level of detail of outputs')
    ).toHaveLength(2);
    const description = document.getElementById(
      group.getAttribute('aria-describedby')!
    );
    expect(description?.textContent).toBe(
      SCHEMAS['whybook:plugin'].properties.outputDetail.description
    );
    expect(
      description!.compareDocumentPosition(group) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(cards().map(card => card.getAttribute('aria-label'))).toEqual([
      'Overview',
      'Compact',
      'Full'
    ]);
    for (const card of cards()) {
      expect(card.querySelector('svg.jp-Epi-pic')).not.toBeNull();
      const line = document.getElementById(
        card.getAttribute('aria-describedby')!
      );
      expect(line?.textContent).toBeTruthy();
      expect(card.textContent).toContain(line!.textContent);
    }
    expect(cards()[0].textContent).toBe(
      'OverviewEach table and text as a tile'
    );
    await view.unmount();
  });

  it('checks the saved choice, which alone takes Tab', async () => {
    const { view, cards } = await drawSetting(
      'whybook:plugin',
      'outputDetail',
      'compact'
    );
    expect(cards().map(card => card.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false'
    ]);
    expect(cards().map(card => card.tabIndex)).toEqual([-1, 0, -1]);
    await view.unmount();
  });

  it('saves a new pick through the form, and checks it', async () => {
    const { view, changes, cards } = await drawSetting(
      'whybook:plugin',
      'outputDetail',
      'compact'
    );
    await step(() => cards()[2].click());
    expect(last(changes)).toEqual({ outputDetail: 'full' });
    expect(cards()[2].getAttribute('aria-checked')).toBe('true');
    expect(cards()[1].getAttribute('aria-checked')).toBe('false');
    await view.unmount();
  });

  it('moves the choice and the focus with the arrow keys, Home and End', async () => {
    const { view, changes, cards } = await drawSetting(
      'whybook:plugin',
      'mapDetail',
      'minimal'
    );
    const press = async (key: string) => {
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true
      });
      await step(() => {
        (document.activeElement as HTMLElement).dispatchEvent(event);
      });
      // The key does not scroll the editor.
      expect(event.defaultPrevented).toBe(true);
    };
    cards()[1].focus();
    await press('ArrowRight');
    expect(last(changes)).toEqual({ mapDetail: 'overview' });
    expect(document.activeElement).toBe(cards()[2]);
    // From the last card, the next is the first.
    await press('ArrowDown');
    expect(last(changes)).toEqual({ mapDetail: 'none' });
    expect(document.activeElement).toBe(cards()[0]);
    await press('End');
    expect(last(changes)).toEqual({ mapDetail: 'overview' });
    await press('ArrowLeft');
    expect(last(changes)).toEqual({ mapDetail: 'minimal' });
    expect(document.activeElement).toBe(cards()[1]);
    await press('Home');
    expect(last(changes)).toEqual({ mapDetail: 'none' });
    expect(cards().map(card => card.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false'
    ]);
    await view.unmount();
  });

  it('shows a switch as two cards, and saves a boolean', async () => {
    const { view, changes, cards } = await drawSetting(
      'whybook:plugin',
      'detailFollowsSpace',
      true
    );
    expect(cards().map(card => card.getAttribute('aria-label'))).toEqual([
      'Off',
      'On'
    ]);
    expect(cards()[1].getAttribute('aria-checked')).toBe('true');
    await step(() => cards()[0].click());
    expect(last(changes)).toEqual({ detailFollowsSpace: false });
    await view.unmount();
  });

  it('gives the default by its title once the value differs, and marks the row as JupyterLab marks a changed field', async () => {
    const { view, cards } = await drawSetting(
      'whybook:checkup',
      'tabQuestion',
      'whybook'
    );
    const field = () => view.host.querySelector('.jp-Epi-choicefield')!;
    expect(field().classList.contains('jp-mod-modified')).toBe(false);
    expect(view.host.querySelector('.jp-Epi-choicefield-default')).toBeNull();
    await step(() => cards()[2].click());
    expect(field().classList.contains('jp-mod-modified')).toBe(true);
    expect(
      view.host.querySelector('.jp-Epi-choicefield-default')?.textContent
    ).toBe('Default: Whybook views');
    await view.unmount();
  });

  it('checks the default when nothing is saved', async () => {
    const { view, cards } = await drawSetting(
      'whybook:plugin',
      'interaction',
      undefined
    );
    expect(cards().map(card => card.getAttribute('aria-checked'))).toEqual([
      'true',
      'false'
    ]);
    await view.unmount();
  });
});

describe('The settings drawn as cards', () => {
  it('registers a renderer for each of them, in the view and in the Check-up', () => {
    const ids: string[] = [];
    addSettingCards({
      addRenderer: (id: string) => ids.push(id),
      getRenderer: () => ({}),
      renderers: {}
    });
    expect(ids).toEqual(Object.keys(SETTING_PICTURES));
    expect(ids).toEqual(
      expect.arrayContaining([
        'whybook:plugin.outputDetail',
        'whybook:plugin.mapDetail',
        'whybook:plugin.detailFollowsSpace',
        'whybook:plugin.variablesPlacement',
        'whybook:plugin.explorationPlacement',
        'whybook:plugin.interaction',
        'whybook:checkup.tabQuestion'
      ])
    );
  });

  it.each(Object.keys(SETTING_PICTURES))(
    '%s has a picture, a title and a short line for each of its choices',
    id => {
      const [plugin, key] = id.split('.');
      const property = SCHEMAS[plugin].properties[key];
      const choices = readChoices(property);
      expect(choices.map(choice => String(choice.value))).toEqual(
        Object.keys(SETTING_PICTURES[id])
      );
      expect(choices.map(choice => choice.value)).toContain(property.default);
      for (const choice of choices) {
        expect(choice.title).toBeTruthy();
        // One short line, with no number in it.
        expect(choice.description).toMatch(/^[^\d.]{6,45}$/);
      }
    }
  );
});

describe('The descriptions of the settings', () => {
  const settings = Object.entries(SCHEMAS).flatMap(([plugin, schema]) => [
    [plugin, schema.description as string],
    ...Object.entries(schema.properties as Record<string, any>).map(
      ([key, property]) => [`${plugin}.${key}`, property.description as string]
    )
  ]);

  it.each(settings)(
    '%s takes at most two short sentences, with no exact values',
    (_, description) => {
      expect(description).toBeTruthy();
      const sentences = description.split(/(?<=[.!?])\s+/);
      expect(sentences.length).toBeLessThanOrEqual(2);
      // No pixels, thresholds, percentages, times or prices.
      expect(description).not.toMatch(/\d/);
      expect(description).not.toMatch(/[%$]/);
      expect(description.length).toBeLessThanOrEqual(220);
    }
  );
});
