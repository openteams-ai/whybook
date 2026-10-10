"""Options for a file dropped from the file browser onto the view.

Dropping a data file is how an analysis starts: load it, look at it first, or
join it to a frame that a cell already uses. The server reads the first rows
of a delimited file, or the schema of a parquet file, to find the keys it
shares with the kernel's frames.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any

from .. import codegen
from . import reshape, starts
from .cells import CellInfo, question_id
from .models import Candidate, Context, InvalidRequest, Placement
from .rankers import score_candidate

# How pandas reads each kind of file; {path} is the path as a Python string (codegen.literal).
READERS = {
    ".csv": "pd.read_csv({path})",
    ".tsv": 'pd.read_csv({path}, sep="\\t")',
    ".tab": 'pd.read_csv({path}, sep="\\t")',
    ".parquet": "pd.read_parquet({path})",
    ".feather": "pd.read_feather({path})",
    ".xlsx": "pd.read_excel({path})",
    ".xls": "pd.read_excel({path})",
    ".json": "pd.read_json({path})",
    ".dta": "pd.read_stata({path})",
    ".sav": "pd.read_spss({path})",
    ".sas7bdat": "pd.read_sas({path})",
}
DELIMITED = {".csv": ",", ".tsv": "\t", ".tab": "\t"}
READABLE = "csv, tsv, parquet, feather, Excel, JSON, Stata, SPSS or SAS"


@dataclass(frozen=True)
class FileDrop:
    # The path in the Jupyter server's contents, and the same file relative to
    # the notebook's folder, which is the kernel's working directory.
    path: str
    kernel_path: str
    label: str
    directory: bool
    target_cell: CellInfo | None
    cells: tuple[CellInfo, ...]
    context: Context

    @classmethod
    def from_json(cls, data: Any) -> FileDrop:
        if not isinstance(data, dict) or not isinstance(data.get("source"), dict):
            raise InvalidRequest("the body needs a source")
        source = data["source"]
        path = source.get("path")
        if not isinstance(path, str) or not path:
            raise InvalidRequest("a file needs a path")
        target = data.get("target") or {}
        return cls(
            path=path,
            kernel_path=str(source.get("kernel_path") or path),
            label=str(source.get("label") or PurePosixPath(path).name),
            directory=source.get("type") == "directory",
            target_cell=CellInfo.from_json(target["cell"]) if target.get("cell") else None,
            cells=tuple(CellInfo.from_json(c) for c in data.get("cells") or ()),
            context=Context.from_json(data.get("context")),
        )


def _inside(root: str | None, path: str) -> str | None:
    """The full path of a file under ``root``, or None for a path that leaves it or names no file."""
    if root is None:
        return None
    base = os.path.realpath(root)
    full = os.path.realpath(os.path.join(base, path))
    return full if full.startswith(base + os.sep) and os.path.isfile(full) else None


# A date as ISO 8601 writes it, with a time or without: 2025-03-14, 2025-03-14 18:30:00, 2025-03-14T18:30Z.
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$")
# The rows of a delimited file read to find its columns of dates.
DATE_SAMPLE = 1000


def date_columns(root: str | None, path: str, suffix: str) -> list[str]:
    """The columns of a file that hold dates which pandas reads as text or as Python objects.

    A delimited file: the columns whose values in the first rows are all ISO
    dates, such as the day of a reading or the date a home switched tariff,
    which is empty for most homes. A parquet file: the columns of dates
    without a time, which pandas reads as ``datetime.date`` objects. Left as
    text, a date gives a question about the time before and after it nothing
    to compare.
    """
    full = _inside(root, path)
    if full is None or (suffix not in DELIMITED and suffix != ".parquet"):
        return []
    try:
        if suffix == ".parquet":
            import pyarrow as pa
            import pyarrow.parquet as pq

            return [field.name for field in pq.read_schema(full) if pa.types.is_date(field.type)]
        import pandas as pd

        sample = pd.read_csv(full, sep=DELIMITED[suffix], nrows=DATE_SAMPLE, dtype=str)
    except Exception:
        return []
    found = []
    for column in sample.columns:
        values = sample[column].dropna()
        if len(values) and all(ISO_DATE.match(value.strip()) for value in values):
            found.append(str(column))
    return found


def header(root: str | None, path: str, suffix: str) -> list[str] | None:
    """The columns of a delimited or parquet file under ``root``, or None."""
    if suffix not in DELIMITED and suffix != ".parquet":
        return None
    full = _inside(root, path)
    if full is None:
        return None
    try:
        if suffix == ".parquet":
            # The schema only: the rows stay on disk. Without pyarrow, no join is offered.
            import pyarrow.parquet as pq

            return [str(name) for name in pq.read_schema(full).names]
        import pandas as pd

        return [str(c) for c in pd.read_csv(full, sep=DELIMITED[suffix], nrows=50).columns]
    except Exception:
        return None


# The rows of a file that the counts of a key read, at most.
KEY_ROWS = 500_000


def sample_rows(root: str | None, path: str, suffix: str) -> Any:
    """The first rows of a delimited or parquet file under ``root`` as a pandas frame, or None: they show which columns hold numbers or few levels."""
    full = _inside(root, path)
    if full is None or (suffix not in DELIMITED and suffix != ".parquet"):
        return None
    try:
        if suffix == ".parquet":
            import pyarrow.parquet as pq

            for batch in pq.ParquetFile(full).iter_batches(batch_size=starts.SAMPLE):
                return batch.to_pandas()
            return None
        import pandas as pd

        return pd.read_csv(full, sep=DELIMITED[suffix], nrows=starts.SAMPLE)
    except Exception:
        return None


def key_counts(root: str | None, path: str, suffix: str, key: str) -> tuple[int | None, int | None]:
    """The rows of a file and the distinct values of one column, or None for both where the file is too long to read for them, or cannot be read."""
    full = _inside(root, path)
    if full is None or (suffix not in DELIMITED and suffix != ".parquet"):
        return None, None
    try:
        if suffix == ".parquet":
            import pyarrow.parquet as pq

            if pq.ParquetFile(full).metadata.num_rows > KEY_ROWS:
                return None, None
            column = pq.read_table(full, columns=[key]).column(0).to_pandas()
        else:
            import pandas as pd

            column = pd.read_csv(full, sep=DELIMITED[suffix], usecols=[key], nrows=KEY_ROWS + 1)[key]
            if len(column) > KEY_ROWS:
                return None, None
        return len(column), int(column.nunique(dropna=True))
    except Exception:
        return None, None


def _option(text: str, kind: str, prior: float, placement: Placement, code: str | None, effect: str, path: str) -> Candidate:
    return Candidate(
        id=question_id(text, path),
        text=text,
        type=kind,
        origin="template",
        variables=(path,),
        prior=prior,
        effect=effect,
        placement=placement,
        code=code,
    )


def file_options(drop: FileDrop, root: str | None) -> dict[str, Any]:
    cell, context = drop.target_cell, drop.context
    title = f"{drop.label} onto {cell.label}" if cell else f"{drop.label} into the notebook"
    suffix = PurePosixPath(drop.path).suffix.lower()
    reader = READERS.get(suffix)
    note = None
    options: list[Candidate] = []
    if drop.directory:
        note = "Drop a file, not a folder."
    elif reader is None:
        note = f"{drop.label} is not a data file that Whybook reads yet: {READABLE}."
    else:
        read = reader.format(path=codegen.literal(drop.kernel_path))
        taken = set(context.frames) | {name for c in drop.cells for name in c.defs}
        name = codegen.identifier(PurePosixPath(drop.path).stem)
        if name in taken:
            name = f"{name}_file"
        # Dates as dates (design iteration 1.75): a delimited file names them
        # to pandas, and the dates of a parquet file are converted after the read.
        dates = date_columns(root, drop.path, suffix)
        if dates and suffix in DELIMITED:
            read = f"{read[:-1]}, parse_dates={codegen.literals(dates)})"

        def loader(variable: str) -> list[str]:
            """The line that reads the file into ``variable``, and those that turn the dates of a parquet file into dates."""
            converted = [f"{variable}[{codegen.literal(c)}] = pd.to_datetime({variable}[{codegen.literal(c)}])" for c in dates] if dates and suffix not in DELIMITED else []
            return [f"{variable} = {read}", *converted]

        loaded = loader(name)
        with_dates = f", with {' and '.join(dates)} as dates" if dates else ""
        last = drop.cells[-1] if drop.cells else None
        if cell is not None:
            home = Placement("new", cell.id, f"new cell after {cell.label}", "Next to the cell it was dropped on", None)
        elif last is not None:
            home = Placement("new", last.id, "a new cell at the end", "Where the analysis continues", None)
        else:
            home = Placement("new", None, "the first cell", "The notebook has no cells yet", None)
        preview = Placement("preview", None, "a preview in the sidebar", "Nothing is written to the notebook unless you keep it", None)
        load = "\n".join(["import pandas as pd", "", *loaded, f"{name}.head()"])
        options.append(_option(f"Load {drop.label} as {name}", "descriptive", 0.7, home, load, f"A data frame from the file, and its first rows{with_dates}", drop.path))
        profile = "\n".join(["import whybook", "import pandas as pd", "", f"whybook.profile({read})"])
        options.append(_option(f"Profile {drop.label} before loading it", "quality", 0.6, preview, profile, f"Types, missing values and duplicates · {starts.UNLESS_KEPT}", drop.path))
        columns = header(root, drop.path, suffix)
        # A diary with pain_1 to pain_7 loads as one row per day too (design iteration 1.85).
        long = reshape.plan(columns, context.unit) if columns else None
        if long:
            long_name = reshape.name_for(name, taken | {name})
            text = f"Load {drop.label} as one row per {long.step}"
            code = "\n".join([codegen.comment(f"{text}: {reshape.text(name, long).split(': ', 1)[1]}"), "import pandas as pd", "", *loaded, *reshape.lines(name, long_name, long)])
            options.append(_option(text, "descriptive", 0.72, home, code, f"{long_name}: {reshape.effect(long)[0].lower()}{reshape.effect(long)[1:]}", drop.path))
        # The frames that the cell loads or reads (design iteration 1.87): a cell that loads
        # sites shares its key with the visits dropped on it, though it reads no frame.
        frames = starts.cell_frames(cell, context)
        link, linked, joined_frame = None, None, None
        for frame in frames if columns else []:
            link = starts.find_link(name, columns or [], lambda key: key_counts(root, drop.path, suffix, key), frame, context)
            if link is not None:
                linked = frame
                break
        if cell is not None and columns:
            file_columns = {c: "" for c in columns}
            for frame in frames:
                if link is not None and link.dropped_many and frame == linked:
                    # The file repeats the keys of the frame: "Add the columns of the frame to the file" joins the other way.
                    continue
                keys = codegen.join_keys(file_columns, context.frames[frame], context.unit)
                if not keys:
                    continue
                joined = codegen.identifier(f"{frame}_{name}")
                # A column only the file has: after the join it is empty where no row matched.
                probe = next((c for c in columns if c not in keys and c not in context.frames[frame]), None)
                lines = ["import pandas as pd", "", *loaded, f"{joined} = {frame}.merge({name}, on={codegen.literals(keys)}, how=\"left\")"]
                if probe is not None:
                    # The file's name goes in as a string of its own: in an f-string, its braces would run.
                    share = f'format({joined}[{codegen.literal(probe)}].notna().mean(), ".0%")'
                    lines.append(f"print({share}, {codegen.literal(f'of {frame} rows found a match in {drop.label}')})")
                lines.append(f"{joined}.head()")
                options.append(
                    _option(
                        f"Join {drop.label} to {frame} on {', '.join(keys)}",
                        "descriptive",
                        0.65,
                        Placement("new", cell.id, f"new cell after {cell.label}", "The cell uses the frame it joins to", None),
                        "\n".join(lines),
                        "Left join, with the share of rows that found a match",
                        drop.path,
                    )
                )
                joined_frame = frame
                break

        def make(text: str, kind: str, prior: float, placement: Placement, code: str | None, effect: str) -> Candidate:
            return _option(text, kind, prior, placement, code, effect, drop.path)

        if link is not None and cell is not None:
            here = Placement("new", cell.id, f"new cell after {cell.label}", "The cell holds the frame it is compared with", None)
            options += starts.combined_options(link, ["import pandas as pd", "", *loaded], make, here, joined_before=joined_frame == linked)
        elif starts.begun(drop.cells):
            # No analysis yet: what is in the file, which needs no model (design iteration 1.87).
            sample = sample_rows(root, drop.path, suffix)
            shape = starts.shape_of(sample) if sample is not None else None
            options += starts.start_options(drop.label, name, lambda variable: ["import pandas as pd", "", *loader(variable)], starts.unit_of(columns or [], context.unit), shape, make, preview)
        else:
            options.append(_option(f"What could {drop.label} add to this analysis?", "descriptive", 0.45, home, None, "AI reads the file's columns and the notebook", drop.path))
    for option in options:
        score_candidate(option, [], context)
    options.sort(key=lambda option: option.probability or 0.0, reverse=True)
    return {"title": title, "note": note, "mode": "auto", "options": [option.to_json() for option in options], "placements": [], "preselected": []}
