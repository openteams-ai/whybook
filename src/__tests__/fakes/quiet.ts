/**
 * Warnings that JupyterLab's modules and a notebook model built in a test
 * give in jest, and the view in a browser does not: the clipboard of
 * @jupyterlab/apputils, and Yjs, which reads each cell's map once before the
 * map joins the notebook's document. Import this before any of them.
 */
const warn = console.warn;
const NOISE = [
  'Invalid access: Add Yjs type to a document',
  '[yjs#509] Not same Y.Doc',
  'Clipboard API not available'
];
console.warn = (...args: unknown[]) => {
  const text = String(args[0] ?? '');
  if (!NOISE.some(noise => text.startsWith(noise))) {
    warn(...args);
  }
};

export {};
