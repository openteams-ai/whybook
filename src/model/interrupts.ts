import type { ISessionContext } from '@jupyterlab/apputils';

/**
 * The interrupts of the kernel of each notebook's session that Whybook knows
 * of. Run all stops at an interrupt during its run, as Run All Cells of
 * JupyterLab's notebook stops (design iteration 1.135). The views of one
 * notebook share its session, so an interrupt from one view stops the Run
 * all of another.
 */
const counts = new WeakMap<ISessionContext, number>();

/** Interrupt the kernel of a notebook, as Interrupt Kernel does. */
export async function interruptKernel(
  sessionContext: ISessionContext
): Promise<void> {
  countInterrupt(sessionContext);
  await sessionContext.session?.kernel?.interrupt();
}

/**
 * Count an interrupt that Whybook did not send: a cell stopped at a
 * KeyboardInterrupt, as an interrupt from another client of the kernel,
 * such as JupyterLab's notebook, gives.
 */
export function countInterrupt(sessionContext: ISessionContext): void {
  counts.set(sessionContext, interruptsOf(sessionContext) + 1);
}

/** How many interrupts of the kernel of this session Whybook knows of. */
export function interruptsOf(sessionContext: ISessionContext): number {
  return counts.get(sessionContext) ?? 0;
}
