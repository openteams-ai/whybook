/**
 * A React root in jsdom for the tests of the bench, the map and the Code
 * view. Each step runs in `act`, as a key or a click does in the page.
 */
import * as React from 'react';
import { createRoot } from 'react-dom/client';

const act: (callback: () => void | Promise<void>) => Promise<void> = (
  React as any
).act;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

export interface IMounted {
  host: HTMLDivElement;
  render(element: React.ReactElement): Promise<void>;
  unmount(): Promise<void>;
}

export async function mount(element: React.ReactElement): Promise<IMounted> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const mounted: IMounted = {
    host,
    render: async next => {
      await act(() => {
        root.render(next);
      });
    },
    unmount: async () => {
      await act(() => {
        root.unmount();
      });
      host.remove();
    }
  };
  await mounted.render(element);
  return mounted;
}

/**
 * Let the model's next frame, and the promises due until then, run: the
 * view draws the model's changes.
 */
export async function settle(ms = 40): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
}

/** Run one step of the analyst, such as a click, and what it draws. */
export async function step(callback: () => void): Promise<void> {
  await act(() => {
    callback();
  });
}

/** The button of this text in the host. */
export function button(host: Element, text: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(
    item => item.textContent?.trim() === text
  );
  if (!found) {
    throw new Error(`no button "${text}"`);
  }
  return found;
}

/** Where the keyboard focus is, in words, for a failure message. */
export function focused(): string {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) {
    return 'the page body';
  }
  const text = active.textContent?.trim().slice(0, 40) ?? '';
  return `${active.tagName.toLowerCase()}${active.className ? `.${active.className.split(' ').join('.')}` : ''} "${text}"`;
}
