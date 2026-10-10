/**
 * Where the keyboard focus goes when the questions of a request come, and
 * where it goes back when they close (useQuestionFocus in src/ui/common.tsx).
 */
import './fakes/quiet';

import { MessageLoop } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';
import * as React from 'react';

import type { Ask, EpiModel } from '../model/epimodel';
import type { IOption, IVariable } from '../tokens';
import { useQuestionFocus } from '../ui/common';
import { DocumentView } from '../ui/document';
import { QuestionsSection, VariablesSection } from '../ui/variables';
import { CurrentModel, FollowingWidget } from '../widgets';
import type { IBenchCell } from './fakes/bench-fake';
import { benchModel } from './fakes/bench-fake';
import { mount, settle, step } from './fakes/bench-render';

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

/** The demo: the mixed model [5] that the analyst asks about. */
const DEMO: IBenchCell[] = [
  { id: 'load', source: "model_data = pd.read_csv('pain.csv')", count: 1 },
  {
    id: 'fit',
    source: "fit = smf.mixedlm('pain_score ~ arm * month', model_data).fit()",
    count: 5
  }
];

/** A notebook made with Whybook's tile of the launcher, run once. */
const UNTITLED: IBenchCell[] = [{ id: 'first', source: 'x = 1', count: 1 }];

function frame(name: string): IVariable {
  return {
    name,
    label: name,
    kind: 'dataframe',
    type: 'pandas.DataFrame',
    rows: 318,
    n_columns: 0,
    columns: []
  };
}

/** A notebook whose kernel holds `patients` and `visits`. */
function withVariables(model: EpiModel): void {
  (model.sessionContext as any).session = { kernel: {} };
  (model.bridge as any)._snapshot = {
    variables: [frame('patients'), frame('visits')],
    packages: {}
  };
}

/**
 * A request from the keyboard, which has no place on the page: its
 * questions show in the Questions section.
 */
function keyboardAsk(
  source: object,
  target: { cellId?: string; item?: object }
): Ask {
  const option = {
    id: 'adjusted',
    text: 'Is bmi associated with pain_score here, adjusting for site?',
    type: 'association',
    origin: 'template',
    probability: 0.5,
    reasons: [],
    placement: { kind: 'new', cell: 'fit', label: 'new cell after [5]' },
    code: 'smf.ols("pain_score ~ bmi + site", model_data).fit()'
  } as IOption;
  return {
    kind: 'drop',
    id: 31,
    anchor: null,
    loading: false,
    error: null,
    source,
    target,
    modifiers: { branch: false, parallel: false },
    result: {
      title: 'bmi onto [5]',
      note: null,
      mode: 'auto',
      options: [option],
      placements: [],
      preselected: []
    },
    checked: [],
    claudeStage: null
  } as unknown as Ask;
}

const BMI = {
  kind: 'column',
  name: "model_data['bmi']",
  label: 'bmi',
  parent: 'model_data'
};
const PATIENTS = { kind: 'variable', name: 'patients', label: 'patients' };
const VISITS = { kind: 'variable', name: 'visits', label: 'visits' };

/**
 * The questions of `ask` come in `section`, from the keyboard, and the
 * analyst asks the first one, which closes them: where the focus is then.
 */
async function askFirst(
  model: EpiModel,
  ask: Ask,
  section: () => Element
): Promise<{ onQuestion: boolean; after: Element | null }> {
  pressKey();
  await step(() => model.showAsk(ask));
  await settle();
  const question = section().querySelector('.jp-Epi-option');
  const onQuestion = !!question && document.activeElement === question;
  // Enter on the question asks it, and the questions go.
  await step(() => model.showAsk(null));
  await settle();
  return { onQuestion, after: document.activeElement };
}

describe('the focus when the questions close, with a Whybook notebook opened earlier still open', () => {
  // jsdom has no watcher of sizes, which the popover and the cards use.
  beforeAll(() => {
    (globalThis as any).ResizeObserver = class {
      observe() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  });
  afterAll(() => {
    delete (globalThis as any).ResizeObserver;
  });

  /** The views of two notebooks, the first opened first. */
  async function twoNotebooks(
    first: IBenchCell[],
    setup: (model: EpiModel) => void = () => undefined
  ) {
    const other = benchModel(first, { path: 'Untitled.ipynb' }).model;
    const asking = benchModel(DEMO, { path: 'pain_diary_demo.ipynb' }).model;
    setup(other);
    setup(asking);
    const view = (model: EpiModel) => (
      <DocumentView
        model={model}
        editorServices={null}
        openFile={() => undefined}
        isVisible={() => true}
      />
    );
    const views = [await mount(view(other)), await mount(view(asking))];
    return {
      other,
      asking,
      views,
      close: async () => {
        for (const mounted of views) {
          await mounted.unmount();
        }
        other.dispose();
        asking.dispose();
      }
    };
  }

  it.each([
    ['a new notebook', UNTITLED],
    ['a copy of the same notebook, with the same cell ids', DEMO]
  ])(
    'goes to the card that the question was about, in the notebook that asked, with %s opened first',
    async (_, first) => {
      const { asking, views, close } = await twoNotebooks(first);
      // The Questions section of the side bar follows the notebook that asks.
      const side = await mount(<QuestionsSection model={asking} />);
      await settle();
      const { onQuestion, after } = await askFirst(
        asking,
        keyboardAsk(BMI, { cellId: 'fit' }),
        () => side.host
      );
      const found = {
        onQuestion,
        inAsking: !!after && views[1].host.contains(after),
        cell: after?.getAttribute('data-cell-id') ?? null
      };
      await side.unmount();
      await close();
      expect(found).toEqual({ onQuestion: true, inAsking: true, cell: 'fit' });
    }
  );

  it('goes to the variable in the Variables panel of the notebook that asked, with the panels in each notebook', async () => {
    // Each notebook shows Variables, Contents and Questions in its own view.
    const { asking, views, close } = await twoNotebooks(DEMO, model => {
      withVariables(model);
      model.settings.variablesPlacement = 'document';
    });
    await settle();
    const { onQuestion, after } = await askFirst(
      asking,
      keyboardAsk(PATIENTS, { item: VISITS }),
      () => views[1].host
    );
    const found = {
      onQuestion,
      inAsking: !!after && views[1].host.contains(after),
      variable: after?.getAttribute('data-variable') ?? null
    };
    await close();
    expect(found).toEqual({
      onQuestion: true,
      inAsking: true,
      variable: 'visits'
    });
  });

  it('goes to the variable in the side bar, which follows the notebook that asked', async () => {
    const { asking, close } = await twoNotebooks(DEMO);
    withVariables(asking);
    const current = new CurrentModel();
    const side = new FollowingWidget(current, model => (
      <>
        <VariablesSection model={model} />
        <QuestionsSection model={model} />
      </>
    ));
    await step(() => {
      Widget.attach(side, document.body);
      current.model = asking;
      MessageLoop.sendMessage(side, Widget.Msg.UpdateRequest);
    });
    await settle();
    const { onQuestion, after } = await askFirst(
      asking,
      keyboardAsk(PATIENTS, { item: VISITS }),
      () => side.node
    );
    const found = {
      onQuestion,
      inSide: !!after && side.node.contains(after),
      variable: after?.getAttribute('data-variable') ?? null
    };
    await step(() => side.dispose());
    await close();
    expect(found).toEqual({
      onQuestion: true,
      inSide: true,
      variable: 'visits'
    });
  });
});
