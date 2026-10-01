import * as React from 'react';

import type { IModelChoice } from '../model/models';
import { choiceLabel } from '../model/models';

/**
 * The options of a task's select: each group of local models under its
 * heading (LOCAL_GROUPS), and a choice with no group on its own. A model that
 * cannot run and cannot be fetched is disabled, unless it is the chosen one.
 */
export function ModelOptions(props: {
  choices: IModelChoice[];
  value: string | undefined;
}): JSX.Element {
  const { value } = props;
  const option = (choice: IModelChoice) => (
    <option
      key={choice.id}
      value={choice.id}
      disabled={
        !choice.available && choice.download === null && choice.id !== value
      }
    >
      {choiceLabel(choice, value)}
    </option>
  );
  return (
    <>
      {grouped(props.choices).map(([group, members]) =>
        group ? (
          <optgroup key={group} label={group}>
            {members.map(option)}
          </optgroup>
        ) : (
          members.map(option)
        )
      )}
    </>
  );
}

/** The choices in runs: the members of one group together, a choice with no group alone. */
function grouped(
  choices: IModelChoice[]
): [string | undefined, IModelChoice[]][] {
  const runs: [string | undefined, IModelChoice[]][] = [];
  for (const choice of choices) {
    const last = runs[runs.length - 1];
    if (last && choice.group && last[0] === choice.group) {
      last[1].push(choice);
    } else {
      runs.push([choice.group, [choice]]);
    }
  }
  return runs;
}
