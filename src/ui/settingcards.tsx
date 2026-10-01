import type {
  IFormRenderer,
  IFormRendererRegistry
} from '@jupyterlab/ui-components';
import * as React from 'react';

import { SETTING_PICTURES } from './settingpictures';

/** A value that a setting with choices takes. */
export type ChoiceValue = string | number | boolean;

/** One choice of a setting: its value, its title and one short line. */
export interface IChoice {
  value: ChoiceValue;
  title: string;
  description: string;
}

/** The part of a setting's schema that the cards read. */
export interface IChoiceSchema {
  title?: string;
  description?: string;
  default?: unknown;
  oneOf?: { const?: unknown; title?: string; description?: string }[];
}

/**
 * The choices of a setting, from the `oneOf` entries of its schema: the
 * value of each, its title, and its description as the card's line.
 */
export function readChoices(schema: IChoiceSchema): IChoice[] {
  const choices: IChoice[] = [];
  for (const entry of schema.oneOf ?? []) {
    const value = entry.const;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      choices.push({
        value,
        title: entry.title ?? String(value),
        description: entry.description ?? ''
      });
    }
  }
  return choices;
}

/**
 * The choices of a setting as cards, each with its picture, its title and
 * one short line, in the manner of GNOME's settings.
 *
 * It is a radio group: Tab reaches the chosen card, the arrow keys move the
 * choice, Home and End jump to the ends.
 */
export function ChoiceCards(props: {
  /** The id of the group, which labels its title and its description. */
  id: string;
  title: string;
  description?: string;
  choices: IChoice[];
  value: ChoiceValue | undefined;
  defaultValue?: ChoiceValue;
  /** The picture of each choice, by its value as text. */
  pictures: Record<string, JSX.Element>;
  disabled?: boolean;
  onChange: (value: ChoiceValue) => void;
}): JSX.Element {
  const { id, choices, value } = props;
  const cards = React.useRef<(HTMLButtonElement | null)[]>([]);
  const chosen = choices.findIndex(choice => choice.value === value);
  const choose = (index: number) => {
    const target = (index + choices.length) % choices.length;
    props.onChange(choices[target].value);
    cards.current[target]?.focus();
  };
  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const moves: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowDown: index + 1,
      ArrowLeft: index - 1,
      ArrowUp: index - 1,
      Home: 0,
      End: choices.length - 1
    };
    if (event.key in moves) {
      // The keys move the choice, and do not scroll the editor around it.
      event.preventDefault();
      event.stopPropagation();
      choose(moves[event.key]);
    }
  };
  const fallback = choices.find(choice => choice.value === props.defaultValue);
  const modified =
    props.defaultValue !== undefined &&
    value !== undefined &&
    value !== props.defaultValue;
  return (
    <div className={`jp-Epi-choicefield${modified ? ' jp-mod-modified' : ''}`}>
      <h3 className="jp-FormGroup-fieldLabel" id={`${id}__title`}>
        {props.title}
      </h3>
      {props.description && (
        <p className="jp-Epi-choicefield-description" id={`${id}__text`}>
          {props.description}
        </p>
      )}
      <div
        className="jp-Epi-choicecards"
        id={id}
        role="radiogroup"
        aria-labelledby={`${id}__title`}
        aria-describedby={props.description ? `${id}__text` : undefined}
      >
        {choices.map((choice, index) => {
          const checked = index === chosen;
          const key = String(choice.value);
          return (
            <button
              key={key}
              ref={node => {
                cards.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={choice.title}
              aria-describedby={
                choice.description ? `${id}__${key}` : undefined
              }
              // The chosen card takes Tab; with none chosen, the first.
              tabIndex={checked || (chosen === -1 && index === 0) ? 0 : -1}
              disabled={props.disabled}
              data-value={key}
              className="jp-Epi-choicecard"
              onClick={() => props.onChange(choice.value)}
              onKeyDown={event => onKeyDown(event, index)}
            >
              <span className="jp-Epi-choicecard-picture">
                {props.pictures[key]}
              </span>
              <span className="jp-Epi-choicecard-title">{choice.title}</span>
              {choice.description && (
                <span className="jp-Epi-choicecard-line" id={`${id}__${key}`}>
                  {choice.description}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {modified && fallback && (
        // In place of the editor's own line, which gives the saved value.
        <div className="jp-Epi-choicefield-default">
          Default: {fallback.title}
        </div>
      )}
    </div>
  );
}

/** The props of a field renderer of JupyterLab's settings editor that this one reads. */
interface IFieldProps {
  schema: IChoiceSchema;
  formData?: unknown;
  idSchema: { $id: string };
  disabled?: boolean;
  readonly?: boolean;
  onChange: (value: ChoiceValue) => void;
}

/**
 * A setting with choices, in JupyterLab's settings editor: its title, its
 * description and a card for each choice. A pick goes to the form, which
 * saves it as it saves the editor's own fields.
 */
export function choiceCardsRenderer(
  pictures: Record<string, JSX.Element>
): (props: IFieldProps) => JSX.Element {
  return props => {
    const { schema } = props;
    const defaultValue = isChoiceValue(schema.default)
      ? schema.default
      : undefined;
    const value = isChoiceValue(props.formData) ? props.formData : defaultValue;
    return (
      <ChoiceCards
        id={props.idSchema.$id}
        title={schema.title ?? ''}
        description={schema.description}
        choices={readChoices(schema)}
        value={value}
        defaultValue={defaultValue}
        pictures={pictures}
        disabled={props.disabled || props.readonly}
        onChange={props.onChange}
      />
    );
  };
}

function isChoiceValue(value: unknown): value is ChoiceValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * Show the settings that have a picture for each choice as cards
 * (./settingpictures.tsx), in the plugins of the view and of the Check-up.
 */
export function addSettingCards(registry: IFormRendererRegistry): void {
  for (const [id, pictures] of Object.entries(SETTING_PICTURES)) {
    registry.addRenderer(id, {
      fieldRenderer: choiceCardsRenderer(
        pictures
      ) as unknown as IFormRenderer['fieldRenderer']
    });
  }
}
