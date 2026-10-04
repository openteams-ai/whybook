import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { IDefaultFileBrowser } from '@jupyterlab/filebrowser';
import { ILauncher } from '@jupyterlab/launcher';
import { IMainMenu } from '@jupyterlab/mainmenu';
import type { Contents, KernelSpec } from '@jupyterlab/services';
import { ServerConnection } from '@jupyterlab/services';
import { LabIcon } from '@jupyterlab/ui-components';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import type { IDisposable } from '@lumino/disposable';
import { DisposableDelegate, DisposableSet } from '@lumino/disposable';

import { epiIcon } from './icons';
import { FACTORY } from './widgets';

/** The command that creates a notebook and opens it in the Whybook view. */
export const NEW_WHYBOOK = 'whybook:new-epinotebook';

/** The section of JupyterLab's launcher that holds a card for each kernel. */
export const CATEGORY = 'Whybook';

/**
 * The rank of the section: JupyterLab 4.6 gives Notebook 0 and Console 20,
 * so the section comes between them. JupyterLab 4.4 and 4.5 have no rank
 * for sections, and put it after Other.
 */
const CATEGORY_RANK = 10;

/**
 * The rank of the one card under jupyterlab-launchpad, among its cards of
 * "Create or Launch": after its Notebook card, rank 1, and before its
 * Terminal card, rank 3 (`typeCommands` and `rankOverrides` in its
 * src/launcher.tsx).
 */
const LAUNCHPAD_RANK = 2;

/**
 * The plugins that provide jupyterlab-launchpad's launcher: its id since
 * 1.0.0 (`MAIN_PLUGIN_ID` in its src/types.ts), and the id of 0.x, when the
 * package was jupyterlab-new-launcher. JupyterLab registers no plugin that
 * the page config disables, so the id is there only while that launcher is.
 */
export const LAUNCHPAD_PLUGINS = [
  'jupyterlab-launchpad:plugin',
  'jupyterlab-new-launcher:plugin'
];

/**
 * Whether jupyterlab-launchpad draws the launcher. It lists the items of
 * Notebook and Console as rows of its kernel tables, and the items of any
 * other section as cards of its "Create or Launch" section, beside the cards
 * for a new file: a card for each kernel would go there.
 */
export function usesLaunchpad(app: {
  hasPlugin(id: string): boolean;
}): boolean {
  return LAUNCHPAD_PLUGINS.some(id => app.hasPlugin(id));
}

/** The arguments of the command. */
export interface INewWhybookArgs {
  /** The folder of the new notebook: the launcher's, else the file browser's. */
  cwd?: string;
  /** The kernel to start: the name of a kernelspec. */
  kernelName?: string;
  /** Ask for the kernel in the kernel dialog, rather than start the default one. */
  chooseKernel?: boolean;
  /** Set by the launcher: with a kernel, the label is the kernel's name. */
  isLauncher?: boolean;
  /** Set by the command palette: the label reads "New Whybook", with no icon. */
  isPalette?: boolean;
}

/** The launcher's items for a set of kernelspecs, the default kernel first. */
export function kernelItems(
  specs: KernelSpec.ISpecModels | null
): ILauncher.IItemOptions[] {
  if (!specs) {
    return [];
  }
  const named = Object.entries(specs.kernelspecs).filter(
    (entry): entry is [string, KernelSpec.ISpecModel] => !!entry[1]
  );
  // The launcher sorts a section by rank, then by label: this order.
  named.sort(([a, first], [b, second]) =>
    a === specs.default
      ? -1
      : b === specs.default
        ? 1
        : first.display_name.localeCompare(second.display_name)
  );
  return named.map(([name, spec]) => {
    const logo = logoOf(spec);
    return {
      command: NEW_WHYBOOK,
      args: { isLauncher: true, kernelName: name },
      category: CATEGORY,
      categoryRank: CATEGORY_RANK,
      rank: name === specs.default ? 0 : Infinity,
      // The image of a kernel's item, which JupyterLab 4.6 draws only in
      // Notebook and Console.
      ...(logo ? { kernelIconUrl: logo.url } : {})
    };
  });
}

/** The one card under jupyterlab-launchpad: its kernel dialog asks for the kernel. */
export function launchpadItem(): ILauncher.IItemOptions {
  return {
    command: NEW_WHYBOOK,
    args: { isLauncher: true, chooseKernel: true },
    category: CATEGORY,
    rank: LAUNCHPAD_RANK
  };
}

/**
 * Add Whybook's items to the launcher: under jupyterlab-launchpad one card,
 * and otherwise a section with a card for each kernel, which follows the
 * kernelspecs as the Notebook section does.
 */
export function addLauncherItems(options: {
  launcher: ILauncher;
  kernelspecs: KernelSpec.IManager;
  launchpad: boolean;
}): IDisposable {
  const { launcher, kernelspecs } = options;
  if (options.launchpad) {
    return launcher.add(launchpadItem());
  }
  let items = new DisposableSet();
  const update = () => {
    items.dispose();
    items = new DisposableSet();
    for (const item of kernelItems(kernelspecs.specs)) {
      items.add(launcher.add(item));
    }
  };
  void kernelspecs.ready.then(update);
  kernelspecs.specsChanged.connect(update);
  return new DisposableDelegate(() => {
    kernelspecs.specsChanged.disconnect(update);
    items.dispose();
  });
}

/**
 * The logo that Whybook draws for a kernel: its SVG, else its 64 px PNG,
 * the two that JupyterLab's Notebook section shows.
 */
function logoOf(
  spec: KernelSpec.ISpecModel
): { url: string; type: string } | null {
  const svg = spec.resources['logo-svg'];
  if (svg) {
    return { url: svg, type: 'image/svg+xml' };
  }
  const png = spec.resources['logo-64x64'];
  if (png) {
    return { url: png, type: 'image/png' };
  }
  return null;
}

/** The width of a kernel's icon, in the units of its SVG. */
const SIZE = 64;

/** What the SVG of Whybook's icon draws, without the `<svg>` around it. */
const EPI_BODY = epiIcon.svgstr.replace(/^<svg[^>]*>|<\/svg>$/g, '');

/** The width of Whybook's icon, in the units of its SVG. */
const EPI_SIZE = 22;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The SVG of a kernel's card: the kernel's logo as an image, or the first
 * letter of its name when it has no logo, as JupyterLab's Notebook section
 * draws such a kernel; nothing while its logo loads. The launcher draws the
 * header of a section with the icon of the section's first card, the
 * default kernel, so the SVG also holds Whybook's icon, which only the
 * header shows (style/launcher.css). An `<image>` in an SVG, as an `<img>`,
 * runs no script of the logo and loads no other file. The letter reaches
 * past the SVG's box, as JupyterLab's letter reaches past its line: "J"
 * lost the end of its hook when the box cut it.
 */
export function kernelIconSvg(
  face: { image: string } | { letter: string } | null
): string {
  let logo = '';
  if (face && 'image' in face) {
    logo = `<image class="jp-Epi-launcher-logo" href="${escapeXml(face.image)}" width="${SIZE}" height="${SIZE}" preserveAspectRatio="xMidYMid meet"/>`;
  } else if (face) {
    logo = `<text class="jp-Epi-launcher-logo jp-Epi-launcher-letter" x="${SIZE / 2}" y="${SIZE / 2}" text-anchor="middle" dominant-baseline="central">${escapeXml(face.letter)}</text>`;
  }
  const mark = `<g class="jp-Epi-launcher-mark" transform="scale(${(SIZE / EPI_SIZE).toFixed(4)})">${EPI_BODY}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" overflow="visible">${logo}${mark}</svg>`;
}

/** CSS pixels in one unit of an SVG's width or height. */
const PIXELS: Record<string, number> = {
  '': 1,
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4
};

/**
 * An SVG logo with a viewBox. An `<image>` stretches an SVG that has a width
 * and a height but no viewBox to its own width, where an `<img>` keeps its
 * proportions: ipykernel's Python logo, 83.4 by 101 pt, came out 52 px wide
 * where the Notebook section draws it 43 px wide. Without a viewBox, one
 * unit of the SVG is one pixel, so the viewBox is its size in pixels.
 */
export function withViewBox(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (
    root.localName !== 'svg' ||
    root.hasAttribute('viewBox') ||
    doc.getElementsByTagName('parsererror').length
  ) {
    return svg;
  }
  const pixels = (value: string | null) => {
    const found = /^\s*(\d*\.?\d+(?:e[+-]?\d+)?)\s*([a-z]*)\s*$/i.exec(
      value ?? ''
    );
    const unit = found ? PIXELS[found[2].toLowerCase()] : undefined;
    return found && unit ? parseFloat(found[1]) * unit : null;
  };
  const width = pixels(root.getAttribute('width'));
  const height = pixels(root.getAttribute('height'));
  if (!width || !height) {
    return svg;
  }
  root.setAttribute(
    'viewBox',
    `0 0 ${+width.toFixed(4)} ${+height.toFixed(4)}`
  );
  return new XMLSerializer().serializeToString(doc);
}

/** The bytes of a file as base64. */
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

/**
 * The icons of the kernels' cards, one LabIcon for each kernel. An icon is
 * empty until the kernel's logo comes from the server, fetched with the
 * server's settings. Then it shows the logo, or the first letter of the
 * kernel's name when the kernel has no logo or the logo cannot be read.
 */
export class KernelIcons {
  constructor(private _serverSettings: ServerConnection.ISettings) {}

  /** The icon of a kernel. It fetches the kernel's logo once for each URL. */
  icon(name: string, spec: KernelSpec.ISpecModel | undefined): LabIcon {
    let entry = this._icons.get(name);
    if (!entry) {
      entry = {
        icon: new LabIcon({
          name: `whybook:kernel-${name}`,
          svgstr: kernelIconSvg(null)
        }),
        url: undefined
      };
      this._icons.set(name, entry);
    }
    if (!spec) {
      return entry.icon;
    }
    const logo = logoOf(spec);
    const url = logo?.url ?? null;
    if (entry.url !== url) {
      entry.url = url;
      const letter = (spec.display_name || name).charAt(0).toUpperCase();
      void this._draw(entry, name, logo, letter);
    }
    return entry.icon;
  }

  private async _draw(
    entry: { icon: LabIcon; url: string | null | undefined },
    name: string,
    logo: { url: string; type: string } | null,
    letter: string
  ): Promise<void> {
    let face: { image: string } | { letter: string } = { letter };
    if (logo) {
      try {
        face = { image: await this._fetch(logo) };
      } catch (reason) {
        console.warn(`Whybook could not read the logo of ${name}.`, reason);
      }
    }
    // A later kernelspec can change the logo while this one loads: only the
    // current one is drawn.
    if (entry.url === (logo?.url ?? null)) {
      entry.icon.svgstr = kernelIconSvg(face);
    }
  }

  /** A logo from the server, as a data URL. */
  private async _fetch(logo: { url: string; type: string }): Promise<string> {
    if (logo.url.startsWith('data:')) {
      return logo.url;
    }
    const url = new URL(logo.url, this._serverSettings.baseUrl).href;
    // The browser's cache, as for the `<img>` of the Notebook section.
    const response = await ServerConnection.makeRequest(
      url,
      { cache: 'default' },
      this._serverSettings
    );
    if (!response.ok) {
      throw new ServerConnection.ResponseError(response);
    }
    let bytes = new Uint8Array(await response.arrayBuffer());
    if (logo.type === 'image/svg+xml') {
      const svg = new TextDecoder().decode(bytes);
      bytes = new TextEncoder().encode(withViewBox(svg));
    }
    return `data:${logo.type};base64,${base64(bytes)}`;
  }

  private _icons = new Map<
    string,
    { icon: LabIcon; url: string | null | undefined }
  >();
}

/**
 * The command that creates a notebook in a folder and opens it in the
 * Whybook view, with the kernel of a launcher's card, the kernel that the
 * kernel dialog gives, or the default kernel.
 */
export function addNewWhybookCommand(
  app: Pick<JupyterFrontEnd, 'commands' | 'serviceManager'>,
  options: { icons: KernelIcons; folder: () => string }
): IDisposable {
  const { commands } = app;
  const kernelspecs = app.serviceManager.kernelspecs;
  /** The kernelspec of a launcher's card, or undefined. */
  const cardKernel = (args: INewWhybookArgs) =>
    args.isLauncher && args.kernelName
      ? {
          name: args.kernelName,
          spec: kernelspecs.specs?.kernelspecs[args.kernelName]
        }
      : undefined;
  return commands.addCommand(NEW_WHYBOOK, {
    label: args => {
      const card = cardKernel(args as INewWhybookArgs);
      if (card) {
        return card.spec?.display_name || card.name;
      }
      return args.isPalette ? 'New Whybook' : 'Whybook';
    },
    caption: args => {
      const card = cardKernel(args as INewWhybookArgs);
      if (card) {
        return `Create a notebook with ${card.spec?.display_name || card.name} and open it in Whybook`;
      }
      return args.chooseKernel
        ? 'Create a notebook, choose its kernel, and open it in Whybook'
        : 'Create a notebook and open it in Whybook';
    },
    icon: args => {
      if (args.isPalette) {
        return undefined;
      }
      const card = cardKernel(args as INewWhybookArgs);
      return card ? options.icons.icon(card.name, card.spec) : epiIcon;
    },
    describedBy: {
      args: {
        type: 'object',
        properties: {
          cwd: {
            type: 'string',
            description:
              "The folder of the new notebook: the launcher's, else the file browser's"
          },
          kernelName: {
            type: 'string',
            description:
              'The kernel to start, by the name of its kernelspec; without it, the default kernel'
          },
          chooseKernel: {
            type: 'boolean',
            description:
              'Ask for the kernel in the kernel dialog, as the Whybook card of jupyterlab-launchpad does'
          },
          isLauncher: {
            type: 'boolean',
            description:
              "Set by the launcher: with kernelName, the label is the kernel's name"
          },
          isPalette: {
            type: 'boolean',
            description:
              'Set by the command palette, where the label reads "New Whybook" with no icon'
          }
        }
      }
    },
    execute: async args => {
      const given = args as INewWhybookArgs & ReadonlyPartialJSONObject;
      // The launcher passes its folder; the menu and the palette use the
      // file browser's.
      const cwd = given.cwd ?? options.folder();
      const created: Contents.IModel = await commands.execute(
        'docmanager:new-untitled',
        { path: cwd, type: 'notebook' }
      );
      // With no kernel, the document's session asks with the kernel dialog,
      // which jupyterlab-launchpad replaces with its table of kernels.
      const kernel =
        given.kernelName ||
        (given.chooseKernel ? undefined : kernelspecs.specs?.default);
      return commands.execute('docmanager:open', {
        path: created.path,
        factory: FACTORY,
        ...(kernel ? { kernel: { name: kernel } } : {})
      });
    }
  });
}

/**
 * The ways to start a Whybook: a section of JupyterLab's launcher with a card
 * for each kernel, File › New › Whybook and the command palette (design
 * iteration 1.72). Under jupyterlab-launchpad the launcher has one Whybook
 * card, and the kernel dialog asks for the kernel. A plugin of its own, so
 * that the section can go without a trace.
 */
export const launcherPlugin: JupyterFrontEndPlugin<void> = {
  id: 'whybook:launcher',
  description:
    'Creates a notebook in Whybook from the launcher, with a card for each kernel, from File, New and from the command palette.',
  autoStart: true,
  optional: [ILauncher, IMainMenu, ICommandPalette, IDefaultFileBrowser],
  activate: (
    app: JupyterFrontEnd,
    launcher: ILauncher | null,
    mainMenu: IMainMenu | null,
    palette: ICommandPalette | null,
    fileBrowser: IDefaultFileBrowser | null
  ) => {
    const icons = new KernelIcons(app.serviceManager.serverSettings);
    addNewWhybookCommand(app, {
      icons,
      folder: () => fileBrowser?.model.path ?? ''
    });
    if (launcher) {
      addLauncherItems({
        launcher,
        kernelspecs: app.serviceManager.kernelspecs,
        launchpad: usesLaunchpad(app)
      });
    }
    mainMenu?.fileMenu.newMenu.addItem({ command: NEW_WHYBOOK, rank: 31 });
    palette?.addItem({
      command: NEW_WHYBOOK,
      category: 'Whybook',
      args: { isPalette: true }
    });
  }
};
