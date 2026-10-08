"""Small analyses that the offline code templates call.

Each returns a pandas DataFrame, so a notebook shows it as a table and the
Whybook view shows it as a table miniature. Some also print the result in
a few short lines, and some draw a plot first.
"""

from __future__ import annotations

import calendar
import math
from typing import Any, Iterable, Sequence

import numpy as np
import pandas as pd

from ._display import name_of
from ._progress import progress
from .plots import _pandas, hist, ribbon


class WholeTextFrame(pd.DataFrame):
    """A table that a notebook shows with each text in full.

    pandas cuts a text in a table at 50 characters (``display.max_colwidth``),
    so the meaning of a row of ``within_between`` ended in "...". The page
    wraps a long text instead.
    """

    @property
    def _constructor(self):
        return WholeTextFrame

    def _repr_html_(self):
        with pd.option_context("display.max_colwidth", None):
            return super()._repr_html_()

    def __repr__(self):
        with pd.option_context("display.max_colwidth", None):
            return super().__repr__()

    def _repr_mimebundle_(self, include=None, exclude=None):
        # The rows at the ends of a quick look go to the view beside the
        # table, as metadata of its output: the view offers to leave them
        # out (design iteration 1.85). The table shows as any other.
        extremes = (self.attrs.get("whybook") or {}).get("extremes")
        return ({}, {"whybook": {"extremes": extremes}}) if extremes else None


def _noun(column: str) -> str:
    """"patient" for "patient_id": the thing that an id column names, as the questions write it."""
    for suffix in ("_id", "_key", "id"):
        if column.lower().endswith(suffix) and len(column) > len(suffix):
            return column[: -len(suffix)].rstrip("_")
    return column


def _plural(count: int, noun: str) -> str:
    return f"{count:,} {noun}" if count == 1 else f"{count:,} {noun}s"


def _number(value: Any) -> str:
    """A number as a table of numbers writes it: 129,058, 211.4, 0.000412, 12,345.7."""
    value = float(value)
    if not math.isfinite(value):
        return str(value)
    if value.is_integer() and abs(value) < 1e15:
        return f"{int(value):,}"
    if abs(value) >= 1000:
        return f"{value:,.1f}"
    return f"{value:.4g}"


def _p(p: float) -> str:
    """A p-value as the results write it: "< 0.001", or two significant figures."""
    return "< 0.001" if p < 0.001 else f"= {p:.2g}"


# The F distribution, for a kernel without scipy: the regularised incomplete
# beta function by its continued fraction (Numerical Recipes, 6.4).


def _beta_fraction(a: float, b: float, x: float) -> float:
    tiny = 1e-300
    c, d = 1.0, 1 - (a + b) * x / (a + 1)
    d = 1 / (d if abs(d) > tiny else tiny)
    h = d
    for m in range(1, 500):
        even = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m))
        odd = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1))
        for step in (even, odd):
            d = 1 + step * d
            d = 1 / (d if abs(d) > tiny else tiny)
            c = 1 + step / c
            c = c if abs(c) > tiny else tiny
            h *= d * c
        if abs(d * c - 1) < 1e-15:
            break
    return h


def _beta_regularised(a: float, b: float, x: float) -> float:
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    front = math.exp(math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log1p(-x))
    if x < (a + 1) / (a + b + 2):
        return front * _beta_fraction(a, b, x) / a
    return 1 - front * _beta_fraction(b, a, 1 - x) / b


def _f_sf(f: float, d1: float, d2: float) -> float:
    """The chance that F with ``d1`` and ``d2`` degrees of freedom exceeds ``f``."""
    try:
        from scipy.stats import f as f_distribution
    except ImportError:
        pass
    else:
        return float(f_distribution.sf(f, d1, d2))
    if f <= 0:
        return 1.0
    return _beta_regularised(d2 / 2, d1 / 2, d2 / (d2 + d1 * f))


def _f_ppf(q: float, d1: float, d2: float) -> float:
    """The ``q`` quantile of F with ``d1`` and ``d2`` degrees of freedom."""
    try:
        from scipy.stats import f as f_distribution
    except ImportError:
        pass
    else:
        return float(f_distribution.ppf(q, d1, d2))
    low, high = 0.0, 1.0
    while _f_sf(high, d1, d2) > 1 - q:
        high *= 2
    for _ in range(200):
        middle = (low + high) / 2
        if _f_sf(middle, d1, d2) > 1 - q:
            low = middle
        else:
            high = middle
    return (low + high) / 2


def _chi2_sf(x: float, df: float) -> float:
    """The chance that chi-square with ``df`` degrees of freedom exceeds ``x``.

    Without scipy: the regularised upper incomplete gamma function Q(df/2,
    x/2), by its series below a + 1 and by its continued fraction above
    (Numerical Recipes, 6.2).
    """
    try:
        from scipy.stats import chi2
    except ImportError:
        pass
    else:
        return float(chi2.sf(x, df))
    if x <= 0:
        return 1.0
    a, z = df / 2, x / 2
    lead = math.exp(-z + a * math.log(z) - math.lgamma(a))
    if z < a + 1:
        term = total = 1 / a
        n = a
        for _ in range(1000):
            n += 1
            term *= z / n
            total += term
            if abs(term) < abs(total) * 1e-16:
                break
        return max(0.0, 1 - total * lead)
    tiny = 1e-300
    b = z + 1 - a
    c, d = 1 / tiny, 1 / b
    h = d
    for i in range(1, 1000):
        step = -i * (i - a)
        b += 2
        d = step * d + b
        d = 1 / (d if abs(d) > tiny else tiny)
        c = b + step / c
        c = c if abs(c) > tiny else tiny
        h *= d * c
        if abs(d * c - 1) < 1e-16:
            break
    return lead * h


def _share(fraction: float) -> str:
    """A share of a whole as a percent, as the view writes one (src/model/numbers.ts, shareText).

    Whole percents, and one decimal below 1% and above 99%, so that one row
    in a thousand does not show as 0% and one row short of all does not show
    as 100%: 12%, 0.4%, < 0.1%, 99.5%, > 99.9%.
    """
    if not np.isfinite(fraction):
        return ""
    percent = 100 * float(fraction)
    # Halves round up, as JavaScript's Math.round does in the view.
    tenths = math.floor(percent * 10 + 0.5) / 10
    if percent > 0 and tenths == 0:
        return "< 0.1%"
    if percent < 100 and tenths == 100:
        return "> 99.9%"
    if 0 < tenths < 1 or (tenths > 99 and percent < 100):
        return f"{tenths:.1f}%"
    return f"{math.floor(percent + 0.5)}%"


def _significant(values: Any, digits: int = 4):
    """Values rounded to ``digits`` significant figures: a mean of 0.000412 stays 0.000412, not 0."""
    return values.map(lambda value: float(f"{value:.{digits}g}") if np.isfinite(value) else value)


def profile(data: Any):
    """One row per column: type, share missing, distinct values, and the range or the top level."""
    import pandas as pd

    frame = _pandas(data)
    rows = []
    for column in frame.columns:
        series = frame[column]
        entry = {
            "column": column,
            "dtype": str(series.dtype),
            "missing": _share(series.isna().mean()),
            "distinct": series.nunique(dropna=True),
        }
        if pd.api.types.is_numeric_dtype(series) and not pd.api.types.is_bool_dtype(series):
            entry["range or top"] = f"{series.min():.4g} – {series.max():.4g}"
        else:
            top = series.value_counts(dropna=True).head(1)
            entry["range or top"] = f"{top.index[0]} ({top.iloc[0]})" if len(top) else ""
        rows.append(entry)
    table = pd.DataFrame(rows).set_index("column")
    table.attrs["whybook"] = {"duplicates": int(frame.duplicated().sum()), "rows": len(frame)}
    return table


def within_between(data: Any, x: str, y: str, group: str):
    """Correlation of ``x`` and ``y`` within groups and between group means.

    Within: both variables minus their group mean, pooled over groups.
    Between: one pair of group means per group.
    """
    import pandas as pd

    frame = _pandas(data)[[x, y, group]].dropna()
    means = frame.groupby(group, observed=True)[[x, y]].transform("mean")
    within = (frame[[x, y]] - means).corr().iloc[0, 1]
    group_means = frame.groupby(group, observed=True)[[x, y]].mean()
    between = group_means.corr().iloc[0, 1]
    # Each meaning in full: pandas cut it at 50 characters.
    return WholeTextFrame(
        {
            "r": [round(float(within), 3), round(float(between), 3)],
            "pairs": [len(frame), len(group_means)],
            "meaning": [
                f"when a {_noun(group)} is above its own mean {x}, is {y} too?",
                f"do {_noun(group)}s with a higher mean {x} have a higher mean {y}?",
            ],
        },
        index=pd.Index(["within", "between"], name=f"{x} vs {y}"),
    )


def _residualise(values: np.ndarray, design: np.ndarray | None) -> np.ndarray:
    if design is None:
        return values - values.mean(axis=0)
    coef, *_ = np.linalg.lstsq(design, values, rcond=None)
    return values - design @ coef


def screen(
    data: Any,
    outcome: Any,
    *,
    on: str | None = None,
    columns: Sequence[str] | None = None,
    adjust: Iterable[str] = (),
    adjust_data: Any = None,
    top: int = 20,
    chunk: int = 200,
):
    """Partial correlation of each column of ``data`` with ``outcome``, strongest first.

    ``outcome`` is a column name of ``data``, or a Series or one-column frame
    joined on ``on``. ``adjust`` columns (from ``adjust_data`` or ``data``) are
    removed from both sides first; a row with a missing value in one of them
    is left out, and a printed line gives how many. Reports progress per chunk
    of columns.
    """
    import pandas as pd

    frame = _pandas(data)
    if isinstance(outcome, str):
        y_name = outcome
        joined = frame
    else:
        target = _pandas(outcome.to_frame() if hasattr(outcome, "to_frame") else outcome)
        y_name = [c for c in target.columns if c != on][0]
        joined = frame.merge(target[[on, y_name]] if on else target, on=on, how="inner")
    adjust = list(adjust)
    if adjust and adjust_data is not None:
        extra = _pandas(adjust_data)[[on, *adjust]] if on else _pandas(adjust_data)[adjust]
        joined = joined.merge(extra, on=on, how="inner") if on else joined.join(extra)
    candidates = [
        c
        for c in (columns or frame.columns)
        if c not in {y_name, on, *adjust} and pd.api.types.is_numeric_dtype(joined[c])
    ]
    design = None
    if adjust:
        # A row with no value to adjust for cannot be adjusted: it is left out.
        missing = joined[adjust].isna()
        left_out = int(missing.any(axis=1).sum())
        if left_out:
            named = [column for column in adjust if missing[column].any()]
            print(
                f"Left out {left_out} of {len(joined)} {'row' if len(joined) == 1 else 'rows'} "
                f"with a missing {' or '.join(map(str, named))}."
            )
            joined = joined[~missing.any(axis=1)]
        design_frame = pd.get_dummies(joined[adjust], drop_first=True, dtype=float)
        design = np.column_stack([np.ones(len(joined)), design_frame.to_numpy(dtype=float)])
    y = joined[y_name].to_numpy(dtype=float)
    keep = ~np.isnan(y)
    results = []
    for start in range(0, len(candidates), chunk):
        progress(start / max(len(candidates), 1), f"screening columns {start + 1}–{min(start + chunk, len(candidates))} of {len(candidates)}")
        block = candidates[start : start + chunk]
        values = joined[block].to_numpy(dtype=float)
        for index, name in enumerate(block):
            x = values[:, index]
            mask = keep & ~np.isnan(x)
            if mask.sum() < 5:
                continue
            d = design[mask] if design is not None else None
            rx = _residualise(x[mask], d)
            ry = _residualise(y[mask], d)
            denominator = np.sqrt((rx**2).sum() * (ry**2).sum())
            r = float((rx * ry).sum() / denominator) if denominator else 0.0
            results.append({"column": name, "r": round(r, 3), "n": int(mask.sum())})
    progress(1.0, f"screened {len(candidates)} columns")
    table = pd.DataFrame(results)
    if table.empty:
        return table
    table["|r|"] = table["r"].abs()
    table = table.sort_values("|r|", ascending=False).drop(columns="|r|").head(top)
    return table.set_index("column")


def line_up(a: Any, b: Any):
    """How two frames line up: for each shared column, how many distinct values each has and share."""
    import pandas as pd

    left, right = _pandas(a), _pandas(b)
    rows = []
    for column in [c for c in left.columns if c in right.columns]:
        lv, rv = set(left[column].dropna().unique()), set(right[column].dropna().unique())
        rows.append(
            {
                "shared column": column,
                "distinct in first": len(lv),
                "distinct in second": len(rv),
                "in both": len(lv & rv),
                "only in first": len(lv - rv),
                "only in second": len(rv - lv),
            }
        )
    if not rows:
        return pd.DataFrame({"shared column": [], "note": []})
    return pd.DataFrame(rows).set_index("shared column").sort_values("in both", ascending=False)


def compare_frames(a: Any, b: Any):
    """Columns in one frame and not the other, and the row counts."""
    import pandas as pd

    left, right = _pandas(a), _pandas(b)
    only_left = [c for c in left.columns if c not in right.columns]
    only_right = [c for c in right.columns if c not in left.columns]
    return pd.DataFrame(
        {
            "first": [len(left), len(left.columns), ", ".join(map(str, only_left[:8])) or "none"],
            "second": [len(right), len(right.columns), ", ".join(map(str, only_right[:8])) or "none"],
        },
        index=["rows", "columns", "columns only here"],
    )


def by_group(data: Any, column: str, group: str):
    """``column`` summarised for each level of ``group``: rows, share missing, and the mean or top level."""
    import pandas as pd

    frame = _pandas(data)
    grouped = frame.groupby(group, observed=True)[column]
    table = pd.DataFrame({"rows": grouped.size(), "missing": grouped.apply(lambda s: _share(s.isna().mean()))})
    if pd.api.types.is_numeric_dtype(frame[column]) and not pd.api.types.is_bool_dtype(frame[column]):
        table["mean"] = _significant(grouped.mean())
        table["sd"] = _significant(grouped.std())
    else:
        table["top"] = grouped.agg(lambda s: s.value_counts().index[0] if s.notna().any() else "")
    return table


# Quick looks with numbers, and answers that start with a line of results
# (design iteration 1.75).


def _dates_of(series: Any):
    """``series`` as pandas dates, for a column of dates or of ``datetime.date`` objects; None for any other column."""
    import datetime

    if pd.api.types.is_datetime64_any_dtype(series):
        return series
    if series.dtype == object:
        present = series.dropna()
        if len(present) and all(isinstance(value, datetime.date) for value in present.head(100)):
            try:
                return pd.to_datetime(series)
            except (TypeError, ValueError):
                return None
    return None


def _span(delta: Any) -> str:
    """A length of time in words: 13 days 23 h 30 min, 30 min."""
    seconds = int(pd.Timedelta(delta).total_seconds())
    days, rest = divmod(seconds, 86400)
    hours, rest = divmod(rest, 3600)
    minutes, seconds = divmod(rest, 60)
    parts = [_plural(days, "day")] if days else []
    parts += [f"{hours} h"] if hours else []
    parts += [f"{minutes} min"] if minutes else []
    if seconds or not parts:
        parts.append(f"{seconds} s")
    return " ".join(parts)


def _extremes(values: Any, count: int, highest: bool) -> str:
    """The ``count`` lowest or highest values, each with its rows when more than one holds it: "0 ×5, 2.61, 2.98"."""
    counts = values.value_counts().sort_index(ascending=not highest).head(count)
    return ", ".join(_number(value) + (f" ×{n:,}" if n > 1 else "") for value, n in counts.items())


def _literal(value: Any) -> str:
    """A value as Python code that compares equal to it in its own type: 999.9 for the float32 999.900024, which 999.9 as a float64 is not.

    pandas compares a column of float32 with a Python number in float32, so
    the shortest text of the float32 value finds its rows.
    """
    if isinstance(value, (bool, np.bool_)):
        return str(bool(value))
    if isinstance(value, (int, np.integer)):
        return str(int(value))
    number = float(value)
    if math.isnan(number):
        return 'float("nan")'
    if math.isinf(number):
        return 'float("inf")' if number > 0 else '-float("inf")'
    return str(value) if isinstance(value, np.floating) else repr(number)


def _ends(series: Any, count: int) -> dict[str, Any]:
    """The ``count`` lowest and highest values of a column of numbers, each as code, with its rows: what the view needs to leave them out."""
    counts = series.dropna().value_counts()
    # An index gives Python numbers: each goes back to the column's own type, float32 for the readings.
    kind = getattr(series.dtype, "numpy_dtype", series.dtype).type

    def side(highest: bool) -> list[dict[str, Any]]:
        return [{"value": _literal(kind(value)), "rows": int(n)} for value, n in counts.sort_index(ascending=not highest).head(count).items()]

    return {"lowest": side(False), "highest": side(True)}


def summary(data: Any, column: str):
    """The numbers of one column, which a histogram does not show, in one table.

    Every column: its rows, its missing values and its distinct values.
    Numbers: the mean, the standard deviation, the minimum, the quartiles,
    the maximum, and the three lowest and the three highest values with
    their rows, where a code such as 999.9 for a reading that failed shows.
    Dates: the first and the last, the span, the most common step between
    two times and the longest gap. Any other column: its most and its least
    common values.
    """
    frame = _pandas(data)
    series = frame[column]
    rows = len(series)
    present = series.dropna()
    missing = rows - len(present)
    entries = [
        ("rows", f"{rows:,}"),
        ("missing", f"{missing:,} ({_share(missing / rows)})" if rows else "0"),
        ("distinct", f"{present.nunique():,}"),
    ]
    dates = _dates_of(present)
    if pd.api.types.is_numeric_dtype(present) and not pd.api.types.is_bool_dtype(present):
        values = present.astype(float)
        if len(values):
            low, first, median, third, high = values.quantile([0, 0.25, 0.5, 0.75, 1]).tolist()
            entries += [
                ("mean", _number(values.mean())),
                ("sd", _number(values.std()) if len(values) > 1 else ""),
                ("min", _number(low)),
                ("25%", _number(first)),
                ("median", _number(median)),
                ("75%", _number(third)),
                ("max", _number(high)),
                ("lowest", _extremes(values, 3, highest=False)),
                ("highest", _extremes(values, 3, highest=True)),
            ]
    elif dates is not None:
        stamps = dates.sort_values()
        if len(stamps):
            timed = bool((stamps != stamps.dt.normalize()).any())
            text = "%Y-%m-%d %H:%M" if timed else "%Y-%m-%d"
            entries += [
                ("first", stamps.iloc[0].strftime(text)),
                ("last", stamps.iloc[-1].strftime(text)),
                ("span", _span(stamps.iloc[-1] - stamps.iloc[0])),
            ]
            steps = stamps.drop_duplicates().diff().dropna()
            if len(steps):
                entries += [("most common step", _span(steps.mode().iloc[0])), ("longest gap", _span(steps.max()))]
    else:
        counts = present.astype(str).value_counts()
        entries.append(("most common", ", ".join(f"{level} ×{n:,}" for level, n in counts.head(3).items())))
        if len(counts) > 3:
            entries.append(("least common", ", ".join(f"{level} ×{n:,}" for level, n in counts.tail(3)[::-1].items())))
    table = WholeTextFrame({column: [value for _, value in entries]}, index=[name for name, _ in entries])
    name = name_of(data)
    if name and isinstance(data, pd.DataFrame) and pd.api.types.is_numeric_dtype(present) and not pd.api.types.is_bool_dtype(present) and len(present):
        # The values at the ends, as code, for the view's "Leave out these rows" (design iteration 1.85).
        table.attrs["whybook"] = {"extremes": {"frame": name, "column": str(column), "rows": rows, **_ends(present, 3)}}
    return table


def rows_per_unit(data: Any, unit: str, *, fewest: int = 10, below: float = 0.9):
    """How many rows each unit has: a line with the count, a histogram of the rows per unit, and the units with the fewest rows.

    A unit with fewer rows than the others, such as a home with long gaps in
    its readings, comes first in the table; a bar per unit in the order of
    the ids hides it among the others. A line counts the units with fewer
    rows than ``below`` times the median, and names that rule: "20 homes
    below 327 rows, 90% of the median."
    """
    frame = _pandas(data)
    counts = frame.groupby(unit, observed=True, sort=True).size()
    counts = counts[counts > 0].sort_values(kind="stable")
    noun = _noun(unit)
    if counts.empty:
        print(f"No row has a {unit}.")
        return WholeTextFrame({"rows": []})
    # Short lines: a quick look in the sidebar is narrow.
    print(f"{_plural(len(counts), noun)} in {int(counts.sum()):,} rows.")
    without = int(frame[unit].isna().sum())
    if without:
        print(f"{_plural(without, 'row')} without a {unit}.")
    # The fewest whole rows at or above the share of the median: 327 for 90% of 363.
    cut = math.ceil(below * float(counts.median()))
    short = int((counts < cut).sum())
    if short:
        print(f"{_plural(short, noun)} below {cut:,} rows, {_share(below)} of the median.")
    if counts.iloc[0] == counts.iloc[-1]:
        spread = f"{counts.iloc[0]:,} each"
    else:
        spread = f"{counts.iloc[0]:,} to {counts.iloc[-1]:,}, median {_number(counts.median())}"
    label = f"rows per {noun}"
    hist(pd.DataFrame({label: counts.to_numpy()}), label, bins=int(min(30, counts.nunique())), title=f"Rows per {noun}: {spread}")
    table = counts.head(fewest).rename("rows").to_frame()
    table.index.name = unit
    return table


def _variance_parts(values: Any, groups: Any) -> tuple[Any, Any, float, float]:
    """The size and the mean of each group, and the mean squares between and within the groups of a one-way analysis of variance."""
    grouped = values.groupby(groups, observed=True, sort=True)
    sizes = grouped.size()
    sizes = sizes[sizes > 0]
    means = grouped.mean()[sizes.index]
    k, n = len(sizes), int(sizes.sum())
    between = float((sizes * (means - values.mean()) ** 2).sum()) / (k - 1) if k > 1 else math.nan
    within = float(((values - grouped.transform("mean")) ** 2).sum()) / (n - k) if n > k else math.nan
    return sizes, means, between, within


def icc(data: Any, y: str, group: str):
    """How much of the variance of ``y`` lies between the groups: the intraclass correlation ICC(1), with the result in words.

    From a one-way analysis of variance of ``y`` by ``group``, with the mean
    group size n0 for groups of unequal size: ICC = (MSB - MSW) / (MSB +
    (n0 - 1) MSW). The 95% interval comes from the F distribution (Shrout and
    Fleiss, 1979), and the F test asks whether the means of the groups are
    equal. A share near 0 leaves little for a random intercept per group to
    explain.
    """
    frame = _pandas(data)[[y, group]].dropna()
    noun = _noun(group)
    values = frame[y].astype(float)
    sizes, _, between, within = _variance_parts(values, frame[group])
    k, n = len(sizes), int(sizes.sum())
    if k < 2 or n <= k:
        print(f"A share between {noun}s needs two {noun}s or more, and a {noun} with two rows or more.")
        return WholeTextFrame({"ICC": []})
    n0 = (n - float((sizes**2).sum()) / n) / (k - 1)
    if within == 0:
        # The rows of each group are alike: all the variance lies between them.
        estimate, f, p, low, high = 1.0, math.inf, 0.0, 1.0, 1.0
    else:
        f = between / within
        estimate = (between - within) / (between + (n0 - 1) * within)
        p = _f_sf(f, k - 1, n - k)
        f_low = f / _f_ppf(0.975, k - 1, n - k)
        f_high = f * _f_ppf(0.975, n - k, k - 1)
        low = (f_low - 1) / (f_low + n0 - 1)
        high = (f_high - 1) / (f_high + n0 - 1)
    # Two short lines: a card shows printed text as it is, without wrapping it.
    print(f"{_share(max(estimate, 0.0))} of the variance of {y} lies between the {_plural(k, noun)}")
    print(f"(ICC {estimate:.2f}, 95% CI {low:.2f} to {high:.2f}), the rest within them.")
    print(f"The test of equal means: F = {f:.3g} on {k - 1:,} and {n - k:,} df, p {_p(p)}.")
    return WholeTextFrame(
        {
            "ICC": [round(estimate, 3)],
            "95% CI": [f"{low:.2f} to {high:.2f}"],
            "F": [float(f"{f:.4g}")],
            "df": [f"{k - 1:,} and {n - k:,}"],
            "p": [_p(p).removeprefix("= ")],
            f"{noun}s": [k],
            "rows": [n],
        },
        index=pd.Index([y]),
    )


def compare_levels(data: Any, y: str, by: str, *, unit: str | None = None):
    """``y`` for each level of ``by``, and a line on whether the means differ.

    The table gives each level's count, mean, standard deviation and the 95%
    interval of its mean, in the order of the levels. The line gives the
    lowest and the highest mean, and a one-way analysis of variance. With
    ``unit``, when ``by`` stays the same within each unit, as the tariff of
    a home does, each unit counts once, with its mean: the days of one home
    are no independent rows.
    """
    from .plots import _t975

    frame = _pandas(data)
    extra = [unit] if unit and unit not in (y, by) else []
    part = frame[[y, by, *extra]].dropna()
    counted = "rows"
    if extra and len(part) and bool((part.groupby(unit, observed=True)[by].nunique() <= 1).all()):
        part = part.groupby([unit, by], observed=True, as_index=False)[y].mean()
        counted = f"{_noun(unit)}s"
    values = part[y].astype(float)
    sizes, means, between, within = _variance_parts(values, part[by])
    if sizes.empty:
        print(f"No row has both {y} and {by}.")
        return WholeTextFrame({counted: []})
    sds = values.groupby(part[by], observed=True, sort=True).std()[sizes.index]
    intervals = []
    for level in sizes.index:
        count, mean, sd = int(sizes[level]), float(means[level]), float(sds[level])
        half = _t975(count - 1) * sd / math.sqrt(count) if count > 1 else math.nan
        intervals.append(f"{_number(mean - half)} to {_number(mean + half)}" if math.isfinite(half) else "")
    table = WholeTextFrame(
        {counted: sizes.astype(int), "mean": _significant(means), "sd": _significant(sds), "95% CI of the mean": intervals}
    )
    table.index.name = by
    k, n = len(sizes), int(sizes.sum())
    lowest, highest = means.idxmin(), means.idxmax()
    line = f"Mean {y} from {_number(means[lowest])} ({lowest}) to {_number(means[highest])} ({highest}) over the {_plural(k, 'level')} of {by}"
    # What the means average, as the bars of the same levels say it (design iteration 1.85).
    print(line + (f", one mean per {_noun(unit)}." if counted != "rows" else ", one value per row."))
    if k > 1 and n > k and within > 0:
        f = between / within
        print(f"One-way analysis of variance: F = {f:.3g} on {k - 1:,} and {n - k:,} df, p {_p(_f_sf(f, k - 1, n - k))}.")
    return table


def _observed(values: Any) -> Any:
    """A column of levels without the categories that no row holds."""
    return values.cat.remove_unused_categories() if isinstance(values.dtype, pd.CategoricalDtype) else values


def _chi_square(counts: Any) -> tuple[float, int, float, float]:
    """Pearson's chi-square test of independence of a table of counts: the statistic, its degrees of freedom, its p-value and the smallest expected count.

    With Yates' correction for one degree of freedom, as
    scipy.stats.chi2_contingency computes it by default.
    """
    observed = counts.to_numpy(dtype=float)
    expected = observed.sum(axis=1, keepdims=True) * observed.sum(axis=0, keepdims=True) / observed.sum()
    dof = (observed.shape[0] - 1) * (observed.shape[1] - 1)
    if dof == 1:
        gap = expected - observed
        observed = observed + np.sign(gap) * np.minimum(0.5, np.abs(gap))
    statistic = float(((observed - expected) ** 2 / expected).sum())
    return statistic, dof, _chi2_sf(statistic, dof), float(expected.min())


def cross_table(data: Any, a: str, b: str, *, unit: str | None = None):
    """How the levels of ``a`` and ``b`` go together: a row per level of ``a`` with its counts and shares of ``b``, and a chi-square test of independence.

    With ``unit``, when both columns stay the same within each unit, as the
    tariff and the electric car of a home do, each unit counts once: the
    365 days of one home are no independent rows. The test is Pearson's
    chi-square on the counts, with Yates' correction for a table of two rows
    and two columns, as scipy.stats.chi2_contingency computes it by default.
    A line says when a cell expects fewer than 5 rows, where the test is
    rough.
    """
    frame = _pandas(data)
    extra = [unit] if unit and unit not in (a, b) else []
    part = frame[[a, b, *extra]].dropna()
    counted = "rows"
    if extra and len(part):
        grouped = part.groupby(unit, observed=True)
        if bool((grouped[a].nunique() <= 1).all()) and bool((grouped[b].nunique() <= 1).all()):
            part = part.drop_duplicates(subset=[unit])
            counted = f"{_noun(unit)}s"
    counts = pd.crosstab(_observed(part[a]), _observed(part[b]))
    if counts.empty:
        print(f"No row has both {a} and {b}.")
        return WholeTextFrame({counted: []})
    totals = counts.sum(axis=1)
    table = WholeTextFrame(
        {str(level): [f"{n:,} ({_share(n / total)})" for n, total in zip(counts[level], totals)] for level in counts.columns}
    )
    table.index = counts.index
    table[counted] = totals.to_numpy()
    table.index.name = a
    once = f", one row per {_noun(unit)}" if counted != "rows" else ""
    if counts.shape[1] == 2:
        # The share of the second level of b in each level of a: the electric cars of each tariff.
        level = counts.columns[1]
        shares = counts[level] / totals
        low, high = shares.idxmin(), shares.idxmax()
        print(f"{b} {level}: from {_share(shares[low])} ({low}) to {_share(shares[high])} ({high}) over the {_plural(len(counts), 'level')} of {a}{once}.")
    else:
        print(f"{a} by {b}: {_plural(int(totals.sum()), counted[:-1])}{once}.")
    if min(counts.shape) < 2:
        print(f"One level of {a if counts.shape[0] < 2 else b}: no test of independence.")
        return table
    statistic, dof, p, smallest = _chi_square(counts)
    print(f"Chi-square test of independence: chi-square = {statistic:.3g} on {dof} df, p {_p(p)}.")
    if smallest < 5:
        print(f"A cell expects {_number(smallest)} {counted}, fewer than 5: the test is rough.")
    return table


def _holds_levels(values: pd.Series, most: int) -> bool:
    """Whether a column holds 2 to ``most`` levels: text, true or false, or whole numbers.

    Data from R and Stata often stores a category as whole numbers: in NHEFS,
    qsmk, sex and race are 0 or 1, and education is 1 to 5. A column of
    whole numbers with more values, such as an age in years, is a measure.
    """
    if not 2 <= values.nunique() <= most:
        return False
    if pd.api.types.is_bool_dtype(values) or not pd.api.types.is_numeric_dtype(values):
        return True
    if pd.api.types.is_complex_dtype(values):
        return False
    return bool((values.dropna() % 1 == 0).all())


def _level_text(level: Any) -> str:
    """A level as the table writes it: 1, not the 1.0 of a column of whole numbers that pandas reads as decimals because a value is missing."""
    if isinstance(level, (float, np.floating)) and float(level).is_integer():
        return str(int(level))
    return str(level)


def who_is_in(data: Any, rows: Any, *, unit: str | None = None, most: int = 8, columns: int | None = 10):
    """Who the rows of a selection are, such as a range of weeks on a plot: their rows and units, and the share of each level of a column here and in all rows.

    A column with ``most`` levels or fewer gets a row per level: text, true
    or false, or whole numbers, as data from R and Stata stores a category
    (sex 0 or 1, education 1 to 5). With ``unit``, a column that stays the
    same within each unit, as the arm of a patient does, counts units: the
    patients with a row here, against all the patients. Any other column
    counts rows.

    The column whose share of a level here is furthest from its share in all
    rows comes first, so the column that tells these rows apart leads, and
    the ``columns`` columns that differ most show (all of them with None).
    The column that a mask of one column names, as
    ``frame["week"].between(4, 6)`` names the week, picks the rows: its
    shares would restate the range, so it gets no rows. A range of late
    weeks asked no question about its rows (design iteration 1.85), and a
    range of NHEFS, which stores its categories as whole numbers, got an
    empty table (1.99).
    """
    frame = _pandas(data)
    # pandas keeps the column's name on a comparison of the column.
    picked_on = getattr(rows, "name", None)
    inside = pd.Series(rows, index=frame.index).fillna(False).astype(bool)
    here = frame[inside]
    noun = _noun(unit) if unit and unit in frame.columns else None
    line = f"{len(here):,} of {len(frame):,} rows"
    if noun:
        line += f", {here[unit].nunique():,} of {frame[unit].nunique():,} {noun}s"
    found: list[tuple[float, list[dict[str, str]]]] = []
    for column in frame.columns:
        values = frame[column]
        if column == unit or column == picked_on or not _holds_levels(values, most):
            continue
        by_unit = bool(noun and (frame.groupby(unit, observed=True)[column].nunique() <= 1).all())
        counted = f"{noun}s" if by_unit else "rows"
        part, whole = (here.drop_duplicates(unit), frame.drop_duplicates(unit)) if by_unit else (here, frame)
        shares_here = part[column].value_counts(normalize=True)
        shares_all = whole[column].value_counts(normalize=True)
        levels = shares_all.sort_index().index
        gap = max(abs(float(shares_here.get(level, 0.0)) - float(shares_all[level])) for level in levels)
        entries = [
            {
                "column": str(column),
                "level": _level_text(level),
                "here": _share(float(shares_here.get(level, 0.0))),
                "all": _share(float(shares_all[level])),
                "of": counted,
            }
            for level in levels
        ]
        # A tenth of a point: columns whose gaps show the same keep the frame's order.
        found.append((round(gap, 3), entries))
    found.sort(key=lambda item: -item[0])
    kept = found if columns is None else found[: max(columns, 0)]
    text = line + "."
    if len(kept) < len(found):
        text += f" The {len(kept)} columns, of {len(found)}, whose shares here differ most from all rows."
    print(text)
    entries = [entry for _, column_entries in kept for entry in column_entries]
    if not entries:
        return WholeTextFrame({"here": []})
    return WholeTextFrame(entries).set_index(["column", "level"])


def time_profile(data: Any, time: str, y: str, by: str | None = None) -> None:
    """The mean of ``y`` by time of day, by weekday and by month, each with a 95% band, and a line on when it is highest and lowest.

    Each profile shows when the times give it three levels or more: three
    times of day, three weekdays, three months. A line through two months,
    a week of February and a week of October, compared two weeks and read as
    a season (design iteration 1.85). ``by`` draws one line per group, such
    as per tariff.
    """
    frame = _pandas(data)
    part = frame[[time, y, *([by] if by else [])]].dropna()
    stamps = _dates_of(part[time])
    if stamps is None:
        stamps = pd.to_datetime(part[time])
    profiles = []
    hours = stamps.dt.hour + stamps.dt.minute / 60
    if hours.nunique() >= 3:
        profiles.append(("hour of day", "hour of day", hours, "at", lambda h: f"{int(h):02d}:{round(h % 1 * 60):02d}"))
    if stamps.dt.dayofweek.nunique() >= 3:
        profiles.append(("weekday", "weekday, 0 is Monday", stamps.dt.dayofweek, "on", lambda d: calendar.day_name[int(d)]))
    if stamps.dt.month.nunique() >= 3:
        profiles.append(("month", "month", stamps.dt.month, "in", lambda m: calendar.month_name[int(m)]))
    if not profiles:
        print(f"{time} holds fewer than three times of day, weekdays and months: no profile to draw.")
        return
    lines = []
    for name, label, values, preposition, text in profiles:
        view = pd.DataFrame({label: values.to_numpy(), y: part[y].to_numpy()})
        if by:
            view[by] = part[by].to_numpy()
        ribbon(view, label, y, by, title=f"Mean {y} by {name}" + (f", one line per {by}" if by else ""))
        # A line for each group of ``by``, where one line pooled the tariffs.
        for group, rows in view.groupby(by, observed=True, sort=True) if by else [(None, view)]:
            means = rows.groupby(label)[y].mean()
            where = f", {by} {group[0] if isinstance(group, tuple) else group}" if by else ""
            lines.append(
                f"Mean {y} by {name}{where}: highest {preposition} {text(means.idxmax())} ({_number(means.max())}), "
                f"lowest {preposition} {text(means.idxmin())} ({_number(means.min())})."
            )
    # A line for each profile, under its plots: a card shows printed text without wrapping it.
    print("\n".join(lines))


# Whether an effect differs by another column: an interaction in a model
# fitted from a formula (design iteration 1.94).


def _top_level(text: str, separator: str) -> list[str]:
    """``text`` split at ``separator`` where it stands outside brackets and quotes: "qsmk:C(sex)[T.1]" at ":" gives "qsmk" and "C(sex)[T.1]"."""
    parts, depth, quote, start = [], 0, None, 0
    for index, char in enumerate(text):
        if quote:
            if char == quote:
                quote = None
        elif char in "'\"":
            quote = char
        elif char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        elif char == separator and depth == 0:
            parts.append(text[start:index])
            start = index + 1
    parts.append(text[start:])
    return parts


def _without_level(part: str) -> str:
    """A factor of a design's column without the level that the formula's library appends: "C(sex)" for "C(sex)[T.1]"."""
    if not part.endswith("]"):
        return part
    depth = 0
    for index in range(len(part) - 1, -1, -1):
        if part[index] == "]":
            depth += 1
        elif part[index] == "[":
            depth -= 1
            if depth == 0:
                return part[:index]
    return part


def _factor_column(code: str) -> str | None:
    """The column that a factor of a formula reads as it is: "sex" for "sex", "C(sex)" and "C(sex, Treatment(1))", and "x y" for 'Q("x y")'.

    None for a factor that transforms its column, such as "np.log(dose)".
    """
    import ast

    try:
        node = ast.parse(code.strip(), mode="eval").body
    except SyntaxError:
        return None
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "C" and node.args:
        node = node.args[0]
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "Q" and len(node.args) == 1:
        argument = node.args[0]
        if isinstance(argument, ast.Constant) and isinstance(argument.value, str):
            return argument.value
    return None


def _design(spec: Any, frame: Any):
    """The design matrix of ``frame`` for a model's right side, as patsy or formulaic built it for the fit."""
    try:
        from patsy import DesignInfo, build_design_matrices
    except ImportError:
        DesignInfo = None
    if DesignInfo is not None and isinstance(spec, DesignInfo):
        (matrix,) = build_design_matrices([spec], frame, return_type="dataframe")
        return matrix
    return spec.get_model_matrix(frame)


def _with_value(frame: Any, column: str, value: Any):
    """``frame`` with every row of ``column`` set to ``value``, in the column's own type: a category stays a category."""
    changed = frame.copy()
    try:
        changed[column] = pd.Series(value, index=frame.index, dtype=frame[column].dtype)
    except (TypeError, ValueError):
        changed[column] = value
    return changed


def _levels_of(values: Any) -> list[Any]:
    """The levels of a column in the rows of a model, in the order the formula's library codes them: a category's order, else sorted."""
    present = values.dropna()
    if isinstance(present.dtype, pd.CategoricalDtype):
        return [level for level in present.cat.categories if (present == level).any()]
    return sorted(pd.unique(present).tolist(), key=lambda level: (str(type(level)), level))


def _tested(fit: Any, rows: Any, test: str):
    """``fit.t_test`` or ``fit.wald_test`` of contrasts over the design's columns.

    A mixed model's t test takes the fixed effects alone, and its Wald test,
    as every other model's tests, all the parameters, the variances too.
    """
    matrix = np.atleast_2d(np.asarray(rows, dtype=float))
    padded = np.zeros((matrix.shape[0], len(fit.params)))
    padded[:, : matrix.shape[1]] = matrix
    run = fit.t_test if test == "t" else (lambda r: fit.wald_test(r, scalar=True))
    try:
        return run(padded)
    except (ValueError, IndexError):
        return run(matrix)


def _ratio_name(fit: Any) -> str | None:
    """What an effect is, exponentiated: an odds ratio for a logistic model, a rate or a risk ratio for a log link; None for the others."""
    model = fit.model
    family = getattr(model, "family", None)
    link = type(getattr(family, "link", None)).__name__.lower() if family is not None else ""
    kind = type(model).__name__
    if kind == "Logit" or link == "logit":
        return "odds ratio"
    if kind in ("Poisson", "NegativeBinomial", "GeneralizedPoisson"):
        return "rate ratio"
    if link == "log":
        return "risk ratio" if type(family).__name__ == "Binomial" else "rate ratio"
    return None


def effect_by(fit: Any, exposure: str, by: str):
    """Whether the effect of ``exposure`` differs by ``by``, in a model fitted with the two crossed, such as smf.ols("y ~ x * C(z) + age", data).fit().

    The first line gives the effect of ``exposure`` in each level of ``by``,
    or at the quartiles of a number of more than two values, and the second
    the interaction: its estimate with its 95% interval and p value, or a
    joint Wald test when it has several terms, as a ``by`` of three levels
    has. The table has a row per level. Each effect is a contrast of the
    model's coefficients, averaged over the model's rows: ``exposure`` at
    each of its levels against its reference level, at its two values for a
    number of two values, and one unit more for any other number, with
    ``by`` set to the level. So in a model that also crosses ``exposure``
    with time, it is the effect at the mean time. The effects are on the
    scale of the model's link; for a logistic model the table adds the odds
    ratios. The intervals and the tests are the fit's own: t or F for least
    squares, z or chi-square for the others, with its covariance, robust
    when the fit is.
    """
    model = getattr(fit, "model", None)
    data = getattr(model, "data", None)
    spec = getattr(data, "model_spec", None) or getattr(data, "design_info", None)
    frame = getattr(data, "frame", None)
    if spec is None or not isinstance(frame, pd.DataFrame):
        raise ValueError('effect_by reads a model fitted from a formula and a data frame, such as smf.ols("y ~ x * C(z)", data).fit()')
    names = list(model.exog_names)
    labels = getattr(data, "row_labels", None)
    rows = frame.loc[labels] if labels is not None else frame
    outcome = str(model.endog_names)

    def columns_of(name: str) -> list[str | None]:
        return [_factor_column(_without_level(part)) for part in _top_level(name, ":")]

    crossed = [index for index, name in enumerate(names) if sorted(map(str, columns_of(name))) == sorted([exposure, by])]
    if exposure == by or not crossed:
        raise ValueError(f"The model does not cross {exposure} with {by}: fit it with {exposure} * {by} in its formula.")
    parts = {_factor_column(_without_level(part)): part for part in _top_level(names[crossed[0]], ":")}
    exposure_levels = parts[exposure] != _without_level(parts[exposure])
    by_levels = parts[by] != _without_level(parts[by])
    main = [index for index, name in enumerate(names) if columns_of(name) == [exposure]]

    # The contrasts of the exposure: (label, value, reference value), or one unit more.
    values = _levels_of(rows[exposure])
    if exposure_levels or len(values) == 2:
        reference = values[0]
        if exposure_levels and main:
            # The reference level is the one whose row has no exposure column set: C(arm, Treatment("B")) has B.
            probe = rows.iloc[:1]
            for level in values:
                design = _design(spec, _with_value(probe, exposure, level)).to_numpy()[0]
                if not np.any(design[main]):
                    reference = level
                    break
        contrasts = [(f"{level} against {reference}" if exposure_levels else "", level, reference) for level in values if level != reference]
    else:
        contrasts = [("per unit", None, None)]
    # Where the effect is taken: each level of by, or the quartiles of a number.
    by_values = _levels_of(rows[by])
    quartiles = not by_levels and len(by_values) > 2
    if quartiles:
        points = rows[by].astype(float).quantile([0.25, 0.5, 0.75])
        settings = [(f"{_number(value)} ({int(share * 100)}th percentile)", value) for share, value in points.items()]
    else:
        settings = [(str(level), level) for level in by_values]

    contrast_rows, records = [], []
    for setting_label, setting in settings:
        at = _with_value(rows, by, setting)
        for contrast_label, level, reference in contrasts:
            if level is None:
                high = at.copy()
                high[exposure] = at[exposure].astype(float) + 1
                low = at
            else:
                high, low = _with_value(at, exposure, level), _with_value(at, exposure, reference)
            contrast_rows.append((_design(spec, high) - _design(spec, low)).mean(axis=0).to_numpy())
            records.append({by: setting_label, "contrast": contrast_label, "rows": int((rows[by] == setting).sum()) if not quartiles else None})
    result = _tested(fit, contrast_rows, "t")
    effects = np.atleast_1d(np.asarray(result.effect, dtype=float))
    intervals = np.atleast_2d(np.asarray(result.conf_int(alpha=0.05), dtype=float))
    pvalues = np.atleast_1d(np.asarray(result.pvalue, dtype=float))
    ratio = _ratio_name(fit)
    for record, effect, (low, high), p in zip(records, effects, intervals, pvalues):
        record[f"effect of {exposure}"] = float(f"{effect:.4g}") if np.isfinite(effect) else effect
        record["95% CI"] = f"{_number(low)} to {_number(high)}" if np.isfinite(low) and np.isfinite(high) else ""
        record["p"] = _p(p).removeprefix("= ") if np.isfinite(p) else ""
        if ratio:
            record[ratio] = float(f"{math.exp(effect):.4g}") if np.isfinite(effect) else effect
            record[f"95% CI of the {ratio}"] = f"{_number(math.exp(low))} to {_number(math.exp(high))}" if np.isfinite(low) and np.isfinite(high) else ""

    # The lines: the effect in each level, then the interaction.
    places = [f"at {by} {_number(setting)}" if quartiles else f"where {by} is {label}" for label, setting in settings]

    def told(numbers: list[float]) -> str:
        if len(numbers) > 3 and not quartiles:
            low, high = int(np.nanargmin(numbers)), int(np.nanargmax(numbers))
            return f"from {_number(numbers[low])} {places[low]} to {_number(numbers[high])} {places[high]}, over {len(numbers)} levels."
        return ", ".join(f"{_number(number)} {place}" for number, place in zip(numbers, places)) + (", its quartiles." if quartiles else ".")

    for contrast_label, _, _ in contrasts:
        mine = [float(effect) for record, effect in zip(records, effects) if record["contrast"] == contrast_label]
        print(f"Effect of {exposure}" + (f" ({contrast_label})" if contrast_label else "") + f" on {outcome}: " + told(mine))
        if ratio:
            print(f"As {ratio}s: " + told([math.exp(effect) for effect in mine]))
    if len(crossed) == 1:
        single = np.zeros(len(names))
        single[crossed[0]] = 1.0
        found = _tested(fit, single, "t")
        estimate = float(np.atleast_1d(found.effect)[0])
        low, high = np.atleast_2d(found.conf_int(alpha=0.05))[0]
        p = float(np.atleast_1d(found.pvalue)[0])
        print(f"Interaction of {exposure} and {by}: {_number(estimate)} (95% CI {_number(low)} to {_number(high)}), p {_p(p)}.")
    else:
        joint = np.zeros((len(crossed), len(names)))
        for row, index in enumerate(crossed):
            joint[row, index] = 1.0
        test = _tested(fit, joint, "wald")
        statistic, p = float(np.squeeze(test.statistic)), float(np.squeeze(test.pvalue))
        if test.distribution == "F":
            text = f"F = {statistic:.3g} on {int(test.df_num)} and {_number(test.df_denom)} df"
        else:
            text = f"chi-square = {statistic:.3g} on {int(test.df_denom)} df"
        print(f"Interaction of {exposure} and {by}, {len(crossed)} terms: {text}, p {_p(p)}.")
    table = WholeTextFrame(records)
    if all(not record["contrast"] for record in records):
        table = table.drop(columns="contrast")
    if quartiles:
        table = table.drop(columns="rows")
    index = [by] + (["contrast"] if "contrast" in table.columns else [])
    return table.set_index(index)
