"""The templates of a unit's id, a time index and dates (design iteration 1.75).

Two testers played first-time analysts on the pain diary and the home energy
data (research/dogfood.md). Each test below is one of their
issues: a unit's id or a time index offered as a cause, a column of dates
compared over its 672 levels, no line per patient over the weeks, quick looks
without numbers, a describe() of 318 patients for a yes-or-no question, dates
left as text, whole numbers drawn as a lattice, three questions on one
transform, and a count per patient that needed a model. Each runs the code
it gets on small frames.
"""

import json

import numpy as np
import pandas as pd
import pytest

from whybook import _display, explore, plots
from whybook.server.questions import templates
from whybook.server.questions.drops import DropRequest, drop_options
from whybook.server.questions.files import FileDrop, file_options
from whybook.server.questions.models import Selection, Variable

FRAMES = {
    "visits": {"rows": 60, "columns": {"patient_id": "id", "week": "int", "crp_mg_l": "num", "analgesic_dose_mg": "int", "site": "cat"}},
    "half_hourly": {"rows": 96 * 14, "columns": {"home_id": "id", "timestamp": "date", "kwh": "num"}},
}
CONTEXT = {"frames": FRAMES, "unit": "patient_id", "units": ["patient_id"], "used": [], "asked": []}


def visits() -> pd.DataFrame:
    """10 patients with 6 visits each, at irregular weeks, and doses in steps of 50 mg."""
    rng = np.random.default_rng(7)
    level = np.repeat(rng.normal(200, 60, 10), 6)
    return pd.DataFrame(
        {
            "patient_id": np.repeat([f"P{i:03d}" for i in range(10)], 6),
            "week": np.concatenate([np.sort(rng.choice(26, 6, replace=False)) for _ in range(10)]),
            "crp_mg_l": rng.gamma(2, 2, 60),
            "analgesic_dose_mg": (np.round((level + rng.normal(0, 40, 60)) / 50) * 50).clip(0, 400).astype(int),
            "site": np.tile(["north", "south", "east"], 20),
        }
    )


def half_hourly() -> pd.DataFrame:
    """Two homes read every half hour for two weeks, with an evening peak."""
    stamps = pd.date_range("2025-02-10", periods=48 * 14, freq="30min")
    hours = stamps.hour + stamps.minute / 60
    use = 0.2 + 0.6 * ((hours >= 16) & (hours < 19))
    return pd.DataFrame({"home_id": np.repeat(["H1", "H2"], len(stamps)), "timestamp": np.tile(stamps, 2), "kwh": np.tile(use, 2)})


def column(label, kind, frame="visits", tag=None):
    return {"name": f"{frame}['{label}']", "label": label, "kind": kind, "parent": frame, "tag": tag, "rows": FRAMES[frame]["rows"]}


WEEK = column("week", "numeric", tag="int")
DOSE = column("analgesic_dose_mg", "numeric", tag="int")
PATIENT = column("patient_id", "id", tag="id")
TIMESTAMP = column("timestamp", "datetime", "half_hourly", "date")
KWH = column("kwh", "numeric", "half_hourly", "num")
HOME = column("home_id", "id", "half_hourly", "id")


def options(source, target, context=CONTEXT):
    request = {"source": source, "target": {"item": target}, "cells": [], "context": context}
    return drop_options(DropRequest.from_json(request))["options"]


def texts(source, target, context=CONTEXT):
    return [option["text"] for option in options(source, target, context)]


def option(source, target, start, context=CONTEXT):
    return next(o for o in options(source, target, context) if o["text"].startswith(start))


@pytest.fixture
def shown(monkeypatch):
    bundles = []
    monkeypatch.setattr(plots, "show", lambda bundle, **kwargs: bundles.append(bundle))
    return bundles


def run(code, **frames):
    namespace = {"visits": visits(), "half_hourly": half_hourly(), **frames}
    exec(code, namespace)  # noqa: S102  the view runs the same code in the kernel
    return namespace


def payloads(bundles):
    return [bundle[_display.PLOT_MIME] for bundle in bundles]


# 1. A unit's id and a time index (pain 4, energy 15 and 19).


@pytest.mark.parametrize(
    "source, target",
    [(WEEK, DOSE), (DOSE, WEEK), (PATIENT, DOSE), (DOSE, PATIENT), (TIMESTAMP, KWH), (KWH, TIMESTAMP)],
    ids=["week onto dose", "dose onto week", "patient onto dose", "dose onto patient", "timestamp onto kwh", "kwh onto timestamp"],
)
def test_a_units_id_or_a_time_index_is_no_cause_and_no_level(source, target):
    found = texts(source, target)
    assert not [text for text in found if "causal path" in text or "What else could explain" in text or "the other way round" in text], found
    assert not [text for text in found if "levels of" in text], found
    assert not [o for o in options(source, target) if o["type"] == "causal"]


def test_two_measures_keep_their_causal_questions():
    crp = column("crp_mg_l", "numeric", tag="num")
    found = texts(crp, DOSE)
    assert "What else could explain both crp_mg_l and analgesic_dose_mg?" in found
    assert "Does crp_mg_l influence analgesic_dose_mg, or the other way round?" in found


@pytest.mark.parametrize("item", [PATIENT, HOME, WEEK, TIMESTAMP], ids=["patient_id", "home_id", "week", "timestamp"])
def test_no_transform_for_an_id_or_a_time(item):
    found = texts(item, item)
    assert not [text for text in found if "ransform" in text], found


def test_the_unit_of_the_analysis_counts_as_an_id_without_the_tag():
    subject = Variable("df['subject']", "subject", "categorical", parent="df", rows=600, unique=300)
    pain = Variable("df['pain']", "pain", "numeric", parent="df", rows=600)
    context = DropRequest.from_json({"source": {"name": "x", "kind": "numeric"}, "target": {"item": {"name": "x", "kind": "numeric"}}, "context": {"unit": "subject"}}).context
    found = {candidate.template for candidate in templates.generate(Selection(subject, pain), context)}
    assert not found & {"group_difference", "equal_spread", "confounding", "direction"}
    assert "random_effect" in found
    assert "group_difference" in {candidate.template for candidate in templates.generate(Selection(subject, pain))}


@pytest.mark.parametrize("name", ["week", "visit", "study_day", "week_num", "visit_number", "timepoint", "t"])
def test_a_number_named_as_a_time_is_a_time_index(name):
    assert templates.is_time(Variable(f"df['{name}']", name, "numeric", parent="df"))


@pytest.mark.parametrize("name", ["reaction_time", "built_year", "sleep_hours", "weeks_pregnant", "day_of_week", "age"])
def test_a_number_that_measures_something_else_is_no_time_index(name):
    assert not templates.is_time(Variable(f"df['{name}']", name, "numeric", parent="df"))


# 2. A column of dates gets its profile by time of day and weekday (energy 15).


def test_a_column_of_dates_and_a_number_get_the_profile_by_hour_and_weekday(shown, capsys):
    profile = option(TIMESTAMP, KWH, "How does kwh vary")
    assert profile["text"] == "How does kwh vary by hour of day and by weekday?"
    assert 'whybook.time_profile(half_hourly, "timestamp", "kwh")' in profile["code"]
    run(profile["code"])
    drawn = payloads(shown)
    assert [payload["x"]["label"] for payload in drawn] == ["hour of day", "weekday, 0 is Monday"]
    hours = drawn[0]["series"][0]["points"]
    assert len(hours) == 48 and max(hours, key=lambda point: point["y"])["x"] >= 16
    assert capsys.readouterr().out.startswith("Mean kwh by hour of day: highest at 16:00 (0.8), lowest at 00:00 (0.2).\nMean kwh by weekday: ")


def test_a_column_named_date_gets_the_profile_by_weekday_and_month(shown, capsys):
    frames = {**FRAMES, "readings": {"rows": 730, "columns": {"home_id": "id", "date": "date", "kwh_import": "num"}}}
    date = {"name": "readings['date']", "label": "date", "kind": "datetime", "parent": "readings", "tag": "date", "rows": 730}
    use = {"name": "readings['kwh_import']", "label": "kwh_import", "kind": "numeric", "parent": "readings", "tag": "num", "rows": 730}
    profile = option(date, use, "How does kwh_import vary", {**CONTEXT, "frames": frames, "unit": "home_id"})
    assert profile["text"] == "How does kwh_import vary by weekday and by month?"
    days = pd.date_range("2025-01-01", periods=365, freq="D")
    readings = pd.DataFrame({"home_id": np.repeat(["H1", "H2"], 365), "date": np.tile(days.date, 2), "kwh_import": np.tile(20 + 10 * np.cos(2 * np.pi * (days.dayofyear - 15) / 365), 2)})
    run(profile["code"], readings=readings)
    assert [payload["x"]["label"] for payload in payloads(shown)] == ["weekday, 0 is Monday", "month"]
    assert "\nMean kwh_import by month: highest in January (29.88), lowest in July (10.12).\n" in capsys.readouterr().out


# 3. A number over a time index: a line per unit and the mean with its band (pain 3).


def test_a_time_index_and_a_number_draw_a_line_per_unit_and_the_mean(shown):
    trajectory = option(WEEK, DOSE, "How does analgesic_dose_mg change over week")
    assert trajectory["text"] == "How does analgesic_dose_mg change over week, per patient?"
    assert 'whybook.ribbon(visits, x="week", y="analgesic_dose_mg", units="patient_id")' in trajectory["code"]
    assert trajectory["uses"] == {"unit": "patient_id"}
    run(trajectory["code"])
    [payload] = payloads(shown)
    assert payload["lines_of"] == {"field": "patient_id", "shown": 10, "total": 10}
    first = payload["lines"][0]
    assert first["name"] == "P000" and len(first["points"]) == 6
    assert len(payload["series"]) == 1 and all("lo" in point for point in payload["series"][0]["points"])


def test_a_ribbon_draws_forty_units_of_many(shown):
    frame = pd.DataFrame({"id": np.repeat(np.arange(300), 2), "t": np.tile([0, 1], 300), "y": np.arange(600.0)})
    plots.ribbon(frame, "t", "y", units="id")
    [payload] = payloads(shown)
    assert payload["lines_of"] == {"field": "id", "shown": 40, "total": 300}
    json.dumps(payload, allow_nan=False)


def test_a_time_index_dropped_on_a_cell_plots_the_outcome_over_time():
    cell = {"id": "c2", "label": "[2]", "source": "fit = smf.mixedlm('analgesic_dose_mg ~ week', visits, groups='patient_id').fit()", "defs": ["fit"], "uses": ["smf", "visits"]}
    request = {"source": WEEK, "target": {"cell": cell}, "cells": [cell], "context": {**CONTEXT, "outcome": "analgesic_dose_mg"}}
    found = drop_options(DropRequest.from_json(request))["options"]
    [plot] = [o for o in found if o["text"].startswith("Plot")]
    assert plot["text"] == "Plot analgesic_dose_mg over week, a line per patient"
    assert 'whybook.ribbon(visits, x="week", y="analgesic_dose_mg", units="patient_id")' in plot["code"]


# 4. Quick looks with numbers (pain 6, energy 8).


def test_the_quick_look_at_a_number_gives_its_numbers(shown):
    summary = option(DOSE, DOSE, "Summarise")
    assert summary["code"] == 'import whybook\n\nwhybook.hist(visits, "analgesic_dose_mg")\nwhybook.summary(visits, "analgesic_dose_mg")'
    frame = visits()
    frame.loc[[3, 7], "analgesic_dose_mg"] = None
    frame.loc[[10, 11, 12], "analgesic_dose_mg"] = 999
    table = run(summary["code"].replace("whybook.summary", "result = whybook.summary"), visits=frame)["result"]
    values = table["analgesic_dose_mg"]
    assert list(table.index) == ["rows", "missing", "distinct", "mean", "sd", "min", "25%", "median", "75%", "max", "lowest", "highest"]
    assert values["rows"] == "60" and values["missing"] == "2 (3%)" and values["max"] == "999"
    assert values["highest"].startswith("999 ×3, ")


def test_the_quick_look_at_dates_gives_the_first_the_last_and_the_longest_gap():
    stamps = pd.Series(pd.to_datetime(["2025-02-10 00:00", "2025-02-10 00:30", "2025-02-10 01:00", "2025-02-10 04:00", None]))
    table = explore.summary(pd.DataFrame({"at": stamps}), "at")
    values = table["at"]
    assert (values["first"], values["last"], values["most common step"], values["longest gap"]) == ("2025-02-10 00:00", "2025-02-10 04:00", "30 min", "3 h")
    assert values["missing"] == "1 (20%)"


def test_the_quick_look_at_an_id_counts_the_rows_of_each_unit_the_fewest_first(shown, capsys):
    summary = option(PATIENT, PATIENT, "Summarise")
    assert summary["text"] == "Summarise patient_id: rows per patient"
    assert summary["code"] == 'import whybook\n\nwhybook.rows_per_unit(visits, "patient_id")'
    frame = visits().drop(index=[0, 1, 2, 13])
    table = run(summary["code"].replace("whybook.rows", "result = whybook.rows"), visits=frame)["result"]
    assert list(table["rows"][:2]) == [3, 5] and list(table.index[:2]) == ["P000", "P002"]
    # The units far below the others are counted too (design iteration 1.85).
    assert capsys.readouterr().out == "10 patients in 56 rows.\n2 patients below 6 rows, 90% of the median.\n"
    [payload] = payloads(shown)
    assert payload["kind"] == "hist" and payload["title"] == "Rows per patient: 3 to 6, median 6"


# 5. A line with the result: the ICC of a number and the unit, and the F test
# of the levels of a category (pain 6 and 37).


def test_a_number_and_the_unit_get_the_share_between_units(capsys):
    icc = option(PATIENT, DOSE, "How much of the variation")
    assert icc["text"] == "How much of the variation in analgesic_dose_mg lies between patients?"
    table = run(icc["code"].replace("whybook.icc", "result = whybook.icc"))["result"]
    line = capsys.readouterr().out
    assert " of the variance of analgesic_dose_mg lies between the 10 patients\n(ICC " in line
    assert "\nThe test of equal means: F = " in line
    assert list(table.columns) == ["ICC", "95% CI", "F", "df", "p", "patients", "rows"]


def test_a_units_id_dropped_on_a_cell_is_no_covariate_but_the_share_between_units(capsys):
    cell = {"id": "c2", "label": "[2]", "source": "fit = smf.ols('analgesic_dose_mg ~ week', visits).fit()", "defs": ["fit"], "uses": ["smf", "visits"], "formulas": ["analgesic_dose_mg ~ week"]}
    request = {"source": PATIENT, "target": {"cell": cell}, "cells": [cell], "context": {**CONTEXT, "outcome": "analgesic_dose_mg"}}
    [share] = drop_options(DropRequest.from_json(request))["options"]
    assert share["text"] == "How much of the variation in analgesic_dose_mg lies between patients?"
    run(share["code"])
    assert "lies between the 10 patients" in capsys.readouterr().out


def test_the_icc_of_groups_of_one_size_is_the_share_of_their_variance():
    # Group means 0, 2, 4 and 6 with a spread of one around them: the variance between the means is 6.667, within 1 by construction.
    rng = np.random.default_rng(0)
    noise = rng.normal(0, 1, (4, 400))
    noise = (noise - noise.mean(axis=1, keepdims=True)) / noise.std(axis=1, ddof=1, keepdims=True)
    frame = pd.DataFrame({"g": np.repeat(list("abcd"), 400), "y": (np.arange(4)[:, None] * 2 + noise).ravel()})
    table = explore.icc(frame, "y", "g")
    between, within = 2**2 * 5 / 3, 1.0
    assert table.loc["y", "ICC"] == pytest.approx((between - within / 400) / (between - within / 400 + within), abs=1e-3)


def test_the_f_distribution_without_scipy_matches_scipy(monkeypatch):
    scipy_stats = pytest.importorskip("scipy.stats")
    cases = [(4.1, 317, 1110), (0.73, 25, 1402), (2.5, 3, 12), (12.0, 1, 358)]
    expected = [scipy_stats.f.sf(*case) for case in cases]
    quantiles = [scipy_stats.f.ppf(0.975, d1, d2) for _, d1, d2 in cases]
    import sys

    monkeypatch.setitem(sys.modules, "scipy.stats", None)
    assert [explore._f_sf(*case) for case in cases] == pytest.approx(expected, rel=1e-6)
    assert [explore._f_ppf(0.975, d1, d2) for _, d1, d2 in cases] == pytest.approx(quantiles, rel=1e-6)


def test_the_levels_of_a_category_get_an_f_test_and_a_row_each(capsys):
    stats = pytest.importorskip("scipy.stats")
    frame = visits()
    table = explore.compare_levels(frame, "crp_mg_l", "site")
    expected = stats.f_oneway(*[part["crp_mg_l"] for _, part in frame.groupby("site")])
    line = capsys.readouterr().out
    assert f"F = {expected.statistic:.3g} on 2 and 57 df, p = {expected.pvalue:.2g}." in line
    assert list(table.columns) == ["rows", "mean", "sd", "95% CI of the mean"] and list(table.index) == ["east", "north", "south"]


def test_the_meaning_of_within_and_between_shows_in_full():
    table = explore.within_between(visits(), "week", "analgesic_dose_mg", group="patient_id")
    html = table._repr_html_()
    assert "when a patient is above its own mean week, is analgesic_dose_mg too?" in html
    assert "do patients with a higher mean week have a higher mean analgesic_dose_mg?" in html
    # The frame stays a frame: a sum, a slice and a copy keep it whole.
    assert "too?" in table.head(1)._repr_html_() and "too?" in repr(table)


# 6. Dates on load (energy 11).


def test_a_csv_file_loads_its_iso_dates_as_dates(tmp_path, monkeypatch):
    (tmp_path / "homes.csv").write_text("home_id,tariff,tou_start,starts\nH1,flat,,00:00\nH2,time of use,2025-03-14,07:00\nH3,time of use,2025-04-02,16:00\n")
    drop = FileDrop.from_json({"source": {"path": "homes.csv", "kernel_path": "homes.csv", "label": "homes.csv"}, "context": {}})
    load = next(o for o in file_options(drop, str(tmp_path))["options"] if o["text"].startswith("Load"))
    assert 'homes = pd.read_csv("homes.csv", parse_dates=["tou_start"])' in load["code"]
    assert load["effect"].endswith(", with tou_start as dates")
    monkeypatch.chdir(tmp_path)
    homes = run(load["code"])["homes"]
    assert pd.api.types.is_datetime64_any_dtype(homes["tou_start"]) and homes["starts"].dtype != "datetime64[ns]"


def test_a_parquet_file_loads_its_dates_as_dates(tmp_path, monkeypatch):
    pytest.importorskip("pyarrow")
    import datetime

    pd.DataFrame({"home_id": ["H1", "H2"], "date": [datetime.date(2025, 1, 1), datetime.date(2025, 1, 2)], "kwh_import": [20.1, 19.9]}).to_parquet(tmp_path / "readings.parquet")
    drop = FileDrop.from_json({"source": {"path": "readings.parquet", "kernel_path": "readings.parquet", "label": "readings.parquet"}, "context": {}})
    load = next(o for o in file_options(drop, str(tmp_path))["options"] if o["text"].startswith("Load"))
    assert 'readings["date"] = pd.to_datetime(readings["date"])' in load["code"]
    monkeypatch.chdir(tmp_path)
    assert pd.api.types.is_datetime64_any_dtype(run(load["code"])["readings"]["date"])


# 7. Whole numbers on both axes are jittered (pain 5).


def lattice() -> pd.DataFrame:
    """400 visits on 10 whole weeks and doses in steps of 50 mg: about 90 spots."""
    rng = np.random.default_rng(5)
    return pd.DataFrame({"week": rng.integers(0, 10, 400), "analgesic_dose_mg": rng.integers(0, 9, 400) * 50, "crp_mg_l": rng.gamma(2, 2, 400)})


def test_a_scatter_of_whole_numbers_moves_its_points_apart(shown):
    frame = lattice()
    plots.scatter(frame, "week", "analgesic_dose_mg")
    [payload] = payloads(shown)
    assert payload["jitter"] == {"x": 0.25, "y": 12.5}
    assert payload["title"] == "analgesic_dose_mg by week (jittered)"
    points = payload["points"]
    assert len(frame[["week", "analgesic_dose_mg"]].drop_duplicates()) < 100 and len({(point["x"], point["y"]) for point in points}) == len(points) == 400
    for point in points:
        row = frame.iloc[point["i"]]
        assert abs(point["x"] - row["week"]) <= 0.25 and abs(point["y"] - row["analgesic_dose_mg"]) <= 12.5


def test_a_scatter_of_measures_or_with_jitter_off_keeps_its_points(shown):
    frame = lattice()
    plots.scatter(frame, "crp_mg_l", "analgesic_dose_mg")
    plots.scatter(frame, "week", "analgesic_dose_mg", jitter=False)
    plots.scatter(visits(), "week", "crp_mg_l")
    measured, kept, few = payloads(shown)
    assert "jitter" not in kept and [point["y"] for point in kept["points"]] == list(frame["analgesic_dose_mg"])
    # Doses on a lattice, CRP measured: only the axis of whole numbers moves.
    assert measured["jitter"] == {"y": 12.5}
    assert [point["x"] for point in measured["points"]] == list(frame["crp_mg_l"])
    # 60 visits over 26 weeks: about two rows a week, which a dot each shows.
    assert "jitter" not in few


# 8. One question on the shape of a number (energy 21, pain 24).


def test_a_number_gets_one_question_about_its_shape():
    found = texts(DOSE, DOSE)
    shape = [text for text in found if "normal" in text or "ransform" in text]
    assert shape == ["Is analgesic_dose_mg close enough to normal for the planned model, or should it be transformed?"]


# 9. The rows of each unit, a group-by count (pain 23).


def test_a_time_index_and_a_number_ask_how_many_rows_each_unit_has(shown, capsys):
    counts = option(WEEK, DOSE, "How many rows")
    assert counts["text"] == "How many rows does each patient have in visits?"
    run(counts["code"])
    assert capsys.readouterr().out == "10 patients in 60 rows.\n"
