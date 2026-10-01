/**
 * The tooltip of a chip (design iteration 1.86): the view's own, in place of
 * the browser's `title`. It shows after a short rest of the pointer and at
 * once on the keyboard's focus, hides on leaving, a press, a key that
 * activates the element and Escape, and is not drawn while the questions of
 * a chip are open under it.
 */
import './fakes/quiet';

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { decisionChips } from '../model/decisions';
import type { IDecision } from '../tokens';
import { DecisionChip } from '../ui/common';
import type { ITooltip } from '../ui/tooltip';
import { TOOLTIP_DELAY, useTooltip } from '../ui/tooltip';
import { mount, step } from './fakes/bench-render';

const HOW: IDecision = {
  name: 'how',
  value: "'inner'",
  provenance: 'library_default',
  param: 'how',
  function: 'DataFrame.merge',
  note: 'rows without a match in both frames are dropped',
  library: 'pandas',
  version: '3.0.6',
  calls: [{ line: 4, col: 5, target: 'homes' }]
};

/** The tooltip that is drawn now, if any. */
function drawn(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.jp-Epi-tooltip');
}

/** A button with a tooltip: the latest `ITooltip` is in `latest`. */
function Harness(props: {
  lines: string[] | null;
  latest: { current: ITooltip | null };
}): JSX.Element {
  const tooltip = useTooltip(props.lines, { code: true });
  props.latest.current = tooltip;
  return (
    <button id="target" {...tooltip.props}>
      chip
      {tooltip.node}
    </button>
  );
}

describe('the tooltip of a chip', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    document.querySelectorAll('.jp-Epi-popover').forEach(node => node.remove());
  });

  async function mountHarness(lines: string[] | null = ['how = 1', 'merge']) {
    const latest: { current: ITooltip | null } = { current: null };
    const mounted = await mount(<Harness lines={lines} latest={latest} />);
    const target = mounted.host.querySelector<HTMLElement>('#target')!;
    const enter = (pointerType = 'mouse') =>
      step(() =>
        latest.current!.props.onPointerEnter({
          currentTarget: target,
          pointerType
        } as unknown as React.PointerEvent<HTMLElement>)
      );
    const wait = (ms: number) =>
      step(() => {
        jest.advanceTimersByTime(ms);
      });
    return { mounted, latest, target, enter, wait };
  }

  it('has no title for the browser to show, and none of its own until the pointer rests', async () => {
    const chip = decisionChips([HOW])[0];
    const markup = renderToStaticMarkup(<DecisionChip chip={chip} />);
    expect(markup).not.toContain('title=');
    expect(markup).not.toContain('aria-describedby');
    expect(drawn()).toBeNull();
  });

  it('shows after the delay and not before, with the first line as code, and describes its element', async () => {
    const { mounted, enter, wait, target } = await mountHarness();
    try {
      await enter();
      await wait(TOOLTIP_DELAY - 1);
      expect(drawn()).toBeNull();
      await wait(1);
      const tooltip = drawn()!;
      expect(tooltip.getAttribute('role')).toBe('tooltip');
      expect(
        Array.from(tooltip.children).map(line => line.textContent)
      ).toEqual(['how = 1', 'merge']);
      expect(tooltip.children[0].querySelector('code')).not.toBeNull();
      expect(tooltip.children[1].querySelector('code')).toBeNull();
      expect(target.getAttribute('aria-describedby')).toBe(tooltip.id);
      // Placed before it paints: no longer hidden.
      expect(tooltip.style.visibility).toBe('visible');
      // It lives in the page's body, so that no card clips it.
      expect(tooltip.parentElement).toBe(document.body);
    } finally {
      await mounted.unmount();
    }
    expect(drawn()).toBeNull();
  });

  it('shows nothing when the pointer leaves before the delay, and hides when it leaves after', async () => {
    const { mounted, latest, enter, wait, target } = await mountHarness();
    try {
      await enter();
      await wait(200);
      await step(() => latest.current!.props.onPointerLeave());
      await wait(1000);
      expect(drawn()).toBeNull();
      await enter();
      await wait(TOOLTIP_DELAY);
      expect(drawn()).not.toBeNull();
      await step(() => latest.current!.props.onPointerLeave());
      expect(drawn()).toBeNull();
      expect(target.getAttribute('aria-describedby')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('hides on Escape wherever the focus is, on a press and on the keys that activate the element', async () => {
    const { mounted, latest, enter, wait } = await mountHarness();
    try {
      for (const hide of [
        () =>
          document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
          ),
        () => latest.current!.props.onPointerDown(),
        () =>
          latest.current!.props.onKeyDown({
            key: 'Enter'
          } as React.KeyboardEvent<HTMLElement>),
        () =>
          latest.current!.props.onKeyDown({
            key: ' '
          } as React.KeyboardEvent<HTMLElement>)
      ]) {
        await enter();
        await wait(TOOLTIP_DELAY);
        expect(drawn()).not.toBeNull();
        await step(hide);
        expect(drawn()).toBeNull();
      }
      // Another key leaves it be.
      await enter();
      await wait(TOOLTIP_DELAY);
      await step(() =>
        latest.current!.props.onKeyDown({
          key: 'Tab'
        } as React.KeyboardEvent<HTMLElement>)
      );
      expect(drawn()).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('shows at once on the keyboard’s focus, and not on a click’s', async () => {
    const { mounted, latest, target } = await mountHarness();
    const matches = Element.prototype.matches;
    const focus = (visible: boolean) => {
      Element.prototype.matches = function (this: Element, selector: string) {
        return selector === ':focus-visible'
          ? visible
          : matches.call(this, selector);
      };
      return step(() =>
        latest.current!.props.onFocus({
          currentTarget: target
        } as unknown as React.FocusEvent<HTMLElement>)
      );
    };
    try {
      await focus(false);
      expect(drawn()).toBeNull();
      await focus(true);
      expect(drawn()).not.toBeNull();
      await step(() => latest.current!.props.onBlur());
      expect(drawn()).toBeNull();
    } finally {
      Element.prototype.matches = matches;
      await mounted.unmount();
    }
  });

  it('is not drawn for a touch, while the questions of a chip are open, or without lines', async () => {
    const touch = await mountHarness();
    try {
      await touch.enter('touch');
      await touch.wait(TOOLTIP_DELAY);
      expect(drawn()).toBeNull();
    } finally {
      await touch.mounted.unmount();
    }
    const popover = document.createElement('div');
    popover.className = 'jp-Epi-popover';
    document.body.appendChild(popover);
    const open = await mountHarness();
    try {
      await open.enter();
      await open.wait(TOOLTIP_DELAY);
      expect(drawn()).toBeNull();
    } finally {
      await open.mounted.unmount();
    }
    popover.remove();
    const empty = await mountHarness([]);
    try {
      await empty.enter();
      await empty.wait(TOOLTIP_DELAY);
      expect(drawn()).toBeNull();
    } finally {
      await empty.mounted.unmount();
    }
  });

  it('draws nothing when its element goes before the delay is over', async () => {
    const { mounted, enter, wait } = await mountHarness();
    await enter();
    await mounted.unmount();
    await step(() => {
      jest.advanceTimersByTime(TOOLTIP_DELAY * 2);
    });
    await wait(0);
    expect(drawn()).toBeNull();
  });
});
