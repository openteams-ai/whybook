import { FRAME_MARGIN, ninejsChart, ninejsPlace } from '../model/ninejs';

const AXES_MIME = 'application/vnd.whybook.axes+json';

/** The HTML of a ninejs chart, as ninejs 0.1 writes it, cut to what the view reads. */
function frameHtml(options: {
  title?: string;
  css?: string;
  viewBox?: string;
  extra?: string;
}): string {
  const {
    title = 'ninejs interactive plot',
    css = '@layer ninejs-defaults{:root{--default-opacity:1;}svg{width:100%;height:auto;}.tooltip{position:absolute;}}',
    viewBox = '0 0 460.8 345.6',
    extra = ''
  } = options;
  const document = `<!doctype html><html lang="en"><head><style>${css}${extra}</style></head><body><div id="plot-container"><svg xmlns="http://www.w3.org/2000/svg" width="460.8pt" height="345.6pt" viewBox="${viewBox}" version="1.1"></svg></div></body></html>`;
  const escaped = document
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<iframe srcdoc="${escaped}" title="${title}" style="width:100%;height:476px;border:0;" sandbox="allow-scripts"></iframe>`;
}

function output(
  html: string,
  library = 'ninejs',
  image = { width: 460.8, height: 345.6, scale: 1 }
): Record<string, unknown> {
  return {
    'text/html': html,
    [AXES_MIME]: {
      version: 1,
      library,
      image,
      axes: [
        {
          box: [39.2, 4.6, 415.4, 311.6],
          x: {
            limits: [15.5, 70.5],
            scale: 'linear',
            label: '',
            column: 'age'
          },
          y: { limits: [0.2, 9.3], scale: 'linear', label: '', column: 'pain' },
          title: '',
          frame: 'week12',
          marks: 50,
          kind: 'scatter'
        }
      ]
    }
  };
}

describe('ninejsChart', () => {
  it("reads the SVG's size of a chart that the hook described", () => {
    const chart = ninejsChart(output(frameHtml({})));
    expect(chart).toMatchObject({ width: 460.8, height: 345.6 });
    expect(chart?.axes.axes[0].frame).toBe('week12');
  });

  it('leaves alone a chart that a later ninejs may draw differently', () => {
    // Another title: not ninejs's frame, or not as the view knows it.
    expect(ninejsChart(output(frameHtml({ title: 'plot' })))).toBeNull();
    // The SVG no longer fills the frame's width.
    expect(
      ninejsChart(output(frameHtml({ css: 'svg{width:80%;height:auto;}' })))
    ).toBeNull();
    // A rule for the page, which may change its margin.
    expect(
      ninejsChart(output(frameHtml({ extra: 'body{margin:0}' })))
    ).toBeNull();
    // The SVG has another size than the figure the hook described.
    expect(
      ninejsChart(output(frameHtml({ viewBox: '0 0 400 300' })))
    ).toBeNull();
  });

  it('needs the Axes of the hook, for ninejs', () => {
    expect(ninejsChart({ 'text/html': frameHtml({}) })).toBeNull();
    expect(ninejsChart(output(frameHtml({}), 'matplotlib'))).toBeNull();
  });
});

describe('ninejsPlace', () => {
  it('puts the SVG inside the margin of the frame, at its proportions', () => {
    const host = document.createElement('div');
    const frame = document.createElement('iframe');
    host.appendChild(frame);
    Object.defineProperty(frame, 'clientWidth', { value: 640 });
    frame.getBoundingClientRect = () =>
      ({ left: 100, top: 50, width: 640, height: 488 }) as DOMRect;
    const chart = ninejsChart(output(frameHtml({})))!;
    const place = ninejsPlace(host, chart)!;
    expect(place.left).toBe(100 + FRAME_MARGIN);
    expect(place.top).toBe(50 + FRAME_MARGIN);
    expect(place.width).toBe(640 - 2 * FRAME_MARGIN);
    expect(place.height).toBeCloseTo((624 * 345.6) / 460.8);
    expect(ninejsPlace(document.createElement('div'), chart)).toBeNull();
  });
});
