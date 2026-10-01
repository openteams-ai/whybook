import { pictureOf, plotGlyph, svgRatio } from '../model/outputs';

describe('svgRatio', () => {
  it("reads the proportions of the SVG in an iframe's document, as ninejs writes it", () => {
    const srcdoc =
      '<!doctype html><html><body><div id="plot-container"><?xml version="1.0"?><svg xmlns:xlink="http://www.w3.org/1999/xlink" width="460.8pt" height="345.6pt" viewBox="0 0 460.8 345.6" xmlns="http://www.w3.org/2000/svg"></svg></div></body></html>';
    expect(svgRatio(srcdoc)).toBeCloseTo(0.75);
  });

  it('gives null without an SVG or a viewBox', () => {
    expect(svgRatio(null)).toBeNull();
    expect(svgRatio('<p>no chart</p>')).toBeNull();
    expect(svgRatio('<svg width="10" height="20"></svg>')).toBeNull();
    expect(svgRatio('<svg viewBox="0 0 0 20"></svg>')).toBeNull();
  });
});

describe('pictureOf', () => {
  const base = { type: 'display_data', metadata: {}, trusted: true };

  it("keeps only the picture of a live figure, as ipympl's output has one", () => {
    const figure = {
      ...base,
      data: {
        'application/vnd.jupyter.widget-view+json': { model_id: 'abc' },
        'image/png': 'iVBORw0KGgo=',
        'text/plain': 'Canvas(toolbar=Toolbar(...))'
      }
    };
    expect(pictureOf(figure)?.data).toEqual({ 'image/png': 'iVBORw0KGgo=' });
  });

  it('gives null for a widget without a picture, and for a plain picture', () => {
    expect(
      pictureOf({
        ...base,
        data: {
          'application/vnd.jupyter.widget-view+json': { model_id: 'abc' }
        }
      })
    ).toBeNull();
    expect(
      pictureOf({ ...base, data: { 'image/png': 'iVBORw0KGgo=' } })
    ).toBeNull();
  });
});

describe('plotGlyph', () => {
  it("reads the view's own plot: its kind and its title", () => {
    const data = {
      'application/vnd.whybook.plot+json': {
        version: 1,
        kind: 'ribbon',
        title: 'Mean pain by week'
      }
    };
    expect(plotGlyph(data)).toEqual({
      glyph: 'ribbon',
      title: 'Mean pain by week'
    });
  });

  it("reads the first trace of a Plotly chart, and the chart's title", () => {
    const plotly = (trace: object, title?: unknown) => ({
      'application/vnd.plotly.v1+json': {
        data: [trace],
        layout: title === undefined ? {} : { title }
      }
    });
    expect(
      plotGlyph(plotly({ type: 'scatter', mode: 'markers' }, { text: 'Pain' }))
    ).toEqual({ glyph: 'scatter', title: 'Pain' });
    expect(plotGlyph(plotly({ type: 'scatter', mode: 'lines' })).glyph).toBe(
      'line'
    );
    expect(plotGlyph(plotly({ type: 'bar' }, 'Counts'))).toEqual({
      glyph: 'bars',
      title: 'Counts'
    });
    expect(plotGlyph(plotly({ type: 'histogram' })).glyph).toBe('hist');
    expect(plotGlyph(plotly({ type: 'sunburst' })).glyph).toBe('chart');
  });

  it('reads what the matplotlib hook says an Axes draws', () => {
    const axes = (kind: string | null) => ({
      'image/png': 'iVBORw0KGgo=',
      'application/vnd.whybook.axes+json': {
        version: 1,
        library: 'matplotlib',
        image: { width: 600, height: 400, scale: 1 },
        axes: [
          {
            box: [10, 10, 590, 390],
            x: { limits: [0, 1], scale: 'linear', label: 'x', column: null },
            y: { limits: [0, 1], scale: 'linear', label: 'y', column: null },
            title: 'Weekly pain',
            frame: null,
            marks: 4,
            kind
          }
        ]
      }
    });
    expect(plotGlyph(axes('barh'))).toEqual({
      glyph: 'bars',
      title: 'Weekly pain'
    });
    expect(plotGlyph(axes(null)).glyph).toBe('chart');
  });

  it('gives a picture it cannot read a plot of no known kind', () => {
    expect(plotGlyph({ 'image/png': 'iVBORw0KGgo=' })).toEqual({
      glyph: 'chart',
      title: ''
    });
  });
});
