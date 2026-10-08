"""Other values of a constant to try, by the kind of constant.

The chip of a decision offers other values of its constant (design iteration
1.18). The rules here read the kind of the constant from its name, its
value, the code of its cell and the call it goes into, and choose values in
the units of that kind: a count of days takes common lengths of time, a
significance level the conventional levels next to it, a seed other seeds.
``suggest`` gives the kind and the values, each with a reason.

When no rule knows the kind, the view asks a model for values
(``model_values`` and ``local_values``): the owner's rule that the view
defers to a model where its rules cannot tell. Without a model the view keeps
the older rule, ``fallback``: half below and above a whole number, half and
double a decimal.
"""

from __future__ import annotations

import ast
import json
import math
import re
from dataclasses import dataclass
from typing import Any, AsyncIterator

from .. import claude, connection, local_models, privacy
from ..config import Whybook

# Other values to try, by function and parameter, where the rules for numbers
# and flags do not fit: how means one thing to merge and another to dropna.
WHAT_IF_CHOICES = {
    ("merge", "how"): ['"left"', '"outer"'],
    ("dropna", "how"): ['"all"'],
    ("corr", "method"): ['"spearman"', '"kendall"'],
    ("std", "ddof"): ["1"],
    ("ribbon", "ci"): ['"bootstrap"'],
    ("from_formula", "missing"): ['"raise"'],
    # The first row as data, or as the names of the columns: pandas' readers
    # take header="infer" unless names are given, and read_excel takes 0.
    ("read_csv", "header"): ["None", "0"],
    ("read_table", "header"): ["None", "0"],
    ("read_excel", "header"): ["None"],
    # The separator that the file uses, which pandas guesses from its first
    # rows when sep is None (design iteration 1.92).
    ("read_csv", "sep"): ["None"],
    ("read_table", "sep"): ["None"],
}

# The other value of a library default, by parameter, when the function has
# no choices of its own above.
LIBRARY_ALTERNATIVES = {
    "reml": "False",
    "how": '"left"',
    "method": '"spearman"',
    "equal_var": "False",
    "ddof": "1",
    "ci": '"bootstrap"',
    "re_formula": None,
    "C": "1e6",
}

# What each common value means, by parameter and value without quotes.
CHOICE_REASONS = {
    ("how", "left"): "keeps every row of the left frame",
    ("how", "outer"): "keeps every row of both frames",
    ("how", "inner"): "keeps the rows found in both frames",
    ("how", "right"): "keeps every row of the right frame",
    ("how", "all"): "drops a row only when all its values are missing",
    ("how", "any"): "drops a row when any value is missing",
    ("method", "spearman"): "correlates ranks, so outliers weigh less",
    ("method", "kendall"): "correlates ranks, for small samples",
    ("method", "pearson"): "the linear correlation",
    ("ddof", "1"): "the sample standard deviation",
    ("ddof", "0"): "the standard deviation of the whole population",
    ("ci", "bootstrap"): "an interval from resampling",
    ("reml", "False"): "maximum likelihood, to compare fits with other fixed effects",
    ("reml", "True"): "restricted maximum likelihood, the default",
    ("equal_var", "False"): "Welch's test, for groups with unequal variances",
    ("equal_var", "True"): "Student's test, for groups with equal variances",
    ("C", "1e6"): "almost no penalty on the coefficients",
    ("missing", "raise"): "stops with an error where a formula variable is missing",
    ("header", "None"): "reads the first row as data",
    ("header", "0"): "reads the first row as column names",
    ("sep", "None"): "guesses the separator from the first rows of the file",
    ("cov_type", "nonrobust"): "plain standard errors, which assume the same spread for everyone",
    ("cov_type", "HC0"): "White's robust standard errors, with no correction for a small sample",
    ("cov_type", "HC1"): "robust standard errors with a correction for a small sample, as Stata's robust",
    ("cov_type", "HC2"): "robust standard errors that correct for the leverage of each row",
    ("cov_type", "HC3"): "robust standard errors that correct more for leverage, safer in a small sample",
}

# The covariances of a statsmodels fit that the rules know: plain standard
# errors, and the robust ones of White and of MacKinnon and White. A value of
# another library's fit, such as linearmodels' "clustered", gets none of them.
STATSMODELS_COV_TYPES = ("nonrobust", "HC0", "HC1", "HC2", "HC3")

# The parameters that name the file a reader such as read_csv reads: another
# file is a value the analyst types, not one to guess.
FILE_PARAMS = frozenset(
    {"filepath_or_buffer", "path", "path_or_buf", "path_or_buffer", "io", "source", "file", "filename", "fname", "filepath"}
)


@dataclass(frozen=True)
class Value:
    """One value to try: as Python code, such as ``7`` or ``"left"``, and what it means."""

    text: str
    why: str

    def to_json(self) -> dict[str, str]:
        return {"value": self.text, "why": self.why}


@dataclass(frozen=True)
class Suggestion:
    """The kind of a constant and the values to try for it.

    ``kind`` is None when no rule knows the kind: then ``values`` hold the
    older rule (``fallback``), and the view asks a model.
    ``label`` names the kind for the analyst, "a count of days", and ``rule``
    says how the values were chosen, "common lengths of time".
    """

    kind: str | None
    label: str
    rule: str
    values: tuple[Value, ...]


# Words of a name: MIN_DAYS is "min" and "days", maxPoints "max" and "points".
NAME_PARTS = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+")


def words(*names: str | None) -> list[str]:
    """The words of names, in lower case: ``words("MIN_DAYS", "min_days")`` gives min, days, min, days."""
    found: list[str] = []
    for name in names:
        if name:
            found += [part.lower() for part in NAME_PARTS.findall(name)]
    return found


def short(function: str | None) -> str:
    """``merge`` for ``DataFrame.merge``: the name that the cell calls; the class for its ``__init__``."""
    parts = (function or "").rsplit(".", 2)
    return parts[-2] if parts[-1] == "__init__" and len(parts) > 1 else parts[-1]


def _read(text: str) -> Any:
    """The Python value of a literal, or None for code that is not one."""
    try:
        return ast.literal_eval(text.strip())
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
        return None


def _number(text: str) -> int | float | None:
    value = _read(text)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return value


def _text(value: float, like: int | float) -> str:
    """A value as Python writes it: a whole number stays whole when the constant was."""
    if isinstance(like, int) and not isinstance(like, bool) and float(value).is_integer():
        return str(int(value))
    return repr(float(round(value, 6)))


def _unquoted(text: str) -> str:
    value = _read(text)
    return value if isinstance(value, str) else text.strip()


def _neighbours(grid: list[float], value: float) -> list[float]:
    """The nearest values of the grid below and above ``value``, or the two nearest on the one side there is."""
    below = [point for point in grid if point < value - 1e-12]
    above = [point for point in grid if point > value + 1e-12]
    if below and above:
        return [below[-1], above[0]]
    return below[-2:][::-1] if below else above[:2]


def _two_digits(value: float) -> int:
    """A whole number rounded to two significant digits: 159 gives 160, 636 gives 640."""
    whole = int(math.floor(value + 0.5))
    if whole < 100:
        return max(1, whole)
    scale = 10 ** (len(str(whole)) - 2)
    return int(math.floor(whole / scale + 0.5)) * scale


# Common lengths of time, and their words.
DAYS = {1: "a day", 2: "two days", 3: "three days", 7: "a week", 14: "two weeks", 21: "three weeks", 30: "a month", 60: "two months", 90: "three months", 180: "half a year", 365: "a year"}
WEEKS = {1: "a week", 2: "two weeks", 4: "four weeks", 8: "eight weeks", 12: "twelve weeks", 26: "half a year", 52: "a year"}
MONTHS = {1: "a month", 3: "a quarter", 6: "half a year", 12: "a year", 24: "two years", 36: "three years", 60: "five years"}
HOURS = {1: "an hour", 2: "two hours", 3: "three hours", 6: "six hours", 12: "half a day", 24: "a day", 48: "two days", 168: "a week"}
MINUTES = {1: "a minute", 5: "five minutes", 10: "ten minutes", 15: "a quarter of an hour", 30: "half an hour", 60: "an hour"}
YEARS = {1: "a year", 2: "two years", 3: "three years", 5: "five years", 10: "ten years", 20: "twenty years"}
UNITS = {"days": DAYS, "weeks": WEEKS, "months": MONTHS, "hours": HOURS, "minutes": MINUTES, "years": YEARS}
UNIT_LABELS = {
    "days": "a count of days",
    "weeks": "a count of weeks",
    "months": "a count of months",
    "hours": "a count of hours",
    "minutes": "a count of minutes",
    "years": "a count of years",
}
UNIT_WORDS = {
    "days": {"day", "days", "daily", "nday", "ndays"},
    "weeks": {"week", "weeks", "weekly", "wk", "wks"},
    "months": {"month", "months", "monthly", "mo", "mos"},
    "hours": {"hour", "hours", "hourly", "hr", "hrs"},
    "minutes": {"minute", "minutes", "mins"},
    "years": {"years", "yrs"},
}

SIGNIFICANCE = [0.001, 0.01, 0.05, 0.1]
CONFIDENCE = [0.8, 0.9, 0.95, 0.99]
CONFIDENCE_PERCENT = [80, 90, 95, 99]
SHARES = [0.01, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 1.0]
PERCENTS = [1, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 99, 100]
SEEDS = [0, 1, 42, 123, 2024]
FOLDS = [2, 3, 5, 10, 20]

SEED_WORDS = {"seed", "seeds", "rseed", "randomseed", "rng"}
SEED_FUNCTIONS = {"seed", "default_rng", "RandomState", "manual_seed", "set_seed", "Generator", "PCG64"}
YEAR_WORDS = {"year", "yr", "yyyy"}
WINDOW_WORDS = {"window", "win", "span", "rolling", "smooth", "smoothing", "lookback", "halflife"}
WINDOW_FUNCTIONS = {"rolling", "ewm", "RollingOLS", "RollingWLS", "moving_average"}
LAG_WORDS = {"lag", "lags", "nlags", "shift", "lead", "horizon"}
LAG_FUNCTIONS = {"shift", "diff", "pct_change", "plot_acf", "plot_pacf", "acf", "pacf", "lagmat", "LocalProjections"}
SIGNIFICANCE_WORDS = {"significance", "signif", "fdr", "qvalue", "qval", "padj", "pvalue", "pval", "pvals", "pvalues"}
SIGNIFICANCE_FUNCTIONS = {
    "multipletests", "fdrcorrection", "conf_int", "summary_frame", "proportion_confint", "confint", "zconfint",
    "tconfint_mean", "t_test", "f_test", "wald_test", "plot_acf", "plot_pacf", "acf", "pacf", "solve_power",
    "tt_ind_solve_power", "zt_ind_solve_power", "get_prediction",
}
# Where alpha is not a significance level: the opacity of a plot, or the penalty of a model.
PLOT_FUNCTIONS = {
    "plot", "scatter", "hist", "bar", "barh", "fill_between", "fill_betweenx", "errorbar", "imshow", "axvspan",
    "axhspan", "axvline", "axhline", "contour", "contourf", "pcolormesh", "boxplot", "violinplot", "stackplot", "step",
    "stem", "pie", "hexbin", "lineplot", "scatterplot", "histplot", "kdeplot", "barplot", "regplot", "lmplot",
    "jointplot", "pairplot", "displot", "relplot", "catplot", "stripplot", "swarmplot", "pointplot", "heatmap",
    "text", "annotate", "legend", "grid", "ribbon", "bars",
}
PENALTY_FUNCTIONS = {
    "Ridge", "Lasso", "ElasticNet", "RidgeCV", "LassoCV", "ElasticNetCV", "RidgeClassifier", "SGDClassifier",
    "SGDRegressor", "MLPClassifier", "MLPRegressor", "fit_regularized", "ExponentialSmoothing", "SimpleExpSmoothing",
    "Holt", "ewm", "MultinomialNB", "BernoulliNB", "ComplementNB", "CategoricalNB", "Lars", "LassoLars",
}
# Words in the code of a cell that make an alpha a learning rate or a penalty.
NOT_SIGNIFICANCE = re.compile(
    r"\b(?:lr|learning|gradient|descent|epochs?|iters?|iterations|ridge|lasso|elastic|regulari[sz]\w*|penalty|smoothing|opacity|transparen\w*)\b",
    re.IGNORECASE,
)
# A name that holds p-values: p, pval, p_values, pvalues, padj, qval.
P_VALUES = re.compile(r"\b(?:p|pv|pval|pvals|p_val|p_vals|pvalue|pvalues|p_value|p_values|padj|p_adj|qval|qvals|q_value|q_values)\b", re.IGNORECASE)
CONFIDENCE_WORDS = {"conf", "confidence", "ci", "cl"}
SHARE_WORDS = {
    "share", "shares", "frac", "fraction", "prop", "proportion", "coverage", "test", "train", "valid", "validation",
    "split", "subsample", "sample", "keep", "size",
}
PERCENT_WORDS = {"pct", "percent", "percentage", "percentile", "perc"}
QUANTILE_WORDS = {"quantile", "quantiles", "q"}
THRESHOLD_WORDS = {"threshold", "thresh", "cutoff", "cut", "limit", "bound", "min", "max", "tol", "floor", "ceiling", "minimum", "maximum"}
COUNT_FIRST = {"n", "num", "number", "nb", "count", "top", "max", "min", "k"}
COUNT_WORDS = {
    "bins", "nbins", "boot", "bootstrap", "bootstraps", "iter", "iters", "iterations", "epochs", "samples", "trials",
    "draws", "clusters", "components", "neighbors", "neighbours", "estimators", "folds", "splits", "points", "rows",
    "items", "features", "depth", "repeats", "permutations", "resamples", "restarts", "chains", "steps", "markers",
    "genes", "topics", "leaves", "init",
}
COUNT_FUNCTIONS = {"head", "tail", "nlargest", "nsmallest", "sample", "most_common", "date_range", "period_range"}
FOLD_PARAMS = {"cv", "n_splits", "folds", "n_folds", "kfold", "k_fold"}
FREQUENCY_PARAMS = {"freq", "rule", "window", "offset", "frequency"}
FREQUENCY_FUNCTIONS = {"resample", "asfreq", "rolling", "date_range", "Grouper", "to_period", "period_range", "floor", "ceil", "round"}
# The pandas frequencies from finer to coarser, and their words.
LADDER = [("h", "hourly"), ("D", "daily"), ("W", "weekly"), ("MS", "monthly"), ("QS", "quarterly"), ("YS", "yearly")]
ALIASES = {
    "h": "h", "H": "h", "D": "D", "B": "D", "W": "W", "M": "MS", "ME": "MS", "MS": "MS", "BM": "MS", "BMS": "MS",
    "Q": "QS", "QE": "QS", "QS": "QS", "Y": "YS", "YE": "YS", "YS": "YS", "A": "YS", "AS": "YS",
}
OFFSET = re.compile(r"^(\d+)\s*(D|days?|W|h|H|hours?|min|T|minutes?|M|ME|MS|Y|YE|YS|A)$")
OFFSET_UNITS = {
    "D": "days", "day": "days", "days": "days", "W": "weeks", "h": "hours", "H": "hours", "hour": "hours",
    "hours": "hours", "min": "minutes", "T": "minutes", "minute": "minutes", "minutes": "minutes", "M": "months",
    "ME": "months", "MS": "months", "Y": "years", "YE": "years", "YS": "years", "A": "years",
}


def _cell_lines(source: str, name: str) -> str:
    """The lines of a cell that name ``name``, where its use says what it is."""
    if not name:
        return ""
    pattern = re.compile(rf"(?<![\w.]){re.escape(name)}(?!\w)")
    return "\n".join(line for line in source.splitlines() if pattern.search(line))


def _passed_to(source: str, name: str, functions: set[str]) -> bool:
    """Whether a line of the cell passes ``name`` as a keyword to one of ``functions``: ``scatter(x, y, alpha=ALPHA)``."""
    for line in _cell_lines(source, name).splitlines():
        if re.search(rf"\w\s*=\s*{re.escape(name)}(?!\w)", line) and any(re.search(rf"\b{re.escape(function)}\(", line) for function in functions):
            return True
    return False


def _uses(source: str, name: str, pattern: str) -> bool:
    """Whether the cell passes ``name`` where ``pattern`` stands, such as ``seed({name})``."""
    return bool(name) and re.search(pattern.format(name=re.escape(name)), source) is not None


def _made(kind: str, label: str, rule: str, values: list[tuple[str, str]]) -> Suggestion:
    return Suggestion(kind, label, rule, tuple(Value(text, why) for text, why in values))


def _on_grid(kind: str, label: str, rule: str, grid: dict[int, str], value: int | float) -> Suggestion:
    return _made(kind, label, rule, [(_text(point, value), grid[int(point)]) for point in _neighbours(sorted(grid), value)])


def _time_unit(names: list[str], function: str, param: str, around: str, name: str) -> str | None:
    """The unit of time a constant counts, from its words or from the call it goes into: timedelta(days=N)."""
    for unit, unit_words in UNIT_WORDS.items():
        if unit_words & set(names):
            return unit
    if function in ("timedelta", "Timedelta", "DateOffset", "relativedelta", "to_timedelta") and param in UNITS:
        return param
    for unit in UNITS:
        if _uses(around, name, rf"\b{unit}\s*=\s*{{name}}(?!\w)"):
            return unit
    return None


def _flag(param: str, value: str) -> Suggestion | None:
    if value not in ("True", "False"):
        return None
    other = "False" if value == "True" else "True"
    return _made("flag", "a flag", "its other value", [(other, CHOICE_REASONS.get((param, other), "the other value"))])


def _choices(function: str, param: str, value: str, provenance: str, by_model: bool = False) -> Suggestion | None:
    """A library's own other values: by function and parameter, else by parameter for a value that is not a number.

    The values by parameter alone are written for the functions of the
    kernel's own list, so a default that a model found gets none of them:
    "spearman" is no other optimizer of a logit fit.
    """
    chosen = WHAT_IF_CHOICES.get((function, param))
    if chosen is None:
        if by_model:
            return None
        other = LIBRARY_ALTERNATIVES.get(param)
        # A flag has its rule, and so has a number, unless a library chose it: C=1.0 of a logistic regression.
        if other is None or value in ("True", "False") or (provenance != "library_default" and _number(value) is not None):
            return None
        chosen = [other]
    current = _unquoted(value)
    kept = [choice for choice in chosen if _unquoted(choice) != current]
    reasons = [CHOICE_REASONS.get((param, _unquoted(choice)), "another common value") for choice in kept]
    label = f"a choice of {function}" if function else "a library's choice"
    return _made("choice", label, "its other common values", list(zip(kept, reasons)))


def _covariance(param: str, value: str) -> Suggestion | None:
    """The other standard errors of a statsmodels fit: plain ones for robust ones, robust ones for plain ones.

    With the quotes of the cell, so that the branch reads as the cell does.
    """
    current = _unquoted(value)
    if param != "cov_type" or current not in STATSMODELS_COV_TYPES:
        return None
    text = value.strip()
    quote = text[0] if text[:1] in ("'", '"') else '"'
    others = ["HC1", "HC3"] if current == "nonrobust" else ["nonrobust", "HC3" if current == "HC1" else "HC1"]
    return _made(
        "covariance",
        "the standard errors of a fit",
        "plain and robust ones",
        [(f"{quote}{other}{quote}", CHOICE_REASONS[("cov_type", other)]) for other in others],
    )


def _seed(names: list[str], name: str, function: str, param: str, number: int | float, around: str) -> Suggestion | None:
    named = bool(SEED_WORDS & set(names)) or ("random" in names and "state" in names) or param in ("random_state", "seed", "random_seed")
    used = function in SEED_FUNCTIONS or any(
        _uses(around, name, pattern)
        for pattern in (r"\bseed\(\s*{name}(?!\w)", r"\bdefault_rng\(\s*{name}(?!\w)", r"\bRandomState\(\s*{name}(?!\w)", r"\brandom_state\s*=\s*{name}(?!\w)", r"\bseed\s*=\s*{name}(?!\w)")
    )
    if not (named or used) or not isinstance(number, int) or number < 0:
        return None
    others = [seed for seed in SEEDS if seed != number][:2]
    return _made("seed", "a random seed", "other seeds, to check that the result does not depend on it", [(str(seed), "another seed: the result should hold") for seed in others])


def _year(names: list[str], name: str, number: int | float, around: str) -> Suggestion | None:
    if not isinstance(number, int) or not 1800 <= number <= 2100:
        return None
    lines = _cell_lines(around, name)
    if not (YEAR_WORDS & set(names) or re.search(r"\.year\b|\byear\b", lines)):
        return None
    return _made("year", "a year", "the year before and the year after", [(str(number - 1), "the year before"), (str(number + 1), "the year after")])


def _time(names: list[str], name: str, function: str, param: str, number: int | float, around: str) -> Suggestion | None:
    unit = _time_unit(names, function, param, around, name)
    if unit is None or number < 0 or (unit == "years" and number >= 1800):
        return None
    return _on_grid(unit, UNIT_LABELS[unit], "common lengths of time", UNITS[unit], number)


def _window(names: list[str], name: str, function: str, param: str, number: int | float, around: str) -> Suggestion | None:
    windowed = bool(WINDOW_WORDS & set(names)) or function in WINDOW_FUNCTIONS or any(
        _uses(around, name, pattern) for pattern in (r"\.rolling\(\s*(?:window\s*=\s*)?{name}(?!\w)", r"\bwindow\s*=\s*{name}(?!\w)", r"\bspan\s*=\s*{name}(?!\w)")
    )
    if windowed and isinstance(number, int) and number >= 1:
        if number <= 2:
            values = [(number + 1, "a longer window"), (number + 2, "a longer window still")]
        else:
            values = [(int(math.floor(number / 2 + 0.5)), "half the window"), (number * 2, "twice the window")]
        return _made("window", "a window", "half and twice the window", [(str(point), why) for point, why in values])
    lagged = bool(LAG_WORDS & set(names)) or (function in LAG_FUNCTIONS and param in ("periods", "lags", "nlags", "maxlag", "")) or any(
        _uses(around, name, pattern) for pattern in (r"\.shift\(\s*(?:periods\s*=\s*)?{name}(?!\w)", r"\.diff\(\s*(?:periods\s*=\s*)?{name}(?!\w)", r"\blags?\s*=\s*{name}(?!\w)")
    )
    if lagged and isinstance(number, int) and number >= 0:
        if number <= 3:
            values = [(number - 1, "one period shorter")] if number >= 2 else []
            values += [(number + 1, "one period longer"), (number + 2, "two periods longer")]
            values = values[:2]
        else:
            values = [(int(math.floor(number / 2 + 0.5)), "half the lag"), (number * 2, "twice the lag")]
        return _made("lag", "a lag", "shorter and longer lags", [(str(point), why) for point, why in values])
    return None


def _significance(names: list[str], name: str, function: str, param: str, number: int | float, around: str) -> Suggestion | None:
    if not 0 < number <= 0.2:
        return None
    named = bool(SIGNIFICANCE_WORDS & set(names)) or ("sig" in names and "level" in names) or (
        "p" in names and bool({"threshold", "thresh", "cutoff", "cut", "level", "max"} & set(names))
    )
    if not named and "alpha" in names:
        # The opacity of a plot, or the penalty of a model, is no significance level.
        if function in PLOT_FUNCTIONS or function in PENALTY_FUNCTIONS or _passed_to(around, name, PLOT_FUNCTIONS | PENALTY_FUNCTIONS):
            return None
        lines = _cell_lines(around, name)
        if function in SIGNIFICANCE_FUNCTIONS or P_VALUES.search(lines):
            named = True
        elif not NOT_SIGNIFICANCE.search(around):
            # A bare ALPHA at a conventional level, with nothing in the cell that makes it a rate.
            named = any(abs(number - level) < 1e-12 for level in SIGNIFICANCE)
    if not named:
        return None
    levels = _neighbours(SIGNIFICANCE, number)
    reasons = {level: ("a stricter level: fewer false positives" if level < number else "a looser level: fewer missed effects") for level in levels}
    return _made("significance", "a significance level", "the conventional levels next to it", [(_text(level, number), reasons[level]) for level in levels])


def _confidence(names: list[str], number: int | float) -> Suggestion | None:
    # "level" alone is too common a word: alpha_level is the opacity of a plot.
    if not CONFIDENCE_WORDS & set(names) or "coverage" in names:
        return None
    if 0.5 <= number < 1:
        grid: list[float] = CONFIDENCE
    elif isinstance(number, int) and 50 <= number < 100:
        grid = CONFIDENCE_PERCENT
    else:
        return None
    levels = _neighbours(grid, number)
    return _made(
        "confidence",
        "a confidence level",
        "the conventional levels next to it",
        [(_text(level, number), "a narrower interval" if level < number else "a wider interval") for level in levels],
    )


def _bounded(kind: str, label: str, rule: str, grid: list[float], number: int | float, lower: str, higher: str) -> Suggestion:
    if number >= grid[-1]:
        # At the upper bound, both values are below it: 90% and 80% of all of it.
        points = [grid[-4], grid[-5]]
    elif number <= 0:
        points = [grid[1], grid[2]]
    else:
        points = _neighbours(grid, number)
    return _made(kind, label, rule, [(_text(point, number), lower if point < number else higher) for point in points])


def _share(names: list[str], function: str, param: str, number: int | float) -> Suggestion | None:
    named = set(names)
    if PERCENT_WORDS & named and 1 < number <= 100:
        return _bounded("percent", "a percentage", "other percentages between 0 and 100", PERCENTS, number, "a smaller percentage", "a larger percentage")
    if not 0 <= number <= 1:
        return None
    if QUANTILE_WORDS & named or "percentile" in named or (function == "quantile" and param in ("q", "")):
        return _bounded("quantile", "a quantile", "other quantiles between 0 and 1", SHARES, number, "a lower quantile", "a higher quantile")
    if PERCENT_WORDS & named or SHARE_WORDS & named or function in ("sample", "train_test_split"):
        if isinstance(number, int) and number not in (0, 1):
            return None
        found = _bounded("share", "a share", "other shares between 0 and 1", SHARES, number, "a smaller share", "a larger share")
        # A share reads better as a percentage: "a smaller share: 80%".
        return Suggestion(found.kind, found.label, found.rule, tuple(Value(item.text, f"{item.why}: {float(item.text) * 100:g}%") for item in found.values))
    if THRESHOLD_WORDS & named:
        return _bounded("threshold", "a threshold between 0 and 1", "other thresholds between 0 and 1", SHARES, number, "a lower threshold", "a higher threshold")
    return None


def _count(names: list[str], name: str, function: str, param: str, number: int | float) -> Suggestion | None:
    if not isinstance(number, int) or number < 1:
        return None
    if param in FOLD_PARAMS or FOLD_PARAMS & set(names):
        points = _neighbours(FOLDS, number)
        return _made("count", "a count of folds", "the common counts of folds", [(str(point), "fewer folds" if point < number else "more folds") for point in points])
    first = names[0] if names else ""
    counted = (
        first in COUNT_FIRST
        or name in ("k", "K", "n", "N")
        or bool(COUNT_WORDS & set(names))
        or (function in COUNT_FUNCTIONS and param in ("n", "periods", ""))
    )
    if not counted:
        return None
    if number <= 5:
        values = ([(number - 1, "one fewer")] if number >= 2 else []) + [(number + 1, "one more"), (number + 2, "two more")]
        values = values[:2]
        rule = "one fewer and one more"
    else:
        values = [(_two_digits(number / 2), "half as many"), (_two_digits(number * 2), "twice as many")]
        rule = "half and twice as many"
    return _made("count", "a count", rule, [(str(point), why) for point, why in values])


def _frequency(function: str, param: str, value: str) -> Suggestion | None:
    """A pandas frequency, such as "7D" or "W": other counts of its unit, or the next finer and coarser units."""
    text = _read(value)
    if not isinstance(text, str) or not (param in FREQUENCY_PARAMS or function in FREQUENCY_FUNCTIONS):
        return None
    # The quotes of the constant, and double quotes for a string with a prefix, such as r"7D".
    quote = value.strip()[0] if value.strip()[:1] in ("'", '"') else '"'
    counted = OFFSET.match(text.strip())
    if counted:
        number, unit = int(counted.group(1)), counted.group(2)
        kind = OFFSET_UNITS[unit]
        grid = UNITS[kind]
        points = _neighbours(sorted(grid), number)
        return _made("window", "a window of time", "common lengths of time", [(f"{quote}{point}{unit}{quote}", grid[int(point)]) for point in points])
    base = ALIASES.get(text.strip())
    if base is None:
        return None
    order = [alias for alias, _ in LADDER]
    index = order.index(base)
    around = [i for i in (index - 1, index + 1) if 0 <= i < len(LADDER)]
    if len(around) < 2:
        around = [index - 1, index - 2] if index > 0 else [index + 1, index + 2]
    return _made("frequency", "a frequency", "the next finer and coarser units", [(f"{quote}{LADDER[i][0]}{quote}", LADDER[i][1]) for i in around])


def reads_file(function: str, param: str, value: str) -> bool:
    """Whether the value is the path that a reader such as read_csv reads."""
    return function.startswith(("read_", "scan_")) and param in FILE_PARAMS and isinstance(_read(value), str)


def fallback(value: str) -> tuple[Value, ...]:
    """The rule without a model: half below and above a whole number, half and double a decimal."""
    number = _number(value)
    if number is None:
        return ()
    text = value.strip()
    if isinstance(number, int) and not any(mark in text.lower() for mark in (".", "e")):
        step = max(1, abs(number) // 2)
        return (Value(str(number - step), ""), Value(str(number + step), ""))
    return (Value(repr(round(number / 2, 6)), ""), Value(repr(round(number * 2, 6)), ""))


def fallback_rule(value: str) -> str:
    """How ``fallback`` chose its values, after "the values are"."""
    number = _number(value)
    if number is None:
        return ""
    whole = isinstance(number, int) and not any(mark in value.strip().lower() for mark in (".", "e"))
    return "half its value below and above it" if whole else "half and double its value"


def suggest(
    name: str, value: str, param: str | None = None, function: str | None = None, provenance: str = "literal", source: str = "", by_model: bool = False
) -> Suggestion:
    """The kind of a constant and two values to try, each with a reason.

    ``source`` is the code of the cell: how it uses the name tells a
    significance level from an opacity, and a seed from a count. With no rule
    for the kind, the values are ``fallback``'s and the kind is None.
    ``by_model`` marks a default that a model found in the function's signature.
    """
    value = value.strip()
    function = short(function)
    param = param or ""
    names = words(name, param)
    for found in (_covariance(param, value), _choices(function, param, value, provenance, by_model), _flag(param, value)):
        if found is not None:
            return found
    if reads_file(function, param, value):
        return Suggestion("file", "a file", "", ())
    number = _number(value)
    if number is None:
        found = _frequency(function, param, value)
        return found if found is not None else Suggestion(None, "", "", ())
    rules = (
        lambda: _seed(names, name, function, param, number, source),
        lambda: _year(names, name, number, source),
        lambda: _time(names, name, function, param, number, source),
        lambda: _window(names, name, function, param, number, source),
        lambda: _significance(names, name, function, param, number, source),
        lambda: _confidence(names, number),
        lambda: _share(names, function, param, number),
        lambda: _count(names, name, function, param, number),
    )
    for rule in rules:
        found = rule()
        if found is not None and found.values:
            return found
    return Suggestion(None, "", fallback_rule(value), fallback(value))


def sweep_values(value: str, others: list[str]) -> list[str]:
    """The values of a sweep: the current one among the others, in order for numbers."""
    everything = [value.strip()] + [other for other in others if other.strip() != value.strip()]
    numbers = [_number(text) for text in everything]
    if all(number is not None for number in numbers):
        return [text for _, text in sorted(zip(numbers, everything), key=lambda pair: pair[0])]
    return everything


# A model's values, when no rule knows the kind.

SYSTEM_PROMPT = """\
You suggest other values of one constant of a data analysis. The analyst tries each value in a
branch of the cell, to see whether the result depends on it. You never change the code.

"constant" is the name of the constant; "parameter" and "function" say where the value goes;
"set_by" says who chose the value; "cell" is the code of the cell that uses it. "value" is the
current value. When "value" is missing, the value stays on the analyst's machine, and the code
shows it as ... (an ellipsis).

Suggest 2 or 3 other values that an analyst in this field would try: values that are common for
this kind of constant, on both sides of the current value where that makes sense, and valid for
the parameter. Write each value as a Python literal, such as 7, 0.01, "left" or True.
why says in at most 12 words what the value means for the analysis.
kind names the kind of constant in at most 6 words, such as "a smoothing window in days".

Answer once, with one JSON object whose keys are "kind" and "values": "values" is a list of
objects, each with "value" and "why". Never send one value on its own."""

SCHEMA = {
    "type": "object",
    "properties": {
        "kind": {"type": "string"},
        "values": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"value": {"type": "string"}, "why": {"type": "string"}},
                "required": ["value", "why"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["kind", "values"],
    "additionalProperties": False,
}

# A local model gets the same instructions, and a grammar that holds each
# answer to the schema and to a length.
WORD = local_models.WORD
LOCAL_SCHEMA = {
    "type": "object",
    "properties": {
        "kind": {"type": "string", "pattern": rf"^{WORD}( {WORD}){{0,5}}$"},
        "values": {
            "type": "array",
            "minItems": 2,
            "maxItems": 3,
            "items": {
                "type": "object",
                "properties": {
                    "value": {"type": "string", "pattern": r"^[A-Za-z0-9_.+\-' ]{1,30}$"},
                    "why": {"type": "string", "pattern": rf"^{WORD}( {WORD}){{0,11}}$"},
                },
                "required": ["value", "why"],
            },
        },
    },
    "required": ["kind", "values"],
}

SET_BY = {
    "defaulted": "a default of the analyst's own function",
    "library_default": "a library default",
    "literal": "written in the cell",
    "agent": "written by an AI model",
    "template": "written by a template that the analyst picked",
    "you": "chosen by the analyst",
}


def prompt_state(name: str, value: str, param: str | None, function: str | None, provenance: str, where: str | None, source: str, keep_local: bool) -> dict[str, Any]:
    """What the model reads about a constant: without its value when the data stays on this machine."""
    state: dict[str, Any] = {
        "constant": name,
        "parameter": param,
        "function": function,
        "set_by": SET_BY.get(provenance, provenance),
        "defined_in": where,
        "cell": (privacy.without_value(source, value) if keep_local else source)[:4000],
    }
    if not keep_local:
        state["value"] = value
    return {key: item for key, item in state.items() if item is not None}


def usable(items: Any, value: str, limit: int = 3) -> list[Value]:
    """The values of a model's answer that can go into code: Python literals, not the current value, each once."""
    found: list[Value] = []
    seen = {value_key(value)}
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        raw = item.get("value")
        text = repr(raw) if isinstance(raw, (bool, int, float)) else str(raw or "").strip()
        why = " ".join(str(item.get("why") or "").split())[:160]
        if not text or len(text) > 80 or _read(text) is None and text != "None":
            continue
        key = value_key(text)
        if key in seen:
            continue
        seen.add(key)
        found.append(Value(text, why))
        if len(found) == limit:
            break
    return found


def value_key(text: str) -> str:
    """A value as the view compares values: 21 and 21.0 are one, "left" and 'left' are one."""
    value = _read(text)
    if isinstance(value, bool) or value is None:
        return text.strip()
    if isinstance(value, (int, float)):
        return repr(float(value))
    return repr(value)


def _result(output: Any, value: str) -> dict[str, Any] | None:
    """The kind and the usable values of a model's answer, or None when no value can go into code."""
    if not isinstance(output, dict):
        return None
    found = usable(output.get("values"), value)
    if not found:
        return None
    kind = " ".join(str(output.get("kind") or "").split())[:80]
    return {"kind": kind, "values": [item.to_json() for item in found]}


NO_VALUES = "The AI model suggested no value that can go into the code."


async def model_values(
    name: str, value: str, param: str | None, function: str | None, provenance: str, where: str | None, source: str, config: Whybook, keep_local: bool = False
) -> AsyncIterator[dict[str, Any]]:
    """Stream progress events, then a result event with the connected model's values: ``kind`` and ``values``."""
    prompt = json.dumps(prompt_state(name, value, param, function, provenance, where, source, keep_local), indent=1)
    # A fast model answered about one call in five with no value that can go
    # into the code: such an answer is asked once more, and what both calls
    # cost goes with the last event, so the view counts it.
    spent = {"cost_usd": 0.0, "elapsed": 0.0}
    for attempt in range(2):
        async for event in connection.structured_call(prompt, schema=SCHEMA, system_prompt=SYSTEM_PROMPT, config=config, effort=config.question_effort):
            if event["type"] == "result":
                for key in spent:
                    if isinstance(event.get(key), (int, float)):
                        event[key] = round(event[key] + spent[key], 6)
                output = event.pop("output", None)
                problems = claude.matches(output, SCHEMA)
                found = None if problems else _result(output, value)
                if found is None:
                    if attempt == 0:
                        spent = {key: event.get(key) or 0.0 for key in spent}
                        break
                    yield {"type": "error", "message": NO_VALUES, **{key: event[key] for key in ("cost_usd", "elapsed", "model") if key in event}}
                    return
                event.update(found)
            yield event
        else:
            return


async def local_values(
    model_id: str, name: str, value: str, param: str | None, function: str | None, provenance: str, where: str | None, source: str, threads: int, check: str = "fast"
) -> AsyncIterator[dict[str, Any]]:
    """Stream progress events, then a result event with a local model's values. A model on this machine reads the value."""
    state = prompt_state(name, value, param, function, provenance, where, source, keep_local=False)
    async for event in local_models.ask_json(model_id, SYSTEM_PROMPT, state, LOCAL_SCHEMA, 300, threads, "suggesting values", check):
        if event["type"] == "result":
            output = event.pop("output", None)
            found = _result(output, value)
            if found is None:
                yield {"type": "error", "message": NO_VALUES, **{key: event[key] for key in ("cost_usd", "elapsed", "model") if key in event}}
                return
            event.update(found)
        yield event
