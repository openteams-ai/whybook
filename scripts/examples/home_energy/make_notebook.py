"""Write examples/home_energy/home_energy.ipynb, the home energy example, run, with its whybook metadata.

The notebook asks whether a time-of-use tariff moved electricity use out of
the evening peak, and whether it lowered the bills. It reads the CSV and
parquet files that make_data.py writes next to it, and imports its helpers
from energy.py.

Like scripts/examples/pain_diary/make_later.py, it runs every cell and keeps what the
view keeps after a run, so the notebook opens with its map and panels before
anything runs. The labels of the tables and the summary are written here,
from the numbers of the run.

    python scripts/examples/home_energy/make_data.py
    python scripts/examples/home_energy/make_notebook.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import nbformat
from nbformat.v4 import new_code_cell, new_markdown_cell, new_notebook

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
# The example's folder: the notebook, energy.py and the data files.
EXAMPLE = HERE.parents[2] / "examples" / "home_energy"

from kept_state import label_tables, run_and_keep  # noqa: E402


def code(source: str, cell_id: str, **epi) -> nbformat.NotebookNode:
    cell = new_code_cell(source.strip("\n"), metadata={"whybook": epi} if epi else {})
    cell["id"] = cell_id
    return cell


def markdown(source: str, cell_id: str) -> nbformat.NotebookNode:
    cell = new_markdown_cell(source.strip("\n"))
    cell["id"] = cell_id
    return cell


def question(text: str, kind: str) -> dict:
    return {"id": f"asked:{text}", "text": text, "type": kind}


def asked(text: str, kind: str, **extra) -> dict:
    """The metadata of a cell that answers a question the analyst asked."""
    return {"title": extra.pop("title"), "question": question(text, kind), "asked_by": "user", "written_by": "agent", **extra}


CELLS = [
    markdown(
        """
# Home energy use

Did the time-of-use tariff move electricity use out of the evening peak, and did it lower the bills? The data is synthetic: 360 homes over 2025, made for the Whybook demo.
""",
        "title",
    ),
    markdown("## Load", "section-load"),
    code(
        """
import whybook
import pandas as pd
import statsmodels.formula.api as smf
from energy import BASE_TEMP_C, MIN_COVERAGE, add_degree_days, drop_gappy
""",
        "imports",
        title="Tools and the shared energy module",
        written_by="user",
    ),
    code(
        """
homes = pd.read_csv("homes.csv", parse_dates=["tou_start"])
weather = pd.read_csv("weather.csv", parse_dates=["date"])
tariffs = pd.read_csv("tariffs.csv")
readings = pd.read_parquet("readings.parquet")
readings.head()
""",
        "load",
        title="Load the homes, the weather, the tariffs and the meter readings",
        question=question("What data do we have?", "descriptive"),
        asked_by="user",
        written_by="user",
    ),
    code(
        """
impossible = readings[(readings["kwh_import"] <= 0) | (readings["kwh_import"] > 500)]
print(f"{len(impossible)} impossible readings from {impossible['home_id'].nunique()} homes")
impossible
""",
        "impossible",
        **asked("Are there readings that no home could make?", "quality", title="Readings no home could make"),
    ),
    code(
        """
daily = (
    readings.drop(impossible.index)
    .pipe(drop_gappy)
    .assign(date=lambda d: pd.to_datetime(d["date"]))
    .merge(homes, on="home_id")
    .merge(weather, on=["region", "date"])
    .pipe(add_degree_days)
    .assign(
        month=lambda d: d["date"].dt.month,
        peak_share=lambda d: d["kwh_peak"] / d["kwh_import"],
        tou_active=lambda d: d["date"] >= d["tou_start"],
    )
)
daily.head()
""",
        "daily",
        **asked("What does one day of one home look like?", "descriptive", title="One row per home and day, with its home and its weather"),
    ),
    markdown("## Use", "section-use"),
    code(
        """
monthly = daily.groupby(["home_id", "heating", "month"], as_index=False, observed=True).agg(
    kwh_import=("kwh_import", "mean"), hdd=("hdd", "mean")
)
whybook.ribbon(monthly, x="month", y="kwh_import", by="heating", title="Daily use by month, by heating")
""",
        "monthly",
        **asked("How does use change over the year for each kind of heating?", "descriptive", title="Daily use by month, by heating"),
    ),
    code(
        """
per_home = (
    daily.groupby(["home_id", "heating"], as_index=False, observed=True)["kwh_import"]
    .mean()
    .rename(columns={"kwh_import": "kwh_per_day"})
)
whybook.bars(per_home, x="heating", y="kwh_per_day", title="Mean daily use per home, by heating")
per_home.groupby("heating", observed=True)["kwh_per_day"].describe().round(1)
""",
        "per_home",
        **asked("How much electricity does each kind of heating use?", "association", title="Daily use per home, by heating"),
    ),
    markdown("## Heating", "section-heating"),
    code(
        """
model_data = monthly.merge(homes[["home_id", "occupants", "floor_area_m2"]], on="home_id")
heating_fit = smf.mixedlm(
    "kwh_import ~ hdd * heating + occupants + floor_area_m2", data=model_data, groups="home_id"
).fit()
heating_fit.summary().tables[1]
""",
        "heating_model",
        **asked(
            "How much more electricity does each degree of cold take, by heating?",
            "model",
            title="Mixed model: what a colder day adds, by heating",
            assumptions=[
                {"text": "Monthly means stand for the days of each month", "kind": "modelling"},
                {"text": "Heating degree days below BASE_TEMP_C drive the extra use", "kind": "modelling"},
            ],
        ),
    ),
    code(
        """
sweep = []
for i, base in enumerate([12.0, 14.0, 15.5, 18.0]):
    whybook.progress(i / 4, f"base {base} °C")
    swept = (
        daily.pipe(add_degree_days, base=base)
        .groupby(["home_id", "heating", "month"], as_index=False, observed=True)
        .agg(kwh_import=("kwh_import", "mean"), hdd=("hdd", "mean"))
        .merge(homes[["home_id", "occupants", "floor_area_m2"]], on="home_id")
    )
    fit = smf.mixedlm("kwh_import ~ hdd * heating + occupants + floor_area_m2", data=swept, groups="home_id").fit(reml=False)
    sweep.append(
        {
            "base_temp_c": base,
            "heat_pump_kwh_per_degree": fit.params["hdd"] + fit.params["hdd:heating[T.heat pump]"],
            "log_likelihood": fit.llf,
        }
    )
whybook.progress(1.0, "done")
base_sweep = pd.DataFrame(sweep).round(3)
base_sweep
""",
        "base_sweep",
        **asked(
            "Does BASE_TEMP_C = 15.5 change the heating slope?",
            "model",
            title="The heating model for four base temperatures",
            branch={"of": "heating_model", "letter": "b"},
        ),
    ),
    markdown("## The time-of-use trial", "section-trial"),
    code(
        """
who_switched = (
    homes.groupby("tariff")[["has_ev", "has_solar"]].mean().round(2).assign(homes=homes["tariff"].value_counts())
)
who_switched
""",
        "who_switched",
        **asked(
            "Do the homes that switched differ from the others?",
            "causal",
            title="Who chose the time-of-use tariff",
            follow_up=[{"text": "Does the evening share of car owners fall more?", "type": "association"}],
        ),
    ),
    code(
        """
peak_monthly = daily.groupby(["home_id", "tariff", "month"], as_index=False, observed=True)["peak_share"].mean()
whybook.ribbon(peak_monthly, x="month", y="peak_share", by="tariff", title="Share of use between 16:00 and 19:00, by tariff")
""",
        "peak_by_month",
        **asked("Did the evening share fall after homes switched?", "association", title="The evening share by month, by tariff"),
    ),
    code(
        """
after = daily[daily["month"] >= 10]
naive = after.groupby("tariff")["peak_share"].mean().round(3)
print(f"October to December: {naive['flat']:.1%} of use falls between 16:00 and 19:00 on the flat tariff, {naive['time of use']:.1%} on time of use")
naive
""",
        "naive",
        **asked("How much lower is the evening share on the new tariff?", "association", title="The evening share after the switch, compared plainly"),
    ),
    code(
        """
switch_data = peak_monthly.merge(homes[["home_id", "tou_start"]], on="home_id").assign(
    tou_active=lambda d: d["tou_start"].dt.month < d["month"]
)
did_fit = smf.mixedlm("peak_share ~ tou_active + C(month)", data=switch_data, groups="home_id").fit()
did_fit.summary().tables[1].loc[["tou_active[T.True]"]]
""",
        "did",
        **asked(
            "How much did switching move the evening share, within the same homes?",
            "causal",
            title="Difference in differences: the switch within each home",
            assumptions=[
                {"text": "The month of the switch counts as before it", "kind": "modelling"},
                {"text": "Flat homes show how the switchers' months would have gone", "kind": "modelling"},
            ],
            follow_up=[
                {"text": "Did the switchers use more at night?", "type": "descriptive"},
                {"text": "Does the effect differ for homes with solar panels?", "type": "association"},
            ],
        ),
    ),
    code(
        """
half = pd.read_parquet("half_hourly.parquet").merge(homes[["home_id", "tariff"]], on="home_id")
half = half.assign(month=half["timestamp"].dt.month, hour=half["timestamp"].dt.hour + half["timestamp"].dt.minute / 60)
day_shape = half.groupby(["home_id", "tariff", "month", "hour"], as_index=False, observed=True)["kwh"].mean()
february = day_shape[day_shape["month"] == 2]
october = day_shape[day_shape["month"] == 10]
whybook.ribbon(february, x="hour", y="kwh", by="tariff", title="Use by half hour in a February week, by tariff")
whybook.ribbon(october, x="hour", y="kwh", by="tariff", title="Use by half hour in an October week, by tariff")
""",
        "day_shape",
        **asked("When in the day do homes use electricity, before and after the switch?", "descriptive", title="A day of use in February and in October"),
    ),
    markdown("## Bills", "section-bills"),
    code(
        """
flat_price = tariffs.loc[tariffs["tariff"] == "flat", "eur_per_kwh"].iloc[0]
tou_price = tariffs[tariffs["tariff"] == "time of use"].set_index("period")["eur_per_kwh"]
standing = tariffs.groupby("tariff")["standing_eur_per_day"].first()
flat_cost = daily["kwh_import"] * flat_price + standing["flat"]
tou_cost = (
    daily["kwh_night"] * tou_price["night"]
    + daily["kwh_peak"] * tou_price["peak"]
    + (daily["kwh_import"] - daily["kwh_night"] - daily["kwh_peak"]) * tou_price["day"]
    + standing["time of use"]
)
billed = daily.assign(cost_eur=flat_cost.where(~daily["tou_active"], tou_cost), flat_eur=flat_cost)
bills = billed.groupby(["home_id", "tariff", "month"], as_index=False, observed=True)[["cost_eur", "flat_eur"]].sum()
late_bills = bills[bills["month"] >= 10]
whybook.bars(late_bills, x="tariff", y="cost_eur", title="Monthly bill from October to December, by tariff")
switched = billed[billed["tou_active"]]
monthly_saving = (switched["flat_eur"] - switched["cost_eur"]).sum() / switched.groupby(["home_id", "month"]).ngroups
print(f"On the new tariff, a switcher pays {monthly_saving:.2f} EUR a month less than the flat tariff would charge for the same use")
bills.pivot_table(index="month", columns="tariff", values="cost_eur", aggfunc="mean").round(2)
""",
        "bills",
        **asked("Did the homes on the new tariff pay less?", "association", title="Monthly bills under each tariff"),
    ),
    # Written after the run, from the numbers: see summary().
    markdown("## Summary", "summary"),
]

NOTEBOOK_EPI = {
    "outcome": "kwh_import",
    "unit": "home_id",
    "mode": "wonder",
    "exploration": {
        "pivots": [{"text": "from heating to the tariff trial", "section": "The time-of-use trial"}],
        "asked": [],
        "dismissed": [],
    },
    "dag": {"edges": [["has_ev", "tariff"], ["has_ev", "peak_share"], ["tariff", "peak_share"], ["mean_temp_c", "kwh_import"]]},
    "assumptions": [{"text": "Homes chose their tariff: the trial did not assign it", "source": "who_switched"}],
}

ASKED_AT = ["09:10", "09:25", "09:40", "10:05", "10:20", "10:50", "11:15", "11:40", "13:10", "13:30", "13:55", "14:20", "14:45"]

# The facts the labels and the summary rest on, read from the kernel after the run.
FACTS = """
from IPython.display import display as _display
_display(
    {
        "application/vnd.whybook.result+json": {
            "hp_slope": float(heating_fit.params["hdd"] + heating_fit.params["hdd:heating[T.heat pump]"]),
            "storage_slope": float(heating_fit.params["hdd"]),
            "best_base": float(base_sweep.loc[base_sweep["log_likelihood"].idxmax(), "base_temp_c"]),
            "did": float(did_fit.params["tou_active[T.True]"]),
            "naive": float(naive["flat"] - naive["time of use"]),
            "ev_tou": float(who_switched.loc["time of use", "has_ev"]),
            "ev_flat": float(who_switched.loc["flat", "has_ev"]),
            "saving": float(monthly_saving),
            "impossible": int(len(impossible)),
            "gappy": int(homes["home_id"].nunique() - daily["home_id"].nunique()),
        }
    },
    raw=True,
)
del _display
"""


def labels(facts: dict) -> dict[str, list[tuple[str, str]]]:
    """A description and a headline for each table output of a cell, in order."""
    return {
        "load": [("meter readings", "")],
        "impossible": [("impossible readings", f"{facts['impossible']} readings")],
        "daily": [("daily rows", "")],
        "per_home": [("use by heating", "")],
        "heating_model": [("heating model", f"heat pump {facts['hp_slope']:.1f} kWh per degree")],
        "base_sweep": [("sweep of BASE_TEMP_C", f"best at {facts['best_base']:g} °C")],
        "who_switched": [("who switched", f"{facts['ev_tou']:.0%} own a car")],
        "did": [("switch within homes", f"{abs(facts['did']) * 100:.1f} points lower")],
        "bills": [("bills by month", f"{facts['saving']:.2f} EUR a month saved")],
    }


def summary(facts: dict) -> str:
    return (
        "## Summary\n\n"
        f"Heat pump homes use {facts['hp_slope']:.1f} kWh more a day for each degree of cold below 15.5 °C, "
        f"and homes with storage heaters {facts['storage_slope']:.1f} kWh. "
        f"After the switch, the share of use between 16:00 and 19:00 fell by {abs(facts['did']) * 100:.1f} points "
        "in the homes on the time-of-use tariff, against the flat homes over the same months. "
        f"A plain comparison after the switch says {facts['naive'] * 100:.1f} points, because the homes that switched "
        f"used more in the evening to begin with: {facts['ev_tou']:.0%} of them own an electric car, "
        f"against {facts['ev_flat']:.0%} of the others. "
        f"On the new tariff a switcher pays {facts['saving']:.2f} EUR a month less than the flat tariff would charge for the same use. "
        f"{facts['impossible']} impossible readings are left out, and so are {facts['gappy']} homes with long gaps in their readings."
    )


def main() -> None:
    cells = [nbformat.from_dict(cell) for cell in CELLS]
    meta = json.loads(json.dumps(NOTEBOOK_EPI))
    questions = [cell["metadata"]["whybook"]["question"] for cell in cells if cell.cell_type == "code" and "question" in cell["metadata"].get("whybook", {})]
    meta["exploration"]["asked"] = [
        {**q, "at": f"2026-09-23T{ASKED_AT[min(i, len(ASKED_AT) - 1)]}:00"} for i, q in enumerate(questions)
    ]
    notebook = new_notebook(
        cells=cells,
        metadata={
            "kernelspec": {"name": "python3", "display_name": "Python 3 (ipykernel)", "language": "python"},
            "language_info": {"name": "python"},
            "whybook": meta,
        },
    )
    facts = run_and_keep(notebook, EXAMPLE, FACTS)
    labelled = label_tables(notebook.cells, labels(facts), "scripts/examples/home_energy/make_notebook.py")
    next(cell for cell in notebook.cells if cell["id"] == "summary")["source"] = summary(facts)
    nbformat.validate(notebook)
    path = EXAMPLE / "home_energy.ipynb"
    nbformat.write(notebook, path)
    print(f"wrote {path}: {len(notebook.cells)} cells, {len(notebook.metadata['whybook']['variables'])} variables kept, {labelled} tables labelled")
    print("facts:", json.dumps(facts))


if __name__ == "__main__":
    main()
