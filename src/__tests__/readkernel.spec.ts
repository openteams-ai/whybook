/**
 * The view reads a kernel only after its plot hooks are in: the hooks keep
 * IPython's callbacks out of the view's silent requests, and without them a
 * request that ends while a cell draws shows that cell's figure in its own
 * output, so the figure is lost (src/model/epimodel.ts, `_readKernel`).
 */
import { EpiModel } from '../model/epimodel';

describe('the view reading a kernel', () => {
  it('waits for the plot hooks before it reads the variables', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const hooks = new Promise<null>(resolve => {
      release = () => {
        order.push('hooks');
        resolve(null);
      };
    });
    const model = Object.create(EpiModel.prototype);
    Object.assign(model, {
      _refreshPolicy: { refreshing: () => undefined },
      plotHooks: { ready: () => hooks },
      bridge: {
        refreshVariables: async () => {
          order.push('variables');
        },
        refreshAnalysis: async () => {
          order.push('analysis');
        }
      },
      codeCells: () => [],
      _emit: () => undefined,
      _version: 0
    });
    const reading = model._readKernel();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(order).toEqual([]);
    release();
    await reading;
    expect(order).toEqual(['hooks', 'variables', 'analysis']);
  });
});
