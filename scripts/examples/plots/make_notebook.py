"""Write examples/plots/libraries.ipynb, a demo of plots, widgets and progress bars in Whybook.

    python scripts/examples/plots/make_notebook.py

Each cell calls a library the way its documentation does; no line of the
code is there for Whybook. The notebook is written without outputs: open it
with Open With, Whybook, and press Run all.
"""

from __future__ import annotations

from pathlib import Path

import nbformat
from nbformat.v4 import new_code_cell, new_markdown_cell, new_notebook

# The example's folder.
EXAMPLE = Path(__file__).resolve().parents[3] / "examples" / "plots"


def code(source: str, cell_id: str, title: str) -> nbformat.NotebookNode:
    cell = new_code_cell(source.strip("\n"), metadata={"whybook": {"title": title}})
    cell["id"] = cell_id
    return cell


def markdown(source: str, cell_id: str) -> nbformat.NotebookNode:
    cell = new_markdown_cell(source.strip("\n"))
    cell["id"] = cell_id
    return cell


CELLS = [
    markdown(
        """
# Plots, widgets and progress bars

Whybook shows what these libraries draw as the notebook does, and the code is the code their documentation shows. The data is synthetic: 200 patients in two arms, seen every week for 12 weeks.

After Run all, try these:

- Watch the bootstrap run: tqdm draws its own bar, and the card and the status bar follow it.
- Drag a box over some points of the Plotly chart, on the bench at Full, in the Code view or in Cell details: the view starts the chart in Box Select, and asks about the rows in the box.
- Move the slider of the ipywidgets cell: the counts under it change.
- Zoom into the ipympl figure with the tools beside it.

The kernel's environment needs numpy and pandas, and `pip install -e ".[plots]" matplotlib ipympl plotnine ninejs` from the repository root.
""",
        "intro",
    ),
    code(
        """
import numpy as np
import pandas as pd

rng = np.random.default_rng(7)
patients = pd.DataFrame(
    {
        "patient_id": [f"P{i:03d}" for i in range(200)],
        "arm": rng.choice(["A", "B"], size=200),
        "site": rng.choice(["north", "south", "west"], size=200),
        "age": rng.integers(18, 70, size=200),
    }
)
visits = patients.loc[patients.index.repeat(12)].reset_index(drop=True)
visits["week"] = np.tile(np.arange(1, 13), 200)
slope = np.where(visits.arm == "B", -0.12, -0.05)
visits["pain"] = (6 + slope * visits.week + 0.02 * (visits.age - 40) + rng.normal(0, 1.2, len(visits))).round(1)
visits["sleep_hours"] = (7 - 0.15 * visits.pain + rng.normal(0, 0.6, len(visits))).round(1)
visits.head()
""",
        "data",
        "Weekly visits of 200 patients",
    ),
    markdown(
        """
## Progress bars from tqdm

The first loop resamples the patients 2,000 times. In a notebook `tqdm.auto` draws a widget; the second loop uses plain `tqdm`, which prints to stderr. Whybook reads the progress of both.
""",
        "section-tqdm",
    ),
    code(
        """
import time

from tqdm.auto import tqdm

week12 = visits[visits.week == 12]
a = week12.loc[week12.arm == "A", "pain"].to_numpy()
b = week12.loc[week12.arm == "B", "pain"].to_numpy()
differences = []
for _ in tqdm(range(2000), desc="bootstrap"):
    differences.append(rng.choice(b, b.size).mean() - rng.choice(a, a.size).mean())
    time.sleep(0.002)  # only so that the bar can be seen in the demo
low, high = np.percentile(differences, [2.5, 97.5])
print(f"B minus A at week 12: {b.mean() - a.mean():.2f} (95% interval {low:.2f} to {high:.2f})")
""",
        "bootstrap",
        "Bootstrap of the difference at week 12",
    ),
    code(
        """
from tqdm import tqdm as text_tqdm

by_site = {}
for site in text_tqdm(sorted(visits.site.unique()), desc="sites"):
    time.sleep(0.5)  # only so that the bar can be seen in the demo
    by_site[site] = visits[visits.site == site].groupby("week").pain.mean()
pd.DataFrame(by_site).round(2).head()
""",
        "sites",
        "Mean pain by week at each site",
    ),
    markdown(
        """
## Plotly: a box asks about its rows

Drag a box over some points, on the bench at Full, in the Code view or in Cell details: the view starts the chart in Box Select, and its toolbar still has zoom and pan. Each point is a patient at week 12, so the view finds the rows of `week12` inside the box and asks about them.
""",
        "section-plotly",
    ),
    code(
        """
import plotly.express as px

px.scatter(week12, x="age", y="pain", color="arm", hover_data=["site"], title="Pain at week 12 by age")
""",
        "plotly",
        "Pain at week 12 by age",
    ),
    markdown(
        """
## matplotlib, plotnine and ninejs

A figure is a thumbnail at Overview and a picture at Full and Compact. On a matplotlib figure, a box asks about the rows inside it when the axes name columns of a frame; on any other picture it asks about that area. ninejs turns a plotnine plot into an interactive one, with a tooltip for each point; it draws in a frame of its own, where a box asks nothing yet.
""",
        "section-static",
    ),
    code(
        """
import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(6, 3))
for arm, part in week12.groupby("arm"):
    ax.hist(part.pain, bins=15, alpha=0.6, label=f"arm {arm}")
ax.set_xlabel("pain at week 12")
ax.set_ylabel("patients")
ax.legend();
""",
        "matplotlib",
        "Pain at week 12, by arm",
    ),
    code(
        """
from plotnine import aes, geom_line, geom_point, ggplot, labs

weekly = visits.groupby(["week", "arm"], as_index=False).pain.mean()
ggplot(weekly, aes("week", "pain", color="arm")) + geom_line() + labs(title="Mean pain by week")
""",
        "plotnine",
        "Mean pain by week, by arm",
    ),
    code(
        """
from ninejs import interactive

interactive(ggplot(week12, aes("age", "pain", color="arm", tooltip="site")) + geom_point())
""",
        "ninejs",
        "Pain at week 12 by age, with tooltips",
    ),
    markdown(
        """
## ipywidgets: a control that changes the answer

The slider sets a pain threshold, and the counts are the patients above it in each arm at week 12. The widget is live while the kernel runs.
""",
        "section-widgets",
    ),
    code(
        """
from ipywidgets import interact


@interact(threshold=(0.0, 10.0, 0.5))
def above(threshold=6.0):
    return week12[week12.pain > threshold].groupby("arm").patient_id.nunique().rename("patients")
""",
        "slider",
        "Patients above a threshold",
    ),
    markdown(
        """
## ipympl: a live figure

`%matplotlib widget` switches matplotlib to ipympl for the cells after it. Zoom and pan with the tools beside the figure. On the bench the figure is a thumbnail of its first drawing.
""",
        "section-ipympl",
    ),
    code(
        """
%matplotlib widget

fig2, ax2 = plt.subplots(figsize=(6, 3))
for arm, part in weekly.groupby("arm"):
    ax2.plot(part.week, part.pain, marker="o", label=f"arm {arm}")
ax2.set_xlabel("week")
ax2.set_ylabel("mean pain")
ax2.legend();
""",
        "ipympl",
        "Mean pain by week, live",
    ),
    markdown(
        """
## Whybook's own plot

`whybook.ribbon` draws the mean with its interval. Each mark keeps the rows behind it, so a brush across weeks asks about those rows, on the bench as in the Code view.
""",
        "section-epi",
    ),
    code(
        """
import whybook

whybook.ribbon(visits, x="week", y="pain", by="arm", title="Mean pain by week, with 95% intervals")
""",
        "ribbon",
        "Mean pain by week, with intervals",
    ),
]


def main() -> None:
    notebook = new_notebook(cells=CELLS)
    notebook.metadata["kernelspec"] = {"display_name": "Python 3 (ipykernel)", "language": "python", "name": "python3"}
    notebook.metadata["language_info"] = {"name": "python"}
    nbformat.validate(notebook)
    nbformat.write(notebook, EXAMPLE / "libraries.ipynb")


if __name__ == "__main__":
    main()
