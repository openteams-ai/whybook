"""The rows behind a region of a whybook plot, and one line on what differs there.

The frontend bundle holds the text of this file and runs it in the kernel, so
it must not import the whybook package.
"""


def _whybook_region_summary(args):
    from IPython import get_ipython
    from IPython.display import display

    ns = get_ipython().user_ns
    frame = ns.get(args["frame"])
    if frame is None:
        display({"application/vnd.whybook.result+json": {"error": f"no variable named {args['frame']}"}}, raw=True)
        return
    if not hasattr(frame, "loc"):
        import narwhals as nw

        frame = nw.from_native(frame, eager_only=True).to_pandas()
    x, values = args["x"], args.get("values")
    y, by, unit = args.get("y"), args.get("by"), args.get("unit")

    def between(column, low, high):
        """The rows of a column from low to high, and the range in words.

        A plot sends a date as the milliseconds since 1970 of its time on the
        frame's clock (whybook/plots.py): a column of dates, or of Python
        dates, compares with those times in its own time zone.
        """
        import datetime

        import pandas as pd

        series = frame[column]
        if series.dtype == object:
            present = series.dropna()
            if len(present) and all(isinstance(item, datetime.date) for item in present.head(100)):
                series = pd.to_datetime(series)
        if pd.api.types.is_datetime64_any_dtype(series):
            low, high = (pd.Timestamp(round(bound), unit="ms") for bound in (low, high))
            words = [str(stamp.date()) if stamp == stamp.normalize() else str(stamp) for stamp in (low, high)]
            if series.dt.tz is not None:
                low, high = (
                    stamp.tz_localize(series.dt.tz, ambiguous=False, nonexistent="shift_forward") for stamp in (low, high)
                )
        else:
            words = [low, high]
        return (series >= low) & (series <= high), f"{words[0]} <= {column} <= {words[1]}"

    if values is not None:
        # Bars: a bar is a level of x, and its label is the level as text.
        wanted = [str(value) for value in values]
        mask = frame[x].astype(str).isin(wanted)
        where = f"{x} = {wanted[0]}" if len(wanted) == 1 else f"{x} in {', '.join(wanted[:-1])} and {wanted[-1]}"
    else:
        mask, where = between(x, args["x0"], args["x1"])
        if args.get("y0") is not None and y in frame.columns:
            # A box on a chart of another library also bounds y.
            inside_y, where_y = between(y, args["y0"], args["y1"])
            mask &= inside_y
            where += f" and {where_y}"
    inside, outside = frame[mask], frame[~mask]
    result = {"rows": int(len(inside)), "total_rows": int(len(frame)), "where": where}
    if unit and unit in frame.columns:
        result["unit"] = unit
        result["units"] = int(inside[unit].nunique())
    sentences = []
    groups = []
    if by and by in frame.columns and len(inside):
        for level, part in inside.groupby(by, observed=True):
            overall = float((frame[by] == level).mean())
            entry = {
                "name": str(level),
                "rows": int(len(part)),
                "share": round(len(part) / len(inside), 3),
                "share_overall": round(overall, 3),
            }
            if y and y in frame.columns:
                entry["mean"] = round(float(part[y].mean()), 3)
            groups.append(entry)
        if y and len(groups) >= 2 and "mean" in groups[0]:
            first, second = groups[0], groups[1]
            inside_gap = first["mean"] - second["mean"]
            outside_means = outside.groupby(by, observed=True)[y].mean()
            if first["name"] in outside_means.index.astype(str) and second["name"] in outside_means.index.astype(str):
                means = {str(k): float(v) for k, v in outside_means.items()}
                outside_gap = means[first["name"]] - means[second["name"]]
                if abs(inside_gap) > 1.5 * abs(outside_gap) and abs(inside_gap) > 0.2:
                    sentences.append(
                        f"The groups diverge here: {first['name']} minus {second['name']} is {inside_gap:+.2f}, against {outside_gap:+.2f} elsewhere."
                    )
                else:
                    sentences.append(f"{first['name']} minus {second['name']} is {inside_gap:+.2f} here and {outside_gap:+.2f} elsewhere.")
        for entry in groups:
            if entry["share_overall"]:
                change = entry["share"] / entry["share_overall"] - 1
                if change < -0.08:
                    sentences.append(f"{by} {entry['name']} has {abs(change):.0%} fewer rows here than overall.")
    if values is not None and y and y in frame.columns and len(inside) and len(outside) and not groups:
        try:
            here, elsewhere = float(inside[y].mean()), float(outside[y].mean())
        except (TypeError, ValueError):
            pass
        else:
            rest = outside[x].astype(str).unique()
            where_else = f"in {x} {rest[0]}" if len(rest) == 1 else "in the other bars"
            sentences.append(f"Mean {y} is {here:.3g} here and {elsewhere:.3g} {where_else}.")
    result["groups"] = groups
    found = f"have {where}" if values is not None else "fall in this range"
    result["seen"] = " ".join(sentences[:2]) or f"{len(inside)} of {len(frame)} rows {found}."
    display({"application/vnd.whybook.result+json": result}, raw=True)
