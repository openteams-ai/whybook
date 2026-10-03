"""The chips of library defaults and keyword arguments (design iteration 1.86).

The owner: a chip "drop True" for ``reset_index`` says
nothing about a result, and the header of ``read_csv`` should come from a
rule, not from a model that picks it and a popover that says "No rule knows
what kind of value header is". The analysis of a cell runs in an in-process
IPython shell on the demo notebook's state, as the kernel runs it.
"""

import pandas as pd
import pytest

from whybook.server.questions.cells import CellInfo, Decision, decision_options
from whybook.server.questions.models import Context

demo_only = pytest.mark.demo


def analyse(demo, source):
    return demo.kernel("analyze_cells", {"cells": [{"id": "x", "source": source}]})["cells"]["x"]["decisions"]


def chips(decisions):
    return [(d["provenance"], d["name"], d["value"]) for d in decisions]


# What a cell keeps its books with is no chip.


@demo_only
def test_a_keyword_argument_that_only_keeps_the_books_is_no_chip(demo):
    source = "\n".join(
        [
            "_a = patients.reset_index(drop=True)",
            "_b = patients.reset_index(names='row')",
            "_c = patients.sort_values('age', ignore_index=True)",
            "_d = patients.set_index('patient_id', drop=False)",
            "_e = pd.concat([patients, patients], ignore_index=True)",
            "_f = patients.rename(columns={'age': 'years'}, copy=False)",
            "patients.drop_duplicates(inplace=True)",
        ]
    )
    assert chips(analyse(demo, source)) == []


@demo_only
def test_the_keyword_arguments_that_change_a_result_keep_their_chips(demo):
    """drop_duplicates keeps its `keep`; the list is by function, so merge's how and dropna's thresh stay."""
    source = "\n".join(
        [
            "_a = patients.drop_duplicates(keep='last', ignore_index=True)",
            "_b = patients.dropna(thresh=2)",
            "_c = weekly.merge(patients, how='left', on='patient_id')",
            "_d = patients.reset_index(drop=True)",
        ]
    )
    found = chips(analyse(demo, source))
    assert ("literal", "keep", "'last'") in found
    assert ("literal", "thresh", "2") in found
    assert ("literal", "how", "'left'") in found
    assert not [name for _, name, _ in found if name in ("drop", "ignore_index", "names", "inplace", "copy")]


# The header of a reader comes from the list of defaults.


@demo_only
def test_the_header_of_a_reader_is_a_library_default_of_the_list_with_its_library_and_version(demo):
    decisions = analyse(demo, '_a = pd.read_csv("homes.csv")\n_b = pd.read_excel("sites.xlsx")')
    headers = [d for d in decisions if d["name"] == "header"]
    assert [(d["provenance"], d["value"]) for d in headers] == [("library_default", "'infer'"), ("library_default", "0")]
    for decision in headers:
        assert (decision["library"], decision["version"]) == ("pandas", pd.__version__)
        assert "the first row names the columns" in decision["note"]
    assert [d["calls"][0]["target"] for d in headers] == ["homes", "sites"]


@demo_only
def test_a_header_that_the_cell_passes_is_the_cells_own_and_no_default(demo):
    decisions = analyse(demo, '_a = pd.read_csv("homes.csv", header=0)')
    assert [(d["provenance"], d["value"]) for d in decisions if d["name"] == "header"] == [("literal", "0")]


@demo_only
def test_a_default_of_the_list_names_its_library_and_version(demo):
    decisions = analyse(demo, "_a = weekly.merge(patients, on='patient_id')")
    how = next(d for d in decisions if d["name"] == "how")
    assert (how["provenance"], how["library"], how["version"]) == ("library_default", "pandas", pd.__version__)


# The values to try for a header come from the view's own rules, with no model.

READ = CellInfo("c1", "[1]", 'homes = pd.read_csv("homes.csv")\nhomes.head()')


def texts(result):
    return [option["text"] for option in result["options"]]


def option(result, text):
    return next(o for o in result["options"] if o["text"] == text)


def test_the_other_values_of_the_header_of_read_csv_are_none_and_zero_with_what_each_does():
    header = Decision("header", "'infer'", "library_default", param="header", function="pandas.read_csv")
    result = decision_options(READ, header, Context())
    assert texts(result)[:2] == ["What if header were None?", "What if header were 0?"]
    assert option(result, "What if header were None?")["effect"] == "None instead of 'infer' · reads the first row as data"
    assert option(result, "What if header were 0?")["effect"] == "0 instead of 'infer' · reads the first row as column names"
    assert 'homes_if_none = pd.read_csv("homes.csv", header=None)' in option(result, "What if header were None?")["code"]
    # No rule is missing: the view asks no model for the values.
    assert (result["kind"], result["ask_model"]) == ("a choice of read_csv", False)


def test_pandas_2_names_the_reader_by_its_file_and_gets_the_same_rule():
    header = Decision("header", "'infer'", "library_default", param="header", function="readers.read_csv")
    result = decision_options(READ, header, Context())
    assert texts(result)[:2] == ["What if header were None?", "What if header were 0?"]
    assert result["ask_model"] is False


def test_the_header_of_read_excel_is_zero_and_its_other_value_is_none():
    cell = CellInfo("c2", "[2]", 'sites = pd.read_excel("sites.xlsx")')
    header = Decision("header", "0", "library_default", param="header", function="pandas.read_excel")
    result = decision_options(cell, header, Context())
    assert texts(result)[:1] == ["What if header were None?"]
    assert result["ask_model"] is False
