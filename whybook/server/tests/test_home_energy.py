"""The home energy example: its CSV and parquet files, and the notebook make_notebook.py wrote."""

import sys
from pathlib import Path

import nbformat
import pandas as pd
import pytest

EXAMPLE = Path(__file__).resolve().parents[3] / "examples" / "home_energy"
sys.path.insert(0, str(EXAMPLE.parents[1] / "scripts" / "examples"))

from kept_state import fingerprint  # noqa: E402

NOTEBOOK = nbformat.read(EXAMPLE / "home_energy.ipynb", 4)
CODE = [cell for cell in NOTEBOOK.cells if cell.cell_type == "code"]


def text_of(cell) -> str:
    parts = []
    for output in cell.outputs:
        if output.output_type == "stream":
            parts.append(output.text)
        else:
            plain = output.get("data", {}).get("text/plain", "")
            parts.append("".join(plain) if isinstance(plain, list) else plain)
    return "\n".join(parts)


def test_the_files_are_csv_and_parquet_with_one_key():
    homes = pd.read_csv(EXAMPLE / "homes.csv")
    assert len(homes) == 360 and homes["home_id"].is_unique
    assert set(pd.read_csv(EXAMPLE / "tariffs.csv")["tariff"]) == {"flat", "time of use"}
    weather = pd.read_csv(EXAMPLE / "weather.csv")
    assert len(weather) == 365 * 4
    pytest.importorskip("pyarrow")
    readings = pd.read_parquet(EXAMPLE / "readings.parquet")
    assert set(readings["home_id"].astype(str)) <= set(homes["home_id"])
    assert list(readings.columns) == ["home_id", "date", "kwh_import", "kwh_peak", "kwh_night", "kwh_export"]
    half = pd.read_parquet(EXAMPLE / "half_hourly.parquet")
    assert len(half) == 360 * 14 * 48


def test_every_cell_ran_and_the_homes_that_switched_own_more_cars():
    assert all(cell.execution_count for cell in CODE)
    assert [cell.id for cell in CODE for output in cell.outputs if output.output_type == "error"] == []
    who = next(cell for cell in CODE if cell.id == "who_switched")
    assert "0.58" in text_of(who) and "0.13" in text_of(who)
    branches = {cell.id: cell.metadata["whybook"]["branch"]["letter"] for cell in CODE if "branch" in cell.metadata["whybook"]}
    assert branches == {"base_sweep": "b"}
    assert sum(len(cell.outputs) >= 2 for cell in CODE) >= 4


def test_it_keeps_what_the_view_reads_and_its_decisions_come_from_the_module():
    kept = {variable["name"] for variable in NOTEBOOK.metadata["whybook"]["variables"]}
    assert {"homes", "readings", "daily", "heating_fit", "did_fit", "bills"} <= kept
    assert all(cell.metadata["whybook"]["analysis"]["source"] == fingerprint(cell.source) for cell in CODE)
    daily = next(cell for cell in CODE if cell.id == "daily")
    decisions = {(d["name"], d["value"], d["provenance"]) for d in daily.metadata["whybook"]["decisions"]}
    assert {("MIN_COVERAGE", "0.9", "defaulted"), ("BASE_TEMP_C", "15.5", "defaulted")} <= decisions


def test_its_two_merges_keep_one_decision_and_its_four_files_four():
    """Design iteration 1.50: [4] shows one chip, inner join ×2, for its two
    merges, and [2] a chip for each of the four files it reads."""
    daily = next(cell for cell in CODE if cell.id == "daily")
    how = next(d for d in daily.metadata["whybook"]["decisions"] if d["name"] == "how")
    assert [call["target"] for call in how["calls"]] == ["homes", "weather"]
    load = next(cell for cell in CODE if cell.id == "load")
    assert [d["value"] for d in load.metadata["whybook"]["decisions"]] == ["'homes.csv'", "'weather.csv'", "'tariffs.csv'", "'readings.parquet'"]


def test_the_summary_states_the_numbers_of_the_run():
    summary = next(cell for cell in NOTEBOOK.cells if cell.id == "summary").source
    bills = next(cell for cell in CODE if cell.id == "bills")
    saving = text_of(bills).split("pays ")[1].split(" EUR")[0]
    assert f"pays {saving} EUR a month less" in summary
    assert "58% of them own an electric car, against 13%" in summary
    sweep = next(cell for cell in CODE if cell.id == "base_sweep")
    headline = next(iter(sweep.metadata["whybook"]["tables"].values()))["headline"]
    assert headline == "best at 14 °C"
