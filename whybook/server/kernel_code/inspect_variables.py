"""List the user's variables with what the Variables and Contents sections show.

The frontend bundle holds the text of this file (scripts/embed-kernel-code.mjs)
and runs it in the kernel, preferably in a subshell, so it must not import the
whybook package. It uses narwhals for data frames and series, and skips them
when narwhals is not installed. The result goes out as display data with a
MIME type that output areas do not render.

``args["known"]`` maps variable names to the fingerprint the frontend already
holds. A frame whose fingerprint has not changed is sent as a stub, which keeps
a 4 812-column panel from being summarised again after every cell.
"""


def _whybook_inspect_variables(args):
    import importlib.metadata
    import importlib.util
    import math
    import os
    import re
    import sys
    import types

    from IPython import get_ipython
    from IPython.display import display

    try:
        import narwhals as nw
    except ImportError:
        nw = None

    known = args.get("known") or {}
    max_columns = args.get("max_columns", 20000)
    # Above this many values, distinct counts and ranges are skipped.
    detail_limit = args.get("detail_limit", 20_000_000)

    skipped_types = (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, types.MethodType, type)
    packages_to_report = (
        ("pandas", "pandas"),
        ("polars", "polars"),
        ("pyarrow", "pyarrow"),
        ("narwhals", "narwhals"),
        ("numpy", "numpy"),
        ("scipy", "scipy"),
        ("statsmodels", "statsmodels"),
        ("sklearn", "scikit-learn"),
        ("pingouin", "pingouin"),
        ("matplotlib", "matplotlib"),
        ("seaborn", "seaborn"),
        ("altair", "altair"),
        ("plotly", "plotly"),
        ("whybook", "whybook"),
    )
    cwd = os.path.realpath(os.getcwd())

    # A key, a token or a password in a variable is listed with its length and
    # "secret": true, never its text: the view keeps the listing in the
    # notebook and sends it with every request to a model. The server, this
    # file, analyze_cells.py and the view hold the same rule (privacy.py says
    # it in full, tests/data/secret_names.json holds its cases): only a string
    # is a secret, when a part of its name says so, as the "token" of HF_TOKEN,
    # or its text holds a known prefix of a key or a long run of letters and digits.
    secret_words = {"token", "secret", "secrets", "password", "passwords", "passwd", "pwd", "credential", "credentials", "bearer", "apikey", "auth"}
    secret_endings = ("token", "secret", "password", "passwd", "apikey")
    secret_pairs = {("api", "key"), ("access", "key"), ("private", "key"), ("secret", "key")}
    secret_prefix = re.compile(
        r"(?<![A-Za-z0-9])(?:sk-|sk_live_|sk_test_|hf_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abpr]-|xapp-"
        r"|AKIA|ASIA|AIza|ya29\.|eyJ|npm_|pypi-)[A-Za-z0-9_.=-]{16,}"
    )
    name_parts = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+")
    long_run = re.compile(r"[A-Za-z0-9]{20,}")
    # A password in a URL, as a connection string holds it, and a query parameter named as a secret.
    url_password = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://[^\s/?#@:]*:[^\s/?#@]+@")
    query_name = re.compile(r"[?&]([A-Za-z0-9_.-]+)=[^&#\s]")

    def secret_name(name):
        parts = [part.lower() for part in name_parts.findall(name)]
        if any(part in secret_words or part.endswith(secret_endings) for part in parts):
            return True
        return any(pair in secret_pairs for pair in zip(parts, parts[1:]))

    def secret_string(name, text):
        if secret_name(name):
            return True
        # The text of a string of up to 10,000 characters: a longer one is listed by its length alone.
        if len(text) > 10_000:
            return False
        if secret_prefix.search(text) or url_password.search(text):
            return True
        if any(secret_name(key) for key in query_name.findall(text)):
            return True
        return any(
            len(run) >= 32 or (re.search("[A-Z]", run) and re.search("[a-z]", run) and re.search("[0-9]", run))
            for run in long_run.findall(text)
        )

    def type_name(value):
        cls = type(value)
        return f"{cls.__module__}.{cls.__qualname__}"

    def clean(value):
        if value is None:
            return None
        if isinstance(value, bool):
            return value
        if isinstance(value, int):
            return value
        try:
            as_float = float(value)
        except (TypeError, ValueError):
            return str(value)
        if math.isnan(as_float):
            return None
        # Six significant figures: a fixed number of decimals made 1e-7 and 4e-5 read 0.
        # The view formats a number for display (src/model/numbers.ts).
        short = float(f"{as_float:.6g}")
        return int(short) if short.is_integer() and abs(short) < 2**53 else short

    def is_ordered(series):
        # A pandas categorical marked ordered, and a polars Enum.
        try:
            return bool(nw.is_ordered_categorical(series))
        except Exception:
            return False

    def column_tag(label, dtype, n_unique, rows, ordered):
        lowered = str(label).lower()
        if isinstance(dtype, nw.Boolean):
            return "bool"
        if lowered == "id" or lowered.endswith("_id"):
            return "id"
        if dtype.is_integer():
            return "int"
        if dtype.is_numeric():
            return "num"
        if dtype.is_temporal():
            return "date"
        if isinstance(dtype, (nw.String, nw.Categorical, nw.Enum)):
            if ordered:
                return "ord"
            if n_unique is not None and rows and n_unique > 50 and n_unique > 0.5 * rows:
                return "text"
            return "cat"
        return "other"

    def column_kind(tag, n_unique):
        if tag == "bool" or (n_unique == 2 and tag in ("int", "num", "cat", "ord")):
            return "binary"
        return {
            "int": "numeric",
            "num": "numeric",
            "date": "datetime",
            "cat": "categorical",
            "ord": "categorical",
            "id": "id",
            "text": "text",
        }.get(tag, "other")

    def column_entry(label, dtype, stats):
        """One column of the Contents list, from precomputed statistics."""
        entry = {"label": str(label), "dtype": str(dtype), "missing": stats.get("missing", 0)}
        n_unique = stats.get("unique")
        tag = column_tag(label, dtype, n_unique, stats.get("rows"), stats.get("ordered", False))
        entry["tag"] = tag
        entry["kind"] = column_kind(tag, n_unique)
        if n_unique is not None:
            entry["unique"] = n_unique
        for key in ("min", "max", "levels"):
            if stats.get(key) is not None:
                entry[key] = stats[key]
        if entry["tag"] not in ("int", "num", "date"):
            entry.pop("min", None)
            entry.pop("max", None)
        return entry

    def describe_series(label, series, detailed):
        rows = len(series)
        stats = {"rows": rows, "missing": int(series.null_count()), "ordered": is_ordered(series)}
        if detailed:
            try:
                # n_unique counts a missing value as one more level.
                stats["unique"] = int(series.n_unique()) - (1 if stats["missing"] else 0)
            except Exception:  # unhashable values, such as lists
                pass
            try:
                if series.dtype.is_numeric() or series.dtype.is_temporal():
                    stats["min"], stats["max"] = clean(series.min()), clean(series.max())
            except Exception:
                pass
            if stats.get("unique") is not None and stats["unique"] <= 6:
                stats["levels"] = levels_of(nw.to_native(series), series)
        return column_entry(label, series.dtype, stats)

    def levels_of(native, series):
        try:
            categories = getattr(getattr(native, "cat", None), "categories", None)
            if categories is not None:
                return [str(v) for v in list(categories)][:6]
            return [str(v) for v in sorted(series.drop_nulls().unique().to_list(), key=str)][:6]
        except Exception:
            return None

    def pandas_stats(native, labels, detailed):
        """Column statistics for a pandas frame, with one vectorised call per statistic.

        narwhals builds one expression per column, which takes seconds on a
        frame with thousands of columns.
        """
        import numpy as np
        import pandas as pd

        frame = native[labels]
        rows = len(frame)
        missing = frame.isna().sum()
        stats = {label: {"rows": rows, "missing": int(missing[label])} for label in labels}
        dtypes = frame.dtypes
        for label in labels:
            stats[label]["ordered"] = bool(getattr(dtypes[label], "ordered", False))
        if not detailed:
            return stats
        numeric = [
            label for label in labels
            if pd.api.types.is_numeric_dtype(dtypes[label]) and not pd.api.types.is_bool_dtype(dtypes[label])
        ]
        if numeric:
            values = frame[numeric].to_numpy(dtype=float, na_value=np.nan)
            ordered_values = np.sort(values, axis=0)
            valid = ~np.isnan(ordered_values)
            changes = (np.diff(ordered_values, axis=0) != 0) & valid[1:]
            distinct = changes.sum(axis=0) + valid.any(axis=0)
            with np.errstate(all="ignore"):
                lows = np.nanmin(np.where(valid.any(axis=0), values, 0), axis=0) if rows else []
                highs = np.nanmax(np.where(valid.any(axis=0), values, 0), axis=0) if rows else []
            for index, label in enumerate(numeric):
                stats[label]["unique"] = int(distinct[index])
                if valid[:, index].any():
                    stats[label]["min"] = clean(lows[index])
                    stats[label]["max"] = clean(highs[index])
        for label in labels:
            if label in numeric:
                continue
            series = frame[label]
            try:
                stats[label]["unique"] = int(series.nunique(dropna=True))
            except TypeError:  # unhashable values, such as lists
                continue
            if pd.api.types.is_datetime64_any_dtype(series):
                stats[label]["min"], stats[label]["max"] = clean(series.min()), clean(series.max())
            if stats[label]["unique"] <= 6:
                categories = getattr(getattr(series, "cat", None), "categories", None)
                values = list(categories) if categories is not None else sorted(series.dropna().unique().tolist(), key=str)
                stats[label]["levels"] = [str(v) for v in values][:6]
        return stats

    def narwhals_stats(frame, labels, detailed):
        stats = {}
        for label in labels:
            series = frame.get_column(label)
            entry = {"rows": len(series), "missing": int(series.null_count()), "ordered": is_ordered(series)}
            if detailed:
                try:
                    entry["unique"] = int(series.n_unique()) - (1 if entry["missing"] else 0)
                except Exception:
                    pass
                try:
                    if series.dtype.is_numeric() or series.dtype.is_temporal():
                        entry["min"], entry["max"] = clean(series.min()), clean(series.max())
                except Exception:
                    pass
                if entry.get("unique") is not None and entry["unique"] <= 6:
                    entry["levels"] = levels_of(nw.to_native(series), series)
            stats[label] = entry
        return stats

    def frame_metadata(value, columns):
        attrs = getattr(value, "attrs", None)
        meta = attrs.get("whybook") if isinstance(attrs, dict) else None
        if not isinstance(meta, dict):
            return None, None, None
        present = set(map(str, columns))
        groups = []
        for label, names in (meta.get("groups") or {}).items():
            kept = [str(n) for n in names if str(n) in present]
            if kept:
                groups.append({"label": str(label), "columns": kept})
        selection = meta.get("selection")
        return groups or None, meta.get("grouped_by"), selection if isinstance(selection, dict) else None

    def missing_counts(value, frame):
        """The missing values of each column, as bytes, over at most 16 million cells at a time."""
        if hasattr(value, "isna") and hasattr(value, "iloc"):
            rows, width = value.shape
            step = max(1, 16_000_000 // max(rows, 1))
            if width <= step:
                return value.isna().to_numpy().sum(axis=0).tobytes()
            return b"".join(value.iloc[:, start : start + step].isna().to_numpy().sum(axis=0).tobytes() for start in range(0, width, step))
        return repr(frame.null_count().row(0)).encode()

    def fingerprint(value, frame, shape):
        """The frame's id, shape, column names, column types and missing counts.

        A column filled or recoded in place leaves the id, the shape and the
        names as they were: its missing count or its type tells the change.
        On 29 September 2026 the fingerprint of the later demo's olink, 318
        rows and 4,813 columns, took 6 ms, where the names alone took 3 ms,
        and that of the home energy readings, 129,058 rows, 5 ms.
        """
        parts = [str(id(value)), str(shape)]
        columns = getattr(value, "columns", None)
        try:
            parts.append(str(hash(tuple(map(str, columns))) if columns is not None else 0))
        except Exception:
            parts.append("0")
        try:
            # The dtype objects themselves: a str() of each takes 84 ms on olink.
            parts.append(str(hash(tuple(value.dtypes))))
        except Exception:
            try:
                parts.append(str(hash(tuple(map(str, frame.schema.values())))))
            except Exception:
                parts.append("0")
        try:
            parts.append(str(hash(missing_counts(value, frame))))
        except Exception:
            parts.append("0")
        return ":".join(parts)

    def describe_frame(name, frame, value):
        rows, n_columns = frame.shape
        labels = list(frame.columns)[:max_columns]
        detailed = rows * len(labels) <= detail_limit
        native = nw.to_native(frame)
        try:
            import pandas as pd

            is_pandas = isinstance(native, pd.DataFrame)
        except ImportError:
            is_pandas = False
        stats = pandas_stats(native, labels, detailed) if is_pandas else narwhals_stats(frame, labels, detailed)
        schema = frame.schema
        columns = []
        for label in labels:
            try:
                columns.append(column_entry(label, schema[label], stats[label]))
            except Exception as error:
                columns.append({"label": str(label), "tag": "other", "kind": "other", "error": repr(error)})
        groups, grouped_by, selection = frame_metadata(value, labels)
        entry = {
            "name": name,
            "label": name,
            "kind": "dataframe",
            "type": type_name(value),
            "rows": rows,
            "n_columns": n_columns,
            "columns": columns,
        }
        if groups:
            entry["groups"] = groups
            entry["grouped_by"] = grouped_by
        if selection:
            entry["selection"] = selection
        return entry

    def describe_model(name, value):
        entry = {"name": name, "label": name, "kind": "model", "type": type_name(value)}
        model = getattr(value, "model", None)
        entry["model_class"] = type(model).__name__ if model is not None else None
        formula = getattr(model, "formula", None)
        if isinstance(formula, str):
            entry["formula"] = formula
        try:
            entry["nobs"] = int(getattr(value, "nobs"))
        except Exception:
            pass
        converged = getattr(value, "converged", None)
        if isinstance(converged, bool):
            entry["converged"] = converged
        try:
            params = value.params
            ci = value.conf_int()
            pvalues = getattr(value, "pvalues", None)
            terms = []
            for term in list(params.index)[:40]:
                row = {"term": str(term), "coef": clean(params[term])}
                try:
                    row["lo"] = clean(ci.loc[term].iloc[0])
                    row["hi"] = clean(ci.loc[term].iloc[1])
                except Exception:
                    pass
                if pvalues is not None:
                    try:
                        row["p"] = clean(pvalues[term])
                    except Exception:
                        pass
                terms.append(row)
            entry["terms"] = terms
        except Exception as error:
            entry["error"] = repr(error)
        return entry

    user_modules = []
    for module in list(sys.modules.values()):
        path = getattr(module, "__file__", None)
        if not path or "site-packages" in path:
            continue
        path = os.path.realpath(path)
        if path.startswith(cwd + os.sep) and path.endswith(".py"):
            user_modules.append((module, path))

    def constant_source(name, value):
        for module, path in user_modules:
            namespace = vars(module)
            if name in namespace and type(namespace[name]) is type(value) and namespace[name] == value:
                line = None
                try:
                    with open(path, encoding="utf-8") as handle:
                        for number, text in enumerate(handle, start=1):
                            if re.match(rf"\s*{re.escape(name)}\s*(:[^=]*)?=", text):
                                line = number
                                break
                except OSError:
                    pass
                return {"file": os.path.relpath(path, cwd), "line": line, "module": module.__name__}
        return None

    def describe(name, value):
        type_ = type_name(value)
        shape = getattr(value, "shape", None)
        if nw is not None:
            try:
                wrapped = nw.from_native(value, eager_only=True, allow_series=True)
            except TypeError:
                wrapped = None
            if isinstance(wrapped, nw.DataFrame):
                print_ = fingerprint(value, wrapped, shape)
                if known.get(name) == print_:
                    return {"name": name, "unchanged": True, "fingerprint": print_}
                entry = describe_frame(name, wrapped, value)
                entry["fingerprint"] = print_
                return entry
            if isinstance(wrapped, nw.Series):
                entry = describe_series(name, wrapped, len(wrapped) <= detail_limit)
                entry.update({"name": name, "label": name, "type": type_, "rows": len(wrapped)})
                return entry
        if hasattr(value, "params") and hasattr(value, "conf_int"):
            return describe_model(name, value)
        if isinstance(value, str) and secret_string(name, value):
            return {"name": name, "label": name, "kind": "constant", "type": type_, "secret": True, "length": len(value)}
        if isinstance(value, str):
            is_scalar = len(value) <= 58
        else:
            is_scalar = isinstance(value, (bool, int, float, complex)) or shape == ()
        if is_scalar:
            text = repr(value)
            if len(text) <= 60:
                entry = {"name": name, "label": name, "kind": "constant", "type": type_, "value": text}
                source = constant_source(name, value)
                if source:
                    entry["defined_in"] = source
                return entry
        if isinstance(shape, tuple):
            return {
                "name": name,
                "label": name,
                "kind": "array",
                "type": type_,
                "shape": list(shape),
                "dtype": str(getattr(value, "dtype", "")),
            }
        entry = {"name": name, "label": name, "kind": "other", "type": type_}
        try:
            entry["length"] = len(value)
        except Exception:
            pass
        return entry

    shell = get_ipython()
    hidden = set(getattr(shell, "user_ns_hidden", {}))
    variables = []
    # list() takes a snapshot: the main shell may add names while a subshell runs this.
    for name, value in list(shell.user_ns.items()):
        if name.startswith("_") or name in hidden or isinstance(value, skipped_types):
            continue
        try:
            variables.append(describe(name, value))
        except Exception as error:
            variables.append({"name": name, "label": name, "kind": "other", "type": type_name(value), "error": repr(error)})

    packages = {}
    for module, distribution in packages_to_report:
        if module in sys.modules or importlib.util.find_spec(module) is not None:
            try:
                packages[module] = importlib.metadata.version(distribution)
            except importlib.metadata.PackageNotFoundError:
                packages[module] = None

    display(
        {
            "application/vnd.whybook.result+json": {
                "variables": variables,
                "packages": packages,
                "python": sys.version.split()[0],
                "cwd": cwd,
            }
        },
        raw=True,
    )
