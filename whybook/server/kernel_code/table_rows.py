"""The rows of a frame behind rows picked in a table, and what sets them apart.

A pandas table labels its rows with the frame's index, or with the values of
some of its columns, as after a groupby or a set_index. The labels come as the
table writes them, as text, and each is read back as a value of its level: "3"
is 3 in an integer index, "0.500000" is 0.5, "2024-01-01" is a date.

A polars table writes no row labels. Its rows are found by their place in the
frame, from 0 (``positions``), or by the values of key columns as the table
writes them: "A" in double quotes, null, true, 0.333333. That path uses
narwhals and needs neither pandas nor numpy, and its mask is polars code.

The frontend bundle holds the text of this file and runs it in the kernel, so
it must not import the whybook package.
"""


def _whybook_table_rows(args):
    import math

    from IPython import get_ipython
    from IPython.display import display

    def done(result):
        display({"application/vnd.whybook.result+json": result}, raw=True)

    name = args["frame"]
    namespace = get_ipython().user_ns
    frame = namespace.get(name)
    if frame is None:
        done({"error": f"no variable named {name}", "missing": True})
        return

    def by_place_or_value():
        """Rows of a polars frame: by their place, or by the values of key columns."""
        import datetime

        try:
            import narwhals.stable.v2 as nw
        except ImportError:
            try:
                import narwhals as nw
            except ImportError:
                done({"error": "narwhals is not installed in the kernel"})
                return
        try:
            df = nw.from_native(frame, eager_only=True)
        except TypeError:
            done({"error": f"{name} is not a data frame"})
            return
        polars = df.implementation.is_polars()
        schema = df.schema
        keys = [str(key) for key in args.get("keys") or []]
        picks = [[str(label) for label in pick] for pick in args.get("labels") or [] if pick]
        unit = args.get("unit")
        # Without keys a row is its place: polars writes no row labels.
        by_place = bool(args.get("positions")) or not keys
        if not by_place:
            absent = [key for key in keys if key not in schema]
            if absent:
                done({"error": f"{name} has no column {absent[0]}"})
                return
        depth = 1 if by_place else len(keys)
        if not picks or max(len(pick) for pick in picks) > depth:
            done({"error": f"the labels do not fit the rows of {name}"})
            return
        height = len(df)
        place = nw.generate_temporary_column_name(8, df.columns)
        places = df.with_row_index(place).get_column(place)
        nothing = places < 0

        def unquoted(text):
            """A string as polars writes it: in double quotes, cut after 30 characters with an ellipsis."""
            if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
                return text[1:-1], False
            if len(text) >= 2 and text[0] == '"' and text[-1] == "\u2026":
                return text[1:-1], True
            return text, False

        def shown(text):
            return unquoted(text)[0] + ("\u2026" if unquoted(text)[1] else "")

        def close(values, text):
            """Floats that polars writes as this text: 0.333333, 12.0, 1.0000e7."""
            target = float(text)
            if math.isinf(target):
                return (values == target).fill_null(False)
            mantissa, _, exponent = text.lower().partition("e")
            decimals = len(mantissa.partition(".")[2])
            tolerance = 0.5 * 10 ** (int(exponent or 0) - decimals)
            return values.is_between(target - tolerance, target + tolerance).fill_null(False)

        def matches(level, text):
            """The rows whose value at this level the table writes as this text; None when it is no value of the level."""
            if by_place:
                try:
                    return places == int(text.replace("_", ""))
                except ValueError:
                    return None
            return written_as(keys[level], text)

        def written_as(column, text):
            """The rows whose value in this column polars writes as this text; None when the view cannot read it."""
            values = df.get_column(column)
            dtype = schema[column]
            if text == "null":
                return values.is_null()
            try:
                if dtype.is_float() and text == "NaN":
                    return values.is_nan().fill_null(False)
                if dtype == nw.Boolean:
                    if text.lower() not in ("true", "false"):
                        return None
                    return (values == (text.lower() == "true")).fill_null(False)
                if dtype.is_integer():
                    return (values == int(text.replace("_", ""))).fill_null(False)
                if dtype.is_float():
                    return close(values, text)
                if isinstance(dtype, nw.Datetime):
                    stamp = text
                    if dtype.time_zone is not None:
                        # polars writes the zone's abbreviation after the time: 2024-01-02 00:00:00 CET.
                        stamp = " ".join(text.split(" ")[:2])
                        values = values.dt.replace_time_zone(None)
                    return (values == datetime.datetime.fromisoformat(stamp)).fill_null(False)
                if isinstance(dtype, nw.Date):
                    return (values == datetime.date.fromisoformat(text)).fill_null(False)
                if isinstance(dtype, (nw.String, nw.Categorical, nw.Enum)):
                    value, cut = unquoted(text)
                    strings = values.cast(nw.String)
                    if cut:
                        return strings.str.starts_with(value).fill_null(False)
                    return (strings == value).fill_null(False)
                return (values.cast(nw.String) == text).fill_null(False)
            except Exception:
                return None

        # A row found by its place must still hold what the table shows: a
        # later cell can sort or change the frame since the table was drawn.
        if by_place:
            for pick, cells in zip(picks, args.get("cells") or []):
                try:
                    at = int(pick[0].replace("_", ""))
                except ValueError:
                    continue
                if not 0 <= at < height:
                    continue
                for column, text in (cells or {}).items():
                    dtype = schema.get(column)
                    # Only the types the view reads back exactly.
                    exact = dtype is not None and (
                        dtype.is_integer()
                        or dtype.is_float()
                        or dtype == nw.Boolean
                        or isinstance(dtype, (nw.String, nw.Categorical, nw.Enum, nw.Date, nw.Datetime))
                    )
                    if not exact:
                        continue
                    rows = written_as(column, text)
                    if rows is not None and not rows[at]:
                        done({"error": f"{name} changed after the table was shown: its row {at} does not hold what the table shows. Run the cell again to ask about these rows."})
                        return

        # A pick has a label for each level, down to the level clicked. A label
        # must read as one value of its level: a string cut short, or a float
        # rounded, that fits two values says so rather than mixing their rows.
        picked = []
        for pick in picks:
            rows = ~nothing
            for level, text in enumerate(pick):
                found = matches(level, text)
                if found is None:
                    found = nothing
                elif not by_place and found.any():
                    kept = df.get_column(keys[level]).filter(found)
                    if kept.n_unique() > 1:
                        done({"error": f"more than one value of {keys[level]} in {name} reads as {shown(text)}: the table shows it cut or rounded"})
                        return
                rows = rows & found
            picked.append(rows)
        mask = picked[0]
        for rows in picked[1:]:
            mask = mask | rows
        single = all(len(pick) == 1 for pick in picks)

        def listed(texts):
            return texts[0] if len(texts) == 1 else f"{', '.join(texts[:-1])} and {texts[-1]}"

        def literal(value, zone=None):
            """The value as polars code, or None when a literal cannot write it."""
            if isinstance(value, (bool, int)):
                return repr(value)
            if isinstance(value, float):
                if math.isnan(value):
                    return None
                return repr(value) if math.isfinite(value) else f"float({str(value)!r})"
            if isinstance(value, str):
                return repr(value)
            if isinstance(value, datetime.datetime):
                # The time as the zone of the column reads it, as polars gives it back.
                parts = [value.year, value.month, value.day, value.hour, value.minute, value.second, value.microsecond]
                while len(parts) > 3 and not parts[-1]:
                    parts.pop()
                written = ", ".join(map(str, parts))
                if value.tzinfo is None:
                    return f"pl.datetime({written})"
                return f"pl.datetime({written}, time_zone={zone!r})" if zone else None
            if isinstance(value, datetime.date):
                return f"pl.date({value.year}, {value.month}, {value.day})"
            return None

        def condition(level, texts, rows):
            """polars code for the rows whose value at this level is one of these texts."""
            if by_place:
                return f"pl.int_range(pl.len()).is_in([{', '.join(str(int(text.replace('_', ''))) for text in texts)}])"
            key = keys[level]
            column = f"pl.col({key!r})"
            values = df.get_column(key).filter(rows)
            dtype = schema[key]
            nulls = bool(values.is_null().any())
            nans = dtype.is_float() and bool(values.is_nan().fill_null(False).any())
            found = [value for value in values.drop_nulls().unique(maintain_order=True).to_list() if not (isinstance(value, float) and math.isnan(value))]
            written = [literal(value, getattr(dtype, "time_zone", None)) for value in found]
            tests = []
            if found:
                if not all(written):
                    return None
                tests.append(f"{column} == {written[0]}" if len(written) == 1 else f"{column}.is_in([{', '.join(written)}])")
            if nulls:
                tests.append(f"{column}.is_null()")
            if nans:
                tests.append(f"{column}.is_nan()")
            if not tests:
                return None
            return tests[0] if len(tests) == 1 else " | ".join(f"({test})" for test in tests)

        mask_code = None
        if polars:
            if single:
                texts = list(dict.fromkeys(pick[0] for pick in picks))
                mask_code = condition(0, texts, mask)
            else:
                tests = []
                for pick, rows in zip(picks, picked):
                    parts = [condition(level, [text], rows) for level, text in enumerate(pick)]
                    if not all(parts):
                        tests = None
                        break
                    tests.append(" & ".join(f"({part})" for part in parts) if len(parts) > 1 else parts[0])
                if tests:
                    mask_code = " | ".join(f"({test})" for test in tests) if len(tests) > 1 else tests[0]
            if mask_code is not None:
                try:
                    # The code must pick the same rows, or the questions offer none.
                    import polars as pl

                    native = nw.to_native(df)
                    got = native.select(eval(mask_code, {"pl": pl}).alias(place)).to_series().fill_null(False)
                    same = len(got) == height and bool((got == nw.to_native(mask)).all())
                except Exception:
                    same = False
                if not same:
                    mask_code = None

        if by_place:
            numbers_shown = list(dict.fromkeys(str(int(pick[0].replace("_", ""))) if pick[0].replace("_", "").isdigit() else pick[0] for pick in picks))
            shortened = numbers_shown if len(numbers_shown) <= 4 else numbers_shown[:3] + [f"{len(numbers_shown) - 3} more"]
            where = f"row {numbers_shown[0]}" if len(numbers_shown) == 1 else f"rows {listed(shortened)}"
        elif single:
            texts = [shown(text) for text in dict.fromkeys(pick[0] for pick in picks)]
            shortened = texts if len(texts) <= 4 else texts[:3] + [f"{len(texts) - 3} more"]
            where = f"{keys[0]} = {texts[0]}" if len(texts) == 1 else f"{keys[0]} in {listed(shortened)}"
        elif len(picks) == 1:
            where = " and ".join(f"{keys[level]} = {shown(text)}" for level, text in enumerate(picks[0]))
        else:
            depth = max(len(pick) for pick in picks)
            where = f"{len(picks)} labels of {listed(keys[:depth])}"

        count = int(mask.sum())
        others = height - count
        result = {
            "rows": count,
            "total_rows": height,
            "where": where,
            "mask": mask_code,
            "positions": by_place,
            "library": "polars" if polars else str(df.implementation),
        }
        if unit and unit in schema:
            result["unit"] = unit
            result["units"] = int(df.get_column(unit).filter(mask).drop_nulls().n_unique())
        differences = []
        skip = set(keys) | ({unit} if unit else set())
        numbers = [column for column, dtype in schema.items() if dtype.is_numeric() and column not in skip]
        if count and others:
            inside, outside = df.filter(mask), df.filter(~mask)
            if numbers:
                # A NaN counts as missing, as pandas counts it.
                cleaned = [nw.col(column).fill_nan(None) if schema[column].is_float() else nw.col(column) for column in numbers]
                means_in = inside.select([expression.mean() for expression in cleaned]).row(0)
                means_out = outside.select([expression.mean() for expression in cleaned]).row(0)
                spreads = df.select([expression.std() for expression in cleaned]).row(0)
                gaps = []
                for column, here, there, spread in zip(numbers, means_in, means_out, spreads):
                    try:
                        here, there, spread = float(here), float(there), float(spread)
                        gap = (here - there) / spread
                    except (TypeError, ValueError, ZeroDivisionError):
                        continue
                    if math.isfinite(gap):
                        gaps.append((column, here, there, gap))
                gaps.sort(key=lambda entry: abs(entry[3]), reverse=True)
                for column, here, there, gap in gaps[:2]:
                    if abs(gap) < 0.5:
                        break
                    differences.append(
                        {"column": str(column), "kind": "number", "inside": float(here), "outside": float(there), "gap": round(float(gap), 2)}
                    )
            levelled = []
            for column in [c for c in df.columns if c not in skip and c not in numbers][:300]:
                try:
                    distinct = df.get_column(column).drop_nulls().n_unique()
                    if distinct > 20 or distinct < 2:
                        continue
                    # A missing value and an empty text get a name of their own.
                    if isinstance(schema[column], nw.Datetime):
                        text = nw.col(column).dt.to_string("%Y-%m-%d %H:%M:%S")
                    else:
                        text = nw.col(column).cast(nw.String).str.strip_chars()
                    label = nw.when(text == "").then(nw.lit("empty")).otherwise(text).fill_null("missing").alias(place)
                    shares = []
                    for part in (inside, outside):
                        counted = part.select(label).get_column(place).value_counts(normalize=True, name="share")
                        shares.append(dict(zip(counted.get_column(place).to_list(), counted.get_column("share").to_list())))
                except Exception:
                    continue
                here, there = shares
                gap = {level: here.get(level, 0.0) - there.get(level, 0.0) for level in sorted(set(here) | set(there), key=str)}
                if not gap:
                    continue
                highest = max(gap, key=gap.get)
                lowest = min(gap, key=gap.get)
                # The level these rows have more of, else the one they lack.
                level = highest if gap[highest] >= abs(gap[lowest]) else lowest
                if abs(gap[level]) >= 0.2:
                    levelled.append(
                        {
                            "column": str(column),
                            "kind": "level",
                            "level": str(level),
                            "inside": float(here.get(level, 0.0)),
                            "outside": float(there.get(level, 0.0)),
                            "gap": round(float(gap[level]), 2),
                        }
                    )
            levelled.sort(key=lambda entry: abs(entry["gap"]), reverse=True)
            differences = (differences + levelled)[:3]
        result["differences"] = differences

        def number(value):
            return f"{value:,.0f}" if abs(value) >= 1000 else f"{value:.3g}"

        def said(entry):
            column, inside, outside = entry["column"], entry["inside"], entry["outside"]
            if entry["kind"] == "number":
                if count == 1:
                    return f"{column} {number(inside)} against a mean of {number(outside)}"
                return f"mean {column} {number(inside)} against {number(outside)}"
            if count == 1:
                return f"{column} {entry['level']}, as in {outside:.0%} of the others"
            return f"{column} {entry['level']} in {inside:.0%} against {outside:.0%}"

        if count == 0:
            result["seen"] = f"{name} has no {where}." if by_place else f"No row of {name} has {where}."
        elif others == 0:
            result["seen"] = f"These are all the rows of {name}."
        elif differences:
            result["seen"] = f"Compared with the other {others:,} rows: {'; '.join(said(entry) for entry in differences)}."
        else:
            result["seen"] = f"No column of {name} differs much between these {count:,} rows and the other {others:,}."
        done(result)

    try:
        import pandas as pd
    except ImportError:
        pd = None
    if pd is None or args.get("positions") or type(frame).__module__.split(".")[0] == "polars":
        by_place_or_value()
        return
    import numpy as np

    if not isinstance(frame, pd.DataFrame):
        try:
            import narwhals as nw

            frame = nw.from_native(frame, eager_only=True).to_pandas()
        except Exception:
            done({"error": f"{name} is not a data frame"})
            return
    keys = args.get("keys") or []
    picks = [[str(label) for label in pick] for pick in args.get("labels") or [] if pick]
    unit = args.get("unit")
    absent = [key for key in keys if key not in frame.columns]
    if absent:
        done({"error": f"{name} has no column {absent[0]}"})
        return
    if keys:
        levels = [(key, pd.Index(frame[key]), f"{name}[{key!r}]") for key in keys]
    else:
        index = frame.index
        levels = [
            (
                index.names[i],
                index.get_level_values(i),
                f"{name}.index" if index.nlevels == 1 else f"{name}.index.get_level_values({i})",
            )
            for i in range(index.nlevels)
        ]
    if not picks or max(len(pick) for pick in picks) > len(levels):
        done({"error": f"the labels do not fit the rows of {name}"})
        return

    missing_text = {"NaN", "nan", "None", "NaT", "<NA>"}
    as_text = {}

    def matches(position, text):
        """Which rows have a value at this level that a table writes as this text."""
        values = levels[position][1]
        if text in missing_text:
            return np.asarray(values.isna())
        dtype = values.dtype
        try:
            if pd.api.types.is_bool_dtype(dtype):
                if text not in ("True", "False"):
                    return np.zeros(len(values), dtype=bool)
                return np.asarray(values == (text == "True"))
            if pd.api.types.is_integer_dtype(dtype):
                return np.asarray(values == int(text))
            if pd.api.types.is_float_dtype(dtype):
                # A table writes six decimals: 1/3 is 0.333333.
                return np.isclose(values.to_numpy(dtype=float), float(text), rtol=5e-6, atol=0)
            if pd.api.types.is_datetime64_any_dtype(dtype):
                moment = pd.Timestamp(text)
                zone = getattr(dtype, "tz", None)
                if zone is not None and moment.tz is None:
                    moment = moment.tz_localize(zone)
                return np.asarray(values == moment)
        except (ValueError, TypeError, OverflowError):
            return np.zeros(len(values), dtype=bool)
        if position not in as_text:
            as_text[position] = np.asarray(values.astype(str).str.strip())
        return as_text[position] == text

    def literal(value):
        """The value as Python code, or None when a literal cannot write it."""
        if isinstance(value, (bool, np.bool_)):
            return repr(bool(value))
        if isinstance(value, (int, np.integer)):
            return repr(int(value))
        if isinstance(value, (float, np.floating)):
            return None if math.isnan(value) else repr(float(value))
        if isinstance(value, str):
            return repr(value)
        if isinstance(value, pd.Timestamp) and value.tz is None:
            return f"pd.Timestamp({str(value)!r})"
        return None

    def condition(position, texts, rows):
        """Code for the rows whose value at this level is one of these texts."""
        values, code = levels[position][1], levels[position][2]
        missing = any(text in missing_text for text in texts)
        found = [value for value in pd.unique(values[rows]) if not pd.isna(value)]
        written = [literal(value) for value in found]
        if found and all(written):
            test = f"{code} == {written[0]}" if len(written) == 1 else f"{code}.isin([{', '.join(written)}])"
        else:
            shown = [text for text in texts if text not in missing_text]
            test = f"{code}.astype(str).isin({shown!r})" if shown else None
        if missing:
            test = f"{code}.isna()" if test is None else f"({test}) | {code}.isna()"
        return test or "False"

    # A pick has a label for each level, down to the level clicked: ["A"] for
    # the outer label of a group, ["A", "3"] for one row under it.
    picked = []
    for pick in picks:
        rows = np.ones(len(frame), dtype=bool)
        for position, text in enumerate(pick):
            rows &= matches(position, text)
        picked.append(rows)
    mask = np.logical_or.reduce(picked)
    single = all(len(pick) == 1 for pick in picks)
    if single:
        texts = list(dict.fromkeys(pick[0] for pick in picks))
        mask_code = condition(0, texts, mask)
    else:
        tests = []
        for pick, rows in zip(picks, picked):
            parts = [condition(position, [text], rows) for position, text in enumerate(pick)]
            tests.append(" & ".join(f"({part})" for part in parts) if len(parts) > 1 else parts[0])
        mask_code = " | ".join(f"({test})" for test in tests) if len(tests) > 1 else tests[0]
    try:
        # The code must pick the same rows, or the questions offer none.
        same = np.array_equal(np.asarray(eval(mask_code, {**namespace, "pd": pd}), dtype=bool), mask)
    except Exception:
        same = False
    if not same:
        mask_code = None

    def level_name(position):
        return str(levels[position][0]) if levels[position][0] is not None else "index"

    def listed(texts):
        return texts[0] if len(texts) == 1 else f"{', '.join(texts[:-1])} and {texts[-1]}"

    if single:
        texts = list(dict.fromkeys(pick[0] for pick in picks))
        shown = texts if len(texts) <= 4 else texts[:3] + [f"{len(texts) - 3} more"]
        where = f"{level_name(0)} = {texts[0]}" if len(texts) == 1 else f"{level_name(0)} in {listed(shown)}"
    elif len(picks) == 1:
        where = " and ".join(f"{level_name(position)} = {text}" for position, text in enumerate(picks[0]))
    else:
        depth = max(len(pick) for pick in picks)
        where = f"{len(picks)} labels of {listed([level_name(position) for position in range(depth)])}"

    count, total = int(mask.sum()), len(frame)
    others = total - count
    result = {"rows": count, "total_rows": total, "where": where, "mask": mask_code}
    if unit and unit in frame.columns:
        result["unit"] = unit
        result["units"] = int(frame.loc[mask, unit].nunique())
    differences = []
    if count and others:
        skip = set(keys) | ({unit} if unit else set())
        numbers = frame.select_dtypes("number")
        numbers = numbers[[column for column in numbers.columns if column not in skip]]
        if numbers.shape[1]:
            inside, outside = numbers[mask].mean(), numbers[~mask].mean()
            gaps = ((inside - outside) / numbers.std()).replace([np.inf, -np.inf], np.nan).dropna()
            for column in gaps.abs().sort_values(ascending=False).index[:2]:
                if abs(gaps[column]) < 0.5:
                    break
                differences.append(
                    {
                        "column": str(column),
                        "kind": "number",
                        "inside": float(inside[column]),
                        "outside": float(outside[column]),
                        "gap": round(float(gaps[column]), 2),
                    }
                )
        levelled = []
        for column in [c for c in frame.columns if c not in skip and c not in numbers.columns][:300]:
            series = frame[column]
            try:
                distinct = series.nunique()
                if distinct > 20 or distinct < 2:
                    continue
                # A missing value and an empty text get a name of their own.
                text = series.astype(str).str.strip()
                text = text.mask(series.isna(), "missing").mask(text == "", "empty")
                here = text[mask].value_counts(normalize=True)
                there = text[~mask].value_counts(normalize=True)
            except TypeError:
                continue
            gap = here.sub(there, fill_value=0)
            # The level these rows have more of, else the one they lack.
            level = gap.idxmax() if gap.max() >= abs(gap.min()) else gap.idxmin()
            if abs(gap[level]) >= 0.2:
                levelled.append(
                    {
                        "column": str(column),
                        "kind": "level",
                        "level": str(level),
                        "inside": float(here.get(level, 0.0)),
                        "outside": float(there.get(level, 0.0)),
                        "gap": round(float(gap[level]), 2),
                    }
                )
        levelled.sort(key=lambda entry: abs(entry["gap"]), reverse=True)
        differences = (differences + levelled)[:3]
    result["differences"] = differences

    def number(value):
        return f"{value:,.0f}" if abs(value) >= 1000 else f"{value:.3g}"

    def said(entry):
        column, inside, outside = entry["column"], entry["inside"], entry["outside"]
        if entry["kind"] == "number":
            if count == 1:
                return f"{column} {number(inside)} against a mean of {number(outside)}"
            return f"mean {column} {number(inside)} against {number(outside)}"
        if count == 1:
            return f"{column} {entry['level']}, as in {outside:.0%} of the others"
        return f"{column} {entry['level']} in {inside:.0%} against {outside:.0%}"

    if count == 0:
        result["seen"] = f"No row of {name} has {where}."
    elif others == 0:
        result["seen"] = f"These are all the rows of {name}."
    elif differences:
        result["seen"] = f"Compared with the other {others:,} rows: {'; '.join(said(entry) for entry in differences)}."
    else:
        result["seen"] = f"No column of {name} differs much between these {count:,} rows and the other {others:,}."
    done(result)
