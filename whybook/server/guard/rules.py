"""The review guard's rules: what a prompt holds of people, and what code reaches.

Rules take at most a few hundredths of a second, and run on every check while
the guard is on. They match text, so they find what they list and nothing
else: a guard model (``models.py``) reads the rest.

``check_text`` reads a prompt for identifiers and personal details:

- An identifier: a code of one to three capital letters and 3 to 8 digits
  (P042, MRN-1234567, H017), a person's name after a title (Dr Patel) or as
  an initial and a surname (J. Wright), or two names right before an
  identifier ("Margaret Ellis at H112").
- A personal detail: an age, a date, a pregnancy or children, a word of care
  (admitted, diagnosis, referred), a place where people are or are not at
  home, an e-mail address or a phone number. With the notebook's columns: a
  value of a personal column next to its name ("stage IV", ``"age": 41``),
  and a level of a personal column of 3 letters or more ("opioid").
- A table whose header names a personal column ("student_id gender sen"):
  the identifiers in its rows are next to a detail.
- A table of people: a header that names the notebook's columns, and rows
  whose cells each hold a value that their column can hold ("233 42 0 1"
  under "seqn age sex race"). A row with three personal details is one person.
- A small count: a table's row of whole numbers with one under 10.
- A key or a token, as ``privacy.py`` finds them.
- A run of base64 is decoded and read the same way.

What the notebook lists of its columns tells a person's value from a
statistic about a column (``Domain``). A number next to a column's name is
the column's value only when the column can hold it: inside its range, whole
for a column of integers ("age 42", and not "age 0.28" or "age 1566"), or
one of its levels. A table whose rows are named by columns, and whose
numbers no column of values can hold, describes the columns: a screen of
confounders, missing values by column (``_summary_spans``). And a column's
name that stands quoted, as the label of a row or in a header names the
column, not a person's condition ("diabetes").

An identifier next to a personal detail, within ``NEAR`` characters, is a
reject; three kinds of detail together, with no identifier, are a reject too;
an identifier alone, or a small count, is an ask. Nothing of a synthetic
dataset is flagged but a key.

``check_code`` reads Python with its IPython ``%`` and ``!`` lines, and the
text of code in other languages: the network, the Jupyter server, secrets,
deletes and writes, the analyst's start-up files, shell commands, installs,
other programs, hidden code, text that addresses the reviewer, and memory.
Each kind has a level outside the sandbox and one in it (``CODE_KINDS``): the
sandbox (``whybook/sandbox``) stops the network, every file outside the
analysis folder, the analyst's environment and other programs, so in it
those are allowed, since code that tries them fails without harm.
"""

from __future__ import annotations

import ast
import base64
import binascii
import json
import math
import re
from bisect import bisect_right
from dataclasses import asdict, dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable

LEVELS = ("allow", "ask", "reject")


@dataclass(frozen=True)
class Flag:
    """One thing a guard found: what it is, the text it matched, the rule, how strict the rule is, and the guard."""

    kind: str
    # The exact text matched; empty when a model flagged the whole text.
    text: str
    rule: str
    level: str
    by: str = "rules"

    def to_json(self) -> dict[str, str]:
        return asdict(self)


@dataclass(frozen=True)
class Finding:
    """What the guards found in one text or one cell. The strictest flag decides."""

    flags: tuple[Flag, ...] = ()
    # Why the guards let something go that they did not read, such as a cell that does not compile.
    note: str = ""

    @property
    def decision(self) -> str:
        if any(flag.level == "reject" for flag in self.flags):
            return "reject"
        return "ask" if self.flags else "allow"

    def __add__(self, other: Finding) -> Finding:
        seen = set(self.flags)
        return Finding(self.flags + tuple(flag for flag in other.flags if flag not in seen), "; ".join(note for note in (self.note, other.note) if note))

    def reasons(self, limit: int = 3) -> str:
        """The rules that the flags break, each once, in plain words."""
        rules: list[str] = []
        for flag in sorted(self.flags, key=lambda flag: flag.level != "reject"):
            if flag.rule not in rules:
                rules.append(flag.rule)
        more = len(rules) - limit
        return "; ".join(rules[:limit]) + (f"; and {more} more" if more > 0 else "")


# Prompts

# How far apart an identifier and a detail may be, in characters, to count as next to each other.
NEAR = 250
# A text shorter than this is one record: three details anywhere in it point to one person.
ONE_RECORD = 600

ID = re.compile(r"\b[A-Z]{1,3}-?\d{3,8}\b")
# A name after a title, an initial and a surname, or two names before an identifier. A model's term, such as
# C(sex)[T.Male], is no initial and surname.
NAME = re.compile(
    r"\b(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?"
    r"|(?<!\[)\b[A-Z]\.\s?[A-Z][a-z]{2,}\b"
    r"|\b[A-Z][a-z]+\s+[A-Z][a-z]+(?=\s+(?:at|from|of|in|\()\s*\(?[A-Z]{1,3}-?\d{3,8}\b)"
)
# Codes that look like an identifier and are not one.
NOT_ID = re.compile(r"^(?:ISO|UTF|RFC|SHA|CVE|PEP|GPT|ICD|NCT|IEC|EN|DIN|FY|ANSI|IEEE|SKU)-?\d{1,8}$")
# The name of a month, whole: "6 marital" is no date.
MONTH = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b"
DETAILS = {
    # An age is a whole number: "age 46.17" is a mean, and "age 0.28" a statistic.
    "age": re.compile(
        r"\bage[ds]?(?:\\?[\"'])?\s*[:=]?\s*\d{1,3}(?:\.0+)?\b(?![.,]?\d)|\b\d{1,3}\s*(?:years?\s*old|-year-old|y/?o)\b|\b(?:she|he|they) (?:is|was|are|were) \d{1,3}\b|\b\d{1,3}\s+años\b",
        re.I,
    ),
    "date": re.compile(
        rf"\b\d{{1,2}}\s+{MONTH}\.?(?:\s+\d{{4}})?\b"
        rf"|\b{MONTH}\.?\s+\d{{1,2}}(?:st|nd|rd|th)?\b"
        r"|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}/\d{1,2}/\d{2,4}\b",
        re.I,
    ),
    "pregnancy or children": re.compile(r"\bpregnan\w*|\bchildren\b|\bgave birth\b|\bembarazada\b", re.I),
    "care": re.compile(r"\badmitted\b|\badmission\b|\bhospital\w*|\bdiagnos\w*|\bmisuse\b|\baddiction\b|\breferred\b|\bdischarged\b|\bsurgery\b", re.I),
    "whether people are at home": re.compile(r"\bat home\b|\baway (?:at work|on holiday|from home)\b|\bon holiday\b|\blives? (?:alone|there|here)\b", re.I),
    "contact details": re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+|\+?\d{2,4}[ -]\d{3,4}[ -]\d{3,4}\b"),
    "health": re.compile(
        r"\bstage\s+(?:I{1,3}|IV|[1-4]|four|three)\b|\bopioid\w*|\bparity\b|\bdiabet\w*|\bcancer\b|\btumou?r\b|\bHIV\b"
        r"|\bdepress(?:ion|ed)\b|\bchemo\w*|\binsulin\b|\boverdose\b|\bflare\b|\bbad night\b",
        re.I,
    ),
    "place": re.compile(r"\b(?:rural|village|hamlet)\b|\b[A-Z]{1,2}\d[A-Z\d]?\s\d[A-Z]{2}\b|\bzip(?:code)?\s*[:=]?\s*\d{5}\b", re.I),
    "household make-up": re.compile(r"\b\d+\s+occupants?\b|\bhousehold of \d+\b|\bone person who lives\b", re.I),
}
# The name of a common personal column, then a value: "diagnosis: asthma",
# "sex"="F", a dict's 'sex': 0, or \"sex\": 0 in JSON inside JSON. A value
# after a colon or an equals sign counts; after a space only a number does,
# so that a table's header ("age stage") is no detail.
SEPARATOR = r"((?:\\?[\"'])?[ \t]*[:=][ \t]*(?:\\?[\"'])?|[ \t]+)"
NAMED_DETAIL = re.compile(
    rf"\b(notes?|comments?|diagnosis|treatment|medication|drug|sex|gender|ethnicity|religion|occupation|postcode|address|dob|date_of_birth|income)\b{SEPARATOR}(?![\",\]}}])([\w.-]+)",
    re.I,
)
NUMBER = re.compile(r"^-?\d+(?:\.\d+)?$")
# The keys of a prompt's JSON whose values name things: a code there is a column or a term, not a person.
NAMING_KEY = re.compile(r'"(?:label|name|column|columns|field|term|terms|frame|parent|of|x|y|by|groups|outcome|unit)"\s*:\s*\[?\s*(?:"[^"]*"\s*,\s*)*"$')
# Column names that describe a person or a household: a column of the
# notebook whose name holds one of these words is personal.
PERSONAL_WORDS = (
    "age", "sex", "gender", "birth", "dob", "postcode", "zip", "address", "city", "town", "ethnic", "race", "religion",
    "income", "salary", "occupation", "job", "diagnos", "disease", "condition", "stage", "treatment", "drug", "medic",
    "analgesic", "opioid", "therapy", "pregnan", "parity", "children", "bmi", "weight", "height", "note", "comment",
    "name", "email", "phone", "occupant", "household", "visit_date", "admission", "discharge",
)
SMALL = 10
# A row of a table: a label of one or two words, then whole numbers. A line of JSON ("missing": 2) is not one.
TABLE_ROW = re.compile(r'^\s*([^\s:"{}\[\],]+(?:\s[^\s:"{}\[\],]+)?)((?:\s+\d+)+)\s*$')
# An escape of JSON that ends a word in a prompt's text: \\n, \\t, \\r.
ESCAPE = re.compile(r"\\[ntr]")
BASE64 = re.compile(r"(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{16,}={0,2}(?![A-Za-z0-9+/=])")
# A number as a table prints it: 42, -0.23, 1.2e-05, 1,566 or 12.5%.
PRINTED_NUMBER = re.compile(r"[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?(?:[eE][-+]?\d+)?%?|[-+]?\.\d+(?:[eE][-+]?\d+)?%?")
# What a table prints in a cell with no value, and at the end of a line that it wraps.
NO_VALUE = frozenset({"nan", "none", "<na>", "na", "nat", "null", "-", "--", "…", "...", "\\", "\\\\"})
# The labels of rows that hold a statistic of each column, as describe() prints them.
STATISTIC_LABELS = frozenset({"count", "mean", "std", "sd", "se", "sem", "var", "min", "max", "median", "sum", "total", "n", "unique", "top", "freq", "mode", "iqr", "25%", "50%", "75%"})
# The labels of a summary's rows that hold a value of a column, or a number of values: no count of people.
VALUE_LABELS = frozenset({"min", "max", "median", "mean", "sd", "std", "mode", "iqr", "range", "25%", "50%", "75%", "unique", "distinct", "lowest", "highest", "top"})
# The marks between the cells of a table that a program draws: | of HTML and markdown, ┆ and │ of polars.
CELL_MARK = re.compile(r"[|│┆]")
# A line that only draws a table: |---|---|, ╞═══╪═══╡.
RULE_LINE = re.compile(r"^[\s|│┆─━═╞╡╪┌┐└┘┬┴├┤┼+:=-]*$")
NAME_WORD = re.compile(r"[A-Za-z_][\w.-]*")


def _personal(name: str) -> bool:
    """Whether a column's name describes a person: age, sex, a diagnosis, or a condition such as diabetes."""
    lowered = name.lower()
    return any(word in lowered for word in PERSONAL_WORDS) or bool(DETAILS["health"].search(lowered.replace("_", " ")))


def _number(token: str) -> float | None:
    """A number as a table prints it, or None for any other text."""
    cell = token.strip()
    if not PRINTED_NUMBER.fullmatch(cell):
        return None
    try:
        return float(cell.rstrip("%").replace(",", ""))
    except ValueError:
        return None


def _half_unit(token: str) -> float:
    """Half the last digit that a printed number shows: 42 stands for 41.5 to 42.5, and 0.28 for 0.275 to 0.285."""
    try:
        exponent = Decimal(token.strip().rstrip("%").replace(",", "")).as_tuple().exponent
    except InvalidOperation:
        return 0.5
    return 0.5 * 10.0 ** exponent if isinstance(exponent, int) else 0.5


def _real(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


@dataclass(frozen=True)
class Domain:
    """What a column of the notebook can hold, as the kernel lists it: numbers from low to high, whole for a column of integers, or its levels."""

    low: float | None = None
    high: float | None = None
    whole: bool = False
    levels: frozenset[str] = frozenset()
    # Whether the levels are all of them: the kernel lists at most 6.
    every_level: bool = False

    @classmethod
    def of(cls, column: dict[str, Any]) -> Domain | None:
        """From a column of the view: ``{"tag", "min", "max", "levels"}``; None when it tells neither a range nor levels."""
        levels = [str(level).strip().lower() for level in column.get("levels") or [] if isinstance(level, (str, int, float))][:60]
        if column.get("tag") == "bool":
            # True and False, or 1 and 0.
            return cls(low=0.0, high=1.0, whole=True, levels=frozenset(levels or ("false", "true")), every_level=True)
        numeric = column.get("tag") in ("int", "num") and _real(column.get("min")) and _real(column.get("max"))
        if not numeric and not levels:
            return None
        return cls(
            low=float(column["min"]) if numeric else None,
            high=float(column["max"]) if numeric else None,
            whole=bool(numeric and column.get("tag") == "int"),
            levels=frozenset(levels),
            every_level=0 < len(levels) < 6,
        )

    def holds(self, value: str) -> bool | None:
        """Whether the column can hold a value as a table prints it, such as 42, 0.28 or IV; None when its listing does not tell."""
        number = _number(value)
        if number is None:
            word = value.strip().lower()
            if word in self.levels:
                return True
            # A column of numbers holds no True or False: a check of each column, {'sex': True}, is nobody's sex.
            if self.low is not None and word in ("true", "false"):
                return False
            # A word that a column of numbers does not list, such as "F" for sex coded 0 and 1, may come from another frame.
            if self.every_level and all(_number(level) is None for level in self.levels):
                return False
            return None
        if value.strip().endswith("%"):
            # A share is a statistic of a column, not one of its values.
            return False
        half = _half_unit(value)
        if self.low is not None and self.high is not None:
            # The kernel rounds a range to 6 significant figures.
            margin = 1e-5 * max(abs(self.low), abs(self.high), 1.0)
            low, high = number - half, number + half
            if high < self.low - margin or low > self.high + margin:
                return False
            # 0.45 is no value of a column of 0 and 1: no whole number rounds to it.
            return not (self.whole and math.floor(high) < math.ceil(low))
        numbers = [_number(level) for level in self.levels]
        if not numbers or any(level is None for level in numbers):
            # A number for a column of words, such as "stage 4" for IV: the listing does not tell.
            return None
        if any(abs(level - number) <= half for level in numbers if level is not None):
            return True
        return False if self.every_level else None

    @property
    def coded(self) -> bool:
        """Whether the column holds a few codes, as sex, race or education do: all its levels, or whole numbers over at most 12 values."""
        if self.low is not None and self.high is not None:
            return self.whole and self.high - self.low <= 11
        return self.every_level


@dataclass
class Dataset:
    """What the notebook tells the guard of its data: whether it is synthetic, its unit, and its personal columns with their levels."""

    kind: str = "real"
    # The column of the unit of the analysis, such as patient_id: its name in a text marks an identifier.
    unit: str | None = None
    # Identifiers known exactly, and the formats learned from them: P001 gives "P" and 3 digits.
    ids: frozenset[str] = frozenset()
    # A personal column's name and its levels, when the kernel lists them.
    personal: dict[str, list[str]] = field(default_factory=dict)
    # Every column name of the notebook's frames: a name is never an identifier, even one like INF0001.
    names: frozenset[str] = frozenset()
    # What each column can hold, by its name in lower case: one domain for each frame that has a column of that name.
    domains: dict[str, tuple[Domain, ...]] = field(default_factory=dict)

    @classmethod
    def from_json(cls, data: Any) -> Dataset:
        """From the view: ``{"synthetic": bool, "unit": str, "columns": [{"name", "levels", "tag", "min", "max"}]}``. Anything else gives a real dataset with no columns."""
        if not isinstance(data, dict):
            return cls()
        unit = data.get("unit") if isinstance(data.get("unit"), str) and data.get("unit") else None
        personal: dict[str, list[str]] = {}
        names: set[str] = set()
        domains: dict[str, tuple[Domain, ...]] = {}
        columns = data.get("columns") if isinstance(data.get("columns"), list) else []
        for column in columns[:400]:
            if not isinstance(column, dict) or not isinstance(column.get("name"), str):
                continue
            name = column["name"][:80]
            names.add(name)
            domain = Domain.of(column)
            if domain is not None:
                domains[name.lower()] = domains.get(name.lower(), ()) + (domain,)
            if name == unit or not (_personal(name) or column.get("personal") is True):
                continue
            levels = column.get("levels") if isinstance(column.get("levels"), list) else []
            personal[name] = [str(level)[:60] for level in levels[:12]]
        ids = data.get("ids") if isinstance(data.get("ids"), list) else []
        return cls(
            kind="synthetic" if data.get("synthetic") is True else "real",
            unit=unit,
            ids=frozenset(str(value)[:40] for value in ids[:2000]),
            personal=personal,
            names=frozenset(names),
            domains=domains,
        )

    def __post_init__(self) -> None:
        # Each column's name in lower case, to the name as the notebook spells it.
        self._spelled = {name.lower(): name for name in self.names}
        # The verdicts so far: a table repeats its values.
        self._verdicts: dict[tuple[str, str], bool | None] = {}

    def column(self, word: str) -> str | None:
        """The column that a word names, in any case, or None.

        A printed number is a value: the columns 1 and 2 of a crosstab do not make "1 7" a row named by a column.
        """
        return None if _number(word) is not None else self._spelled.get(word.lower())

    def holds(self, column: str, value: str) -> bool | None:
        """Whether a column can hold a value as a text prints it; None when the notebook does not tell.

        A column of the same name in two frames holds what either holds.
        """
        key = (column.lower(), value)
        if key in self._verdicts:
            return self._verdicts[key]
        verdicts = [domain.holds(value) for domain in self.domains.get(key[0], ())]
        verdict = True if any(told is True for told in verdicts) else False if verdicts and all(told is False for told in verdicts) else None
        if len(self._verdicts) < 20_000:
            self._verdicts[key] = verdict
        return verdict

    def coded(self, column: str) -> bool:
        """Whether a column holds a few codes in every frame that has it, as sex does; False when the notebook does not tell."""
        domains = self.domains.get(column.lower(), ())
        return bool(domains) and all(domain.coded for domain in domains)


def _span_near(position: int, spans: Iterable[tuple[int, int]], radius: int = NEAR) -> bool:
    return any(start - radius <= position <= end + radius for start, end in spans)


def _value(text: str, match: re.Match[str], group: int) -> str:
    """The value that a match ends with, with the % after it: "12.5%" is a share, not 12.5."""
    value = match.group(group)
    return value + "%" if text[match.end(group) : match.end(group) + 1] == "%" else value


# An age after the word: "age 42", "aged": 41.
AGE_VALUE = re.compile(r"age[ds]?(?:\\?[\"'])?\s*[:=]?\s*([\d.]+)", re.I)
# The words after a number of years: "15 years old".
YEARS = re.compile(r"\s*(?:years?\s*old|-year-old|y/?o\b|años)", re.I)


def _details(text: str, dataset: Dataset, summaries: Spans | None = None, described: Spans | None = None) -> list[tuple[str, str, int, int]]:
    """Each personal detail in the text: its kind, the text matched, and where it is.

    A value counts only where its column can hold it, and nothing counts in
    the rows of a table that describes the columns (``summaries``), or in a
    list or a dict that names a column (``described``).
    """
    found = []
    for kind, pattern in DETAILS.items():
        for match in pattern.finditer(text):
            # A column's name that stands as a name, such as the label of a row, "diabetes", is no condition of a person.
            if dataset.column(match.group(0)) is not None and _stands_as_name(text, match.start(), match.end(), dataset):
                continue
            age = AGE_VALUE.fullmatch(match.group(0)) if kind == "age" else None
            # "age: 15 years old" is an age, also where the column age holds codes 1 to 7.
            if age and dataset.holds("age", age.group(1)) is False and not YEARS.match(text, match.end()):
                continue
            found.append((kind, match.group(0), match.start(), match.end()))
    for match in NAMED_DETAIL.finditer(text):
        explicit = any(mark in match.group(2) for mark in ":=")
        if not explicit and not NUMBER.match(match.group(3)):
            continue
        if dataset.holds(match.group(1), _value(text, match, 3)) is False:
            continue
        word = match.group(1).lower()
        found.append((word if word == "diagnosis" else word.rstrip("s"), match.group(0), match.start(), match.end()))
    for name, levels in dataset.personal.items():
        label = name.replace("_", " ")
        known = {level.lower() for level in levels}
        # The name of the column next to a value: "stage IV", "age": 41, analgesic_use opioid.
        named = re.compile(rf"\b{re.escape(name)}\b{SEPARATOR}(?![\",\]}}])([\w.-]+)", re.I)
        for match in named.finditer(text):
            explicit = any(mark in match.group(1) for mark in ":=")
            value = match.group(2)
            if not (NUMBER.match(value) or value.lower() in known or (explicit and not levels)):
                continue
            # "age 0.28" and "age 1566" are no ages where the ages run from 25 to 74.
            if dataset.holds(name, _value(text, match, 2)) is False:
                continue
            found.append((label, match.group(0), match.start(), match.end()))
        for level in levels:
            if len(level) < 3 or level.lower() in {"none", "nan", "true", "false", "yes", "no", "other", "unknown"}:
                continue
            for match in re.finditer(rf"\b{re.escape(level)}", text, re.I):
                found.append((label, match.group(0), match.start(), match.end()))
    for spans in (summaries, described):
        if spans:
            found = [item for item in found if not spans.holds(item[2])]
    # One part of the text is one detail: a match of a notebook's column wins over a generic one at the same place.
    # Sorted by where they start, a match overlaps a kept one when it starts before the furthest end kept so far.
    generic = set(DETAILS)
    kept: list[tuple[str, str, int, int]] = []
    reach = -1
    for item in sorted(found, key=lambda item: (item[2], item[0] in generic, -(item[3] - item[2]))):
        if item[2] >= reach:
            kept.append(item)
        reach = max(reach, item[3])
    return kept


class Spans:
    """Parts of a text, as (start, end) pairs: whether a place is inside one of them."""

    def __init__(self, spans: Iterable[tuple[int, int]] = ()) -> None:
        merged: list[list[int]] = []
        for start, end in sorted(spans):
            if merged and start <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], end)
            else:
                merged.append([start, end])
        self.starts = [start for start, _ in merged]
        self.ends = [end for _, end in merged]

    def __bool__(self) -> bool:
        return bool(self.starts)

    def holds(self, place: int) -> bool:
        index = bisect_right(self.starts, place) - 1
        return index >= 0 and place < self.ends[index]


def _cells(line: str) -> list[str]:
    """The cells of a line of a table: split at the marks that a program draws between cells, or else at white space."""
    if CELL_MARK.search(line):
        return [cell.strip() for cell in CELL_MARK.split(line) if cell.strip()]
    return line.split()


def _numbers(cells: list[str]) -> list[str | None] | None:
    """The cells of a row as printed numbers, None for a cell with no value; None when a cell holds a word."""
    values: list[str | None] = []
    for cell in cells:
        if cell.lower() in NO_VALUE:
            values.append(None)
        elif _number(cell) is not None:
            values.append(cell)
        else:
            return None
    return values if any(value is not None for value in values) else None


def _stands_as_name(text: str, start: int, end: int, dataset: Dataset) -> bool:
    """Whether a column's name stands as a name: quoted, as the label of a table's row, or in a line of the notebook's column names."""
    if text[start - 1 : start] in ("'", '"') and text[end : end + 1] in ("'", '"', "\\"):
        return True
    line_start = text.rfind("\n", 0, start) + 1
    line_end = text.find("\n", end)
    # The word's part of the line: inside a JSON string, from the quote before it to the quote after it.
    before = re.split(r'(?<!\\)"', text[line_start:start])[-1]
    after = re.split(r'(?<!\\)"', text[end : len(text) if line_end < 0 else line_end])[0]
    left, right = _cells(before), _cells(after)
    # The label of a row: at most pandas' index before it, and numbers after it.
    if len(left) <= 1 and all(cell.isdigit() for cell in left) and _numbers(right) is not None:
        return True
    names = [cell for cell in left + right if cell.lower() not in NO_VALUE]
    return bool(names) and all(dataset.column(name) is not None for name in names)


def _unquoted(text: str) -> str:
    """A string as Python's repr prints it, without its quotes: a cell that ends on a string shows '   Measure  Level\\n   sex  0.0'."""
    stripped = text.strip()
    if len(stripped) > 1 and stripped[0] == stripped[-1] and stripped[0] in "'\"" and ESCAPE.search(stripped):
        return stripped[1:-1]
    return text


def _documents(text: str) -> list[str]:
    """The texts whose lines may be a table's lines: the text, or each string of a JSON prompt.

    JSON's escapes break lines, and so do those of a string that Python
    printed as its repr, inside the JSON or not.
    """
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return [ESCAPE.sub("\n", _unquoted(text))]
    found: list[str] = []

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, str) and ("\n" in value or ESCAPE.search(value)) and len(found) < 50:
            found.append(ESCAPE.sub("\n", _unquoted(value)))

    walk(data)
    return found


def _core(line: str) -> str:
    """A line of a table without the space around it, and without the backslash that ends a line that pandas wraps."""
    return re.sub(r"(?:\s+(?:\\{1,2}|…|\.\.\.))+\s*$", "", line).strip()


def _places(scan: str, texts: Iterable[str]) -> list[tuple[int, int]]:
    """Where each text is in the scanned prompt, as it is or as JSON writes it inside a string."""
    found = []
    for text in list(texts)[:400]:
        for form in {text, json.dumps(text)[1:-1]} if text else ():
            start = scan.find(form)
            while start >= 0:
                found.append((start, start + len(form)))
                start = scan.find(form, start + len(form))
    return found


def _named_row(line: str, dataset: Dataset) -> tuple[str, list[str | None]] | None:
    """A row of a table that a column of the notebook names, with its numbers: "age 0.28 -0.23 1566", "6 marital 6 1566"."""
    cells = _cells(line)
    if len(cells) >= 2 and cells[0].isdigit() and _number(cells[1]) is None:
        # The index that pandas prints before the label.
        cells = cells[1:]
    column = dataset.column(cells[0]) if len(cells) >= 2 else None
    values = _numbers(cells[1:]) if column is not None else None
    return (column, values) if column is not None and values is not None else None


def _describes_columns(rows: list[tuple[str, list[str | None]]], dataset: Dataset) -> bool:
    """Whether a table whose rows are named by columns describes the columns rather than people.

    One person's record holds a value in every row, "age 42" and "sex 0"; so
    does each person's column of a frame turned on its side. A table that
    describes the columns has no such column of values: a screen of
    confounders holds statistics, "age 0.28 -0.23 1566", and missing values
    by column hold "age 0" where the ages run from 25 to 74. Or its column of
    values is a column of levels, beside columns of statistics: the shares of
    each level, "sex 0.0 46.8 55.4" and "sex 1.0 53.2 44.6". A record names
    each column once, and holds values of columns that are no codes, such as
    an age.
    """
    width = max(len(values) for _, values in rows)
    told_any = values = statistics = False
    for place in range(width):
        told = []
        for column, numbers in rows:
            value = numbers[place] if place < len(numbers) else None
            verdict = dataset.holds(column, value) if value is not None else None
            if verdict is not None:
                told.append(verdict)
        if told:
            told_any = True
            if all(told):
                values = True
            else:
                statistics = True
    if not values:
        return told_any
    labels = [column for column, _ in rows]
    return statistics and (len(set(labels)) < len(labels) or all(dataset.coded(label) for label in labels))


def _summary_spans(scan: str, documents: list[str], dataset: Dataset) -> tuple[Spans, set[str]]:
    """The rows of the tables that describe the notebook's columns: where they are in the scanned prompt, and their text.

    A table is a paragraph: its rows run to the next empty line.
    """
    rows: set[str] = set()
    for document in documents:
        lines = document.split("\n")
        block: list[tuple[str, tuple[str, list[str | None]]]] = []
        for line in [*lines, ""]:
            row = _named_row(line, dataset) if line.strip() else None
            if row is not None:
                block.append((line, row))
            elif not line.strip():
                if block and _describes_columns([named for _, named in block], dataset):
                    rows.update(_core(text) for text, _ in block)
                block = []
        rows.update(_core(line) for line in _codebook_lines(lines, dataset))
    return Spans(_places(scan, rows)), rows


# A code of an answer and its label in a codebook: "1: Female", "0 = No".
CODE_LABEL = re.compile(r"(?<![\w.])\d+\s*[:=]\s*[A-Za-z]")
# A column's name at the start of a line, then what describes it.
NAMED_LINE = re.compile(r"\s*([A-Za-z_][\w.-]*)\s*[:=(|-]")


def _codebook_lines(lines: list[str], dataset: Dataset) -> list[str]:
    """The lines of a codebook: a column's name, then its codes with their labels, or the question that it asks.

    "sex: Item 2. What is your sex? | 1: Female, 2: Male" describes the
    column sex, and "11 years old" among the labels of age_first_intercourse
    is nobody's age. A line that only asks a question counts when another
    line of the text names another column the same way: a person's notes can
    hold a question.
    """
    coded, asked = [], []
    for line in lines:
        start = NAMED_LINE.match(line)
        column = dataset.column(start.group(1)) if start else None
        if column is None:
            continue
        rest = line[start.end() :]
        if len(CODE_LABEL.findall(rest)) >= 2:
            coded.append((column, line))
        elif rest.split("|", 1)[0].rstrip().endswith("?"):
            asked.append((column, line))
    if len({column for column, _ in coded + asked}) < 2:
        asked = []
    return [line for _, line in coded + asked]


def _header(line: str, dataset: Dataset) -> list[tuple[str, int]] | None:
    """The notebook's columns that a table's header names, each with its place: the number of its cell, or where its name ends."""
    if CELL_MARK.search(line):
        named = [(cell.strip(), place) for place, cell in enumerate(CELL_MARK.split(line)) if cell.strip()]
    else:
        named = [(match.group(0), match.end()) for match in re.finditer(r"\S+", line)]
    words = [(name, place) for name, place in named if name.lower() not in NO_VALUE]
    if len(words) < 2 or not all(NAME_WORD.fullmatch(name) for name, _ in words):
        return None
    known = [(column, place) for column, place in ((dataset.column(name), place) for name, place in words) if column is not None]
    return known if len(known) >= 2 else None


def _aligned(line: str, header: list[tuple[str, int]], marked: bool) -> tuple[str, dict[str, str]] | None:
    """A row under a header: what comes before its first cell (pandas' index), and the cell of each column.

    pandas, R and polars print a column's values right-aligned under its
    name, so a cell ends where the name ends; a table with marks between its
    cells has them at the header's places.
    """
    if marked:
        cells = [cell.strip() for cell in CELL_MARK.split(line)]
        values = {column: cells[place] for column, place in header if place < len(cells) and cells[place]}
        first = min((place for _, place in header), default=0)
        key = " ".join(cell for cell in cells[:first] if cell)
    else:
        tokens = [(match.group(0), match.end()) for match in re.finditer(r"\S+", line)]
        ends = {place: column for column, place in header}
        values = {ends[end]: token for token, end in tokens if end in ends}
        first = min((end - len(token) for token, end in tokens if end in ends), default=0)
        key = " ".join(token for token, end in tokens if end not in ends and end <= first)
    return (key, values) if values else None


def _grouped(line: str, dataset: Dataset) -> bool:
    """Whether a line under a header names the index of a table of groups, as pandas prints "qsmk" under the header of a groupby.

    The index of a table of people is an identifier, such as seqn, whose
    whole numbers run over a wide range: its rows are not groups.
    """
    for name in line.split():
        if name == dataset.unit or any(
            domain.whole and domain.low is not None and domain.high is not None and domain.high - domain.low > 50 for domain in dataset.domains.get(name.lower(), ())
        ):
            continue
        return True
    return False


def _records(documents: list[str], dataset: Dataset) -> list[tuple[list[str], list[str]]]:
    """The rows of tables of people that hold three personal details or more: each row's lines, one for each part of a table that pandas wraps, and its personal columns.

    A table of people: a header that names the notebook's columns, and rows
    whose cells all hold values that their columns can hold. A table of
    groups (an index under the header), of statistics (rows named mean, 50%)
    or with any cell that its column cannot hold describes no one.
    """
    found: list[tuple[list[str], list[str]]] = []
    for document in documents:
        lines = document.split("\n")
        # Each table: its first and last line, whether its rows are groups, and its rows (key, cells, lines).
        tables: list[tuple[int, int, bool, list[tuple[str, dict[str, str], list[str]]]]] = []
        index = 0
        while index < len(lines):
            header = _header(lines[index], dataset)
            if header is None:
                index += 1
                continue
            marked = bool(CELL_MARK.search(lines[index]))
            first = index
            index += 1
            rows: list[tuple[str, dict[str, str], list[str]]] = []
            grouped = False
            while index < len(lines) and lines[index].strip():
                line = lines[index]
                index += 1
                if RULE_LINE.match(line):
                    continue
                aligned = _aligned(line, header, marked)
                if aligned is None or not any(_number(cell) is not None or dataset.holds(column, cell) for column, cell in aligned[1].items()):
                    # A line before the rows: the index's name under pandas' header, or the types under polars'.
                    if not rows and aligned is None and all(NAME_WORD.fullmatch(word) for word in line.split()):
                        grouped = grouped or _grouped(line, dataset)
                    if rows:
                        break
                    continue
                rows.append((aligned[0], aligned[1], [_core(line)]))
            last = index
            previous = tables[-1] if tables else None
            # pandas wraps a wide table into parts, one under the other, each with the same rows.
            if previous and previous[1] + 1 == first and [key for key, _, _ in previous[3]] == [key for key, _, _ in rows] and rows:
                merged = [(key, {**cells, **more}, texts + extra) for (key, cells, texts), (_, more, extra) in zip(previous[3], rows)]
                tables[-1] = (previous[0], last, previous[2] or grouped, merged)
            else:
                tables.append((first, last, grouped, rows))
        for _, _, grouped, rows in tables:
            # The first rows tell a table of people; each of its rows is flagged, so that masking leaves none.
            if grouped or not rows or not all(_holds_a_person(key, cells, dataset) for key, cells, _ in rows[:60]):
                continue
            for _, cells, texts in rows[:400]:
                kinds = sorted(
                    {column.replace("_", " ") for column, cell in cells.items() if column in dataset.personal and cell.lower() not in NO_VALUE and dataset.holds(column, cell)}
                )
                if len(kinds) >= 3:
                    found.append(([text for text in texts if text], kinds))
    return found


def _holds_a_person(key: str, cells: dict[str, str], dataset: Dataset) -> bool:
    """Whether a row of a table can be one person's: each cell holds a value of its column, and its label names no statistic."""
    if key.strip().lower() in STATISTIC_LABELS:
        return False
    told = [dataset.holds(column, cell) for column, cell in cells.items() if cell.lower() not in NO_VALUE]
    told = [verdict for verdict in told if verdict is not None]
    return bool(told) and all(told)


def _naming(text: str, start: int) -> bool:
    """Whether the text at ``start`` is a value of a JSON key that names things, such as a column's label."""
    return bool(NAMING_KEY.search(text[max(0, start - 400) : start]))


# A list or a dict with no other list or dict inside: a variable's levels in a prompt, or a row that a cell printed.
LIST = re.compile(r"\[[^\[\]]{1,20000}\]")
DICT = re.compile(r"\{[^{}]{1,20000}\}")


def _literal(text: str) -> Any:
    """A list or a dict as JSON or Python writes it, also inside a JSON string, or None."""
    sources = (text, text.replace('\\"', '"'))
    for source in sources:
        try:
            return json.loads(source, strict=False)
        except ValueError:
            pass
    for source in sources:
        try:
            return ast.literal_eval(source)
        except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
            pass
    return None


def _describing(text: str, dataset: Dataset) -> Spans:
    """The lists and the dicts of the text that name a column of the notebook among their values, as a row of a codebook does.

    ["1: Never, ...", "Item 104. How often ...?", "Q104", "parents_know_where_you_are"]
    describes the column parents_know_where_you_are: Q104 is the name of its
    question, not a person's identifier. A record names its columns in its
    keys, and holds values.
    """
    if not dataset.names:
        return Spans()
    spans = []
    for pattern in (LIST, DICT):
        for match in pattern.finditer(text):
            value = _literal(match.group(0))
            items = value.values() if isinstance(value, dict) else value if isinstance(value, list) else ()
            if any(isinstance(item, str) and dataset.column(item.strip()) is not None for item in items):
                spans.append(match.span())
    return Spans(spans)


def _ids(text: str, dataset: Dataset, described: Spans | None = None) -> list[tuple[str, str, int, int]]:
    found = []
    described = _describing(text, dataset) if described is None else described
    for match in ID.finditer(text):
        code = match.group(0)
        if code not in dataset.ids and (NOT_ID.match(code) or code in dataset.names or _naming(text, match.start()) or described.holds(match.start())):
            continue
        found.append(("identifier", code, match.start(), match.end()))
    for value in dataset.ids:
        if ID.fullmatch(value):
            continue
        for match in re.finditer(rf"(?<![\w-]){re.escape(value)}(?![\w-])", text):
            found.append(("identifier", match.group(0), match.start(), match.end()))
    for match in NAME.finditer(text):
        found.append(("name", match.group(0), match.start(), match.end()))
    return found


def _tables(text: str, dataset: Dataset) -> list[tuple[list[str], int, int]]:
    """Each table whose header names personal columns: the columns, and where the table's rows start and end.

    A header is a line of bare names, one of them personal, such as
    "student_id gender sen", anywhere in the text: a line of JSON or a
    question is not one. The rows run to the next empty line.
    """
    found = []
    lines = text.splitlines(keepends=True)
    offset = 0
    index = 0
    while index < len(lines):
        line = lines[index]
        offset += len(line)
        index += 1
        if any(mark in line for mark in '{}[]":?'):
            continue
        header = [name for name in line.split() if re.fullmatch(r"[A-Za-z_][\w.-]*", name)]
        named = [name for name in header if _personal(name) or name in dataset.personal]
        if not named:
            continue
        start = offset
        while index < len(lines) and lines[index].strip():
            offset += len(lines[index])
            index += 1
        found.append((named, start, offset))
    return found


def _columns_by_rows(tables: list[tuple[list[str], int, int]], ids: list[tuple[str, str, int, int]]) -> list[str]:
    """The personal columns of the tables whose rows hold an identifier."""
    hit = [named for named, start, end in tables if any(start <= place < end for _, _, place, _ in ids)]
    return list(dict.fromkeys(name for named in hit for name in named))


def _small_counts(text: str) -> list[tuple[str, int, int]]:
    """Rows of a table whose cells after the label are all whole numbers, with one under 10.

    A row of a summary that holds a value or a number of values, such as
    "min 1", "75% 1" or "distinct 2", counts no people.
    """
    found = []
    offset = 0
    lines = text.splitlines(keepends=True)
    tabular = sum(1 for line in lines if TABLE_ROW.match(line.rstrip("\n"))) >= 2
    for line in lines:
        match = TABLE_ROW.match(line.rstrip("\n")) if tabular else None
        if match and match.group(1).strip().lower() in VALUE_LABELS:
            match = None
        if match:
            numbers = [int(value) for value in match.group(2).split()]
            if any(0 < value < SMALL for value in numbers):
                found.append((line.strip(), offset, offset + len(line)))
        offset += len(line)
    return found


def _decoded(text: str) -> list[tuple[str, str]]:
    """Each run of base64 that decodes to readable text, with its text."""
    out = []
    for match in BASE64.finditer(text):
        chunk = match.group(0)
        try:
            raw = base64.b64decode(chunk + "=" * (-len(chunk) % 4), validate=True)
            decoded = raw.decode("utf-8")
        except (binascii.Error, UnicodeDecodeError, ValueError):
            continue
        if decoded and sum(ch.isprintable() or ch.isspace() for ch in decoded) / len(decoded) > 0.95:
            out.append((chunk, decoded))
    return out


def check_text(text: str, dataset: Dataset | None = None) -> Finding:
    """What a prompt holds of people and secrets, by the rules of the module's docstring."""
    from .. import privacy

    dataset = dataset or Dataset()
    flags: list[Flag] = []
    decoded = _decoded(text)
    readable = {chunk for chunk, _ in decoded}
    for token in set(re.findall(r"\S{20,}", text)):
        # A run of base64 that decodes to text is read as that text, not taken for a key.
        if not any(chunk in token for chunk in readable) and privacy._secret_text(token):
            flags.append(Flag("key or token", token[:60], "a key, a token or a password never leaves this machine", "reject"))
    if dataset.kind == "synthetic":
        return Finding(tuple(flags))
    # The text with each escape of JSON written as a line break and a space: "\\nP289" starts a word on a
    # line of its own, and the places stay the same.
    scan = ESCAPE.sub("\n ", text)
    # What the notebook lists of its columns' values tells the tables that describe the columns, and the tables of people.
    documents = _documents(text) if dataset.domains else []
    summaries, summary_rows = _summary_spans(scan, documents, dataset) if documents else (Spans(), set())
    described = _describing(scan, dataset)
    ids = _ids(scan, dataset, described)
    details = _details(scan, dataset, summaries, described)
    id_spans = [(start, end) for _, _, start, end in ids]
    near = [detail for detail in details if _span_near(detail[2], id_spans)]
    # A table whose header names personal columns, with identifiers in its rows.
    for name in _columns_by_rows(_tables(scan, dataset), ids):
        near.append(("personal column", name, 0, len(name)))
    for table in _tables_inside(text):
        inner_ids = _ids(table, dataset)
        columns = _columns_by_rows(_tables(table, dataset), inner_ids)
        if columns:
            # A table's text inside a JSON result, as an agent's step returns it.
            for name in columns:
                near.append(("personal column", name, 0, len(name)))
            ids.extend(item for item in inner_ids if item[1] not in {found[1] for found in ids})
    names = [item for item in ids if item[0] == "name"]
    codes = [item for item in ids if item[0] != "name"]
    if names and codes:
        near.extend(name for name in names if _span_near(name[2], [(start, end) for _, _, start, end in codes]))
    if ids and near:
        kinds = sorted({kind for kind, *_ in near if kind != "personal column"})
        if any(kind == "personal column" for kind, *_ in near):
            kinds.append("a table's personal columns")
        rule = f"an identifier next to {', '.join(kinds[:4])}" + (" and more" if len(kinds) > 4 else "")
        for kind, matched, *_ in ids[:4]:
            flags.append(Flag(kind, matched, rule, "reject"))
        for kind, matched, *_ in near[:6]:
            flags.append(Flag(kind, matched, rule, "reject"))
    else:
        kinds = {kind for kind, *_ in details}
        if len(kinds) >= 3 and (len(text) <= ONE_RECORD or _clustered(details)):
            rule = f"{len(kinds)} personal details together, which could point to one person: {', '.join(sorted(kinds)[:4])}"
            for kind, matched, *_ in details[:6]:
                flags.append(Flag(kind, matched, rule, "reject"))
        for kind, matched, *_ in ids[:4]:
            flags.append(Flag(kind, matched, "an identifier of a person or a household", "ask"))
    records = _records(documents, dataset) if documents else []
    # A row of a table that describes the columns counts the column's values, not people; a row of a person is flagged as one.
    counted = summary_rows | {text for texts, _ in records for text in texts}
    if records:
        kinds = sorted({kind for _, row in records for kind in row})
        rule = f"rows of people, each with personal details that could point to one person: {', '.join(kinds[:4])}" + (" and more" if len(kinds) > 4 else "")
        # Each line of each row, so that masking leaves none of them.
        for texts, _ in records[:400]:
            for start, end in [place for row in texts for place in _places(scan, [row])[:1]]:
                flags.append(Flag("row of a person", scan[start:end], rule, "reject"))
    rows = [row for row, *_ in _small_counts(scan) if _core(row) not in counted]
    for table in _tables_inside(text):
        rows.extend(row for row, *_ in _small_counts(table) if _core(row) not in counted)
    for row in rows[:3]:
        flags.append(Flag("small count", row[:80], f"a count under {SMALL} in a table, which could point to one person", "ask"))
    for _, plain in decoded[:3]:
        inner = check_text(plain, dataset)
        for flag in inner.flags:
            flags.append(Flag(f"{flag.kind}, in base64", flag.text, flag.rule + " (in base64)", flag.level))
    return Finding(tuple(dict.fromkeys(flags)))


def _tables_inside(text: str) -> list[str]:
    """The texts with line breaks inside a JSON prompt, such as a table's text in an agent's step: each may be a table."""
    import json

    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return []
    found: list[str] = []

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, str) and "\n" in value and len(found) < 20:
            found.append(value)

    walk(data)
    return found


def _clustered(details: list[tuple[str, str, int, int]]) -> bool:
    """Whether three kinds of detail stand within NEAR characters of one of them."""
    for _, _, start, _ in details:
        kinds = {kind for kind, _, other, _ in details if abs(other - start) <= NEAR}
        if len(kinds) >= 3:
            return True
    return False


# Flags that show why a text was flagged and hold no data to mask: a column's name, a table's row of counts.
UNMASKED = ("personal column", "small count")


def mask(text: str, finding: Finding) -> str:
    """The text with each flagged part written as its kind: "P042" as "[identifier]". Only whole words are masked."""
    for flag in sorted(finding.flags, key=lambda flag: -len(flag.text)):
        if not flag.text or flag.kind in UNMASKED:
            continue
        before = r"(?:(?<![\w])|(?<=\\[ntr]))" if flag.text[0].isalnum() or flag.text[0] == "_" else ""
        after = r"(?![\w])" if flag.text[-1].isalnum() or flag.text[-1] == "_" else ""
        text = re.sub(before + re.escape(flag.text) + after, f"[{flag.kind}]", text)
    return text


# Code

# Each kind of finding in code: its level outside the sandbox, its level in the sandbox, and the rule.
CODE_KINDS: dict[str, tuple[str, str, str]] = {
    "network": ("reject", "allow", "reaches the network"),
    "Jupyter server": ("reject", "allow", "reaches the Jupyter server"),
    "secret": ("reject", "allow", "reads a secret: keys, tokens or passwords outside the analysis folder"),
    "secret in the folder": ("reject", "reject", "reads a secret in the analysis folder, such as a .env file"),
    "environment": ("reject", "allow", "reads secrets from the environment"),
    "delete outside": ("reject", "allow", "deletes files outside the analysis folder"),
    "delete the folder": ("reject", "reject", "deletes the analysis folder"),
    "delete data": ("ask", "ask", "deletes files of the analysis folder"),
    "overwrite data": ("ask", "ask", "overwrites data files of the analysis folder"),
    "start-up file": ("reject", "allow", "changes a start-up file or a setting of the analyst"),
    "write outside": ("ask", "allow", "writes outside the analysis folder"),
    "read outside": ("ask", "allow", "reads files outside the analysis folder"),
    "shell": ("ask", "allow", "runs a shell command"),
    "install": ("ask", "allow", "installs a package"),
    "other programs": ("reject", "allow", "stops other programs"),
    "hidden code": ("reject", "reject", "hides what it runs: exec or eval of built strings, or encoded code"),
    "steers the reviewer": ("reject", "reject", "has text that tells the reviewer what to answer"),
    "memory": ("ask", "ask", "uses a great deal of memory or processes"),
    "unreadable": ("ask", "ask", "the guard could not read the code"),
}

NETWORK_MODULES = {
    "socket", "requests", "httpx", "aiohttp", "urllib.request", "urllib3", "http.client", "ftplib", "smtplib", "paramiko",
    "websocket", "websockets", "telnetlib", "pycurl", "boto3", "botocore", "google.cloud", "azure", "dropbox", "pysftp", "fabric",
}
URL = re.compile(r"^\s*(?:https?|ftp|sftp|s3|gs|az|abfss?|ssh|git|wss?)://", re.I)
JUPYTER = re.compile(r"(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):88\d\d|/api/(?:sessions|kernels|contents|terminals|kernelspecs)\b|JUPYTERHUB_API_TOKEN|JPY_API_TOKEN|JUPYTER_TOKEN")
SECRET_PATH = re.compile(
    r"\.ssh\b|\.aws\b|\.netrc\b|\.pgpass\b|\.git-credentials\b|id_rsa|id_ed25519|id_ecdsa|\.kube/config|\.config/gcloud|\.docker/config\.json|credentials(?:\.json)?\b|\.pem$|\.key$|(?:^|/)\.env(?:\.\w+)?$|(?:^|/)secrets?\.(?:json|ya?ml|toml)$",
    re.I,
)
STARTUP_PATH = re.compile(r"\.(?:bashrc|bash_profile|profile|zshrc|zprofile|config/fish)\b|\.ipython/|\.jupyter/|crontab|\.config/autostart|authorized_keys|\.local/share/jupyter|/etc/", re.I)
SECRET_NAME = re.compile(r"key|token|secret|passw|credential|auth|cookie|session", re.I)
NETWORK_SHELL = re.compile(r"\b(?:curl|wget|ssh|scp|sftp|rsync|nc|ncat|ftp|telnet|aws|gsutil|gcloud|az)\b|\bgit\s+(?:push|pull|clone|fetch)\b|\bpip\d?\s+download\b")
INSTALL = re.compile(r"^\s*[%!]\s*(?:pip3?|conda|mamba|micromamba|uv|apt(?:-get)?|brew|npm)\b|\bpip3?\s+install\b|\bconda\s+install\b|\buv\s+(?:pip\s+)?(?:install|add)\b|\bapt(?:-get)?\s+install\b|\binstall\.packages\(")
KILL_SHELL = re.compile(r"\b(?:kill|pkill|killall|shutdown|reboot)\b")
STEERING = re.compile(
    r"\b(?:reviewer|review guard|the guard|security check|safety check)\b|approved by (?:the )?analyst|\banswer\s+(?:allow|yes|pass)\b|ignore (?:the|all|any|previous|these) (?:policy|rules|instructions)|this (?:code|cell) is (?:safe|approved)",
    re.I,
)
OUTPUT_DIRS = ("output", "outputs", "figures", "figs", "plots", "results", "tmp", "temp", "cache", ".cache", "build", ".ipynb_checkpoints", "__pycache__")
DATA_PATH = re.compile(r"^(?:\./)?(?:data|raw|input|inputs)(?:/|$)|/raw/|(?:^|/)raw_", re.I)
READERS = {"open", "read_csv", "read_table", "read_excel", "read_parquet", "read_json", "read_feather", "read_pickle", "read_sql", "read_text", "read_bytes", "load", "loadtxt", "genfromtxt", "connect", "read_file", "read_fwf", "read_html", "read_xml", "read_stata", "read_sas", "read_spss", "scan_csv", "scan_parquet"}
WRITERS = {"to_csv", "to_parquet", "to_excel", "to_json", "to_pickle", "savefig", "write_text", "write_bytes", "to_feather", "to_hdf", "to_sql", "save", "savetxt", "savez", "write_csv", "write_parquet", "dump", "copy", "copyfile", "copytree", "move", "rename", "replace", "symlink_to", "write"}
DELETERS = {"rmtree", "remove", "unlink", "rmdir", "removedirs", "send2trash", "truncate"}
ARRAYS = {"ones", "zeros", "empty", "full", "rand", "randn", "random", "normal", "uniform", "integers", "standard_normal"}


def code_flag(kind: str, text: str, sandboxed: bool) -> Flag | None:
    """A flag of this kind for the kernel's context, or None when the context allows it."""
    outside, inside, rule = CODE_KINDS[kind]
    level = inside if sandboxed else outside
    if level == "allow":
        return None
    return Flag(kind, text[:120], rule, level)


def _path_kind(path: str, reading: bool) -> str | None:
    """What reading or writing a literal path is: outside the folder, a secret, a start-up file, data, or fine."""
    stripped = path.strip()
    if URL.match(stripped):
        return "Jupyter server" if JUPYTER.search(stripped) else "network"
    outside = stripped.startswith(("/", "~", "..")) or stripped.startswith("$HOME")
    if SECRET_PATH.search(stripped):
        return "secret" if outside else "secret in the folder"
    if outside and not reading and STARTUP_PATH.search(stripped):
        return "start-up file"
    if outside:
        return "read outside" if reading else "write outside"
    if not reading and DATA_PATH.search(stripped):
        return "overwrite data"
    return None


def _delete_kind(path: str | None) -> str:
    if path is None:
        return "delete data"
    stripped = path.strip().rstrip("/")
    if stripped in {"", ".", "./*", "*", "./", ".*", "$PWD", "`pwd`"}:
        return "delete the folder"
    if stripped.startswith(("/", "~", "..", "$HOME")):
        return "delete outside"
    first = stripped.lstrip("./").split("/", 1)[0]
    if first in OUTPUT_DIRS or stripped.endswith((".pyc", ".log", ".tmp")):
        return ""
    return "delete data"


def _shell(command: str) -> list[tuple[str, str]]:
    """The kinds of one shell command line, with the part matched."""
    found: list[tuple[str, str]] = []
    if INSTALL.search(command):
        found.append(("install", command))
        return found
    if JUPYTER.search(command):
        found.append(("Jupyter server", command))
    if NETWORK_SHELL.search(command):
        found.append(("network", command))
    if KILL_SHELL.search(command):
        found.append(("other programs", command))
    for match in re.finditer(r"\brm\s+(?:-\w+\s+)*([^\s;&|]+)", command):
        kind = _delete_kind(match.group(1))
        if kind:
            found.append((kind, match.group(0)))
    for token in re.findall(r"[^\s;&|<>'\"]+", command):
        if SECRET_PATH.search(token) and not token.startswith("-"):
            found.append(("secret" if token.startswith(("/", "~", "..", "$HOME")) else "secret in the folder", token))
        elif token.startswith(("~/", "$HOME/")) and STARTUP_PATH.search(token) and re.search(r">>?\s*" + re.escape(token), command):
            found.append(("start-up file", token))
    if not found:
        found.append(("shell", command))
    return found


class _CodeVisitor(ast.NodeVisitor):
    """Walks a cell's syntax tree and notes each kind of finding with the code that shows it."""

    def __init__(self, source: str) -> None:
        self.source = source
        self.found: list[tuple[str, str]] = []
        self.aliases: dict[str, str] = {}
        self.loops = 0
        # The names that a loop binds to the paths of a glob: the glob's pattern stands for them.
        self.globbed: dict[str, str] = {}

    def note(self, kind: str, node: ast.AST | str) -> None:
        text = node if isinstance(node, str) else (ast.get_source_segment(self.source, node) or "")
        self.found.append((kind, " ".join(text.split())))

    def dotted(self, node: ast.AST) -> str:
        """A call's function as a dotted name, with import aliases resolved: sp.run as subprocess.run."""
        if isinstance(node, ast.Name):
            return self.aliases.get(node.id, node.id)
        if isinstance(node, ast.Attribute):
            base = self.dotted(node.value)
            return f"{base}.{node.attr}" if base else node.attr
        if isinstance(node, ast.Call):
            return self.dotted(node.func) + "()"
        return ""

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self.aliases[alias.asname or alias.name.split(".")[0]] = alias.name if alias.asname else alias.name.split(".")[0]
            if any(alias.name == module or alias.name.startswith(module + ".") for module in NETWORK_MODULES):
                self.note("network", node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        module = node.module or ""
        for alias in node.names:
            self.aliases[alias.asname or alias.name] = f"{module}.{alias.name}"
        if any(module == name or module.startswith(name + ".") for name in NETWORK_MODULES):
            self.note("network", node)

    def visit_For(self, node: ast.For) -> None:
        if isinstance(node.target, ast.Name) and isinstance(node.iter, ast.Call):
            called = self.dotted(node.iter.func).rsplit(".", 1)[-1]
            pattern = next((arg.value for arg in node.iter.args if isinstance(arg, ast.Constant) and isinstance(arg.value, str)), None)
            if called in {"glob", "iglob", "rglob"} and pattern is not None:
                self.globbed[node.target.id] = pattern
        self.loops += 1
        self.generic_visit(node)
        self.loops -= 1

    def visit_ListComp(self, node: ast.ListComp) -> None:
        self.loops += 1
        self.generic_visit(node)
        self.loops -= 1

    visit_GeneratorExp = visit_SetComp = visit_DictComp = visit_ListComp  # type: ignore[assignment]

    def visit_While(self, node: ast.While) -> None:
        if isinstance(node.test, ast.Constant) and node.test.value and not any(isinstance(child, (ast.Break, ast.Return)) for child in ast.walk(node)):
            self.note("memory", "while True with no break")
        self.loops += 1
        self.generic_visit(node)
        self.loops -= 1

    def visit_Constant(self, node: ast.Constant) -> None:
        if isinstance(node.value, str):
            value = node.value
            if JUPYTER.search(value):
                self.note("Jupyter server", node)
            elif URL.match(value):
                self.note("network", node)
            elif SECRET_PATH.search(value) and "/" in value or re.fullmatch(r"\.env(?:\.\w+)?", value.strip()):
                self.note("secret" if value.strip().startswith(("/", "~", "..")) else "secret in the folder", node)
            if STEERING.search(value):
                self.note("steers the reviewer", node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if self.dotted(node) == "os.environ":
            parent = getattr(node, "parent", None)
            reads_one = isinstance(parent, ast.Subscript) or (isinstance(parent, ast.Attribute) and parent.attr in {"get", "setdefault", "pop", "__contains__"})
            if not reads_one:
                self.note("environment", node)
        self.generic_visit(node)

    def visit_Subscript(self, node: ast.Subscript) -> None:
        if self.dotted(node.value) == "os.environ":
            key = node.slice.value if isinstance(node.slice, ast.Constant) else None
            if not isinstance(key, str) or SECRET_NAME.search(key):
                self.note("environment", node)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        name = self.dotted(node.func)
        last = name.rsplit(".", 1)[-1]
        first = node.args[0] if node.args else None
        literal = first.value if isinstance(first, ast.Constant) and isinstance(first.value, str) else None
        segment = ast.get_source_segment(self.source, node) or ""
        home = "expanduser" in segment or "Path.home" in segment or "HOME" in segment
        if name in {"exec", "eval", "compile", "__import__"} and not all(isinstance(arg, ast.Constant) for arg in node.args):
            self.note("hidden code", node)
        elif name == "getattr" and node.args and isinstance(node.args[0], ast.Call) and self.dotted(node.args[0].func) == "__import__":
            self.note("hidden code", node)
        elif last in {"b64decode", "a85decode", "b32decode", "decodebytes", "unhexlify"} or (last == "decode" and "rot" in segment.lower()) or name in {"marshal.loads", "codecs.decode"}:
            self.note("hidden code", node)
        elif name.startswith(("subprocess.", "os.system", "os.popen", "os.exec", "os.spawn", "pty.spawn", "commands.")) or name in {"os.system", "os.popen"}:
            command = " ".join(_strings(node))
            for kind, text in _shell(command or segment):
                self.note(kind, text)
        elif name in {"os.kill", "os.killpg", "signal.pthread_kill"} or last in {"terminate", "kill"} and "psutil" in segment:
            self.note("other programs", node)
        elif name in {"os.getenv", "getenv", "os.environ.get", "environ.get"}:
            key = literal
            if key is None or SECRET_NAME.search(key):
                self.note("environment", node)
        elif name in {"os.fork", "fork"}:
            self.note("memory", node)
        elif last in DELETERS and (name.startswith(("os.", "shutil.", "send2trash")) or "Path" in segment or "unlink" == last):
            path = literal
            if path is None and isinstance(first, ast.Name) and first.id in self.globbed:
                path = self.globbed[first.id]
            if path is None and home:
                kind = "delete outside"
            elif path is None and re.search(r"getcwd|Path\.cwd|Path\(\s*['\"]\.['\"]\s*\)", segment):
                kind = "delete the folder"
            else:
                kind = _delete_kind(path)
            if kind:
                self.note(kind, node)
        elif name in {"shutil.copy", "shutil.copy2", "shutil.copyfile", "shutil.copytree", "shutil.move", "os.rename", "os.replace"}:
            paths = [arg.value if isinstance(arg, ast.Constant) and isinstance(arg.value, str) else None for arg in node.args[:2]]
            source, target = (paths + [None, None])[:2]
            for path, reading in ((source, True), (target, False)):
                kind = _path_kind(path, reading=reading) if path is not None else None
                if kind:
                    self.note(kind, node)
            if name in {"shutil.move", "os.rename", "os.replace"} and source is not None:
                kind = _delete_kind(source)
                if kind:
                    self.note(kind, node)
        elif name in {"keyring.get_password", "keyring.get_credential", "keyring.get_keyring"}:
            # The system's keyring, which the sandbox does not reach.
            self.note("secret", node)
        elif last in WRITERS or (last == "open" and _write_mode(node)):
            target = literal or _first_path(node)
            if target is not None:
                kind = _path_kind(target, reading=False)
                if kind:
                    self.note(kind, node)
            elif home:
                self.note("start-up file" if STARTUP_PATH.search(segment) else "write outside", node)
        elif last in READERS:
            target = literal or _first_path(node)
            if target is not None:
                kind = _path_kind(target, reading=True)
                if kind:
                    self.note(kind, node)
            elif home and SECRET_PATH.search(segment):
                self.note("secret", node)
            elif home:
                self.note("read outside", node)
        elif (last == "glob" or last == "rglob" or last == "iterdir") and SECRET_PATH.search(segment):
            self.note("secret" if home or "/" in (literal or "") else "secret in the folder", node)
        if last in ARRAYS and self.loops and _elements(node) >= 10_000_000 or last in ARRAYS and _elements(node) >= 100_000_000:
            self.note("memory", node)
        self.generic_visit(node)


def _write_mode(node: ast.Call) -> bool:
    modes = [arg.value for arg in node.args[1:2] if isinstance(arg, ast.Constant)] + [kw.value.value for kw in node.keywords if kw.arg == "mode" and isinstance(kw.value, ast.Constant)]
    return any(isinstance(mode, str) and any(letter in mode for letter in "wax+") for mode in modes)


def _first_path(node: ast.Call) -> str | None:
    """The literal path of a call: its first string argument, or the string a Path(...) receiver holds."""
    func = node.func
    if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Call):
        inner = func.value
        strings = [arg.value for arg in inner.args if isinstance(arg, ast.Constant) and isinstance(arg.value, str)]
        if strings:
            return "/".join(strings)
    return None


def _strings(node: ast.AST) -> list[str]:
    return [child.value for child in ast.walk(node) if isinstance(child, ast.Constant) and isinstance(child.value, str)]


def _elements(node: ast.Call) -> int:
    """How many elements an array call makes, from a literal shape: np.ones((10_000, 10_000)) makes 10**8."""
    for arg in [*node.args, *(kw.value for kw in node.keywords if kw.arg in {"shape", "size"})]:
        values = [arg] if isinstance(arg, ast.Constant) else list(arg.elts) if isinstance(arg, (ast.Tuple, ast.List)) else []
        numbers = [value.value for value in values if isinstance(value, ast.Constant) and isinstance(value.value, int) and not isinstance(value.value, bool)]
        if numbers and len(numbers) == len(values):
            total = 1
            for number in numbers:
                total *= number
            return total
    return 0


def _comments(source: str) -> list[str]:
    return [line.split("#", 1)[1] for line in source.splitlines() if "#" in line and not line.strip().startswith(("!", "%"))]


def check_code(code: str, sandboxed: bool = False, language: str = "python") -> Finding:
    """What a cell reaches, by the rules of the module's docstring, at the levels of the kernel's context."""
    found: list[tuple[str, str]] = []
    python: list[str] = []
    cell_magic = code.lstrip().startswith(("%%bash", "%%sh", "%%script", "%%system"))
    for line in code.splitlines():
        stripped = line.strip()
        if cell_magic and not stripped.startswith("%%"):
            found.extend(_shell(stripped) if stripped else [])
            python.append("")
        elif stripped.startswith("!") or re.match(r"%(?:%)?(?:pip|conda|mamba|sx|system|sc)\b", stripped):
            found.extend(_shell(stripped.lstrip("!%")) if not INSTALL.search(stripped) else [("install", stripped)])
            python.append("")
        elif stripped.startswith("%"):
            python.append("")
        else:
            python.append(line)
    source = "\n".join(python)
    for comment in _comments(source):
        if STEERING.search(comment):
            found.append(("steers the reviewer", "#" + comment.strip()))
    if language.lower() not in {"python", "python3", "ipython", ""}:
        found.extend(_text_code(code))
    else:
        try:
            tree = ast.parse(source)
        except SyntaxError as error:
            unrun = _runs_nothing(code, source)
            if unrun:
                # The kernel sends back Python's error, which the agent reads and fixes: the next cell is read again.
                return Finding(note=f"the cell does not compile ({unrun}), so it runs no line")
            found.append(("unreadable", f"not Python: {error.msg}"))
            tree = None
        if tree is not None:
            for parent in ast.walk(tree):
                for child in ast.iter_child_nodes(parent):
                    child.parent = parent  # type: ignore[attr-defined]
            visitor = _CodeVisitor(source)
            visitor.visit(tree)
            found.extend(visitor.found)
    flags = [flag for flag in (code_flag(kind, text, sandboxed) for kind, text in found) if flag]
    return Finding(tuple(dict.fromkeys(flags)))


def _runs_nothing(code: str, source: str) -> str | None:
    """Python's error when IPython cannot parse a cell, which then runs no line of it; None when it can, or cannot tell.

    IPython turns the whole cell into Python, its % and ! lines into calls,
    removes an indentation that every line shares, and parses the result
    before any line runs. So "files = !ls ~/.ssh", which the rules cannot
    read, does run, and a cell that IPython cannot parse runs nothing: the
    kernel sends back the SyntaxError. A cell magic's body is another
    language, which runs: it is never one of these. ``source`` is the cell
    with its % and ! lines blank, as the rules read it.
    """
    if code.lstrip().startswith("%%"):
        return None
    try:
        from IPython.core.inputtransformer2 import TransformerManager
    except ImportError:
        return None
    try:
        transformed = TransformerManager().transform_cell(code)
    except Exception:  # noqa: BLE001  IPython stops before the cell runs as well; its Python lines tell why
        transformed = source
    try:
        compile(transformed, "<cell>", "exec", ast.PyCF_ONLY_AST | ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    except SyntaxError as error:
        return f"{type(error).__name__}: {error.msg}"
    except (ValueError, MemoryError, RecursionError):
        return None
    return None


def _text_code(code: str) -> list[tuple[str, str]]:
    """The findings in code of another language, from its text: URLs, shell calls, secrets and deletes."""
    found: list[tuple[str, str]] = []
    for match in re.finditer(r"[\"']([^\"'\n]+)[\"']", code):
        value = match.group(1)
        if JUPYTER.search(value):
            found.append(("Jupyter server", value))
        elif URL.match(value):
            found.append(("network", value))
        elif SECRET_PATH.search(value):
            found.append(("secret" if value.startswith(("/", "~", "..")) else "secret in the folder", value))
    for match in re.finditer(r"\b(?:system2?|shell|processx::run)\s*\((.*)\)", code):
        found.extend(_shell(" ".join(re.findall(r"[\"']([^\"']*)[\"']", match.group(1))) or match.group(0)))
    for match in re.finditer(r"\b(?:unlink|file\.remove)\s*\(\s*[\"']([^\"']+)[\"']", code):
        kind = _delete_kind(match.group(1))
        if kind:
            found.append((kind, match.group(0)))
    if INSTALL.search(code):
        found.append(("install", "install.packages"))
    if re.search(r"\beval\s*\(\s*parse\s*\(", code):
        found.append(("hidden code", "eval(parse(...))"))
    return found
