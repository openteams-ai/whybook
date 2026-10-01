"""Facts that code computes from the text of a table, and headlines written from them.

A local model labels a table in two calls (local_models.label): the first
writes the description, and the second picks one of the headlines that
candidates() writes here, or none. The grammar allows nothing else, so a local
model cannot state a number that the table does not hold. With this method no
model of the benchmark wrote an untrue headline, where the single call wrote
up to 7 of 20 (research/local-models.md, "Models of 3B to 12B", and
research/benchmark-proxy.md).

This is research/local_models/facts.py without its check() of a headline,
which grades the benchmark's answers. parse() reads the text/plain form of an
output back into rows and columns: pandas' to_string layout, with its wrapped
blocks, its elided "..." columns and the index name on a line of its own, and
the key = value lines of a printed summary such as lifelines'
print_summary. table_facts() states what code computes exactly from that text:

- the shape, and whether the table is only the first rows of a frame;
- the kinds of the columns;
- the terms with p < 0.05, and the sign of their coefficients;
- the strongest correlation of a correlation matrix;
- the diagonal of a confusion table;
- for each numeric column, the largest and smallest values and their rows;
- for two columns on one scale, in how many rows one is lower;
- a column that rises or falls in every row along a sorted key.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any

TOKEN = re.compile(r"\S+")
NUMBER = re.compile(r"^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?%?$")
MISSING = {"NaN", "nan", "None", "NaT", "<NA>", ""}
FOOTER = re.compile(r"^\[(\d[\d,]*) rows x (\d[\d,]*) columns\]$")
PAIR = re.compile(r"^\s*([^=]+?)\s+=\s+(\S.*)$")
P_NAME = re.compile(r"^(p|p[-_. ]?val(ue)?s?|p>\|[zt]\||pr\(>\|?[a-z]*\|?\)|pr\(>(f|chi|chisq)\)|p-unc|p_unc|pval)$", re.I)
COEF_NAME = re.compile(r"^(coef\.?|coefficient|estimate|beta|params?)$", re.I)
MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
HEAD = re.compile(r"\.(head|tail|sample)\(\s*[\w=]*\s*\)\s*;?\s*$")
DESCRIBE = re.compile(r"\.describe\(")
# The statistics of DataFrame.describe(), as its rows, or as its columns once transposed.
DESCRIBE_LABELS = ({"count", "mean", "std", "min", "max"}, {"count", "unique", "top", "freq"})
FILTER = re.compile(r"\[[^\n]*(<=?|>=?|==|!=)[^\n]*\]|\.query\(")
AGGREGATE = re.compile(r"groupby|pivot|\.agg|describe|value_counts|\.corr|crosstab|\.mean\(|\.sum\(|\.count\(")


def number(token: str) -> float | None:
    """The value of a printed number, or None: '64.69%' is 64.69, 'NaN' is None."""
    text = token.replace("−", "-").replace(",", "")
    if not NUMBER.match(text):
        return None
    try:
        return float(text.rstrip("%"))
    except ValueError:
        return None


@dataclass
class Table:
    index: list[str]
    columns: list[str]
    cells: list[list[str]]
    index_names: list[str] = field(default_factory=list)
    columns_name: str = ""

    def column(self, j: int) -> list[str]:
        return [row[j] if j < len(row) else "" for row in self.cells]

    def values(self, j: int) -> list[float | None]:
        return [number(cell) for cell in self.column(j)]

    def is_numeric(self, j: int) -> bool:
        cells = [cell for cell in self.column(j) if cell not in MISSING]
        return bool(cells) and all(number(cell) is not None for cell in cells)

    def is_percent(self, j: int) -> bool:
        cells = [cell for cell in self.column(j) if cell not in MISSING]
        return bool(cells) and all(cell.endswith("%") for cell in cells)


@dataclass
class Parsed:
    tables: list[Table]
    pairs: dict[str, str]
    footer: tuple[int, int] | None

    @property
    def main(self) -> Table | None:
        return max(self.tables, key=lambda t: len(t.index) * max(1, len(t.columns)), default=None)


def _spans(line: str) -> list[tuple[int, int, str]]:
    return [(m.start(), m.end(), m.group()) for m in TOKEN.finditer(line)]


def _mostly_words(line: str) -> bool:
    tokens = line.split()
    return bool(tokens) and sum(number(t) is None for t in tokens) * 2 > len(tokens)


def _table(block: list[str]) -> Table | None:
    """One printed table: a header, maybe a line with the index name, and rows."""
    if len(block) < 2:
        return None
    header = _spans(block[0])
    columns_name = ""
    if block[0][:1] not in (" ", "") and len(header) > 1:
        columns_name = header[0][2]
        header = header[1:]
    if not header:
        return None
    first_start = header[0][0]
    rest = block[1:]
    index_names: list[str] = []
    second = _spans(rest[0])
    if (
        len(rest) > 1
        and second
        and second[0][0] == 0
        and all(number(text) is None for _, _, text in second)
        and second[-1][1] < first_start
    ):
        index_names = [text for _, _, text in second]
        rest = rest[1:]
    rows = [_spans(line) for line in rest]
    counts: dict[int, int] = {}
    for spans in rows:
        for _, end, _ in spans:
            counts[end] = counts.get(end, 0) + 1
    need = 1 if len(rows) <= 2 else math.ceil(0.5 * len(rows))
    edges = sorted({end for _, end, _ in header if counts.get(end, 0) >= need})
    if not edges:
        return None
    names: list[list[str]] = [[] for _ in edges]
    for start, end, text in header:
        slot = next((k for k, edge in enumerate(edges) if end <= edge), None)
        if slot is not None:
            names[slot].append(text)
    starts = [start for spans in rows for start, end, _ in spans if end == edges[0]]
    limit = min([first_start] + starts)
    index, cells = [], []
    for spans in rows:
        label = " ".join(text for start, end, text in spans if end < limit)
        row = [[] for _ in edges]
        for start, end, text in spans:
            if end < limit:
                continue
            slot = next((k for k, edge in enumerate(edges) if end <= edge), len(edges) - 1)
            row[slot].append(text)
        index.append(label)
        cells.append([" ".join(parts) for parts in row])
    keep = [k for k, parts in enumerate(names) if " ".join(parts) != "..."]
    return Table(
        index=index,
        columns=[" ".join(names[k]) for k in keep],
        cells=[[row[k] for k in keep] for row in cells],
        index_names=index_names,
        columns_name=columns_name,
    )


def parse(text: str) -> Parsed:
    """The tables and the key = value pairs of a printed output."""
    pairs: dict[str, str] = {}
    footer = None
    segments: list[list[str]] = []
    current: list[str] = []
    for raw in text.replace("\t", "    ").splitlines():
        line = raw.rstrip()
        if line.endswith("\\"):
            line = line[:-1].rstrip()
        stripped = line.strip()
        found = FOOTER.match(stripped)
        if found:
            footer = (int(found.group(1).replace(",", "")), int(found.group(2).replace(",", "")))
        if not stripped or found or set(stripped) <= set("-=~_") or (stripped.startswith("<") and stripped.endswith(">")):
            if current:
                segments.append(current)
            current = []
            continue
        # The pattern backtracks on long lines of spaces: try it only where it can match.
        pair = PAIR.match(line) if " = " in line and len(line) < 300 else None
        if pair and not current:
            pairs[pair.group(1).strip()] = pair.group(2).strip()
            continue
        current.append(line)
    if current:
        segments.append(current)
    blocks: list[list[str]] = []
    for segment in segments:
        block: list[str] = []
        for line in segment:
            # A second header in the same run of lines, as print_summary writes it.
            if block and line[:1] == " " and block[-1][:1] not in (" ", "") and _mostly_words(line):
                blocks.append(block)
                block = []
            block.append(line)
        blocks.append(block)
    tables: list[Table] = []
    for block in blocks:
        table = _table(block)
        if table is None or not table.columns:
            continue
        same = next((t for t in tables if t.index == table.index), None)
        if same is not None:
            same.columns += table.columns
            same.cells = [a + b for a, b in zip(same.cells, table.cells)]
        else:
            tables.append(table)
    return Parsed(tables, pairs, footer)


# Facts


def fmt(value: float) -> str:
    """A computed number, short: 0.9310 is '0.931', 2984.0 is '2984'."""
    if value == int(value) and abs(value) < 1e15:
        return str(int(value))
    return f"{value:.4g}" if abs(value) < 1e-3 else f"{value:.3f}".rstrip("0").rstrip(".")


def _runs(numbers: list[int]) -> str:
    """'3 to 12' for 3, 4, ..., 12; '1, 2 and 5' otherwise."""
    if len(numbers) >= 3 and numbers == list(range(numbers[0], numbers[-1] + 1)):
        return f"{numbers[0]} to {numbers[-1]}"
    words = [str(n) for n in numbers]
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1]


def _names(labels: list[str], limit: int = 4) -> str:
    if not labels:
        return "none"
    if len(labels) > limit:
        return ", ".join(labels[:limit]) + f" and {len(labels) - limit} more"
    return labels[0] if len(labels) == 1 else ", ".join(labels[:-1]) + " and " + labels[-1]


@dataclass
class Info:
    """What table_facts() found, for candidates() and check()."""

    kind: str = "table"  # raw, describe, coefficients, correlation, confusion, table
    rows: int | None = None
    columns: int | None = None
    lines: list[str] = field(default_factory=list)
    table: Table | None = None
    labels: list[str] = field(default_factory=list)  # a readable label per row
    key: int | None = None  # the column that gives the labels, if any
    key_name: str = ""
    numeric: list[int] = field(default_factory=list)
    pvalues: dict[str, float] = field(default_factory=dict)
    signs: dict[str, float] = field(default_factory=dict)  # coefficient of each term
    pairs: list[tuple[str, str, float]] = field(default_factory=list)  # correlations, strongest first
    diagonal: tuple[int, int] | None = None  # agreements, total
    per_class: list[tuple[str, int, int]] = field(default_factory=list)  # label, found, of
    confusion_names: tuple[str, str] = ("", "")  # columns name, index name
    compare: tuple[str, str, list[str], int] | None = None  # lower column, higher column, rows where lower, rows with both
    trends: list[tuple[str, str]] = field(default_factory=list)  # column, "rises" or "falls"
    extremes: dict[str, tuple[list[str], str, list[str], str]] = field(default_factory=dict)
    counts: set[float] = field(default_factory=set)  # numbers that code computed
    filtered: bool = False
    missing_counts: bool = False
    two_rows: tuple[str, str, list[str], list[str]] | None = None  # higher row, lower row, columns where higher, lower


def _row_labels(table: Table) -> tuple[list[str], int | None, str]:
    """A readable label per row, the column it comes from, and its name."""
    index = table.index
    name = " ".join(table.index_names)
    plain = all(re.fullmatch(r"-?\d+", label) for label in index)
    if name and plain and name.lower() == "month" and all(1 <= int(label) <= 12 for label in index):
        return [f"month {label} ({MONTHS[int(label) - 1].title()})" for label in index], None, name
    if name and plain:
        return [f"{name} {label}" for label in index], None, name
    if (plain or not any(index)) and table.columns:
        first = table.column(0)
        if all(first) and len(set(first)) == len(first):
            numeric = table.is_numeric(0)
            return [f"{table.columns[0]} {value}" if numeric else value for value in first], 0, table.columns[0]
    return index, None, name


def _extreme(values: list[float | None], labels: list[str], cells: list[str], high: bool) -> tuple[list[str], str]:
    present = [(v, label, cell) for v, label, cell in zip(values, labels, cells) if v is not None]
    best = max(v for v, _, _ in present) if high else min(v for v, _, _ in present)
    return [label for v, label, _ in present if v == best], next(cell for v, _, cell in present if v == best)


def table_facts(case: dict[str, Any]) -> Info:
    """The facts of one table case of cases.json, as short lines for a prompt."""
    parsed = parse(case["text"])
    table = parsed.main
    info = Info(table=table)
    code = case.get("code", "")
    last = [line for line in code.strip().splitlines() if line.strip()][-1:] or [""]
    rows = case.get("rows") or (parsed.footer[0] if parsed.footer else None) or (len(table.index) if table else None)
    columns = case.get("columns") or (parsed.footer[1] if parsed.footer else None) or (len(table.columns) if table else None)
    info.rows, info.columns = rows, columns
    info.counts |= {float(n) for n in (rows, columns) if n}
    # Rows kept by a filter: the last line filters, or names a frame that a filter made.
    name = re.fullmatch(r"\s*([A-Za-z_]\w*)\s*", last[0])
    made = name and re.search(rf"^\s*{name.group(1)}\s*=\s*.*$", code, re.M)
    info.filtered = bool(FILTER.search(last[0]) or (made and FILTER.search(made.group(0))))
    info.missing_counts = bool(re.search(r"\.(isna|isnull)\(\)", code))
    if rows and columns:
        info.lines.append(f"{rows} rows, {columns} columns")
    if table is None:
        info.lines.append("code could not read the table")
        return info
    head = bool(HEAD.search(last[0])) or (table.index == [str(i) for i in range(5)] and not AGGREGATE.search(last[0]))
    info.labels, info.key, info.key_name = _row_labels(table)
    info.numeric = [j for j in range(len(table.columns)) if table.is_numeric(j) and j != info.key]
    text_columns = [table.columns[j] for j in range(len(table.columns)) if j not in info.numeric and j != info.key]
    kinds = f"{len(info.numeric)} numeric"
    if text_columns:
        kinds += f", {len(text_columns)} text ({_names(text_columns, 3)})"
    if head:
        info.kind = "raw"
        shown = table.columns[:8]
        info.lines.append("the first rows of a frame, as the code shows them: raw data, not a result")
        info.lines.append(f"columns shown: {', '.join(shown)}" + (f" and {len(table.columns) - 8} more" if len(table.columns) > 8 else ""))
        return info
    if _describes(table, last[0]):
        # Each row, or each column, is another statistic: a comparison across them compares a count with a mean.
        info.kind = "describe"
        info.lines.append("the summary statistics of describe(): count, mean, spread and quantiles")
        return info
    for key, value in list(parsed.pairs.items()):
        if number(value.split()[0]) is not None and len(info.lines) < 4:
            info.lines.append(f"{key} = {value}")
    labels = info.labels
    p_column = next((j for j in info.numeric if P_NAME.match(table.columns[j].strip())), None)
    square = len(table.index) == len(table.columns) >= 2
    if p_column is not None:
        info.kind = "coefficients"
        values = table.values(p_column)
        terms = [(label, v) for label, v in zip(labels, values) if v is not None]
        info.pvalues = dict(terms)
        low = [(label, v) for label, v in terms if v < 0.05]
        info.counts |= {float(len(low)), float(len(terms)), float(len(terms) - len(low))}
        shown = ", ".join(f"{label} (p = {fmt(v)})" for label, v in low[:6])
        if len(terms) == 1:
            label, v = terms[0]
            info.lines.append(f"{label} has p = {fmt(v)}, {'below' if v < 0.05 else 'not below'} 0.05")
        elif len(low) == len(terms):
            info.lines.append(f"all {len(terms)} terms have p < 0.05")
        elif not low:
            info.lines.append(f"none of the {len(terms)} terms has p < 0.05")
        elif len(terms) - len(low) <= 3 and len(low) > 3:
            others = ", ".join(f"{label} (p = {fmt(v)})" for label, v in terms if v >= 0.05)
            info.lines.append(f"{len(low)} of {len(terms)} terms have p < 0.05; the other{'s' if len(terms) - len(low) > 1 else ''}: {others}")
        else:
            info.lines.append(f"{len(low)} of {len(terms)} terms have p < 0.05: {shown}")
        coef = next((j for j in info.numeric if COEF_NAME.match(table.columns[j].strip())), None)
        if coef is not None and low:
            signs = dict(zip(labels, table.values(coef)))
            info.signs = {label: signs[label] for label, _ in low if signs.get(label) is not None and label.lower() != "intercept"}
            up = [label for label, v in info.signs.items() if v > 0]
            down = [label for label, v in info.signs.items() if v < 0]
            parts = []
            if up:
                parts.append(f"positive for {_names(up, 5)}")
            if down:
                parts.append(f"negative for {_names(down, 5)}")
            if parts:
                info.lines.append(f"{table.columns[coef].strip()} of the terms with p < 0.05: " + "; ".join(parts))
    elif square and [c.strip() for c in table.columns] == [i.strip() for i in table.index]:
        grid = [table.values(j) for j in range(len(table.columns))]
        diagonal = [grid[j][j] for j in range(len(grid))]
        flat = [v for column in grid for v in column if v is not None]
        if all(v is not None and abs(v - 1) < 1e-6 for v in diagonal) and flat and all(-1 <= v <= 1 for v in flat):
            info.kind = "correlation"
            names = table.columns
            pairs = [(names[a], names[b], grid[b][a]) for a in range(len(names)) for b in range(a + 1, len(names)) if grid[b][a] is not None]
            pairs.sort(key=lambda p: -abs(p[2]))
            info.pairs = pairs
            a, b, r = pairs[0]
            info.lines.append(f"strongest correlation off the diagonal: {a} and {b}, r = {fmt(r)}")
            if len(pairs) > 1:
                c, d, s = pairs[1]
                info.lines.append(f"next strongest: {c} and {d}, r = {fmt(s)}")
                strong = sum(abs(r) >= 0.3 for _, _, r in pairs)
                info.lines.append(f"{strong} of {len(pairs)} pairs have |r| of 0.3 or more")
                info.counts |= {float(strong), float(len(pairs))}
    if info.kind == "table" and square and sorted(c.strip() for c in table.columns) == sorted(i.strip() for i in table.index):
        grid = [[number(cell) for cell in row] for row in table.cells]
        flat = [v for row in grid for v in row]
        if all(v is not None and v >= 0 and v == int(v) for v in flat):
            info.kind = "confusion"
            order = [table.index.index(c) for c in table.columns]
            total = int(sum(flat))
            agree = int(sum(grid[order[j]][j] for j in range(len(table.columns))))
            info.diagonal = (agree, total)
            info.counts |= {float(agree), float(total), float(total - agree), round(100 * agree / total, 1), round(100 * (total - agree) / total, 1)}
            column_name, index_name = table.columns_name or "column", " ".join(table.index_names) or "row"
            info.confusion_names = (column_name, index_name)
            info.lines.append(f"same label in row and column: {agree} of {total} ({fmt(100 * agree / total)}%); different: {total - agree}")
            for j, label in enumerate(table.columns):
                of = int(sum(grid[i][j] for i in range(len(grid))))
                found = int(grid[order[j]][j])
                info.per_class.append((label, found, of))
                info.counts |= {float(of), float(found)}
                info.lines.append(f"of {of} with {column_name} = {label}, {found} have {index_name} = {label}")
    if info.kind == "table" or (info.kind == "coefficients" and len(table.index) <= 3):
        _column_facts(info, table)
    return info


def _describes(table: Table, last_line: str) -> bool:
    """Whether a table is the summary of DataFrame.describe(), transposed or not."""
    if DESCRIBE.search(last_line):
        return True
    for labels in (table.index, table.columns):
        found = {label.strip() for label in labels}
        if any(statistics <= found for statistics in DESCRIBE_LABELS):
            return True
    return False


def _column_facts(info: Info, table: Table) -> None:
    labels = info.labels
    numeric = info.numeric
    if len(table.index) == 2 and len(numeric) >= 2:
        # Two rows: one comparison, column by column.
        groups: dict[str, list[tuple[str, str, str]]] = {"higher": [], "lower": [], "equal": []}
        for j in numeric:
            x, y = table.values(j)
            if x is None or y is None:
                continue
            way = "higher" if x > y else "lower" if x < y else "equal"
            groups[way].append((table.columns[j], table.column(j)[0], table.column(j)[1]))
        compared = sum(len(g) for g in groups.values())
        if not compared:
            return
        a, b = labels
        if len(groups["lower"]) > len(groups["higher"]):
            a, b = b, a
            groups = {"higher": groups["lower"], "lower": groups["higher"], "equal": groups["equal"]}
            groups = {way: [(name, y, x) for name, x, y in items] for way, items in groups.items()}
        parts = []
        for way in ("higher", "lower", "equal"):
            items = groups[way]
            if not items:
                continue
            shown = [f"{name} ({x} against {y})" if way != "equal" else f"{name} ({x})" for name, x, y in items[:4]]
            more = f" and {len(items) - 4} more" if len(items) > 4 else ""
            prefix = f"{a} is higher than {b} in {len(items)} of {compared} columns: " if way == "higher" else f"{way} in "
            parts.append(prefix + ", ".join(shown) + more)
        info.lines.append("; ".join(parts))
        info.two_rows = (a, b, [name for name, _, _ in groups["higher"]], [name for name, _, _ in groups["lower"]])
        info.counts |= {float(len(groups["higher"])), float(compared)}
        return
    for j in numeric[:6]:
        values = table.values(j)
        present = [v for v in values if v is not None]
        if not present:
            continue
        name = table.columns[j]
        if min(present) == max(present):
            info.lines.append(f"{name}: {table.column(j)[values.index(present[0])]} in every row")
            continue
        top, top_cell = _extreme(values, labels, table.column(j), True)
        bottom, bottom_cell = _extreme(values, labels, table.column(j), False)
        info.extremes[name] = (top, top_cell, bottom, bottom_cell)
        # Ties of two or more rows are counts a headline may state ("5 zero readings").
        info.counts |= {float(len(side)) for side in (top, bottom) if len(side) > 1}
        line = f"{name}: largest {top_cell} " + (f"at {top[0]}" if len(top) == 1 else f"in {len(top)} rows: {_names(top)}")
        rest = sorted((v for v in present if v < max(present)), reverse=True)
        if len(present) >= 5 and len(top) == 1 and rest:
            second = [label for v, label in zip(values, labels) if v == rest[0]]
            cell = table.column(j)[values.index(rest[0])]
            line += f", then {cell} at {_names(second, 2)}"
        line += f"; smallest {bottom_cell} " + (f"at {bottom[0]}" if len(bottom) == 1 else f"in {len(bottom)} rows: {_names(bottom)}")
        info.lines.append(line)
        if all(v is not None and v >= 0 and v == int(v) for v in values) and len(values) > 2:
            total = sum(values)
            info.counts.add(float(total))
            info.lines.append(f"{name}: total {fmt(total)}")
    if len(numeric) > 6:
        info.lines.append(f"and {len(numeric) - 6} more numeric columns")
    if len(numeric) == 2 and len(table.index) >= 3:
        a, b = numeric
        va, vb = table.values(a), table.values(b)
        both = [(x, y, label) for x, y, label in zip(va, vb, labels) if x is not None and y is not None]
        if both and min(x for x, _, _ in both) < max(y for _, y, _ in both) and min(y for _, y, _ in both) < max(x for x, _, _ in both):
            lower_a = [label for x, y, label in both if x < y]
            lower_b = [label for x, y, label in both if y < x]
            low, high, where = (table.columns[a], table.columns[b], lower_a) if len(lower_a) >= len(lower_b) else (table.columns[b], table.columns[a], lower_b)
            if where:
                info.compare = (low, high, where, len(both))
                info.counts |= {float(len(where)), float(len(both))}
                info.counts |= {round(abs(x - y), 2) for x, y, _ in both}
                info.counts |= {round(abs(x - y)) for x, y, _ in both}
                months = [re.match(r"month (\d+)", label) for label in where]
                shown = f"months {_runs([int(m.group(1)) for m in months])}" if all(months) else _names(where, 5)
                info.lines.append(f"{low} is lower than {high} in {len(where)} of {len(both)} rows: {shown}")
    key_values = None
    if info.key is not None and table.is_numeric(info.key):
        key_values = table.values(info.key)
    elif info.key is None and all(re.fullmatch(r"-?\d+", label) for label in table.index) and info.key_name:
        key_values = [float(label) for label in table.index]
    if key_values and len(key_values) >= 3 and all(v is not None for v in key_values) and key_values == sorted(key_values):
        for j in numeric:
            values = table.values(j)
            if any(v is None for v in values):
                continue
            steps = [b - a for a, b in zip(values, values[1:])]
            if all(s > 0 for s in steps) or all(s < 0 for s in steps):
                way = "rises" if steps[0] > 0 else "falls"
                info.trends.append((table.columns[j], way))
                info.lines.append(
                    f"{table.columns[j]} {way} in every row as {info.key_name} rises: {table.column(j)[0]} at {info.labels[0]} to {table.column(j)[-1]} at {info.labels[-1]}"
                )


# Candidates for the constrained choice


# A headline states one result in at most four words. The grammar of a local
# model's answer holds each word to 20 characters, so at most 83 in all.
HEADLINE_WORDS = 4
HEADLINE_CHARS = 83


def headline(text: Any) -> str:
    """``text`` on one line, as a tile shows it, or "" when it has more than four words or 83 characters.

    A headline is never cut: cut to 48 characters, "pain_score_baseline and
    pain_score_week_12: -0.45" read "-0.4", and cut to four words, "3
    significant terms at the 5% level" read "3 significant terms at".
    """
    words = str(text or "").split()
    shown = " ".join(words)
    return shown if len(words) <= HEADLINE_WORDS and len(shown) <= HEADLINE_CHARS else ""


def _short(label: str) -> str:
    """A row label as a headline word: 'month 12 (December)' is 'December'."""
    found = re.match(r"month \d+ \((\w+)\)", label)
    return found.group(1) if found else label


def candidates(info: Info) -> list[str]:
    """Headlines of at most four words that state a computed fact; the model picks one or none."""
    out: list[str] = []
    table = info.table
    if info.kind in ("raw", "describe") or table is None:
        return out
    if info.kind == "coefficients":
        low = [label for label, p in info.pvalues.items() if p < 0.05]
        n = len(info.pvalues)
        if n == 1:
            p = next(iter(info.pvalues.values()))
            out.append(f"significant, p = {fmt(p)}" if p < 0.05 else f"not significant, p = {fmt(p)}")
        elif len(low) == n:
            out.append(f"all {n} terms significant")
        elif not low:
            out.append("no significant terms")
        else:
            out.append(f"{len(low)} of {n} significant")
        for label in sorted(info.signs, key=lambda term: info.pvalues[term])[:3]:
            out.append(f"{label} {'positive' if info.signs[label] > 0 else 'negative'} effect")
    if info.kind == "correlation" and info.pairs:
        a, b, r = info.pairs[0]
        out.append(f"{a} and {b}: {fmt(r)}")
        if len(info.pairs) > 1:
            strong = sum(abs(r) >= 0.3 for _, _, r in info.pairs)
            out.append("no strong correlations" if strong == 0 else f"{strong} of {len(info.pairs)} pairs correlate")
    if info.kind == "confusion" and info.diagonal:
        agree, total = info.diagonal
        out.append(f"accuracy {fmt(100 * agree / total)}%")
        out.append(f"{total - agree} errors")
        for label, found, of in info.per_class:
            out.append(f"{found}/{of} {label} found")
    if info.filtered and info.rows:
        out.append(f"{info.rows} rows")
    if info.two_rows:
        a, b, higher, lower = info.two_rows
        for name in higher[:3]:
            out.append(f"{a} higher {name}")
        for name in lower[:1]:
            out.append(f"{b} higher {name}")
    for name, (top, _, bottom, _) in list(info.extremes.items())[:4]:
        several = len(info.extremes) > 1
        one_word = len(name.split()) == 1
        if len(top) <= 2:
            who = " and ".join(_short(label) for label in top)
            out.append(f"{who} most {name}" if one_word else (f"{who} highest {name}" if several else f"{who} highest"))
        if len(bottom) <= 2 and not info.missing_counts:
            who = " and ".join(_short(label) for label in bottom)
            out.append(f"{who} least {name}" if one_word else (f"{who} lowest {name}" if several else f"{who} lowest"))
    if info.compare:
        # Of the rows where both values are present, as the facts line counts them.
        low, high, where, compared = info.compare
        out.append(f"{low} lower {len(where)}/{compared}")
        out.append(f"{high} higher {len(where)}/{compared}")
    for name, way in info.trends:
        out.append(f"{name} {way} with {info.key_name}")
    seen, unique = set(), []
    for text in out:
        if headline(text) != text:
            continue  # too long for a tile, and a cut headline would not read
        if text and text.lower() not in seen:
            seen.add(text.lower())
            unique.append(text)
    return unique[:12]
