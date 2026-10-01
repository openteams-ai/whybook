"""What the view keeps from a run, written by the scripts that build the demo notebooks.

After a run the view keeps the kernel's variables in the notebook metadata
and each cell's analysis in the cell's metadata, so the notebook opens with
its map and panels before anything runs. ``run_and_keep`` does the same for
a notebook that a script builds: it runs the notebook, lists the variables,
analyses the cells and reads the facts that the headlines and the summary
rest on, as the view does after a run.
"""

from __future__ import annotations

import datetime
import json
from pathlib import Path

import nbformat
from nbclient import NotebookClient
from nbformat.v4 import new_code_cell

KERNEL_CODE = Path(__file__).resolve().parents[2] / "whybook" / "server" / "kernel_code"
RESULT_MIME = "application/vnd.whybook.result+json"
# The columns of a frame the view keeps, as src/model/restore.ts keeps them.
KEPT_COLUMNS = 100


def fingerprint(text: str) -> str:
    """FNV-1a over UTF-16 code units, as src/model/tables.ts computes it."""
    value = 0x811C9DC5
    data = text.encode("utf-16-le")
    for index in range(0, len(data), 2):
        value ^= data[index] | (data[index + 1] << 8)
        value = (value * 0x01000193) & 0xFFFFFFFF
    return f"{value:08x}"


def snippet(name: str, args: dict) -> str:
    source = (KERNEL_CODE / f"{name}.py").read_text()
    payload = json.dumps(json.dumps(args))
    return f'{source}\ntry:\n    _whybook_{name}(__import__("json").loads({payload}))\nfinally:\n    del _whybook_{name}\n'


def result_of(cell: nbformat.NotebookNode) -> dict:
    for output in cell.get("outputs", []):
        if RESULT_MIME in output.get("data", {}):
            return output["data"][RESULT_MIME]
    raise RuntimeError(f"no result: {cell.get('outputs')}")


def stored_variable(variable: dict, cell: str | None) -> dict:
    """What src/model/restore.ts keeps of a variable."""
    kept = {k: v for k, v in variable.items() if k not in ("fingerprint", "unchanged", "stale")}
    kept["cell"] = cell
    if "columns" in variable:
        kept["columns"] = [{k: v for k, v in column.items() if k not in ("name", "parent", "rows")} for column in variable["columns"][:KEPT_COLUMNS]]
    if "groups" in variable:
        labels = {column["label"] for column in kept.get("columns", [])}
        kept["groups"] = [
            {"label": group["label"], "columns": [c for c in group["columns"] if c in labels], "total": group.get("total", len(group["columns"]))}
            for group in variable["groups"]
        ]
    if isinstance(variable.get("value"), str) and len(variable["value"]) > 200:
        kept["value"] = variable["value"][:200] + "…"
    if len(variable.get("terms") or []) > 40:
        kept["terms"] = variable["terms"][:40]
    return kept


def html_of(output: dict) -> str | None:
    html = output.get("data", {}).get("text/html")
    if html is None:
        return None
    return "".join(html) if isinstance(html, list) else html


def label_tables(cells: list, by_cell: dict[str, list[tuple[str, str]]], script: str) -> int:
    """Keep the labels with each cell, under the hash of each table output.

    The labels record that ``script`` wrote them from the numbers of each
    table, where the view would ask a model, so that the view says so.
    """
    by = {"choice": "script", "model": script, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    count = 0
    for cell in cells:
        tables = [html for html in (html_of(o) for o in cell.get("outputs", [])) if html and "<table" in html]
        notes = by_cell.get(cell["id"], [])
        kept = {fingerprint(html): {"description": d, "headline": h, "by": by} for html, (d, h) in zip(tables, notes)}
        if kept:
            cell["metadata"].setdefault("whybook", {})["tables"] = kept
            count += len(kept)
    return count


def run_and_keep(notebook: nbformat.NotebookNode, run_in: Path, facts: str, timeout: int = 900) -> dict:
    """Run every cell, keep what the view keeps, and return the facts ``facts`` displays.

    Three cells at the end list the variables, analyse the cells and read the
    facts, as the view does after a run; they are removed again.
    """
    cells = notebook.cells
    sources = [{"id": cell["id"], "source": cell["source"]} for cell in cells if cell.cell_type == "code"]
    cells.append(new_code_cell(snippet("inspect_variables", {"known": {}})))
    cells.append(new_code_cell(snippet("analyze_cells", {"cells": sources})))
    cells.append(new_code_cell(facts))
    NotebookClient(notebook, timeout=timeout, kernel_name="python3", resources={"metadata": {"path": str(run_in)}}).execute()
    found_facts = result_of(cells.pop())
    analysis = result_of(cells.pop())["cells"]
    snapshot = result_of(cells.pop())
    defined_in: dict[str, str] = {}
    for cell in cells:
        if cell.cell_type != "code":
            continue
        found = analysis.get(cell["id"])
        if found:
            cell["metadata"].setdefault("whybook", {})["analysis"] = {**found, "source": fingerprint(cell["source"])}
            if found.get("decisions"):
                cell["metadata"]["whybook"]["decisions"] = found["decisions"]
            for name in found.get("defs", []):
                defined_in[name] = cell["id"]
    notebook.metadata["whybook"]["variables"] = [stored_variable(v, defined_in.get(v["name"])) for v in snapshot["variables"]]
    return found_facts
