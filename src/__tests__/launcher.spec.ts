/**
 * The ways to start a Whybook (design iteration 1.72): a section of
 * JupyterLab's launcher with a card for each kernel, drawn by JupyterLab's
 * own Launcher widget, each with the kernel's name and the logo that
 * Whybook draws; the section follows the kernelspecs; under a fake of
 * jupyterlab-launchpad, one card; and File, New and the palette as before.
 */
import './fakes/quiet';

import { Launcher, LauncherModel } from '@jupyterlab/launcher';
import type { ILauncher } from '@jupyterlab/launcher';
import type { KernelSpec } from '@jupyterlab/services';
import { ServerConnection } from '@jupyterlab/services';
import { CommandRegistry } from '@lumino/commands';
import { MessageLoop } from '@lumino/messaging';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import * as React from 'react';

import { epiIcon } from '../icons';
import {
  CATEGORY,
  LAUNCHPAD_PLUGINS,
  NEW_WHYBOOK,
  kernelIconSvg,
  kernelItems,
  launcherPlugin,
  usesLaunchpad
} from '../launcher';

// The name of the view's factory, without the view's module.
jest.mock('../widgets', () => ({ FACTORY: 'Whybook' }));

const act: (callback: () => void | Promise<void>) => Promise<void> = (
  React as any
).act;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = 'http://localhost:8888/lab-base/';

function spec(
  name: string,
  display_name: string,
  logos: string[]
): KernelSpec.ISpecModel {
  const files: Record<string, string> = {
    'logo-svg': 'logo-svg.svg',
    'logo-64x64': 'logo-64x64.png',
    'logo-32x32': 'logo-32x32.png'
  };
  const resources: Record<string, string> = {};
  for (const logo of logos) {
    resources[logo] = `/lab-base/kernelspecs/${name}/${files[logo]}`;
  }
  return {
    name,
    display_name,
    language: 'python',
    argv: [],
    resources,
    env: {},
    metadata: {}
  };
}

/**
 * Five kernels: Python and R with an SVG logo, IRkernel with a PNG alone,
 * Julia with no logo, and SAS whose SVG the server does not find.
 */
function fiveKernels(): KernelSpec.ISpecModels {
  return {
    default: 'python3',
    kernelspecs: {
      xr: spec('xr', 'R 4.4.3 (xr)', ['logo-svg', 'logo-64x64']),
      julia: spec('julia', 'julia 1.10', []),
      python3: spec('python3', 'Python 3 (ipykernel)', [
        'logo-svg',
        'logo-64x64'
      ]),
      ir: spec('ir', 'R (IRkernel)', ['logo-64x64', 'logo-32x32']),
      sas: spec('sas', 'SAS (licence needed)', ['logo-svg'])
    }
  };
}

/**
 * The logos: Python's with a width and a height in points and no viewBox,
 * as ipykernel's logo-svg.svg has, and R's with a viewBox.
 */
const SVGS: Record<string, string> = {
  python3:
    '<svg xmlns="http://www.w3.org/2000/svg" width="83.371017pt" height="101.00108pt"><circle cx="55" cy="67" r="50" fill="#3776ab"/></svg>',
  xr: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text x="2" y="8">R</text></svg>'
};
/** Python's logo as the card draws it: with a viewBox of its size in pixels. */
const PYTHON_DRAWN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="83.371017pt" height="101.00108pt" viewBox="0 0 111.1614 134.6681"><circle cx="55" cy="67" r="50" fill="#3776ab"/></svg>';
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 250]);

/** The kernelspecs of a server, which change as a test says. */
class FakeKernelSpecs {
  constructor(public specs: KernelSpec.ISpecModels | null) {}
  ready = Promise.resolve();
  specsChanged = new Signal<FakeKernelSpecs, KernelSpec.ISpecModels>(this);
  change(specs: KernelSpec.ISpecModels): void {
    this.specs = specs;
    this.specsChanged.emit(specs);
  }
}

/** A server that serves the logos above, and records each request. */
function server(): {
  settings: ServerConnection.ISettings;
  requests: { url: string; authorization: string | null }[];
} {
  const requests: { url: string; authorization: string | null }[] = [];
  const settings = ServerConnection.makeSettings({
    baseUrl: BASE,
    token: 'secret',
    fetch: async (input: RequestInfo | URL) => {
      const request = input as Request;
      requests.push({
        url: request.url,
        authorization: request.headers.get('Authorization')
      });
      const path = new URL(request.url).pathname;
      const found = /\/kernelspecs\/([^/]+)\/(.+)$/.exec(path);
      if (found && found[2] === 'logo-svg.svg' && SVGS[found[1]]) {
        return new Response(SVGS[found[1]], {
          headers: { 'Content-Type': 'image/svg+xml' }
        });
      }
      if (found && found[2] === 'logo-64x64.png') {
        return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
      }
      return new Response('Not found', { status: 404 });
    }
  });
  return { settings, requests };
}

/**
 * The plugin, activated in a fake application with a real launcher model,
 * and JupyterLab's Launcher widget drawn in jsdom, in the folder
 * "analysis". The document manager's commands record what they get.
 */
async function setUp(
  options: {
    specs?: KernelSpec.ISpecModels | null;
    plugins?: string[];
  } = {}
) {
  const commands = new CommandRegistry();
  const created: any[] = [];
  const opened: any[] = [];
  commands.addCommand('docmanager:new-untitled', {
    execute: args => {
      created.push(args);
      return { path: `${args.path ? `${args.path}/` : ''}Untitled.ipynb` };
    }
  });
  commands.addCommand('docmanager:open', {
    execute: args => {
      opened.push(args);
      return null;
    }
  });
  // The sections that JupyterLab's notebook and console plugins add.
  commands.addCommand('notebook:create-new', {
    label: 'Notebook',
    execute: () => null
  });
  commands.addCommand('console:create', {
    label: 'Console',
    execute: () => null
  });
  const specs = new FakeKernelSpecs(
    options.specs === undefined ? fiveKernels() : options.specs
  );
  const { settings, requests } = server();
  const app = {
    commands,
    serviceManager: { kernelspecs: specs, serverSettings: settings },
    hasPlugin: (id: string) => (options.plugins ?? []).includes(id)
  };
  const model = new LauncherModel();
  model.add({ command: 'notebook:create-new', category: 'Notebook', rank: 0 });
  model.add({ command: 'console:create', category: 'Console', rank: 0 });
  const menu: any[] = [];
  const palette: any[] = [];
  await launcherPlugin.activate(
    app as any,
    model,
    { fileMenu: { newMenu: { addItem: (item: any) => menu.push(item) } } },
    { addItem: (item: any) => palette.push(item) },
    { model: { path: 'from-browser' } }
  );
  await specs.ready;
  const launcher = new Launcher({
    model,
    cwd: 'analysis',
    commands,
    callback: () => undefined
  });
  Widget.attach(launcher, document.body);
  const draw = () =>
    act(async () => {
      MessageLoop.sendMessage(launcher, Widget.Msg.UpdateRequest);
      await new Promise(resolve => setTimeout(resolve, 5));
    });
  await draw();
  return {
    app,
    commands,
    created,
    opened,
    specs,
    requests,
    model,
    menu,
    palette,
    launcher,
    draw
  };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

function sectionTitles(launcher: Launcher): string[] {
  return Array.from(
    launcher.node.querySelectorAll('.jp-Launcher-sectionTitle')
  ).map(node => node.textContent ?? '');
}

function section(launcher: Launcher, title: string): Element | null {
  return (
    Array.from(launcher.node.querySelectorAll('.jp-Launcher-section')).find(
      node =>
        node.querySelector('.jp-Launcher-sectionTitle')?.textContent === title
    ) ?? null
  );
}

function cards(launcher: Launcher, title = CATEGORY): HTMLElement[] {
  return Array.from(
    section(launcher, title)?.querySelectorAll<HTMLElement>(
      '.jp-LauncherCard'
    ) ?? []
  );
}

function labels(launcher: Launcher): string[] {
  return cards(launcher).map(
    card => card.querySelector('.jp-LauncherCard-label p')?.textContent ?? ''
  );
}

/** Each card's icon: the kernel it draws, and what it shows. */
function faces(launcher: Launcher): Record<string, string | null> {
  const found: Record<string, string | null> = {};
  for (const card of cards(launcher)) {
    const svg = card.querySelector('.jp-LauncherCard-icon svg');
    const name = svg?.getAttribute('data-icon') ?? 'none';
    const image = svg?.querySelector('image');
    const letter = svg?.querySelector('text');
    found[name] = image
      ? image.getAttribute('href')
      : letter
        ? `letter ${letter.textContent}`
        : null;
  }
  return found;
}

/** Draw the launcher again until every card shows its logo or its letter. */
async function logosDrawn(setup: Setup): Promise<void> {
  for (let tries = 0; tries < 40; tries++) {
    await setup.draw();
    if (Object.values(faces(setup.launcher)).every(face => face !== null)) {
      return;
    }
  }
  throw new Error(`logos not drawn: ${JSON.stringify(faces(setup.launcher))}`);
}

function base64(text: string | Uint8Array): string {
  return Buffer.from(text).toString('base64');
}

// The warning for the logo that the server does not find.
let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  document.body.innerHTML = '';
});

describe('The Whybook section of the launcher', () => {
  it('has a card for each kernel, the default first, with its name', async () => {
    const setup = await setUp();
    // Between Notebook and Console, as JupyterLab 4.6 ranks the sections.
    expect(sectionTitles(setup.launcher)).toEqual([
      'Notebook',
      'Whybook',
      'Console'
    ]);
    expect(labels(setup.launcher)).toEqual([
      'Python 3 (ipykernel)',
      'julia 1.10',
      'R (IRkernel)',
      'R 4.4.3 (xr)',
      'SAS (licence needed)'
    ]);
    // No Whybook card among the kernels of the Notebook section.
    expect(
      cards(setup.launcher, 'Notebook').map(
        card => card.querySelector('.jp-LauncherCard-label')?.textContent
      )
    ).toEqual(['Notebook']);
    // A card's title says what it makes.
    expect(cards(setup.launcher)[3].title).toBe(
      'Create a notebook with R 4.4.3 (xr) and open it in the Whybook view'
    );
  });

  it("draws each kernel's logo, fetched with the server's settings, or the kernel's first letter", async () => {
    const setup = await setUp();
    await logosDrawn(setup);
    expect(faces(setup.launcher)).toEqual({
      'whybook:kernel-python3': `data:image/svg+xml;base64,${base64(PYTHON_DRAWN)}`,
      'whybook:kernel-julia': 'letter J',
      'whybook:kernel-ir': `data:image/png;base64,${base64(PNG)}`,
      'whybook:kernel-xr': `data:image/svg+xml;base64,${base64(SVGS.xr)}`,
      // The server does not find its logo.
      'whybook:kernel-sas': 'letter S'
    });
    // The SVG when there is one, else the PNG; each request with the token.
    expect(setup.requests.map(request => request.url).sort()).toEqual([
      `${BASE}kernelspecs/ir/logo-64x64.png`,
      `${BASE}kernelspecs/python3/logo-svg.svg`,
      `${BASE}kernelspecs/sas/logo-svg.svg`,
      `${BASE}kernelspecs/xr/logo-svg.svg`
    ]);
    expect(
      setup.requests.every(request => request.authorization === 'token secret')
    ).toBe(true);
    expect(warn.mock.calls.map(call => call[0])).toEqual([
      'Whybook could not read the logo of sas.'
    ]);
  });

  it("shows Whybook's icon in the section's header, which JupyterLab takes from the first card", async () => {
    const setup = await setUp();
    await logosDrawn(setup);
    const header = section(setup.launcher, 'Whybook')!.querySelector(
      '.jp-Launcher-sectionHeader svg'
    )!;
    // The default kernel's icon, whose logo style/launcher.css hides there.
    expect(header.getAttribute('data-icon')).toBe('whybook:kernel-python3');
    // Whybook's orange tile and its [?], scaled from 22 units to 64.
    const mark = header.querySelector('.jp-Epi-launcher-mark')!;
    expect(mark.getAttribute('transform')).toBe('scale(2.9091)');
    expect(
      Array.from(mark.querySelectorAll('*')).map(
        node => node.getAttribute('d') ?? node.getAttribute('class')
      )
    ).toEqual([
      'jp-notebook-icon-color',
      null,
      'M6.7 5.7H5.2v10.6h1.5M15.3 5.7h1.5v10.6h-1.5',
      'M9 8.7a2.1 2.1 0 1 1 3.1 1.8c-.7.4-1.1.9-1.1 1.7v.2',
      null
    ]);
    expect(
      header.querySelector('.jp-Epi-launcher-logo')?.getAttribute('href')
    ).toBe(`data:image/svg+xml;base64,${base64(PYTHON_DRAWN)}`);
  });

  it("creates a notebook with the card's kernel in the launcher's folder, in the Whybook view", async () => {
    const setup = await setUp();
    const card = cards(setup.launcher).find(
      item => item.textContent === 'R 4.4.3 (xr)'
    )!;
    await act(async () => {
      card.click();
      await new Promise(resolve => setTimeout(resolve, 5));
    });
    expect(setup.created).toEqual([{ path: 'analysis', type: 'notebook' }]);
    expect(setup.opened).toEqual([
      {
        path: 'analysis/Untitled.ipynb',
        factory: 'Whybook',
        kernel: { name: 'xr' }
      }
    ]);
  });

  it('follows the kernelspecs, as the Notebook section does', async () => {
    const setup = await setUp();
    await logosDrawn(setup);
    const specs = fiveKernels();
    delete specs.kernelspecs.julia;
    delete specs.kernelspecs.sas;
    specs.kernelspecs.python3 = {
      ...specs.kernelspecs.python3!,
      display_name: 'Python 3.13'
    };
    specs.kernelspecs.ark = spec('ark', 'Ark R', []);
    specs.default = 'xr';
    setup.specs.change(specs);
    await setup.draw();
    expect(labels(setup.launcher)).toEqual([
      'R 4.4.3 (xr)',
      'Ark R',
      'Python 3.13',
      'R (IRkernel)'
    ]);
    await logosDrawn(setup);
    expect(faces(setup.launcher)['whybook:kernel-ark']).toBe('letter A');
    // One item for each kernel, and none left of the kernels that went.
    const items = Array.from(setup.model.items()).filter(
      item => item.category === CATEGORY
    );
    expect(items.map(item => item.args?.kernelName)).toEqual([
      'xr',
      'ark',
      'python3',
      'ir'
    ]);
  });

  it('adds no card while the server lists no kernelspecs', async () => {
    const setup = await setUp({ specs: null });
    expect(sectionTitles(setup.launcher)).toEqual(['Notebook', 'Console']);
    expect(kernelItems(null)).toEqual([]);
  });
});

/**
 * Where jupyterlab-launchpad puts an item, as its render() of
 * src/launcher.tsx at 6644b4e decides: the items of Notebook and Console go
 * to its kernel tables, the others to the cards of "Create or Launch", after
 * its own Notebook (rank 1) and Console (rank 4) cards, by rank.
 */
function launchpadPlaces(items: ILauncher.IItemOptions[]) {
  const kernelCategories = ['Notebook', 'Console'];
  const typeCards = [
    { command: 'notebook:create-new', rank: 1 },
    { command: 'console:create', rank: 4 },
    { command: 'terminal:create-new', rank: 3 },
    ...items.filter(
      item => !item.category || !kernelCategories.includes(item.category)
    )
  ].sort(
    (a, b) =>
      (a.rank ?? Number.POSITIVE_INFINITY) -
      (b.rank ?? Number.POSITIVE_INFINITY)
  );
  return {
    typeCards: typeCards.map(item => item.command),
    notebookTable: items.filter(item => item.category === 'Notebook')
  };
}

describe('Under jupyterlab-launchpad', () => {
  it('detects it by the id of the plugin that provides its launcher', () => {
    expect(usesLaunchpad({ hasPlugin: () => false })).toBe(false);
    for (const id of LAUNCHPAD_PLUGINS) {
      expect(usesLaunchpad({ hasPlugin: other => other === id })).toBe(true);
    }
    expect(LAUNCHPAD_PLUGINS[0]).toBe('jupyterlab-launchpad:plugin');
  });

  it('adds one Whybook card, after its Notebook card, whose kernel the kernel dialog asks for', async () => {
    const setup = await setUp({ plugins: ['jupyterlab-launchpad:plugin'] });
    setup.specs.change(fiveKernels());
    const ours = Array.from(setup.model.items()).filter(
      item => item.command === NEW_WHYBOOK
    );
    expect(ours).toHaveLength(1);
    const places = launchpadPlaces(ours);
    expect(places.notebookTable).toEqual([]);
    expect(places.typeCards).toEqual([
      'notebook:create-new',
      NEW_WHYBOOK,
      'terminal:create-new',
      'console:create'
    ]);
    // Its card, as launchpad's Item reads it: the view's name and icon.
    const args = { ...ours[0].args, cwd: 'analysis' };
    expect(setup.commands.label(NEW_WHYBOOK, args)).toBe('Whybook');
    expect(setup.commands.icon(NEW_WHYBOOK, args)).toBe(epiIcon);
    expect(setup.commands.caption(NEW_WHYBOOK, args)).toBe(
      'Create a notebook, choose its kernel, and open it in the Whybook view'
    );
    // No kernel: the document's session asks with the kernel dialog, which
    // launchpad replaces with its table of kernels.
    await setup.commands.execute(NEW_WHYBOOK, args);
    expect(setup.opened).toEqual([
      { path: 'analysis/Untitled.ipynb', factory: 'Whybook' }
    ]);
  });
});

describe('File, New and the command palette', () => {
  it('keep their entries, and start the default kernel in the file browser folder', async () => {
    const setup = await setUp();
    expect(setup.menu).toEqual([{ command: NEW_WHYBOOK, rank: 31 }]);
    expect(setup.palette).toEqual([
      { command: NEW_WHYBOOK, category: 'Whybook', args: { isPalette: true } }
    ]);
    expect(setup.commands.label(NEW_WHYBOOK, { isPalette: true })).toBe(
      'New Whybook'
    );
    expect(setup.commands.icon(NEW_WHYBOOK, { isPalette: true })).toBe(
      undefined
    );
    expect(setup.commands.label(NEW_WHYBOOK, {})).toBe('Whybook');
    expect(setup.commands.icon(NEW_WHYBOOK, {})).toBe(epiIcon);
    await setup.commands.execute(NEW_WHYBOOK, {});
    expect(setup.opened).toEqual([
      {
        path: 'from-browser/Untitled.ipynb',
        factory: 'Whybook',
        kernel: { name: 'python3' }
      }
    ]);
  });
});

describe('The icon of a kernel', () => {
  it('escapes the letter and the address of the image', () => {
    expect(kernelIconSvg({ letter: '<' })).toContain('>&lt;</text>');
    expect(kernelIconSvg({ image: 'data:a"b&c' })).toContain(
      'href="data:a&quot;b&amp;c"'
    );
    expect(kernelIconSvg(null)).not.toMatch(/<image|<text/);
  });
});
