"""The privacy guard tells a table of statistics from a person (design iteration 1.96).

The cases are real: the tool results that the guard asked about in the takes
of the demo video, on NHEFS, and records of people from the same data
(tests/data/guard_takes.json); and the texts it asked about in the second
video's first dry run, on the 2025 Youth Risk Behavior Survey. The dataset is
what the view sends the guard: every column of the notebook's frames, with
its tag and its range.
"""

import json
from pathlib import Path

import pytest

from whybook.server import guard

TAKES = json.loads((Path(__file__).parent / "data" / "guard_takes.json").read_text())
NHEFS = guard.Dataset.from_json(TAKES["dataset"])
YRBS = guard.Dataset.from_json(TAKES["yrbs"]["dataset"])


def check(result, dataset=NHEFS):
    return guard.check_text(result if isinstance(result, str) else json.dumps(result), dataset)


def result(text, kind="text"):
    """An agent's step that printed this text, as the view sends its result."""
    return json.dumps({"status": "ok", "cell": "[9]", "title": "A step", "outputs": [{"kind": kind, "text": text}], "defines": []})


@pytest.mark.parametrize("case", TAKES["statistics"], ids=lambda case: f"{case['take']}{case['cell']}")
def test_the_tables_of_statistics_that_the_guard_asked_about_in_the_takes_pass(case):
    found = check(case["result"])
    assert found.decision == "allow", (case["dialog"], found.flags)


@pytest.mark.parametrize("case", TAKES["yrbs"]["statistics"], ids=lambda case: f"{case['take']} {case['cell']}")
def test_the_codebook_that_the_guard_asked_about_in_the_second_video_passes(case):
    found = check(case.get("result") or case["prompt"], YRBS)
    assert found.decision == "allow", (case["dialog"], found.flags)


def test_a_line_of_a_codebook_describes_its_column():
    codes = "sex: Item 2. What is your sex? | 1: Female, 2: Male\nage_first_intercourse: Item 60. How old were you? | 1: I have never had sexual intercourse, 2: 11 years old or younger, 3: 12 years old"
    assert check(result(codes), YRBS).decision == "allow"
    # The questions alone, of two columns or more.
    questions = "sex: Item 2. What is your sex?\nsexual_violence: Item 20. How many times did anyone force you?\nage: Item 1. How old are you?"
    assert check(result(questions), YRBS).decision == "allow"
    # A student's answers are still a record, as codes or as labels.
    assert check(result("sex: 2, age: 4, sexual_violence: 3"), YRBS).decision == "reject"
    assert check(result("sex: Female\nage: 15 years old\nforced_sexual_intercourse: Yes"), YRBS).decision == "reject"


def test_a_list_that_names_a_column_holds_no_identifier_of_a_person():
    row = ["1: Never, 2: Rarely", "The CDC's QN104 counts answers 4 and 5 as Yes.", "Item 104. How often do your parents know where you are?", "Q104", "parents_know_where_you_are"]
    assert check(json.dumps({"variables": [{"name": "r", "levels": row}]}), YRBS).decision == "allow"
    assert check(result(str(dict(zip(["answers", "notes", "question", "cdc_variable", "variable"], row)))), YRBS).decision == "allow"
    # Without a column's name, a code is still asked about, and a person's identifier is.
    assert check(json.dumps({"variables": [{"name": "r", "levels": ["Q104", "Item 104."]}]}), YRBS).decision == "ask"
    assert check(result(str({"student": "ST0147", "sex": 1, "age": 4, "grade": 2})), YRBS).decision == "reject"


def test_a_check_of_each_column_is_no_record():
    # Whether each column is present: a column of codes or of weights holds no True or False.
    present = "Present columns: {'social_media': True, 'sex': True, 'race_ethnicity': True, 'sexual_identity': True, 'weight': True}"
    assert check(result(present), YRBS).decision == "allow"
    # A column of True and False holds them: a person's flags are still a record.
    flags = guard.Dataset.from_json({"columns": [{"name": "pregnant", "tag": "bool"}, {"name": "diabetic", "tag": "bool"}, {"name": "age", "tag": "int", "min": 18, "max": 55}]})
    assert check(result("{'pregnant': True, 'diabetic': True, 'age': 41}"), flags).decision == "reject"


def test_a_row_of_a_summary_that_holds_a_value_counts_no_people():
    summary = "rows   10,710\ndistinct    2\nmin         1\n25%         1\nmedian      1\nmax         2"
    assert check(result(summary), YRBS).decision == "allow"
    counts = "sex  count\n1        7\n2      903"
    assert check(result(counts), YRBS).decision == "ask"


@pytest.mark.parametrize("name", ["the first rows of the frame", "a printed list of people with their age and diagnoses", "one person's record"])
def test_records_of_people_are_still_a_reject(name):
    found = check(TAKES["people"][name])
    assert found.decision == "reject", found.flags


def test_the_first_rows_of_the_frame_are_rows_of_people_and_masking_leaves_none_of_them():
    head = TAKES["people"]["the first rows of the frame"]
    text = json.dumps(head)
    found = check(text)
    rows = [flag for flag in found.flags if flag.kind == "row of a person"]
    # Five people, in the three parts that pandas wraps the 64 columns into.
    assert len(rows) == 15
    assert rows[0].rule == "rows of people, each with personal details that could point to one person: age, birthcontrol, pregnancies, sex"
    masked = json.loads(guard.mask(text, found))["outputs"][0]["text"]
    assert "[row of a person]" in masked and " 233 " not in masked and "seqn" in masked


def test_a_value_counts_only_where_its_column_can_hold_it():
    # Ages run from 25 to 74, in whole years; sex and race are 0 or 1; income is a code from 11 to 22.
    assert check("age 42, sex 0, race 1").decision == "reject"
    assert check("age 0.28, sex -0.16, race -0.17").decision == "allow"
    assert check("age 1566, sex 1566, race 1566").decision == "allow"
    assert check("age 46.17, sex 0.45, race 0.09, income 18.15").decision == "allow"
    # Printed with the decimals of a frame of floats, a whole value is still a value.
    assert check("age 42.000000, sex 0.000000, race 1.000000").decision == "reject"
    # A share is a statistic of a column.
    assert check("age 42, sex 51%, race 13%").decision == "allow"
    # Without the notebook's ranges, the generic rules read a fraction as no age, and a number after sex as a value.
    assert guard.check_text("age 0.28, sex 0, race 1, diabetes").decision == "allow"
    assert guard.check_text("age 42, sex 0, diabetes").decision == "reject"


def test_a_persons_record_as_a_dict_is_a_reject_and_a_dict_of_statistics_is_not():
    record = "{'seqn': 233.0, 'age': 42.0, 'sex': 0.0, 'race': 1.0, 'diabetes': 1.0}"
    assert check(record).decision == "reject"
    # As JSON inside the JSON of a step's result: "{\"age\": 42.0, ...}".
    assert check(result(json.dumps({"seqn": 233, "age": 42, "sex": 0, "race": 1}))).decision == "reject"
    assert check(result(str([{"seqn": 233, "age": 42, "sex": 0, "race": 1}, {"seqn": 235, "age": 36, "sex": 0, "race": 0}]))).decision == "reject"
    smd = "{'age': 0.28, 'sex': -0.16, 'race': -0.17, 'diabetes': -0.06}"
    assert check(smd).decision == "allow" and check(result(smd)).decision == "allow"


def test_a_table_whose_rows_are_named_by_columns_describes_the_columns_unless_a_column_of_it_holds_values():
    missing = "sex      0\nrace     0\nbirthcontrol  0\nage      0\nincome  62"
    # sex 0, race 0 and birthcontrol 0 are values, but no one is 0 years old and income runs from 11 to 22.
    assert check(result(missing)).decision == "allow"
    # Each person's column of a frame turned on its side holds values in every row.
    turned = "          0     1\nseqn    233   235\nsex      0     0\nage     42    36\nrace     1     0"
    assert check(result(turned)).decision == "reject"
    # A column of people beside a column of means is still a column of values.
    beside = "       233  mean\nsex      0  0.51\nage     42  43.9\nrace     1  0.13"
    assert check(result(beside)).decision == "reject"


def test_a_column_of_levels_beside_their_shares_describes_the_columns():
    # The take v2dry2's table, as a cell that ends on a string sends it: one line, with its line breaks escaped.
    shares = "'   Measure  Level  Continuer %  Quitter %\\n       sex    0.0         46.8       55.4\\n       sex    1.0         53.2       44.6\\n      race    1.0         14.7        8.9\\nbirthplace   54.0          4.8        1.2'"
    assert check(result(shares)).decision == "allow"
    # One level of each column, each column a code: the share of the people with it.
    assert check(result("Measure  Level  Continuer %  Quitter %\nsex    1.0    53.2    44.6\nrace    1.0    14.7    8.9\ndiabetes    1.0    4.0    3.5")).decision == "allow"
    # One person beside the means: an age is no code, and each column is named once.
    assert check(result("       233  mean\nsex      0  0.51\nage     42  43.9\nrace     1  0.13")).decision == "reject"
    # People in a long table, one value a row, with no statistics beside them.
    assert check(result("seqn variable value\n233 age 42\n233 sex 0\n233 race 1\n235 age 36\n235 sex 0\n235 race 0")).decision == "reject"


def test_tables_of_groups_and_of_statistics_are_no_rows_of_people():
    describe = "               age          sex         race\ncount  1629.000000  1629.000000  1629.000000\nmean     43.915285     0.509515     0.131983\nmin      25.000000     0.000000     0.000000\n50%      44.000000     1.000000     0.000000\nmax      74.000000     1.000000     1.000000"
    assert check(result(describe, "table")).decision == "allow"
    # pandas prints the name of a groupby's index under the header.
    medians = "       age  sex  race\nqsmk                 \n0     43.0  1.0   0.0\n1     47.0  0.0   0.0"
    assert check(result(medians, "table")).decision == "allow"
    means = "    qsmk        age       sex      race\n0      0  42.788  0.534  0.145\n1      1  46.174  0.454  0.091"
    assert check(result(means, "table")).decision == "allow"
    # An index of identifiers is no group: one row is one person.
    people = "      age  sex  race\nseqn                \n233    42    0     1\n235    36    0     0"
    assert check(result(people, "table")).decision == "reject"
    # The cells of an HTML table, as the view reads them.
    cells = " | seqn | age | sex | race\n0 | 233 | 42 | 0 | 1\n1 | 235 | 36 | 0 | 0"
    assert check(result(cells, "table")).decision == "reject"


def test_a_columns_name_is_no_condition_where_it_stands_as_a_name():
    # Quoted, as the label of a row, and in a header: the column diabetes.
    assert check("Columns: ['seqn', 'diabetes', 'tumor', 'pregnancies']\nsex 0").decision == "allow"
    assert check(json.dumps({"defines": [{"columns": [{"label": "diabetes", "tag": "int"}, {"label": "tumor", "tag": "int"}]}]})).decision == "allow"
    assert check(result("13        diabetes  1566  -0.028   0.273\n14           tumor  1566   0.011   0.650")).decision == "allow"
    # In a sentence about a person, the word is a condition.
    assert check("Is P042's diabetes linked to her tumor?").decision == "reject"
    assert check("He is 42, has diabetes, and was admitted last week.").decision == "reject"


def test_a_month_is_a_whole_word_and_a_models_term_is_no_name():
    assert check(result("6             marital       6        1566       0.818")).decision == "allow"
    assert guard.check_text("4         marital          1629").decision == "allow"
    assert guard.check_text("P042 came in on 6 March 2026").decision == "reject"
    assert guard.check_text("C(has_ev)[T.True]    0.41    0.12\nC(sex)[T.Male]    1.2    0.3").decision == "allow"
    assert guard.check_text("J. Wright had a flare").decision == "reject"


def test_the_same_column_in_two_frames_holds_what_either_holds():
    dataset = guard.Dataset.from_json(
        {
            "columns": [
                {"name": "has_ev", "tag": "bool", "levels": ["False", "True"]},
                {"name": "has_ev", "tag": "num", "min": 0.13, "max": 0.58},
                {"name": "age", "tag": "int", "min": 18, "max": 55},
                {"name": "stage", "tag": "ord", "levels": ["I", "II", "III", "IV"]},
            ]
        }
    )
    assert dataset.holds("has_ev", "True") and dataset.holds("has_ev", "0.41")
    assert dataset.holds("has_ev", "2") is False
    assert dataset.holds("AGE", "41") and dataset.holds("age", "41.5") is False and dataset.holds("age", "56") is False
    # Words for levels and a number: the listing does not tell, and "stage 4" still counts.
    assert dataset.holds("stage", "IV") and dataset.holds("stage", "4") is None and dataset.holds("stage", "V") is False
    # A column that the view sent without a range tells nothing.
    assert guard.Dataset.from_json({"columns": [{"name": "age"}]}).holds("age", "0.28") is None
