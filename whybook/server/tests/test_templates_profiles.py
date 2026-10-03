"""The templates of profiles, splits by a level and wide frames (design iteration 1.85).

Two testers played first-time analysts on the home energy data and on the
pain diary again, after the fixes of the first pass. Each
test below is one of their issues: the share between patients computed on a
leftover frame of an agent, the profile by hour of day offered for the date
a home switched tariff, a month panel drawn from two months, a cross table
of home-days with no test, the homes with gaps listed and not counted, no
profile or trajectory split by a group, two cards with different means for
the same arms, a wide diary that only a model could reshape, its wide
columns suggested as separate measures, and rows at the ends of a quick
look that only a model could leave out. Each runs the code it gets on small
frames.
"""

import numpy as np
import pandas as pd
import pytest

from whybook import _display, explore, plots
from whybook.server import codegen
from whybook.server.questions.drops import DropRequest, drop_options

# The pain diary after the join of patients, a weekly frame that an agent
# left behind, and the raw diary with one row per patient-week.
PAIN_FRAMES = {
    "diary_patients": {"rows": 400, "columns": {"patient_id": "id", "week": "int", "day": "int", "pain": "num", "treatment_arm": "cat", "site": "cat", "age": "int"}},
    "grp": {"rows": 26, "columns": {"week": "int", "pain": "num"}},
    "diary_raw": {"rows": 80, "columns": {"patient_id": "id", "week": "int", "pain_1": "num", "pain_2": "num"}},
}
PAIN = {"frames": PAIN_FRAMES, "unit": "patient_id", "units": ["patient_id"], "outcome": "pain", "outcomes": ["pain"], "used": [], "asked": []}


def column(label, kind, frame, tag, frames):
    return {"name": f"{frame}['{label}']", "label": label, "kind": kind, "parent": frame, "tag": tag, "rows": frames[frame]["rows"]}


def pain_column(label, kind, tag, frame="diary_patients"):
    return column(label, kind, frame, tag, PAIN_FRAMES)


def onto_cell(source, cell, context, cells=None):
    request = {"source": source, "target": {"cell": cell}, "cells": cells or [cell], "context": context}
    return drop_options(DropRequest.from_json(request))["options"]


def diary_patients(patients=20, weeks=4) -> pd.DataFrame:
    """Patients in two arms, a pain score on each day of each week, and a level per patient."""
    rng = np.random.default_rng(3)
    rows = patients * weeks * 7
    level = np.repeat(rng.normal(5, 1.5, patients), weeks * 7)
    slope = np.repeat(rng.normal(0, 0.15, patients), weeks * 7)
    arm = np.repeat(np.where(np.arange(patients) % 2, "B", "A"), weeks * 7)
    week = np.tile(np.repeat(np.arange(1, weeks + 1), 7), patients)
    pain = level - (np.where(arm == "B", 0.4, 0.1) + slope) * week + rng.normal(0, 1, rows)
    return pd.DataFrame(
        {
            "patient_id": np.repeat([f"P{i:03d}" for i in range(patients)], weeks * 7),
            "week": week,
            "day": np.tile(np.arange(1, 8), patients * weeks),
            "pain": pain,
            "treatment_arm": arm,
            "site": np.repeat(np.where(np.arange(patients) % 3, "east", "west"), weeks * 7),
            "age": np.repeat(rng.integers(20, 50, patients), weeks * 7),
        }
    )


@pytest.fixture
def shown(monkeypatch):
    bundles = []
    monkeypatch.setattr(plots, "show", lambda bundle, **kwargs: bundles.append(bundle))
    return bundles


def payloads(bundles):
    return [bundle[_display.PLOT_MIME] for bundle in bundles]


def run(code, **frames):
    namespace = dict(frames)
    exec(code, namespace)  # noqa: S102  the view runs the same code in the kernel
    return namespace


# 1. The share between patients on a model card took the agent's leftover
# frame grp, and joined patient_id to it through the week (pain step 16).

AGENT_CELL = {
    "id": "c8",
    "label": "[8]",
    "source": "\n".join(
        [
            "fig, ax = plt.subplots(figsize=(8, 5))",
            "for arm, grp in diary_patients.groupby('treatment_arm'):",
            "    grp = grp.groupby('week', as_index=False)['pain'].mean()",
            "    ax.plot(grp['week'], grp['pain'], marker='o', label=arm)",
            "fit = smf.ols('pain ~ week * treatment_arm', data=diary_patients).fit(cov_type='cluster', cov_kwds={'groups': diary_patients['patient_id']})",
        ]
    ),
    "defs": ["fig", "ax", "arm", "grp", "fit"],
    "uses": ["plt", "diary_patients", "smf"],
    "formulas": ["pain ~ week * treatment_arm"],
}


def test_the_share_between_units_on_a_card_uses_the_frame_the_unit_was_dragged_from(capsys):
    [share] = onto_cell(pain_column("patient_id", "id", "id"), AGENT_CELL, PAIN)
    assert share["text"] == "How much of the variation in pain lies between patients?"
    assert 'whybook.icc(diary_patients, "pain", "patient_id")' in share["code"]
    assert "grp" not in share["code"] and "merge" not in share["code"]
    run(share["code"], diary_patients=diary_patients())
    assert "lies between the 20 patients" in capsys.readouterr().out


def test_a_units_id_is_never_joined_through_another_key():
    # One arbitrary patient per week, with .first(): no plan at all.
    frames = {name: frame["columns"] for name, frame in PAIN_FRAMES.items()}
    assert codegen.plan_data("grp", ["patient_id"], frames, "patient_id", target="_x") is None
    # A level of the units, such as the arm, through the week: one arbitrary arm per week.
    assert codegen.plan_data("grp", ["treatment_arm"], frames, "patient_id", target="_x") is None
    # A number of the units through the week stays a mean per week, and a join on the unit stays.
    assert codegen.plan_data("grp", ["age"], frames, "patient_id", target="_x").lines[1].endswith('["age"].mean(), on="week", how="left")')
    joined = codegen.plan_data("diary_raw", ["treatment_arm"], frames, "patient_id", target="_x")
    assert 'on=["patient_id", "week"]' in joined.lines[1] or 'on="patient_id"' in joined.lines[1]


# 2. The profile by hour of day and weekday was offered for tou_start, one
# date per home with no time of day, against daily readings (energy step 16).

ENERGY_FRAMES = {
    "readings": {"rows": 129058, "columns": {"home_id": "id", "date": "date", "kwh_import": "num", "kwh_peak": "num"}},
    "homes": {"rows": 360, "columns": {"home_id": "id", "tariff": "cat", "tou_start": "date", "has_ev": "bool", "heating": "cat"}},
    "readings_homes": {
        "rows": 129058,
        "columns": {"home_id": "id", "date": "date", "kwh_import": "num", "kwh_peak": "num", "tariff": "cat", "tou_start": "date", "has_ev": "bool", "heating": "cat"},
    },
    "half_hourly": {"rows": 241920, "columns": {"home_id": "id", "timestamp": "date", "kwh": "num"}},
}
ENERGY = {"frames": ENERGY_FRAMES, "unit": "home_id", "units": ["home_id"], "outcome": "kwh_import", "outcomes": ["kwh_import"], "used": [], "asked": []}


def energy_column(label, kind, frame, tag, **listing):
    return {**column(label, kind, frame, tag, ENERGY_FRAMES), **listing}


def pair(source, target, context=ENERGY):
    request = {"source": source, "target": {"item": target}, "cells": [], "context": context}
    return drop_options(DropRequest.from_json(request))["options"]


DAY = {"min": "2025-01-01 00:00:00", "max": "2025-12-31 00:00:00"}
TOU_START = energy_column("tou_start", "datetime", "readings_homes", "date", min="2025-03-03 00:00:00", max="2025-09-29 00:00:00")
KWH_PEAK = energy_column("kwh_peak", "numeric", "readings_homes", "num")


def test_a_date_that_each_unit_has_once_gets_no_profile_and_no_rows_per_unit():
    found = [o["text"] for o in pair(TOU_START, KWH_PEAK)]
    assert not [text for text in found if "vary by" in text], found
    assert not [text for text in found if text.startswith("How many rows")], found
    # The trend over the switch date stays, for a model to answer.
    assert "How does kwh_peak change over tou_start?" in found


def test_daily_dates_get_the_profile_by_weekday_and_month():
    date = energy_column("date", "datetime", "readings", "date", **DAY)
    found = [o["text"] for o in pair(date, energy_column("kwh_import", "numeric", "readings", "num"))]
    assert "How does kwh_import vary by weekday and by month?" in found
    assert "How many rows does each home have in readings?" in found


def test_times_of_day_get_the_profile_by_hour_and_weekday_whatever_the_name():
    stamp = energy_column("timestamp", "datetime", "half_hourly", "date", min="2025-02-10 00:00:00", max="2025-10-12 23:30:00")
    kwh = energy_column("kwh", "numeric", "half_hourly", "num")
    assert "How does kwh vary by hour of day and by weekday?" in [o["text"] for o in pair(stamp, kwh)]
    named = energy_column("date", "datetime", "half_hourly", "date", min="2025-02-10 00:00:00", max="2025-10-12 23:30:00")
    frames = {**ENERGY_FRAMES, "half_hourly": {"rows": 241920, "columns": {"home_id": "id", "date": "date", "kwh": "num"}}}
    found = [o["text"] for o in pair(named, kwh, {**ENERGY, "frames": frames})]
    assert "How does kwh vary by hour of day and by weekday?" in found


# 3. The month panel was drawn from two months: a week of February and a
# week of October (energy step 21).


def two_weeks() -> pd.DataFrame:
    stamps = pd.date_range("2025-02-10", periods=48 * 7, freq="30min").append(pd.date_range("2025-10-06", periods=48 * 7, freq="30min"))
    hours = stamps.hour + stamps.minute / 60
    use = 0.2 + 0.6 * ((hours >= 16) & (hours < 19)) + 0.1 * (stamps.month == 2)
    return pd.DataFrame({"home_id": "H1", "timestamp": stamps, "kwh": use})


def test_a_panel_with_fewer_than_three_levels_is_left_out(shown, capsys):
    explore.time_profile(two_weeks(), "timestamp", "kwh")
    assert [payload["x"]["label"] for payload in payloads(shown)] == ["hour of day", "weekday, 0 is Monday"]
    assert "by month" not in capsys.readouterr().out
    # Two times of day, noon and midnight, on two days of one month: no panel at all.
    twice = pd.DataFrame({"at": pd.date_range("2025-03-03", periods=4, freq="12h"), "y": np.arange(4.0)})
    shown.clear()
    explore.time_profile(twice, "at", "y")
    assert payloads(shown) == []
    assert "no profile to draw" in capsys.readouterr().out


# 4. The cross table of tariff by EV counted home-days and gave no test
# (energy step 15).


def readings_homes(homes=360, days=5) -> pd.DataFrame:
    """Homes on two tariffs, with an electric car in 34 of 267 flat homes and in 54 of 93 that switched."""
    tariff = np.where(np.arange(homes) < 267, "flat", "time of use")
    car = np.zeros(homes, bool)
    car[:34] = True
    car[267 : 267 + 54] = True
    return pd.DataFrame(
        {
            "home_id": np.repeat([f"H{i:03d}" for i in range(homes)], days),
            "date": np.tile(pd.date_range("2025-01-01", periods=days), homes),
            "tariff": np.repeat(tariff, days),
            "has_ev": np.repeat(car, days),
            "kwh_import": np.random.default_rng(2).gamma(4, 4, homes * days),
        }
    )


def test_two_attributes_of_the_units_count_each_unit_once_with_a_chi_square_test(capsys):
    tariff = energy_column("tariff", "categorical", "readings_homes", "cat")
    has_ev = energy_column("has_ev", "binary", "readings_homes", "bool")
    [independent] = [o for o in pair(tariff, has_ev) if o["text"] == "Are tariff and has_ev independent?"]
    assert 'whybook.cross_table(readings_homes, "tariff", "has_ev", unit="home_id")' in independent["code"]
    table = run(independent["code"].replace("whybook.cross_table", "result = whybook.cross_table"), readings_homes=readings_homes())["result"]
    assert list(table.columns) == ["False", "True", "homes"] and list(table["homes"]) == [267, 93]
    assert table.loc["time of use", "True"] == "54 (58%)"
    stats = pytest.importorskip("scipy.stats")
    expected = stats.chi2_contingency([[233, 34], [39, 54]])
    out = capsys.readouterr().out
    assert out.startswith("has_ev True: from 13% (flat) to 58% (time of use) over the 2 levels of tariff, one row per home.\n")
    assert f"Chi-square test of independence: chi-square = {expected.statistic:.3g} on 1 df, p < 0.001." in out


def test_the_chi_square_test_without_scipy_matches_scipy(monkeypatch):
    stats = pytest.importorskip("scipy.stats")
    tables = [[[233, 34], [39, 54]], [[10, 12, 8], [7, 30, 4]], [[3, 1], [2, 6]]]
    expected = [stats.chi2_contingency(table) for table in tables]
    import sys

    monkeypatch.setitem(sys.modules, "scipy.stats", None)
    for table, result in zip(tables, expected):
        statistic, dof, p, smallest = explore._chi_square(pd.DataFrame(table))
        assert (statistic, dof, smallest) == (pytest.approx(result.statistic), result.dof, pytest.approx(result.expected_freq.min()))
        assert p == pytest.approx(result.pvalue, rel=1e-6)


# 5. The rows per home listed the 10 lowest homes and stopped, with no count
# of the homes far below the median (energy step 10).


def test_the_rows_per_unit_count_the_units_below_a_share_of_the_median(shown, capsys):
    # 30 homes with 363 rows, and 4 with 271, 302, 326 and 327: three of them under 327, 90% of 363.
    counts = [363] * 30 + [271, 302, 326, 327]
    frame = pd.DataFrame({"home_id": np.repeat([f"H{i:03d}" for i in range(len(counts))], counts)})
    table = explore.rows_per_unit(frame, "home_id")
    out = capsys.readouterr().out
    assert out == "34 homes in 12,116 rows.\n3 homes below 327 rows, 90% of the median.\n"
    assert list(table["rows"][:4]) == [271, 302, 326, 327]
    # Units that all have as many rows get no such line.
    explore.rows_per_unit(pd.DataFrame({"home_id": np.repeat(["H1", "H2"], 5)}), "home_id")
    assert capsys.readouterr().out == "2 homes in 10 rows.\n"


# 6. No template split a profile by a group: tariff dropped on the profile
# gave one bar per tariff (energy steps 22 and 23), and treatment_arm on the
# trajectory of pain gave no split (pain steps 11 and 26).

PROFILE_CELL = {
    "id": "c11",
    "label": "[11]",
    "source": '# How does kwh vary by hour of day and by weekday?\nimport whybook\n\nwhybook.time_profile(half_hourly, "timestamp", "kwh")',
    "defs": [],
    "uses": ["whybook", "half_hourly"],
}
TRAJECTORY_CELL = {
    "id": "c6",
    "label": "[6]",
    "source": '# How does pain change over week, per patient?\nimport whybook\n\nwhybook.ribbon(diary_patients, x="week", y="pain", units="patient_id")',
    "defs": [],
    "uses": ["whybook", "diary_patients"],
}


def half_hourly_two_homes() -> pd.DataFrame:
    stamps = pd.date_range("2025-02-10", periods=48 * 7, freq="30min")
    hours = stamps.hour + stamps.minute / 60
    evening = (hours >= 16) & (hours < 19)
    # The home on time of use moves its evening peak to the night.
    flat = 0.2 + 0.6 * evening
    shifted = 0.2 + 0.2 * evening + 0.4 * (hours < 5)
    return pd.DataFrame({"home_id": np.repeat(["H1", "H2"], len(stamps)), "timestamp": np.tile(stamps, 2), "kwh": np.concatenate([flat, shifted])})


def test_a_level_of_the_units_on_a_profile_draws_one_line_per_level(shown, capsys):
    tariff = energy_column("tariff", "categorical", "homes", "cat", unique=2)
    found = onto_cell(tariff, PROFILE_CELL, {**ENERGY, "outcome": "kwh", "outcomes": ["kwh"]})
    split = found[0]
    assert split["text"] == "The same profile of kwh, one line per tariff"
    assert 'whybook.time_profile(_kwh_by_tariff_data, "timestamp", "kwh", by="tariff")' in split["code"]
    assert 'homes.groupby("home_id", as_index=False, observed=True)["tariff"].first(), on="home_id", how="left")' in split["code"]
    # The bars that pooled every half hour are not offered beside it.
    assert not [o for o in found if o["text"].startswith("Plot ")]
    homes = pd.DataFrame({"home_id": ["H1", "H2"], "tariff": ["flat", "time of use"]})
    run(split["code"], half_hourly=half_hourly_two_homes(), homes=homes)
    hours, weekdays = payloads(shown)
    assert [series["name"] for series in hours["series"]] == ["flat", "time of use"]
    assert hours["title"] == "Mean kwh by hour of day, one line per tariff"
    out = capsys.readouterr().out
    assert "Mean kwh by hour of day, tariff flat: highest at 16:00 (0.8)" in out
    assert "Mean kwh by hour of day, tariff time of use: highest at " in out


def test_an_arm_on_a_trajectory_draws_one_line_per_arm_and_asks_a_mixed_model(shown):
    arm = pain_column("treatment_arm", "binary", "cat")
    found = onto_cell(arm, TRAJECTORY_CELL, PAIN)
    split, model = found[0], found[1]
    assert split["text"] == "The same trajectory of pain, one line per treatment_arm"
    assert 'whybook.ribbon(diary_patients, x="week", y="pain", by="treatment_arm")' in split["code"]
    run(split["code"], diary_patients=diary_patients())
    [payload] = payloads(shown)
    assert [series["name"] for series in payload["series"]] == ["A", "B"]
    assert model["text"] == "Does treatment_arm change the trajectory of pain?"
    assert 'smf.mixedlm("pain ~ week * treatment_arm", diary_patients, groups=diary_patients["patient_id"], re_formula="~week").fit()' in model["code"]
    pytest.importorskip("statsmodels")
    namespace = run(model["code"], diary_patients=diary_patients(patients=40, weeks=6))
    terms = list(namespace["pain_by_week_and_treatment_arm"].params.index)
    assert "week:treatment_arm[T.B]" in terms


# 7. The plot of the arms averaged rows (A 3.18, B 1.63) and the F test
# averaged patients (A 3.626, B 2.002), with no note (pain step 27).


def test_the_bars_of_a_level_of_the_units_average_one_mean_per_unit_with_intervals(shown, capsys):
    cell = {"id": "c4", "label": "[4]", "source": "diary_patients = diary.merge(patients, on='patient_id')", "defs": ["diary_patients"], "uses": ["diary", "patients"]}
    [plot] = [o for o in onto_cell(pain_column("treatment_arm", "binary", "cat"), cell, PAIN) if o["text"].startswith("Plot")]
    assert 'whybook.bars(diary_patients, x="treatment_arm", y="pain", unit="patient_id")' in plot["code"]
    # Patients with fewer days pull the mean of the rows away from the mean of the patients.
    frame = diary_patients().iloc[lambda d: ((d["treatment_arm"] == "A") | (d["week"] <= 2)).to_numpy()]
    run(plot["code"], diary_patients=frame)
    [payload] = payloads(shown)
    assert payload["title"] == "Mean pain by treatment_arm, one mean per patient" and payload["unit"] == "patient"
    means = frame.groupby(["treatment_arm", "patient_id"])["pain"].mean().groupby("treatment_arm")
    for bar, (level, values) in zip(payload["bars"], means):
        assert (bar["x"], bar["n"]) == (level, 10)
        assert bar["y"] == pytest.approx(values.mean())
        assert bar["lo"] < bar["y"] < bar["hi"]
    explore.compare_levels(frame, "pain", "treatment_arm", unit="patient_id")
    explore.compare_levels(frame, "pain", "site")
    lines = capsys.readouterr().out.splitlines()
    assert lines[0].endswith(", one mean per patient.") and lines[2].endswith(", one value per row.")
    assert f"({payload['bars'][0]['y']:.4g}" in lines[0] or f"{payload['bars'][0]['y']:.4g} (A)" in lines[0]


# 8. The diary with pain_1 to pain_7 needed a model to reshape (pain steps 2
# and 4), and its numbered columns were suggested as separate measures:
# "How does pain_2 relate to pain_1?" (pain step 5).

from whybook.server.questions import reshape  # noqa: E402
from whybook.server.questions.cells import CellInfo, next_steps  # noqa: E402
from whybook.server.questions.files import FileDrop, file_options  # noqa: E402
from whybook.server.questions.models import Context  # noqa: E402

DIARY_COLUMNS = {"patient_id": "id", "week": "int", "analgesic_use": "cat", "notes": "text", "cycle_start": "int"}
DIARY_COLUMNS.update({f"{measure}_{day}": "num" for day in range(1, 8) for measure in ("pain", "sleep", "mood")})


def diary_raw(patients=3, weeks=2) -> pd.DataFrame:
    """One row per patient and week, a column per day of each measure; the last day of each week is not logged."""
    rng = np.random.default_rng(4)
    rows = []
    for patient in range(patients):
        for week in range(1, weeks + 1):
            row = {"patient_id": f"P{patient:03d}", "week": week, "analgesic_use": "none", "notes": "", "cycle_start": 16}
            for day in range(1, 8):
                for measure in ("pain", "sleep", "mood"):
                    row[f"{measure}_{day}"] = np.nan if day == 7 else float(rng.integers(0, 10))
            rows.append(row)
    return pd.DataFrame(rows)


def test_numbered_columns_are_one_measure_each():
    groups = reshape.stub_groups(DIARY_COLUMNS)
    assert list(groups) == ["pain", "sleep", "mood"] and groups["pain"] == [f"pain_{day}" for day in range(1, 8)]
    assert reshape.stub_groups(["q3_7", "x_2", "x_3", "visit_0", "visit_1"]) == {"visit": ["visit_0", "visit_1"]}
    wide = reshape.plan(DIARY_COLUMNS, "patient_id", DIARY_COLUMNS)
    assert (wide.stubs, wide.keys, wide.step, wide.per, wide.running) == (("pain", "sleep", "mood"), ("patient_id", "week"), "day", 7, "day_number")


def test_a_wide_diary_on_itself_reshapes_to_one_row_per_day(capsys):
    frames = {"diary_raw": {"rows": 6, "columns": DIARY_COLUMNS}}
    source = {"name": "diary_raw", "label": "diary_raw", "kind": "dataframe", "rows": 6, "n_columns": len(DIARY_COLUMNS)}
    found = pair(source, source, {"frames": frames, "unit": "patient_id", "units": ["patient_id"], "used": [], "asked": []})
    [long] = [o for o in found if o["text"].startswith("Reshape")]
    assert long["text"] == "Reshape diary_raw to one row per day: pain, sleep and mood"
    assert 'diary = pd.wide_to_long(diary_raw, stubnames=["pain", "sleep", "mood"], i=["patient_id", "week"], j="day", sep="_").reset_index()' in long["code"]
    assert long["code"] and "needs AI" not in long["reasons"]
    diary = run(long["code"], pd=pd, diary_raw=diary_raw())["diary"]
    assert len(diary) == 3 * 2 * 6 and list(diary["day_number"][:7]) == [1, 2, 3, 4, 5, 6, 8]
    assert {"pain", "sleep", "mood", "analgesic_use"} <= set(diary.columns)
    assert capsys.readouterr().out == "42 days, 6 without any value of pain, sleep or mood, left out.\n"


def test_a_wide_diary_file_loads_as_one_row_per_day(tmp_path, monkeypatch):
    diary_raw().to_csv(tmp_path / "diary_raw.csv", index=False)
    drop = FileDrop.from_json({"source": {"path": "diary_raw.csv", "kernel_path": "diary_raw.csv", "label": "diary_raw.csv"}, "context": {}})
    [long] = [o for o in file_options(drop, str(tmp_path))["options"] if "one row per" in o["text"]]
    assert long["text"] == "Load diary_raw.csv as one row per day"
    monkeypatch.chdir(tmp_path)
    namespace = run(long["code"])
    assert len(namespace["diary"]) == 36 and len(namespace["diary_raw"]) == 6


def test_numbered_columns_are_not_suggested_as_measures_of_each_other_and_the_reshape_is():
    context = Context.from_json({"frames": {"diary_raw": {"rows": 5880, "columns": DIARY_COLUMNS}}, "outcome": "pain_1", "unit": "patient_id"})
    cells = [CellInfo(id="c1", label="[1]", source="diary_raw = pd.read_csv('diary_raw.csv')", defs=("diary_raw",))]
    texts = [step.text for step in next_steps(cells, context, {}, set())]
    assert not [text for text in texts if "pain_2" in text or "sleep_2" in text], texts
    assert "Reshape diary_raw to one row per day: pain, sleep and mood" in texts
    # Once a frame holds pain, sleep and mood as columns, the reshape is done.
    frames = {"diary_raw": {"rows": 5880, "columns": DIARY_COLUMNS}, "diary": {"rows": 36941, "columns": {"patient_id": "id", "day_number": "int", "pain": "num", "sleep": "num", "mood": "num"}}}
    context = Context.from_json({"frames": frames, "outcome": "pain", "unit": "patient_id"})
    texts = [step.text for step in next_steps(cells, context, {}, set())]
    assert not [text for text in texts if text.startswith("Reshape") or "pain_" in text or "sleep_" in text], texts


# 9. The quick look showed the bad readings, "lowest 0 x5" and "highest 999.9
# x4", but only a model could leave them out (energy step 7). The quick look
# gives the view its ends as code, beside the table.


def test_the_quick_look_of_a_number_gives_the_view_its_ends_as_code(monkeypatch):
    import types

    import IPython

    readings = pd.DataFrame({"kwh_import": np.array([0, 0, 2.116, 5, np.nan, 999.9, 999.9, 171.214], dtype=np.float32)})
    monkeypatch.setattr(IPython, "get_ipython", lambda: types.SimpleNamespace(user_ns={"readings": readings}))
    table = explore.summary(readings, "kwh_import")
    data, metadata = table._repr_mimebundle_()
    assert data == {}
    extremes = metadata["whybook"]["extremes"]
    assert (extremes["frame"], extremes["column"], extremes["rows"]) == ("readings", "kwh_import", 8)
    assert extremes["lowest"] == [{"value": "0.0", "rows": 2}, {"value": "2.116", "rows": 1}, {"value": "5.0", "rows": 1}]
    assert extremes["highest"] == [{"value": "999.9", "rows": 2}, {"value": "171.214", "rows": 1}, {"value": "5.0", "rows": 1}]
    # The code compares in float32: 999.9 finds the rows of 999.900024, which 999.9 as a float64 misses.
    column = readings["kwh_import"]
    assert int((column >= float(extremes["highest"][0]["value"])).sum()) == 2
    assert int(column.isin([999.9]).sum()) == 0
    # The table shows as before, and a frame without a name in the kernel gets no ends.
    assert "999.9" in table._repr_html_()
    monkeypatch.setattr(IPython, "get_ipython", lambda: types.SimpleNamespace(user_ns={}))
    assert explore.summary(readings, "kwh_import")._repr_mimebundle_() is None


# 10. A range of late weeks picked on the trajectory asked no question about
# its rows (pain step 28): who is in them, and how the arms compare there.


def test_who_is_in_the_rows_of_a_range_counts_rows_units_and_levels(capsys):
    frame = diary_patients(patients=12, weeks=6)
    # The patients of arm A stop after week 3.
    frame = frame[(frame["treatment_arm"] == "B") | (frame["week"] <= 3)].reset_index(drop=True)
    table = explore.who_is_in(frame, frame["week"].between(4, 6), unit="patient_id")
    assert capsys.readouterr().out == "126 of 378 rows, 6 of 12 patients.\n"
    # Levels of the patients count patients; numbers, such as the week, get no rows.
    assert list(table.index) == [("treatment_arm", "A"), ("treatment_arm", "B"), ("site", "east"), ("site", "west")]
    assert table.loc[("treatment_arm", "B")].to_dict() == {"here": "100%", "all": "50%", "of": "patients"}
    explore.compare_levels(frame[frame["week"].between(4, 6)], "pain", "treatment_arm", unit="patient_id")
    assert "over the 1 level of treatment_arm, one mean per patient." in capsys.readouterr().out
