import type { IPlotlyGraph } from '../model/plotly';
import { plotlyPayload, selectedBox } from '../model/plotly';

// A graph div as Plotly draws `px.scatter(df, x="week", y="pain", color="arm")`.
function graph(overrides: Partial<IPlotlyGraph> = {}): IPlotlyGraph {
  const axes = {
    xaxis: { type: 'linear', title: { text: 'week' } },
    yaxis: { type: 'linear', title: { text: 'pain' } },
    legend: { title: { text: 'arm' } }
  };
  return {
    on: () => undefined,
    data: [{ name: 'A' }, { name: 'B' }],
    layout: { ...axes },
    _fullLayout: { ...axes },
    calcdata: [new Array(100).fill({}), new Array(100).fill({})],
    ...overrides
  } as unknown as IPlotlyGraph;
}

describe('plotlyPayload', () => {
  it('names the columns from the axis and legend titles', () => {
    const payload = plotlyPayload(graph());
    expect(payload?.source).toEqual({
      frame: null,
      x: 'week',
      y: 'pain',
      by: 'arm',
      rows: 200
    });
    expect(payload?.title).toBe('pain by week');
  });

  it('takes the frame and the columns from layout.meta.epi', () => {
    const payload = plotlyPayload(
      graph({
        layout: {
          meta: { epi: { frame: 'diary', x: 'week', y: 'pain_score' } },
          title: { text: 'Pain over time' }
        }
      })
    );
    expect(payload?.source.frame).toBe('diary');
    expect(payload?.source.y).toBe('pain_score');
    expect(payload?.title).toBe('Pain over time');
  });

  it('gives no payload for a chart whose marks are not rows', () => {
    expect(plotlyPayload(graph({ data: [{ type: 'histogram' }] }))).toBeNull();
    expect(
      plotlyPayload(graph({ data: [{ type: 'scattergl' }] }))?.source.x
    ).toBe('week');
  });

  it('gives no payload for an x axis of dates or categories', () => {
    const dates = graph();
    dates._fullLayout = { xaxis: { type: 'date', title: { text: 'day' } } };
    expect(plotlyPayload(dates)).toBeNull();
  });
});

describe('selectedBox', () => {
  it('orders the ranges of a box', () => {
    expect(
      selectedBox({ range: { x: [9, 5], y: [2, 8] }, points: [] })
    ).toEqual({
      x: [5, 9],
      y: [2, 8]
    });
  });

  it('gives no box for a lasso or a click', () => {
    expect(
      selectedBox({ lassoPoints: { x: [1, 2, 3] }, points: [] })
    ).toBeNull();
    expect(selectedBox(undefined)).toBeNull();
  });
});
