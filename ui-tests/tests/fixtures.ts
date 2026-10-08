import { expect, test as base } from '@jupyterlab/galata';

/**
 * The routes of the server extension whose requests reach a model
 * (whybook/server/routes.py, src/model/api.ts): a model reads the request,
 * the server fetches a model's files, or it asks a model server or a
 * provider which models it has or whether a key works.
 */
export const MODEL_ROUTES = [
  // The connected model, a local model, Jev, or a speech engine.
  'solve',
  'agent',
  'agent/result',
  'questions/claude',
  'questions/review',
  'questions/sort',
  'questions/rank',
  'decision/values',
  'defaults/ask',
  'dependencies/claude',
  'tables/describe',
  'frames/describe',
  'cells/title',
  'speech/transcribe',
  // A model's files, from Hugging Face or from Moonshine's site.
  'models/download',
  'speech/download',
  // A model server on this machine, or a provider. A GET of `connection`
  // reads the saved choice and reaches neither: it goes to the server.
  'connection',
  'connection/models',
  'connection/local',
  'auth/key',
  'auth/openrouter/code',
  'auth/huggingface',
  'auth/huggingface/poll'
];

const MODEL_PATH = new RegExp(`/whybook/(${MODEL_ROUTES.join('|')})$`);

const KERNEL_ACTION = /\/api\/kernels\/[^/]+\/(restart|interrupt)$/;

export const test = base.extend<{ modelRoutes: void; kernelActions: void }>({
  /**
   * Abort every request to a model route that the test does not answer
   * itself: the test server would run a local model on this machine, fetch
   * a model's files, or ask a provider. Playwright tries the routes that
   * match a request from the last registered to the first, so a test's own
   * `page.route`, registered after this one, answers first, and this one
   * takes a request that it passes on with `route.fallback()`. Each aborted
   * request is noted on the test as an annotation.
   */
  modelRoutes: [
    async ({ page }, use, testInfo) => {
      await page.route(
        url => MODEL_PATH.test(url.pathname),
        route => {
          const request = route.request();
          const name = MODEL_PATH.exec(new URL(request.url()).pathname)![1];
          if (name === 'connection' && request.method() === 'GET') {
            return route.fallback();
          }
          testInfo.annotations.push({
            type: 'aborted model route',
            description: `${request.method()} /whybook/${name}`
          });
          return route.abort('blockedbyclient');
        }
      );
      await use();
    },
    { auto: true }
  ],

  /**
   * Send the restart and the interrupt of a kernel to the server past
   * galata's mock of the kernels, which takes every POST under /api/kernels
   * for the start of a kernel. The mock answers a restart with 201, where
   * JupyterLab expects 200: the session's `restartKernel()` then throws
   * before it reconnects to the new kernel, and a reply that the new kernel
   * sends while the server's sockets reconnect can be lost. The view's
   * request for a subshell went unanswered that way, and a question about a
   * variable from the last run waited 10 s before it offered to run its
   * cells. The mock also reads an interrupt's empty 204 as JSON, and the
   * test fails with "Unexpected end of JSON input".
   */
  kernelActions: [
    async ({ page }, use) => {
      await page.route(
        url => KERNEL_ACTION.test(url.pathname),
        route => route.continue()
      );
      await use();
    },
    { auto: true }
  ]
});

export { expect };

/**
 * A request's body without the review guard's object. The server reads the
 * notebook's columns from it to check what would leave the machine, and no
 * model reads it: a check that a request holds nothing of the notebook
 * leaves it out.
 */
export function withoutGuard(body: any): any {
  const copy = { ...body };
  delete copy.guard;
  return copy;
}
