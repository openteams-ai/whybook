"""Write data frames of the kernel to files that a notebook of another kernel reads.

An agent that answers a question in a second notebook (design iteration 1.69)
moves the data as files: the analyst's kernel writes the frames that the
cells to port read, into a folder beside the notebooks, and the second
notebook reads them. Parquet keeps each column's type; it needs pyarrow or
fastparquet here for a pandas frame, and a reader in the other kernel. CSV
needs neither. ``args["format"]`` is "parquet" when the other kernel reads
parquet; a frame that cannot go as parquet here goes as CSV.

A pandas frame whose index holds data, such as the keys of a groupby, keeps
it as columns; an index of the rows' places, as after a filter, stays out.
Columns under two levels of headers join their names with "_".

The result gives each file's path from the kernel's folder, its format, its
size and its columns, and whether a file of that name was there before.

The frontend bundle holds the text of this file and runs it in the kernel, so
it must not import the whybook package.
"""


def _whybook_write_frames(args):
    import os

    from IPython import get_ipython
    from IPython.display import display

    namespace = get_ipython().user_ns
    folder = str(args.get("folder") or "from_python")
    wanted = "parquet" if args.get("format") == "parquet" else "csv"
    files = []
    errors = []

    def columns_of(names, types):
        return [{"name": str(name), "type": str(kind)} for name, kind in list(zip(names, types))[:200]]

    def write_pandas(frame, name):
        import pandas as pd

        if isinstance(frame, pd.Series):
            frame = frame.to_frame(name=frame.name if frame.name is not None else name)
        # An index without a name and of whole numbers holds the rows' places,
        # as after a filter: it stays out. A named index, such as the keys of
        # a groupby, or one of labels, goes into columns.
        index = frame.index
        named = any(level is not None for level in index.names)
        if named or not pd.api.types.is_integer_dtype(index.dtype):
            frame = frame.reset_index()
        if isinstance(frame.columns, pd.MultiIndex):
            frame = frame.copy()
            frame.columns = ["_".join(str(part) for part in column if str(part)) for column in frame.columns]
        written = None
        if wanted == "parquet":
            path = os.path.join(folder, f"{name}.parquet")
            existed = os.path.exists(path)
            try:
                frame.to_parquet(path, index=False)
                written = ("parquet", path, existed)
            except Exception:  # noqa: BLE001  no engine here, or a column that parquet cannot hold: CSV then
                if not existed and os.path.exists(path):
                    os.remove(path)
        if written is None:
            path = os.path.join(folder, f"{name}.csv")
            existed = os.path.exists(path)
            frame.to_csv(path, index=False)
            written = ("csv", path, existed)
        format_, path, existed = written
        return format_, path, existed, int(frame.shape[0]), columns_of(frame.columns, frame.dtypes)

    def write_polars(frame, name):
        written = None
        if wanted == "parquet":
            path = os.path.join(folder, f"{name}.parquet")
            existed = os.path.exists(path)
            try:
                frame.write_parquet(path)
                written = ("parquet", path, existed)
            except Exception:  # noqa: BLE001  CSV then
                if not existed and os.path.exists(path):
                    os.remove(path)
        if written is None:
            path = os.path.join(folder, f"{name}.csv")
            existed = os.path.exists(path)
            frame.write_csv(path)
            written = ("csv", path, existed)
        format_, path, existed = written
        return format_, path, existed, int(frame.height), columns_of(frame.columns, frame.dtypes)

    for name in [str(item) for item in args.get("frames") or []]:
        if not name.isidentifier() or name not in namespace:
            errors.append({"frame": name, "error": f"no variable named {name}"})
            continue
        frame = namespace[name]
        library = type(frame).__module__.split(".")[0]
        try:
            os.makedirs(folder, exist_ok=True)
            if library == "pandas" and hasattr(frame, "to_csv"):
                found = write_pandas(frame, name)
            elif library == "polars" and hasattr(frame, "write_csv"):
                found = write_polars(frame, name)
            elif library == "polars" and hasattr(frame, "collect"):
                errors.append({"frame": name, "error": f"{name} is a lazy frame: collect it into a frame first"})
                continue
            else:
                errors.append({"frame": name, "error": f"{name} is not a data frame of pandas or polars"})
                continue
        except Exception as error:  # noqa: BLE001  the error goes to the agent
            errors.append({"frame": name, "error": f"{type(error).__name__}: {error}"[:300]})
            continue
        format_, path, existed, rows, columns = found
        files.append(
            {
                "frame": name,
                "path": path.replace(os.sep, "/"),
                "format": format_,
                "rows": rows,
                "columns": columns,
                "existed": existed,
            }
        )

    display({"application/vnd.whybook.result+json": {"folder": folder, "files": files, "errors": errors}}, raw=True)
