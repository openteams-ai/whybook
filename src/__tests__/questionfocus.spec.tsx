/**
 * Where the keyboard focus goes when the questions of a request come
 * (useQuestionFocus in src/ui/common.tsx).
 */
import * as React from 'react';

import { useQuestionFocus } from '../ui/common';
import { mount } from './fakes/bench-render';

interface IFakeAsk {
  id: number;
  loading: boolean;
  missing: null;
}

function Questions(props: {
  model: { ask: IFakeAsk | null };
  options: string[];
}): React.ReactElement {
  const box = React.useRef<HTMLDivElement>(null);
  useQuestionFocus(box, props.model as any, !!props.model.ask);
  return (
    <div ref={box}>
      <button className="caret">Ask</button>
      {props.options.map(text => (
        <button key={text} className="jp-Epi-option">
          {text}
        </button>
      ))}
    </div>
  );
}

/** A key pressed in the page, so that the questions count as asked from the keyboard. */
function pressKey(): void {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })
  );
}

describe('the focus when the questions of a request come', () => {
  it('stays on the caret of the Ask button that the analyst reached while the questions loaded', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    pressKey();
    const loading = { ask: { id: 1, loading: true, missing: null } };
    const view = await mount(<Questions model={loading} options={[]} />);
    const caret = view.host.querySelector<HTMLElement>('.caret')!;
    caret.focus();
    pressKey();
    const answered = { ask: { id: 1, loading: false, missing: null } };
    await view.render(<Questions model={answered} options={['First']} />);
    expect(document.activeElement).toBe(caret);
    await view.unmount();
    opener.remove();
  });

  it('goes to the first question when the analyst left it where the questions opened', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    pressKey();
    const loading = { ask: { id: 2, loading: true, missing: null } };
    const view = await mount(<Questions model={loading} options={[]} />);
    const answered = { ask: { id: 2, loading: false, missing: null } };
    await view.render(<Questions model={answered} options={['First']} />);
    expect(document.activeElement?.textContent).toBe('First');
    await view.unmount();
    opener.remove();
  });
});
