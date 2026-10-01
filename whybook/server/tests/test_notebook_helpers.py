"""The notebook helpers (whybook/plots.py, whybook/explore.py): what their payloads and tables hold."""

import builtins
import datetime
import json

import numpy as np
import pandas as pd
import pytest

import whybook
from whybook import _display, explore, plots


@pytest.fixture
def shown(monkeypatch):
    bundles = []
    monkeypatch.setattr(plots, "show", lambda bundle, **kwargs: bundles.append(bundle))
    return bundles


def payload(bundles):
    return bundles[-1][_display.PLOT_MIME]


def ms(text):
    """Milliseconds since 1970 of a time read as UTC, as the view reads a date."""
    return int(pd.Timestamp(text).value // 10**6)


# Numbers at full precision (critique 3, item 15).


def test_a_histogram_of_small_values_keeps_its_bin_edges(shown):
    # Concentrations in mol/L: 0.1 to 0.9 micromolar.
    frame = pd.DataFrame({"conc_M": np.linspace(1e-7, 9e-7, 50)})
    plots.hist(frame, "conc_M", bins=4)
    edges = [(item["x0"], item["x1"]) for item in payload(shown)["bins"]]
    expected = np.histogram(frame["conc_M"], bins=4)[1]
    assert [x0 for x0, _ in edges] + [edges[-1][1]] == pytest.approx(list(expected), rel=1e-12)


def test_a_scatter_of_small_values_keeps_its_points(shown):
    frame = pd.DataFrame({"dose_g": [1e-7, 2e-7, 3e-7, 4e-7], "response": [1.0, 2.0, 3.0, 4.0]})
    plots.scatter(frame, "dose_g", "response")
    assert [point["x"] for point in payload(shown)["points"]] == [1e-7, 2e-7, 3e-7, 4e-7]


def test_a_payload_holds_no_infinity_that_json_cannot_carry(shown):
    frame = pd.DataFrame({"x": [1.0, 2.0, 3.0], "y": [1.0, np.inf, 2.0]})
    plots.scatter(frame, "x", "y")
    assert [point["y"] for point in payload(shown)["points"]] == [1.0, None, 2.0]
    json.dumps(payload(shown), allow_nan=False)


def test_profile_shows_one_missing_value_in_a_thousand():
    frame = pd.DataFrame({"age": [30.0] * 999 + [None], "sex": ["f"] * 1000})
    table = whybook.profile(frame)
    assert table.loc["age", "missing"] == "0.1%"
    assert table.loc["sex", "missing"] == "0%"


def test_by_group_keeps_a_small_mean_and_a_small_share_missing():
    # Residuals by site: their means are small by construction.
    frame = pd.DataFrame({"site": ["a"] * 1000 + ["b"] * 2, "residual": [0.0004] * 999 + [None] + [0.12, 0.14]})
    table = whybook.by_group(frame, "residual", "site")
    assert table.loc["a", "mean"] == pytest.approx(0.0004)
    assert table.loc["a", "missing"] == "0.1%"
    assert table.loc["b", "mean"] == pytest.approx(0.13)


@pytest.mark.parametrize(
    "fraction, text",
    [(0, "0%"), (0.0003, "< 0.1%"), (0.001, "0.1%"), (0.0042, "0.4%"), (0.123, "12%"), (1, "100%"), (0.995, "99.5%"), (0.9998, "> 99.9%")],
)
def test_a_share_reads_as_the_view_writes_it(fraction, text):
    # The same examples as shareText in src/__tests__/numbers.spec.ts.
    assert explore._share(fraction) == text


# Dates (critique 3, item 16).


def test_a_ribbon_over_days_sends_each_day_as_milliseconds(shown):
    diary = pd.DataFrame(
        {
            "day": pd.to_datetime(["2024-01-01", "2024-01-01", "2024-01-02", "2024-01-02", "2024-01-03", "2024-01-03"]),
            "pain": [3.0, 4.0, 5.0, 4.0, 6.0, 5.0],
        }
    )
    plots.ribbon(diary, "day", "pain")
    sent = payload(shown)
    assert sent["x"] == {"field": "day", "label": "day", "type": "date"}
    points = sent["series"][0]["points"]
    assert [point["x"] for point in points] == [ms("2024-01-01"), ms("2024-01-02"), ms("2024-01-03")]
    assert [point["y"] for point in points] == [3.5, 4.5, 5.5]


def test_a_scatter_sends_dates_on_either_axis(shown):
    visits = pd.DataFrame(
        {"day": pd.to_datetime(["2024-01-01 06:30", "2024-01-02 18:00"]), "next": pd.to_datetime(["2024-02-01", "2024-03-01"])}
    )
    plots.scatter(visits, "day", "next")
    sent = payload(shown)
    assert sent["x"]["type"] == sent["y"]["type"] == "date"
    assert [(point["x"], point["y"]) for point in sent["points"]] == [
        (ms("2024-01-01 06:30"), ms("2024-02-01")),
        (ms("2024-01-02 18:00"), ms("2024-03-01")),
    ]


# The groups of a scatter (critique 4, the app): the view colours and names
# them in the order of a ribbon's lines, so that one colour is one group.


def test_a_scatter_lists_its_groups_in_the_order_of_a_ribbons_lines(shown):
    frame = pd.DataFrame({"week": [1, 2, 3, 4], "pain": [5.0, 4.0, 6.0, 3.0], "arm": ["B", "A", "B", "A"]})
    plots.ribbon(frame, "week", "pain", by="arm")
    lines = [series["name"] for series in payload(shown)["series"]]
    plots.scatter(frame, "week", "pain", by="arm")
    assert payload(shown)["groups"] == lines == ["A", "B"]


def test_a_scatter_names_a_whole_number_group_as_its_groups_do(shown):
    # iterrows made every value of a row of numbers a float: group 2 was "2.0".
    frame = pd.DataFrame({"fitted": [0.5, 1.5, 2.5], "residual": [0.1, -0.2, 0.3], "week": [2, 10, 2]})
    plots.scatter(frame, "fitted", "residual", by="week")
    sent = payload(shown)
    assert sent["groups"] == ["2", "10"]
    assert [point["g"] for point in sent["points"]] == ["2", "10", "2"]


def test_a_scatter_without_groups_lists_none(shown):
    plots.scatter(pd.DataFrame({"x": [1.0, 2.0], "y": [3.0, 4.0]}), "x", "y")
    assert "groups" not in payload(shown)


def test_dates_with_a_time_zone_keep_their_clock_time_and_name_the_zone(shown):
    frame = pd.DataFrame(
        {"at": pd.to_datetime(["2024-01-01 00:00", "2024-01-01 06:00"]).tz_localize("Europe/Warsaw"), "pain": [3.0, 4.0]}
    )
    plots.scatter(frame, "at", "pain")
    sent = payload(shown)
    assert sent["x"] == {"field": "at", "label": "at", "type": "date", "tz": "Europe/Warsaw"}
    assert [point["x"] for point in sent["points"]] == [ms("2024-01-01 00:00"), ms("2024-01-01 06:00")]


def test_dates_held_as_python_objects_count_as_dates(shown):
    frame = pd.DataFrame({"day": [datetime.date(2024, 1, 1), datetime.date(2024, 1, 2)], "pain": [3.0, 4.0]})
    plots.ribbon(frame, "day", "pain")
    sent = payload(shown)
    assert sent["x"] == {"field": "day", "label": "day", "type": "date", "objects": True}
    assert [point["x"] for point in sent["series"][0]["points"]] == [ms("2024-01-01"), ms("2024-01-02")]


def test_a_histogram_of_dates_has_its_bins_in_milliseconds(shown):
    frame = pd.DataFrame({"day": pd.to_datetime(["2024-01-01", "2024-01-03", "2024-01-05", None])})
    plots.hist(frame, "day", bins=2)
    sent = payload(shown)
    assert sent["x"]["type"] == "date"
    assert [(item["x0"], item["x1"], item["n"]) for item in sent["bins"]] == [
        (ms("2024-01-01"), ms("2024-01-03"), 1),
        (ms("2024-01-03"), ms("2024-01-05"), 2),
    ]
    assert sent["missing"] == 1


def test_a_bar_of_a_date_reads_as_the_column_does_as_text(shown):
    # The view finds a bar's rows with astype(str) (src/model/bars.ts).
    frame = pd.DataFrame({"day": pd.to_datetime(["2024-01-01", "2024-01-01", "2024-01-02"]), "pain": [3.0, 5.0, 4.0]})
    plots.bars(frame, "day", "pain")
    labels = [bar["x"] for bar in payload(shown)["bars"]]
    assert labels == ["2024-01-01", "2024-01-02"]
    assert set(labels) == set(frame["day"].astype(str))


@pytest.mark.demo
@pytest.mark.parametrize(
    "day, column, low, high",
    [
        # The code of a picked range, as boundCode and columnCode write it
        # (src/model/numbers.ts) from the axis that the plot sent.
        pytest.param(pd.to_datetime, 'dated["day"]', 'pd.Timestamp("2024-01-02")', 'pd.Timestamp("2024-01-03")', id="dates"),
        pytest.param(
            lambda days: pd.to_datetime(days).tz_localize("Europe/Warsaw"),
            'dated["day"]',
            'pd.Timestamp("2024-01-02", tz="Europe/Warsaw")',
            'pd.Timestamp("2024-01-03", tz="Europe/Warsaw")',
            id="dates in a time zone",
        ),
        pytest.param(
            lambda days: [datetime.date.fromisoformat(day) for day in days],
            'pd.to_datetime(dated["day"])',
            'pd.Timestamp("2024-01-02")',
            'pd.Timestamp("2024-01-03")',
            id="Python dates",
        ),
    ],
)
def test_a_range_of_dates_counts_the_rows_that_its_code_keeps(demo, day, column, low, high):
    days = ["2024-01-01", "2024-01-02", "2024-01-02", "2024-01-03", "2024-01-04"]
    demo.shell.user_ns["dated"] = pd.DataFrame({"day": day(days), "pain": [1.0, 2.0, 3.0, 4.0, 5.0]})
    try:
        summary = demo.kernel("region_summary", {"frame": "dated", "x": "day", "x0": ms("2024-01-02"), "x1": ms("2024-01-03")})
        assert summary["rows"] == 3
        assert summary["where"] == "2024-01-02 <= day <= 2024-01-03"
        demo.run(f"import pandas as pd\n_kept = dated[{column}.between({low}, {high})]")
        assert list(demo.shell.user_ns["_kept"]["pain"]) == [2.0, 3.0, 4.0]
    finally:
        demo.run("del dated\n_kept = None\ndel _kept")


# Bars (critique 3, item 18).


def test_bars_count_the_rows_behind_each_mean(shown):
    frame = pd.DataFrame({"arm": ["A"] * 10 + ["B"] * 2, "pain": [None] * 8 + [4.0, 6.0] + [5.0, 7.0]})
    plots.bars(frame, "arm", "pain")
    bars = {item["x"]: item for item in payload(shown)["bars"]}
    assert (bars["A"]["y"], bars["A"]["n"]) == (5.0, 2)
    assert (bars["B"]["y"], bars["B"]["n"]) == (6.0, 2)


def test_bars_of_counts_count_every_row(shown):
    frame = pd.DataFrame({"arm": ["A"] * 10 + ["B"] * 2, "pain": [None] * 8 + [4.0, 6.0] + [5.0, 7.0]})
    plots.bars(frame, "arm")
    assert [(item["x"], item["y"], item["n"]) for item in payload(shown)["bars"]] == [("A", 10, 10), ("B", 2, 2)]


# Wrong numbers on less common input (critique 3, item 40).


def test_the_ribbon_s_95_percent_interval_covers_the_mean_95_percent_of_the_time_with_3_rows_per_point(shown):
    # 2,000 points of 3 rows each from a normal distribution of mean 10.
    rng = np.random.default_rng(3)
    frame = pd.DataFrame({"x": np.repeat(np.arange(2000), 3), "y": rng.normal(10, 2, 6000)})
    plots.ribbon(frame, "x", "y")
    points = payload(shown)["series"][0]["points"]
    covered = np.mean([point["lo"] <= 10 <= point["hi"] for point in points])
    assert 0.94 < covered < 0.96, f"the 95% interval covers the mean for {covered:.1%} of the points"


def test_the_t_quantiles_without_scipy_match_scipy(monkeypatch):
    stats = pytest.importorskip("scipy.stats")
    exact = {df: float(stats.t.ppf(0.975, df)) for df in range(1, 301)}
    real_import = builtins.__import__

    def without_scipy(name, *args, **kwargs):
        if name.startswith("scipy"):
            raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", without_scipy)
    for df, quantile in exact.items():
        assert plots._t975(df) == pytest.approx(quantile, abs=1e-5), df


def test_screen_leaves_out_a_row_with_a_missing_adjustment_and_says_so(capsys):
    rng = np.random.default_rng(2)
    frame = pd.DataFrame({"age": rng.normal(50, 10, 100), "x": rng.normal(0, 1, 100), "y": rng.normal(0, 1, 100)})
    frame.loc[0, "age"] = None
    table = whybook.screen(frame, "y", adjust=["age"])
    assert np.isfinite(table.loc["x", "r"])
    assert table.loc["x", "n"] == 99
    assert "Left out 1 of 100 rows with a missing age." in capsys.readouterr().out


def test_screen_leaves_out_a_row_with_a_missing_level_of_an_adjustment():
    # Without the fix, the row with no site was adjusted as if it were in site a.
    frame = pd.DataFrame(
        {
            "site": ["a", "a", "a", "b", "b", "b", None, "b"],
            "x": [1.0, 2.0, 3.0, 10.0, 11.0, 12.0, 30.0, 13.0],
            "y": [1.0, 2.0, 3.0, 10.0, 11.0, 12.0, 0.0, 13.0],
        }
    )
    assert whybook.screen(frame, "y", adjust=["site"]).loc["x", "n"] == 7


def test_screen_matches_the_partial_correlation_of_statsmodels():
    sm = pytest.importorskip("statsmodels.api")
    stats = pytest.importorskip("scipy.stats")
    rng = np.random.default_rng(1)
    age = rng.normal(50, 10, 200)
    x = 0.5 * age + rng.normal(0, 5, 200)
    y = 0.3 * age + 0.4 * x + rng.normal(0, 5, 200)
    frame = pd.DataFrame({"age": age, "x": x, "y": y})
    design = sm.add_constant(frame[["age"]])
    rx = sm.OLS(frame["x"], design).fit().resid
    ry = sm.OLS(frame["y"], design).fit().resid
    assert whybook.screen(frame, "y", adjust=["age"]).loc["x", "r"] == pytest.approx(stats.pearsonr(rx, ry)[0], abs=1e-3)
