"""Write examples/pain_diary/pain_diary_cohort.ipynb, the demo notebook, with its whybook metadata.

    python scripts/examples/pain_diary/make_notebook.py [--execute] [--root]

With --root it writes pain_diary_demo.ipynb in the repository root instead,
the same notebook importing prep as examples.pain_diary.prep.
"""

from __future__ import annotations

import copy
import sys
from pathlib import Path

import nbformat
from nbformat.v4 import new_code_cell, new_markdown_cell, new_notebook

# The repository, and the example's folder: the notebook, prep.py and clinic.sqlite.
REPO = Path(__file__).resolve().parents[3]
EXAMPLE = REPO / "examples" / "pain_diary"


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


CELLS = [
    markdown(
        """
# Pain diary cohort

Does treatment arm B change how pain evolves over the first six months? The data is synthetic, made for the Whybook demo.
""",
        "title",
    ),
    markdown("## Load and reshape", "section-load"),
    code(
        """
import whybook
import pandas as pd
import statsmodels.formula.api as smf
from prep import MIN_DAYS, drop_sparse, load_diary_raw, load_olink, load_patients, to_long
""",
        "imports",
        title="Tools and the shared prep module",
        written_by="user",
    ),
    code(
        """
diary_raw = load_diary_raw()
patients = load_patients()
olink = load_olink()
""",
        "load",
        title="Load the diary, the patients and the protein panel",
        question=question("What data do we have?", "descriptive"),
        asked_by="user",
        written_by="user",
    ),
    code(
        """
diary = to_long(diary_raw)
diary.head()
""",
        "reshape",
        title="One row per patient-day",
        question=question("What does one diary day look like?", "descriptive"),
        asked_by="user",
        written_by="agent",
    ),
    markdown("## Shape", "section-shape"),
    code(
        """
weekly = (
    diary.pipe(drop_sparse)
    .merge(patients[["patient_id", "treatment_arm"]], on="patient_id")
    .groupby(["patient_id", "treatment_arm", "week"], as_index=False, observed=True)["pain_score"]
    .mean()
)
whybook.ribbon(weekly, x="week", y="pain_score", by="treatment_arm", ci="bootstrap", n_boot=1000)
""",
        "weekly",
        title="Weekly pain per patient, by arm",
        question=question("How does weekly pain differ between the arms?", "association"),
        asked_by="user",
        written_by="agent",
    ),
    markdown("## Model", "section-model"),
    code(
        """
model_data = weekly.merge(patients[["patient_id", "age", "site"]], on="patient_id", how="left").assign(
    month=lambda d: (d["week"] - 1) / 4.345
)
lmm_fit = smf.mixedlm(
    "pain_score ~ treatment_arm * month + age",
    data=model_data,
    groups="patient_id",
    re_formula="~month",
    missing="drop",
).fit()
lmm_fit.summary().tables[1]
""",
        "lmm",
        title="Mixed model: does arm change the trajectory?",
        question=question("Does arm change the trajectory of pain?", "model"),
        asked_by="user",
        written_by="agent",
    ),
    code(
        """
from statsmodels.miscmodels.ordinal_model import OrderedModel

ordinal_data = model_data.assign(
    pain_level=pd.cut(model_data["pain_score"], [-1, 3, 6, 10], labels=["mild", "moderate", "severe"]),
    arm_b=(model_data["treatment_arm"] == "B").astype(int),
)
estimates = []
for i in range(40):
    whybook.progress(i / 40, f"bootstrap {i + 1} of 40")
    sample = ordinal_data.sample(frac=1, replace=True, random_state=i)
    fit = OrderedModel.from_formula("pain_level ~ 0 + arm_b * month + age", sample, distr="logit").fit(method="bfgs", disp=False)
    estimates.append(fit.params["arm_b:month"])
whybook.progress(1.0, "done")
ordinal_arm_month = pd.Series(estimates, name="arm B × month (log odds)").describe()
ordinal_arm_month
""",
        "ordinal",
        title="Ordinal model",
        question=question("Does an ordinal model agree on the arm effect?", "model"),
        asked_by="user",
        written_by="agent",
        branch={"of": "lmm", "letter": "b"},
    ),
]

NOTEBOOK_EPI = {
    "outcome": "pain_score",
    "unit": "patient_id",
    "mode": "wonder",
    "exploration": {
        "pivots": [{"text": "from the level of pain to its trajectory", "section": "Model"}],
        "asked": [],
        "dismissed": [],
    },
    "dag": {"edges": [["treatment_arm", "pain_score"], ["site", "pain_score"]]},
}


def main() -> None:
    root = "--root" in sys.argv
    cells = copy.deepcopy(CELLS)
    if root:
        imports = next(cell for cell in cells if cell["id"] == "imports")
        imports["source"] = imports["source"].replace("from prep import", "from examples.pain_diary.prep import")
    path, run_in = (REPO / "pain_diary_demo.ipynb", REPO) if root else (EXAMPLE / "pain_diary_cohort.ipynb", EXAMPLE)
    notebook = new_notebook(
        cells=cells,
        metadata={
            "kernelspec": {"name": "python3", "display_name": "Python 3 (ipykernel)", "language": "python"},
            "language_info": {"name": "python"},
            "whybook": NOTEBOOK_EPI,
        },
    )
    if "--execute" in sys.argv:
        from nbclient import NotebookClient

        NotebookClient(notebook, timeout=600, kernel_name="python3", resources={"metadata": {"path": str(run_in)}}).execute()
    nbformat.validate(notebook)
    nbformat.write(notebook, path)
    print(f"wrote {path}")
    # The clinic's records, for the Databases panel.
    sys.path.insert(0, str(EXAMPLE))
    import prep

    prep.write_clinic_db(EXAMPLE / "clinic.sqlite")
    print(f"wrote {EXAMPLE / 'clinic.sqlite'}")


if __name__ == "__main__":
    main()
