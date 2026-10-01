"""Plots that keep the link between marks and rows.

Each function displays one ``application/vnd.whybook.plot+json`` bundle. The
payload holds the aggregated points, how many rows sit behind each point, and
the name of the source frame, so the view can turn a region of the plot into a
row selection. Other frontends show the ``text/plain`` fallback.

Numbers go at full precision: the view rounds each where it shows it. A column
of dates goes as the milliseconds since 1970 of each date's time on the
frame's clock, and its axis has ``"type": "date"``, with the time zone of the
column in ``"tz"``, so that the view writes the ticks as dates and the code of
a picked range as ``pd.Timestamp(...)``.
"""

from __future__ import annotations

import datetime
import math
from typing import Any

import numpy as np

from ._display import PLOT_MIME, name_of, show


def _pandas(data: Any):
    """A pandas view of any frame that narwhals understands."""
    import pandas as pd

    if isinstance(data, pd.DataFrame):
        return data
    import narwhals as nw

    return nw.from_native(data, eager_only=True).to_pandas()


def _number(value: Any) -> float | int | str | None:
    """A value of the payload: a number as it is, None for a missing or infinite one."""
    if value is None:
        return None
    if isinstance(value, (np.integer, int)) and not isinstance(value, bool):
        return int(value)
    if isinstance(value, (np.floating, float)):
        number = float(value)
        # JSON has no NaN or infinity.
        return number if math.isfinite(number) else None
    return str(value)


def _dates(series: Any) -> tuple[Any, dict[str, Any] | None]:
    """A column of dates as milliseconds since 1970, and what its axis needs; any other column as it is.

    A date keeps its time on the frame's clock: a time zone goes into the axis,
    not into the numbers. A column of ``datetime.date`` objects, as
    ``.dt.date`` makes, counts as dates too.
    """
    import pandas as pd

    values = series
    objects = False
    if values.dtype == object:
        present = values.dropna()
        if len(present) and all(isinstance(value, datetime.date) for value in present.head(100)):
            try:
                values = pd.to_datetime(values)
            except (TypeError, ValueError):
                return series, None
            objects = True
    if not pd.api.types.is_datetime64_any_dtype(values):
        return series, None
    axis: dict[str, Any] = {"type": "date"}
    zone = values.dt.tz
    if zone is not None:
        axis["tz"] = str(zone)
        values = values.dt.tz_localize(None)
    if objects:
        axis["objects"] = True
    return (values - pd.Timestamp(0)) / pd.Timedelta(milliseconds=1), axis


def _date_columns(frame: Any, payload: dict[str, Any], axes: dict[str, str | None]):
    """``frame`` with its columns of dates as numbers, and each axis of ``payload`` that shows one marked as such."""
    copied = False
    for axis, column in axes.items():
        if not column:
            continue
        values, info = _dates(frame[column])
        if info:
            if not copied:
                frame, copied = frame.copy(), True
            frame[column] = values
            payload[axis].update(info)
    return frame


def _payload(kind: str, data: Any, x: str, y: str | None, by: str | None, title: str | None, **extra: Any):
    frame = _pandas(data)
    payload = {
        "version": 1,
        "kind": kind,
        "title": title or (f"{y} by {x}" if y else f"Distribution of {x}"),
        "x": {"field": x, "label": x},
        "y": {"field": y, "label": y} if y else None,
        "source": {"frame": name_of(data), "x": x, "y": y, "by": by, "rows": int(len(frame))},
        "select": "x",
    }
    payload.update(extra)
    return frame, payload


def _show(payload: dict[str, Any]) -> None:
    summary = f"<whybook {payload['kind']}: {payload['title']}>"
    show({PLOT_MIME: payload, "text/plain": summary})


# The 97.5% quantiles of Student's t for 1 to 30 degrees of freedom, as
# scipy.stats.t.ppf gives them, for a kernel without scipy.
_T975 = (
    12.706205, 4.302653, 3.182446, 2.776445, 2.570582, 2.446912, 2.364624, 2.306004, 2.262157, 2.228139,
    2.200985, 2.178813, 2.160369, 2.144787, 2.131450, 2.119905, 2.109816, 2.100922, 2.093024, 2.085963,
    2.079614, 2.073873, 2.068658, 2.063899, 2.059539, 2.055529, 2.051831, 2.048407, 2.045230, 2.042272,
)


def _t975(df: int) -> float:
    """How many standard errors a 95% interval of a mean reaches each side: the 97.5% quantile of t with ``df`` degrees of freedom."""
    try:
        from scipy.stats import t
    except ImportError:
        pass
    else:
        return float(t.ppf(0.975, df))
    if df <= len(_T975):
        return _T975[df - 1]
    # Past 30 degrees of freedom, three terms of the expansion of t around the
    # normal quantile: within 1e-5 of scipy's value.
    z = 1.959964
    return z + (z**3 + z) / (4 * df) + (5 * z**5 + 16 * z**3 + 3 * z) / (96 * df**2) + (3 * z**7 + 19 * z**5 + 17 * z**3 - 15 * z) / (384 * df**3)


def _unit_lines(frame: Any, x: str, y: str, units: str, most: int, seed: int) -> tuple[list[dict[str, Any]], int]:
    """One thin line per unit, the mean of ``y`` at each ``x`` of the unit: up to ``most`` units, picked at random with ``seed``, and how many units there are."""
    names = sorted(frame[units].unique(), key=str)
    if len(names) > most:
        picked = np.random.default_rng(seed).choice(len(names), size=most, replace=False)
        names = [names[index] for index in sorted(picked)]
    lines = []
    for name, part in frame[frame[units].isin(names)].groupby(units, sort=True, observed=True):
        means = part.groupby(x, sort=True)[y].mean()
        lines.append({"name": str(name), "points": [{"x": _number(x_value), "y": _number(y_value)} for x_value, y_value in means.items()]})
    return lines, int(frame[units].nunique())


def ribbon(
    data: Any,
    x: str,
    y: str,
    by: str | None = None,
    *,
    units: str | None = None,
    max_units: int = 40,
    ci: str = "normal",
    n_boot: int = 1000,
    seed: int = 0,
    title: str | None = None,
) -> None:
    """Mean of ``y`` at each value of ``x`` with a 95% interval, one line per group of ``by``.

    ``ci`` is ``"normal"`` (the mean ± t standard errors, with t for n - 1
    degrees of freedom: the interval for the mean of normal values) or
    ``"bootstrap"`` (percentile interval of ``n_boot`` resampled means).

    ``units`` names a column such as patient_id: a thin line under the mean
    then follows each unit, so that the plot shows how the units move apart
    from the mean. Up to ``max_units`` units are drawn, picked at random with
    ``seed``; the payload says how many there are.
    """
    frame, payload = _payload("ribbon", data, x, y, by, title, ci=ci, n_boot=n_boot if ci == "bootstrap" else None)
    columns = [x, y] + ([by] if by else []) + ([units] if units and units not in (x, y, by) else [])
    frame = _date_columns(frame[columns].dropna(), payload, {"x": x})
    if units:
        lines, total = _unit_lines(frame, x, y, units, max_units, seed)
        payload["lines"] = lines
        payload["lines_of"] = {"field": units, "shown": len(lines), "total": total}
        if title is None:
            drawn = f"a line for {len(lines)} of {total} {units}" if total > len(lines) else f"a line per {units}"
            payload["title"] = f"{y} by {x}: the mean, and {drawn}"
    rng = np.random.default_rng(seed)
    groups = frame.groupby(by, sort=True, observed=True) if by else [("all", frame)]
    quantiles: dict[int, float] = {}
    series = []
    for name, part in groups:
        points = []
        for x_value, cell in part.groupby(x, sort=True):
            values = cell[y].to_numpy(dtype=float)
            n = len(values)
            mean = float(values.mean())
            if n < 2:
                lo = hi = mean
            elif ci == "bootstrap":
                draws = values[rng.integers(0, n, size=(n_boot, n))].mean(axis=1)
                lo, hi = (float(v) for v in np.percentile(draws, [2.5, 97.5]))
            else:
                if n not in quantiles:
                    quantiles[n] = _t975(n - 1)
                half = quantiles[n] * float(values.std(ddof=1)) / math.sqrt(n)
                lo, hi = mean - half, mean + half
            points.append({"x": _number(x_value), "y": _number(mean), "lo": _number(lo), "hi": _number(hi), "n": n})
        series.append({"name": str(name[0] if isinstance(name, tuple) else name), "points": points})
    payload["series"] = series
    _show(payload)


def _lattice_step(values: Any) -> float | None:
    """The step between the values of an axis of a few whole numbers, such as weeks or doses in steps of 50 mg; None for any other axis."""
    import pandas as pd

    if not pd.api.types.is_numeric_dtype(values) or pd.api.types.is_bool_dtype(values):
        return None
    distinct = np.unique(values.to_numpy(dtype=float, na_value=np.nan))
    distinct = distinct[np.isfinite(distinct)]
    if not 2 <= len(distinct) <= 50 or not np.all(np.mod(distinct, 1) == 0):
        return None
    return float(np.min(np.diff(distinct)))


def scatter(
    data: Any,
    x: str,
    y: str,
    by: str | None = None,
    *,
    jitter: bool | None = None,
    max_points: int = 3000,
    seed: int = 0,
    title: str | None = None,
) -> None:
    """One point per row, sampled down to ``max_points``. Each point keeps its row position.

    ``jitter`` moves each point at random by up to a quarter of the step
    between the values of an axis of whole numbers, so that the rows on one
    spot show as a cloud and not as one dot: 1,428 visits on integer weeks
    and doses in steps of 50 mg showed as about 230 dots. None jitters an
    axis of 50 whole numbers or fewer when three rows or more share each of
    its values, on average; the payload gives the largest move on each axis.
    A box still selects the rows by their values, so a box edge drawn
    through a cloud can cut it.
    """
    frame, payload = _payload("scatter", data, x, y, by, title, select="xy")
    columns = [x, y] + ([by] if by else [])
    frame = _date_columns(frame[columns].reset_index(drop=True).dropna(), payload, {"x": x, "y": y})
    if by:
        # The order of a ribbon's lines, which gives each group its colour in the view.
        payload["groups"] = [str(name) for name, _ in frame.groupby(by, sort=True, observed=True)]
    if len(frame) > max_points:
        frame = frame.sample(max_points, random_state=seed).sort_index()
        payload["sampled"] = True
    steps = {}
    for axis, column in (("x", x), ("y", y)):
        step = _lattice_step(frame[column])
        # Left to the data, an axis jitters when three rows or more share each of its values, on average.
        if step is not None and (jitter or (jitter is None and len(frame) >= 3 * frame[column].nunique())):
            steps[axis] = step
    moves = {axis: step / 4 for axis, step in steps.items()}
    xs, ys = frame[x], frame[y]
    if moves:
        rng = np.random.default_rng(seed)
        if "x" in moves:
            xs = xs.astype(float) + rng.uniform(-moves["x"], moves["x"], len(frame))
        if "y" in moves:
            ys = ys.astype(float) + rng.uniform(-moves["y"], moves["y"], len(frame))
        payload["jitter"] = moves
        if title is None:
            payload["title"] += " (jittered)"
    # Column by column: iterrows made every value of a row of numbers a float, group 2 "2.0".
    groups = frame[by] if by else [None] * len(frame)
    points = [
        {"x": _number(x_value), "y": _number(y_value), "g": str(group) if by else None, "i": int(index)}
        for index, x_value, y_value, group in zip(frame.index, xs, ys, groups)
    ]
    payload["points"] = points
    _show(payload)


def hist(data: Any, x: str, *, bins: int = 30, title: str | None = None) -> None:
    """Counts of ``x`` in equal-width bins."""
    frame, payload = _payload("hist", data, x, None, None, title)
    column = _date_columns(frame[[x]].dropna(), payload, {"x": x})[x]
    values = column.to_numpy(dtype=float)
    counts, edges = np.histogram(values, bins=bins)
    payload["bins"] = [
        {"x0": _number(edges[i]), "x1": _number(edges[i + 1]), "n": int(counts[i])} for i in range(len(counts))
    ]
    payload["missing"] = int(frame[x].isna().sum())
    _show(payload)


def _noun(column: str) -> str:
    """"patient" for "patient_id": the thing that an id column names."""
    for suffix in ("_id", "_key", "id"):
        if column.lower().endswith(suffix) and len(column) > len(suffix):
            return column[: -len(suffix)].rstrip("_")
    return column


def bars(data: Any, x: str, y: str | None = None, *, unit: str | None = None, title: str | None = None) -> None:
    """One bar per level of ``x``: the mean of ``y`` with its 95% interval, or the row count when ``y`` is not given.

    A bar's ``n`` counts the rows behind its height: the rows whose ``y`` is
    present, or every row of the level for a count. A bar is labelled with
    its level as ``astype(str)`` writes it, as the view compares it: a date
    at midnight is 2024-01-03. The interval is the mean ± t standard errors,
    with t for n - 1 degrees of freedom.

    With ``unit``, when ``x`` stays the same within each unit, as the arm of
    a patient does, each unit counts once, with its mean, as
    ``compare_levels`` counts them: the bars of the rows gave arms A and B
    3.18 and 1.63, where their patients average 3.63 and 2.00 (design
    iteration 1.85). ``n`` then counts units, and the payload names them.
    """
    import pandas as pd

    frame, payload = _payload("bars", data, x, y, None, title)
    noun = None
    if y and unit and unit not in (x, y) and unit in frame.columns:
        part = frame[[x, y, unit]].dropna()
        if len(part) and bool((part.groupby(unit, observed=True)[x].nunique() <= 1).all()):
            frame = part.groupby([unit, x], observed=True, as_index=False)[y].mean()
            noun = _noun(unit)
            payload["unit"] = noun
    if title is None:
        payload["title"] = (f"Mean {y} by {x}" + (f", one mean per {noun}" if noun else "")) if y else f"Rows by {x}"
    grouped = frame.groupby(x, observed=True, sort=True)
    heights = grouped[y].mean() if y else grouped.size()
    counts = grouped[y].count() if y else grouped.size()
    spreads = grouped[y].std() if y else None
    levels = heights.index
    labels = levels.astype(str) if pd.api.types.is_datetime64_any_dtype(levels) else [str(level) for level in levels]
    shown = []
    for label, level in zip(labels, levels):
        bar = {"x": str(label), "y": _number(heights[level]), "n": int(counts[level])}
        if spreads is not None and counts[level] > 1 and math.isfinite(float(spreads[level])):
            half = _t975(int(counts[level]) - 1) * float(spreads[level]) / math.sqrt(int(counts[level]))
            bar["lo"], bar["hi"] = _number(float(heights[level]) - half), _number(float(heights[level]) + half)
        shown.append(bar)
    payload["bars"] = shown
    _show(payload)
