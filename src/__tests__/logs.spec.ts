import { SHORT_TEXT_LINES, outputText, readText } from '../model/logs';

const WARNINGS =
  '/site-packages/statsmodels/regression/mixed_linear_model.py:2384: ' +
  'ConvergenceWarning: Maximum Likelihood optimization failed to converge. ' +
  'Check mle_retvals\n' +
  '  rslt = super().fit(\n' +
  '/tmp/ipykernel_58783/262504853.py:8: ConvergenceWarning: Retrying ' +
  'MixedLM optimization with lbfgs\n' +
  '  sleep_fit = smf.mixedlm("sleep_hours ~ treatment_arm * month + age",\n';

describe('readText', () => {
  it('cuts each warning to its category and message', () => {
    expect(readText(WARNINGS)).toEqual({
      lines: [
        'ConvergenceWarning: Maximum Likelihood optimization failed to converge. Check mle_retvals',
        'ConvergenceWarning: Retrying MixedLM optimization with lbfgs'
      ],
      total: 4,
      warnings: 2,
      hidden: 0
    });
  });

  it("leaves out IPython's messages about its history database", () => {
    const history =
      'The history saving thread hit an unexpected error ' +
      "(OperationalError('attempt to write a readonly database'))." +
      'History will not be written to the database.\n';
    expect(readText(history)).toEqual({
      lines: [],
      total: 0,
      warnings: 0,
      hidden: 1
    });
    expect(readText(`fitting\n${history}done\n`).lines).toEqual([
      'fitting',
      'done'
    ]);
  });

  it('keeps a line as last drawn, without colour codes', () => {
    const text = '\u001b[32mfitting\u001b[0m\n10%\r50%\r100%\ndone\n';
    expect(readText(text).lines).toEqual(['fitting', '100%', 'done']);
  });
});

describe('outputText', () => {
  it('reads a stream, and a plain-text result', () => {
    const printed = outputText({
      'application/vnd.jupyter.stdout':
        'Residual SD 0.72; 3 residuals beyond 3\n'
    });
    expect(printed).toMatchObject({
      lines: ['Residual SD 0.72; 3 residuals beyond 3'],
      stream: 'stdout'
    });
    const result = outputText({ 'text/plain': ['count  40\n', 'mean  -1.4'] });
    expect(result).toMatchObject({
      lines: ['count  40', 'mean  -1.4'],
      stream: null
    });
    expect(outputText({ 'image/png': 'abc' })).toBeNull();
  });

  it('reads the log that sas_kernel sends as HTML, whose plain text only names the object', () => {
    // The log of a cell of the real SAS notebook (research/sas_kernel/sgf2019_gaines), cut.
    const html =
      '<!DOCTYPE html>\n<html>\n<head>\n  <title></title>\n  <style>.cm { color: green }</style>\n</head>\n<body>\n<h2></h2>\n\n' +
      '<div class="highlight"><pre><span></span>' +
      '<span class="cm">NOTE: Writing HTML5(SASPY_INTERNAL) Body file: STDOUT</span><br>' +
      '<span class="s">1048 rows created in WORK.TITANICTRAINCLEAN from TITANIC.</span><br>' +
      '<span class="s">  </span><br><span class="s">  </span><br>' +
      '<span class="s">260 rows created in WORK.TITANICTESTCLEAN from TITANIC2.</span><br>' +
      '</pre></div>\n</body>\n</html>\n';
    const printed = outputText({
      'text/plain': '<IPython.core.display.HTML object>',
      'text/html': html
    });
    expect(printed).toMatchObject({
      lines: [
        'NOTE: Writing HTML5(SASPY_INTERNAL) Body file: STDOUT',
        '1048 rows created in WORK.TITANICTRAINCLEAN from TITANIC.',
        '',
        '260 rows created in WORK.TITANICTESTCLEAN from TITANIC2.'
      ],
      stream: null
    });
    // HTML with no text keeps the name of the object; a plain text that
    // names no object stays as it is.
    expect(
      outputText({
        'text/plain': '<IPython.core.display.HTML object>',
        'text/html': '<div><img src="a.png"></div>'
      })?.lines
    ).toEqual(['<IPython.core.display.HTML object>']);
    expect(
      outputText({ 'text/plain': 'count  40', 'text/html': '<b>x</b>' })?.lines
    ).toEqual(['count  40']);
  });

  it('keeps a short output whole and a long one as a tile', () => {
    const lines = (count: number) =>
      Array.from({ length: count }, (_, i) => `epoch ${i}`).join('\n');
    const short = outputText({ 'application/vnd.jupyter.stdout': lines(10) });
    const long = outputText({ 'application/vnd.jupyter.stdout': lines(11) });
    expect(short!.lines.length).toBeLessThanOrEqual(SHORT_TEXT_LINES);
    expect(long!.lines.length).toBeGreaterThan(SHORT_TEXT_LINES);
  });
});
