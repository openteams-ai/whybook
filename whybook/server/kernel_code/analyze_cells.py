"""Static analysis of notebook cells against the live kernel namespace.

For each cell: the names it defines and uses, the data frame columns it
touches, its decisions, and the sections of the user's own files it depends
on. A decision is a value that changes the result:

- ``defaulted``: a parameter of the user's own function left at its default,
  such as ``min_days=MIN_DAYS`` in ``prep.drop_sparse``;
- ``library_default``: a library parameter from a short list of defaults known
  to change results, such as ``reml=True`` in statsmodels' MixedLM.fit;
- ``literal``: a value written in the cell itself, such as ``n_boot=1000``.

A library default also names its ``library`` and that library's ``version``
when it is known, for the popover that says "default in pandas 3.0.6". A
keyword argument that keeps the books, such as ``drop=True`` of
``reset_index``, makes no ``literal`` decision (``bookkeeping`` below), and
neither does a call that picks the rows that the cell only shows, such as the
``head()`` that ends it (``showing_functions``).

Each decision of a call is keyed by that call: where the cell names the
function, its line and column. Calls that leave the same parameter at the
same value share one decision, which lists them in ``calls``, so a cell
that merges twice with the default ``how='inner'`` has one decision with two
calls. Each call also names, in one word, the frame that it joins or reads
(``target``), such as ``weather`` for ``.merge(weather, on="date")`` and
``homes`` for ``pd.read_csv("homes.csv")``. The line counts from 1 and the
column counts UTF-8 bytes from the start of the line, as ``ast`` does, and
``codegen.call_site`` on the server finds the call by the same place.

With ``signatures`` in the arguments (the view's setting "Find more defaults
with AI", design iteration 1.53), a cell also lists the library functions
that it calls, under ``signatures``: each function's module, its library and
the library's version, each parameter of its signature that has a default,
with the default as code, and each call with the parameters that it leaves at
their defaults. A default that holds data, such as a frame, says what it is
(``<DataFrame 3 × 2>``, ``"data": true``), and one that looks like a key is
left out. A marker that no code can write, such as pandas' ``<no_default>``,
gives way to the default that the function's documentation gives, ``','``
for the separator of ``read_csv``, and without one its parameter is left
out. Builtins, the notebook's own functions and those of the analyst's
modules are left out too, a cell lists at most ``max_signatures`` functions,
and what was read of each function stays on the shell for the kernel's
session. The analysis is the same with or without them.

The frontend bundle holds the text of this file and runs it in the kernel, so
it must not import the whybook package.
"""


def _whybook_analyze_cells(args):
    import ast
    import builtins
    import inspect
    import os
    import re
    import sys
    import textwrap

    from IPython import get_ipython
    from IPython.display import display

    shell = get_ipython()
    ns = shell.user_ns
    cwd = os.path.realpath(os.getcwd())
    max_decisions = args.get("max_decisions", 6)
    read_signatures = bool(args.get("signatures"))
    max_signatures = args.get("max_signatures", 8)
    # What was read of each function, by its qualified name, and each
    # library's version: kept on the shell for the kernel's session, as the
    # plot hooks keep their state.
    kept_signatures = getattr(shell, "_whybook_signatures", None)
    if kept_signatures is None:
        kept_signatures = shell._whybook_signatures = {"functions": {}, "versions": {}}

    # What a reader's default header does, for the readers below.
    first_row = "the first row names the columns: header=None reads it as data"
    # Library defaults that change results, keyed by the qualified function name.
    library_defaults = {
        "statsmodels.base.model.Model.from_formula": {
            "missing": ("'drop'", "rows with a missing value in any formula variable are dropped"),
        },
        "statsmodels.regression.mixed_linear_model.MixedLM.from_formula": {
            "re_formula": ("None", "random intercept only, no random slopes"),
        },
        "statsmodels.regression.mixed_linear_model.MixedLM.fit": {
            "reml": ("True", "REML fit: likelihoods cannot compare models with different fixed effects"),
        },
        "pandas.core.frame.DataFrame.merge": {
            "how": ("'inner'", "rows without a match in both frames are dropped"),
        },
        "pandas.core.reshape.merge.merge": {
            "how": ("'inner'", "rows without a match in both frames are dropped"),
        },
        # pandas 3 names pd.merge after its public module.
        "pandas.merge": {
            "how": ("'inner'", "rows without a match in both frames are dropped"),
        },
        "pandas.core.frame.DataFrame.dropna": {
            "how": ("'any'", "a row with any missing value is dropped"),
        },
        # pandas 3 names the readers after their public module, pandas 2 after the file that defines them.
        "pandas.io.parsers.readers.read_csv": {
            "header": ("'infer'", first_row),
        },
        "pandas.read_csv": {
            "header": ("'infer'", first_row),
        },
        "pandas.io.parsers.readers.read_table": {
            "header": ("'infer'", first_row),
        },
        "pandas.read_table": {
            "header": ("'infer'", first_row),
        },
        "pandas.io.excel._base.read_excel": {
            "header": ("0", first_row),
        },
        "pandas.read_excel": {
            "header": ("0", first_row),
        },
        "pandas.core.frame.DataFrame.corr": {
            "method": ("'pearson'", "linear correlation, sensitive to outliers"),
        },
        "pandas.core.series.Series.corr": {
            "method": ("'pearson'", "linear correlation, sensitive to outliers"),
        },
        "scipy.stats._stats_py.ttest_ind": {
            "equal_var": ("True", "Student's t test: assumes equal variances"),
        },
        "numpy.std": {"ddof": ("0", "population standard deviation, unlike pandas (ddof=1)")},
        "sklearn.linear_model._logistic.LogisticRegression.__init__": {
            "C": ("1.0", "L2 regularisation is on by default"),
        },
        "whybook.plots.ribbon": {"ci": ("'normal'", "t interval of the mean, with n - 1 degrees of freedom: assumes normal values at each x")},
    }
    # Keyword arguments that name data rather than choose how to analyse it,
    # and those that keep the books: inplace and copy say where the result
    # goes, and ignore_index numbers the rows again, in every function that has it.
    skipped_params = {
        "data", "x", "y", "by", "on", "columns", "column", "groups", "group", "index", "name", "labels",
        "title", "as_index", "observed", "sort", "disp", "verbose", "inplace", "copy", "axis", "left_on",
        "right_on", "id_vars", "value_vars", "var_name", "value_name", "subset", "keys", "path", "sep",
        "outcome", "random_state", "seed", "formula", "ignore_index",
    }
    # Parameters that keep the books in one function and mean more in another,
    # by the function's name (design iteration 1.86): reset_index(drop=True)
    # throws the old index away, where drop_duplicates keeps its `keep`. The
    # chip of such a value would tell the analyst nothing about a result.
    bookkeeping = {
        "reset_index": {"drop", "names"},
        "set_index": {"drop"},
    }
    # Calls whose arguments are not analysis choices.
    skipped_functions = {"progress", "print", "display", "range", "len", "enumerate", "zip", "format", "round"}
    # The parameters of a drawing function that shape the drawing and not a
    # result: the size of a figure, its labels, marks and colours. They make
    # no decision, so that they leave room for those that do (design
    # iteration 1.83). The view holds the same rule (withoutDrawing in
    # src/model/decisions.ts), for the analyses that notebooks kept before.
    drawing_params = {
        "figsize", "dpi", "xlabel", "ylabel", "zlabel", "label", "title", "suptitle", "t", "s", "marker",
        "markersize", "ms", "linestyle", "ls", "linewidth", "lw", "color", "c", "colors", "palette", "cmap",
        "alpha", "edgecolor", "facecolor", "fontsize", "loc", "ncol", "frameon", "rotation", "grid", "legend",
        "width", "height", "aspect", "size", "style", "theme", "bbox_inches",
    }
    drawing_functions = re.compile(
        r"(subplots|figure|plot|scatter|bar|barh|hist|boxplot|violinplot|errorbar|fill_between|axhline|axvline"
        r"|axline|step|stairs|stem|pie|imshow|text|annotate|legend|title|suptitle|savefig|xlabel|ylabel"
        r"|set_xlabel|set_ylabel|set_title|set|set_xlim|set_ylim|xlim|ylim|tight_layout|grid|lineplot"
        r"|scatterplot|barplot|histplot|kdeplot|regplot|lmplot|catplot|relplot|pointplot|stripplot|swarmplot"
        r"|heatmap|pairplot|jointplot|displot|countplot|ggplot|aes|labs|ggtitle|xlab|ylab|theme|geom_\w+)"
    )
    # The calls that pick the rows that a cell shows, or write a value out as
    # text to show it: the first rows of a frame, its last rows, a few rows
    # at random. When the cell only shows their value, their arguments change
    # what the analyst sees and nothing that a later cell reads, so they make
    # no decision, and their signatures go to no model: the 5 rows that
    # head() shows make no chip (design iteration 1.91). top = df.head(12)
    # keeps its chip.
    showing_functions = {"head", "tail", "sample", "show", "glimpse", "to_string", "to_markdown", "to_html", "round"}
    # The calls that show their arguments.
    display_functions = {"print", "display"}
    frame_methods = {
        "pipe", "merge", "assign", "query", "dropna", "fillna", "sort_values", "rename", "drop",
        "reset_index", "set_index", "copy", "astype", "join", "loc", "head", "tail", "sample",
    }
    # Calls that join one frame to another, named by the frame they join.
    joins = {"merge", "join", "merge_asof", "merge_ordered"}

    # A key, a token or a password is no choice to try, and its text would go
    # into the notebook with the analysis. The server, inspect_variables.py and
    # the view hold the same rule (privacy.py says it in full,
    # tests/data/secret_names.json holds its cases): only a string is a
    # secret, so max_tokens=512 keeps its chip.
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
        parts = [part.lower() for part in name_parts.findall(name or "")]
        if any(part in secret_words or part.endswith(secret_endings) for part in parts):
            return True
        return any(pair in secret_pairs for pair in zip(parts, parts[1:]))

    def looks_secret(name, value):
        """Whether a decision holds a secret, from its name and its value as written: repr of a string."""
        try:
            text = ast.literal_eval(value)
        except Exception:
            return False
        if not isinstance(text, str):
            return False
        if secret_name(name):
            return True
        if secret_prefix.search(text) or url_password.search(text):
            return True
        if any(secret_name(key) for key in query_name.findall(text)):
            return True
        return any(
            len(run) >= 32 or (re.search("[A-Z]", run) and re.search("[a-z]", run) and re.search("[0-9]", run))
            for run in long_run.findall(text)
        )

    frames = {}
    for name, value in list(ns.items()):
        columns = getattr(value, "columns", None)
        if name.startswith("_") or columns is None or not hasattr(value, "shape"):
            continue
        try:
            frames[name] = set(map(str, columns))
        except Exception:
            pass
    known_names = set(ns) | set(dir(builtins))

    def is_user_code(func):
        # whybook is the view's own helper library, even when the notebook sits next to it.
        module = getattr(inspect.getmodule(func), "__name__", None) or ""
        if module.split(".")[0] == "whybook":
            return None
        try:
            path = inspect.getsourcefile(func)
        except TypeError:
            return None
        if not path or "site-packages" in path:
            return None
        path = os.path.realpath(path)
        return path if path.startswith(cwd + os.sep) else None

    def qualified(func):
        target = getattr(func, "__func__", func)
        module = getattr(target, "__module__", None)
        name = getattr(target, "__qualname__", None)
        return f"{module}.{name}" if module and name else None

    # Where a module's name is not the name of the distribution that installs it.
    distributions = {"sklearn": "scikit-learn", "PIL": "pillow", "yaml": "PyYAML", "cv2": "opencv-python", "bs4": "beautifulsoup4"}
    stdlib = getattr(sys, "stdlib_module_names", frozenset())

    def version_of(library):
        """A library's version: Python's for the standard library, else its __version__, else its distribution's."""
        versions = kept_signatures["versions"]
        if library not in versions:
            version = getattr(sys.modules.get(library), "__version__", None)
            if library in stdlib:
                version = sys.version.split()[0]
            elif not isinstance(version, str):
                # importlib.metadata.packages_distributions() would tell every
                # name, and takes about a second.
                try:
                    import importlib.metadata

                    version = importlib.metadata.version(distributions.get(library, library))
                except Exception:
                    version = None
            versions[library] = version
        return versions[library]

    plain_types = (type(None), bool, int, float, complex, str)
    address = re.compile(r" at 0x[0-9A-Fa-f]+")
    # A default that no code can write, such as pandas' <no_default> or
    # numpy's <no value>: a marker that the parameter was not given, for
    # which the function uses a value of its own.
    marker = re.compile(r"<[^<>]*>")
    # The value of a default as numpydoc writes it, after "default": a
    # string in quotes, a number, True, False or None.
    doc_value = re.compile(r"""'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|True\b|False\b|None\b""")

    def documented(target, name):
        """The default that a function's documentation gives one of its parameters, as code; None when it gives none.

        numpydoc writes it after the type, "sep : str, default ','", and
        scikit-learn and SciPy as "default=1.0" and "default: 0". The value
        that a marker stands for is there: the separator of read_csv, whose
        signature holds <no_default>, is the comma of "default ','" (design
        iteration 1.91).
        """
        try:
            doc = inspect.getdoc(target) or ""
        except Exception:
            return None
        line = re.search(rf"^\s*{re.escape(name)}\s*:\s*(.+)$", doc, re.M)
        found = line and re.search(r"\bdefault\b\s*(?:[:=]\s*)?(.+)$", line.group(1))
        value = found and doc_value.match(found.group(1).strip())
        if not value:
            return None
        try:
            return repr(ast.literal_eval(value.group(0)))
        except (ValueError, SyntaxError):
            return None

    def default_of(name, value):
        """A default as code, and whether it holds data rather than code; None for a key, a token or a password.

        A frame or an array says its type and its shape, a long text or a
        large container its length: their values stay in the kernel.
        """
        kind = type(value).__name__
        try:
            if isinstance(value, plain_types) and not isinstance(value, str):
                return repr(value), False
            if isinstance(value, str):
                if looks_secret(name, repr(value)):
                    return None
                return (repr(value), False) if len(value) <= 60 else (f"<str of {len(value)} characters>", True)
            if isinstance(value, (tuple, list, set, frozenset, dict)):
                items = list(value.items()) if isinstance(value, dict) else list(value)
                flat = [part for item in items for part in (item if isinstance(value, dict) else (item,))]
                text = repr(value)
                if len(items) <= 8 and len(text) <= 80 and all(isinstance(part, plain_types) for part in flat):
                    return text, False
                return f"<{kind} of {len(items)} items>", True
            shape = getattr(value, "shape", None)
            if isinstance(shape, tuple) or hasattr(value, "columns") or hasattr(value, "__array__"):
                size = " × ".join(str(part) for part in shape) if isinstance(shape, tuple) else ""
                return (f"<{kind} {size}>" if size else f"<{kind}>"), True
            if inspect.isroutine(value) or inspect.isclass(value) or inspect.ismodule(value):
                module = getattr(value, "__module__", None)
                label = getattr(value, "__qualname__", None) or getattr(value, "__name__", None)
                if label:
                    return (f"{module}.{label}" if module and module != "builtins" else label), False
            text = address.sub("", repr(value))
            return (text, False) if len(text) <= 80 else (f"<{kind}>", True)
        except Exception:
            return f"<{kind}>", True

    def signature_of(func, signature):
        """What the signature of a library function holds, read once in the session; None for any other function.

        A builtin, a function that the notebook defines (``__main__``) and
        a module whose name starts with ``_`` are no library's.
        """
        key = qualified(func)
        if key is None:
            return None
        functions = kept_signatures["functions"]
        if key in functions:
            return functions[key]
        target = getattr(func, "__func__", func)
        module = getattr(target, "__module__", None) or ""
        library = module.split(".")[0]
        entry = None
        if library and library not in ("builtins", "__main__") and not library.startswith("_"):
            params = []
            for param in signature.parameters.values():
                if param.default is inspect.Parameter.empty or param.kind in (param.VAR_POSITIONAL, param.VAR_KEYWORD):
                    continue
                found = default_of(param.name, param.default)
                if found is not None and not found[1] and marker.fullmatch(found[0]):
                    # A marker is no value: the default that the documentation
                    # gives, or no parameter, so no chip says <no_default>.
                    text = documented(target, param.name)
                    found = (text, False) if text is not None else None
                if found is not None:
                    params.append({"name": param.name, "default": found[0], **({"data": True} if found[1] else {})})
            name = getattr(target, "__qualname__", key)
            entry = {
                "function": key,
                # A class by its own name, as the cell calls it: DataFrame, not DataFrame.__init__.
                "name": name[: -len(".__init__")] if name.endswith(".__init__") else name,
                "module": module,
                "library": library,
                "version": version_of(library),
                "params": params,
            }
        functions[key] = entry
        return entry

    def literal(node):
        """The source text of a literal argument, or None."""
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float, str, bool)):
            return node.value, repr(node.value)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub) and isinstance(node.operand, ast.Constant):
            if isinstance(node.operand.value, (int, float)):
                return -node.operand.value, repr(-node.operand.value)
        if isinstance(node, (ast.List, ast.Tuple)) and 0 < len(node.elts) <= 8:
            values = [literal(e) for e in node.elts]
            if all(v is not None and isinstance(v[0], (int, float)) for v in values):
                text = ast.unparse(node)
                return text, text
        return None

    def infer(node):
        """What an expression evaluates to, without running it.

        Returns ("value", object) for names and attributes found in the
        namespace, ("type", class) for calls whose result type is known, or None.
        """
        try:
            if isinstance(node, ast.Name):
                if node.id in ns:
                    return ("value", ns[node.id])
                if hasattr(builtins, node.id):
                    return ("value", getattr(builtins, node.id))
                return None
            if isinstance(node, ast.Attribute):
                base = infer(node.value)
                if base is None:
                    return None
                kind, obj = base
                if kind == "value":
                    return ("value", getattr(obj, node.attr))
                return ("method", (obj, getattr(obj, node.attr)))
            if isinstance(node, ast.Call):
                callee = infer(node.func)
                if callee is None:
                    return None
                kind, obj = callee
                if kind == "value" and getattr(obj, "__name__", "") == "from_formula" and isinstance(getattr(obj, "__self__", None), type):
                    return ("type", obj.__self__)
                owner = None
                name = ""
                if kind == "value" and hasattr(obj, "__self__"):
                    owner, name = type(obj.__self__), getattr(obj, "__name__", "")
                elif kind == "method":
                    owner, name = obj[0], getattr(obj[1], "__name__", "")
                if owner is not None and owner.__name__ == "DataFrame" and name in frame_methods:
                    return ("type", owner)
                if owner is not None and owner.__name__ == "DataFrame" and name == "groupby":
                    return None
            return None
        except Exception:
            return None

    def resolve_call(call):
        """The function a call runs, how many positional slots the receiver fills, and the call's arguments."""
        func_node = call.func
        positional = list(call.args)
        keywords = {kw.arg: kw.value for kw in call.keywords if kw.arg}
        # df.pipe(func, *args, **kwargs) runs func(df, *args, **kwargs).
        if isinstance(func_node, ast.Attribute) and func_node.attr == "pipe" and positional:
            target = infer(positional[0])
            if target and target[0] == "value" and callable(target[1]):
                return target[1], 1, positional[1:], keywords
            return None
        target = infer(func_node)
        if target is None:
            return None
        kind, obj = target
        if kind == "method":
            owner, func = obj
            return func, 1, positional, keywords
        if not callable(obj):
            return None
        if isinstance(obj, type):
            init = getattr(obj, "__init__", None)
            return init, 1, positional, keywords
        return obj, 0, positional, keywords

    def default_node(func, param):
        """The AST node of a parameter's default, from the function's source."""
        try:
            source = textwrap.dedent(inspect.getsource(func))
            tree = ast.parse(source)
        except Exception:
            return None
        definition = next((n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))), None)
        if definition is None:
            return None
        arguments = definition.args
        positional = arguments.posonlyargs + arguments.args
        defaults = dict(zip([a.arg for a in positional][-len(arguments.defaults):], arguments.defaults)) if arguments.defaults else {}
        for a, d in zip(arguments.kwonlyargs, arguments.kw_defaults):
            if d is not None:
                defaults[a.arg] = d
        return defaults.get(param)

    def line_of(path, name):
        try:
            with open(path, encoding="utf-8") as handle:
                for number, text in enumerate(handle, start=1):
                    if re.match(rf"\s*{re.escape(name)}\s*(:[^=]*)?=", text):
                        return number, text.rstrip("\n")
        except OSError:
            pass
        return None, None

    def attachment_for(func, path, highlight):
        try:
            lines, start = inspect.getsourcelines(func)
        except (OSError, TypeError):
            return None
        shown = [[start + i, text.rstrip("\n")] for i, text in enumerate(lines[:12])]
        if highlight and all(number != highlight[0] for number, _ in shown):
            shown = [highlight] + [[None, "…"]] + shown
        return {
            "file": os.path.relpath(path, cwd),
            "symbol": getattr(func, "__name__", "?"),
            "start": start,
            "end": start + len(lines) - 1,
            "lines": shown,
            "highlight": [highlight[0]] if highlight else [],
        }

    def building(tree):
        """The strings of assignments that make a frame without reading one.

        The keys of the dict given to pd.DataFrame name the frame's columns,
        and so does a list of columns to read from a file, but they build the
        frame and analyse nothing: they are not columns the cell uses.
        """
        found = set()
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assign):
                continue
            if not any(isinstance(target, ast.Name) and target.id in frames for target in node.targets):
                continue
            reads = {n.id for n in ast.walk(node.value) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
            if not reads & set(frames):
                found.update(id(n) for n in ast.walk(node.value) if isinstance(n, ast.Constant))
        return found

    def parse(source):
        """The cell's syntax tree, with the lines and columns of the cell as it is written.

        IPython's transform drops a cell's leading blank lines, which would
        move every line of a call, so the transform is only for a cell that
        is not plain Python, such as one with a magic.
        """
        try:
            return ast.parse(source)
        except SyntaxError:
            return ast.parse(shell.transform_cell(source))

    def name_site(node):
        """Where a name is written: for ``a.b``, where ``b`` starts."""
        if isinstance(node, ast.Attribute):
            return node.end_lineno, node.end_col_offset - len(node.attr.encode("utf-8"))
        return node.lineno, node.col_offset

    def call_site(call):
        """Where a call names its function: ``merge`` in ``.merge(...)``, ``f`` in ``.pipe(f)``.

        The call's own place does not tell two calls of a chain apart: each
        starts where the chain starts.
        """
        func = call.func
        if isinstance(func, ast.Attribute) and func.attr == "pipe" and call.args and isinstance(call.args[0], (ast.Name, ast.Attribute)):
            return name_site(call.args[0])
        return name_site(func)

    def shown_calls(tree):
        """The calls of showing_functions whose value the cell only shows, by their ids.

        A value is shown, or thrown away, when it is an expression statement,
        such as the cell's last line, or what print or display gets. The walk
        goes down a chain while its calls only show: in ``df.head(3).round(2)``
        both calls show, and in ``df.sort_values("x").head(3)`` the sort is
        a choice. A value that goes into a file, ``df.sample(9).to_csv(...)``,
        is no value that the cell shows.
        """
        found = set()

        def walk(node):
            while True:
                if isinstance(node, (ast.Attribute, ast.Subscript)):
                    node = node.value
                    continue
                if not isinstance(node, ast.Call):
                    return
                func = node.func
                name = func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else None
                if name in display_functions:
                    for argument in node.args:
                        walk(argument)
                    return
                if name not in showing_functions:
                    return
                found.add(id(node))
                if not isinstance(func, ast.Attribute):
                    return
                node = func.value

        for node in ast.walk(tree):
            if isinstance(node, ast.Expr):
                walk(node.value)
        return found

    def root(node):
        """The name an expression starts from: ``homes`` for ``homes[["home_id"]]`` or ``homes.drop(...)``."""
        while node is not None:
            if isinstance(node, ast.Name):
                return node.id
            if isinstance(node, (ast.Subscript, ast.Attribute)):
                node = node.value
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                node = node.func.value
            else:
                return None
        return None

    def target_of(call, function_name, bound, file_param):
        """The frame a call joins or reads, in one word, or None.

        A join names the frame it joins, a read the file it reads without its
        extension, and another call the first frame it reads: the start of the
        chain it is called on, else the first frame in its arguments.
        """
        if function_name in joins:
            other = bound.get("right", bound.get("other"))
            name = root(other)
            if name and (name in frames or name not in ns):
                return name
        if file_param:
            file = bound.get(file_param)
            if isinstance(file, ast.Constant) and isinstance(file.value, str):
                return os.path.splitext(os.path.basename(file.value))[0] or None
        if isinstance(call.func, ast.Attribute):
            name = root(call.func.value)
            if name in frames:
                return name
        for node in ast.walk(call):
            if isinstance(node, ast.Name) and node.id in frames:
                return node.id
        return None

    def analyze(source):
        tree = parse(source)
        defs, uses, strings = [], [], []
        formulas = []
        made = building(tree)
        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                (defs if isinstance(node.ctx, ast.Store) else uses).append(node.id)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                defs.append(node.name)
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                for alias in node.names:
                    defs.append((alias.asname or alias.name).split(".")[0])
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                if id(node) not in made:
                    strings.append(node.value)
                if "~" in node.value and len(node.value) < 300:
                    formulas.append(node.value)
        used_frames = [name for name in dict.fromkeys(uses) if name in frames]
        defined_frames = [name for name in dict.fromkeys(defs) if name in frames]
        touched = {}
        candidates = set()
        for text in strings:
            if "~" in text:
                candidates.update(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", text))
            else:
                candidates.add(text)
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in frames:
                candidates.add(node.attr)
        for frame in dict.fromkeys(used_frames + defined_frames):
            for column in sorted(candidates & frames[frame]):
                touched.setdefault(frame, []).append(column)

        decisions, attachments, seen = [], [], set()
        # The library functions that the cell calls, by qualified name, with their calls.
        signatures = {}
        shown = shown_calls(tree)

        def short(function):
            return (function or "").rsplit(".", 1)[-1]

        def add(entry, call=None):
            """Add a decision of a call, keyed by the call, or of an assignment, keyed by its name.

            A call that leaves the same parameter at the same value as an
            earlier call joins that call's decision: both merges of a cell
            that leave ``how='inner'`` make one decision with two calls.
            """
            key = (entry["name"], call and (call["line"], call["col"]))
            if key in seen or looks_secret(entry["name"], str(entry["value"])):
                return
            seen.add(key)
            if call is None:
                decisions.append(entry)
                return
            for other in decisions:
                if (
                    "calls" in other
                    and other["name"] == entry["name"]
                    and other["value"] == entry["value"]
                    and other["provenance"] == entry["provenance"]
                    and other.get("param") == entry.get("param")
                    and short(other.get("function")) == short(entry.get("function"))
                ):
                    other["calls"].append(dict(call))
                    return
            decisions.append({**entry, "calls": [dict(call)]})

        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            try:
                resolved = resolve_call(node)
            except Exception:
                resolved = None
            if resolved is None:
                continue
            func, receiver_slots, positional, keywords = resolved
            try:
                signature = inspect.signature(func)
            except (TypeError, ValueError):
                continue
            params = [p for p in signature.parameters.values() if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
            bound_positional = [p.name for p in params[receiver_slots : receiver_slots + len(positional)]]
            passed = set(bound_positional) | set(keywords)
            if receiver_slots and params:
                passed.add(params[0].name)
            function_name = getattr(func, "__name__", "?")
            if function_name in skipped_functions or id(node) in shown:
                continue
            # The file that a reader such as read_csv or read_parquet reads, even
            # where its parameter is named "path", a name kept out below.
            reads_file = function_name.startswith(("read_", "scan_")) and len(params) > receiver_slots
            file_param = params[receiver_slots].name if reads_file else None
            bound = {**dict(zip(bound_positional, positional)), **keywords}
            line, col = call_site(node)
            try:
                target = target_of(node, function_name, bound, file_param)
            except Exception:
                target = None
            call = {"line": line, "col": col, "target": target}
            user_path = is_user_code(func)
            qualname = qualified(func)
            # A call that unpacks its arguments may pass any parameter.
            unpacks = any(isinstance(arg, ast.Starred) for arg in node.args) or any(kw.arg is None for kw in node.keywords)
            if read_signatures and not user_path and not unpacks:
                read = signature_of(func, signature)
                defaulted = [p["name"] for p in read["params"] if p["name"] not in passed] if read else []
                if defaulted:
                    signatures.setdefault(read["function"], {**read, "calls": []})["calls"].append({**call, "defaulted": defaulted})
            for param in signature.parameters.values():
                if param.name in passed or param.default is inspect.Parameter.empty:
                    continue
                if param.kind in (param.VAR_POSITIONAL, param.VAR_KEYWORD):
                    continue
                if user_path:
                    node_default = default_node(func, param.name)
                    highlight = None
                    if isinstance(node_default, ast.Name) and node_default.id in getattr(func, "__globals__", {}):
                        constant = node_default.id
                        number, text = line_of(user_path, constant)
                        highlight = [number, text] if number else None
                        add({
                            "name": constant,
                            "value": repr(func.__globals__[constant]),
                            "provenance": "defaulted",
                            "param": param.name,
                            "function": function_name,
                            "source": {"file": os.path.relpath(user_path, cwd), "line": number},
                        }, call)
                    else:
                        add({
                            "name": param.name,
                            "value": repr(param.default),
                            "provenance": "defaulted",
                            "param": param.name,
                            "function": function_name,
                            "source": {"file": os.path.relpath(user_path, cwd), "line": None},
                        }, call)
                    attachment = attachment_for(func, user_path, highlight)
                    if attachment and all(a["symbol"] != attachment["symbol"] for a in attachments):
                        attachments.append(attachment)
                elif qualname in library_defaults and param.name in library_defaults[qualname]:
                    label, note = library_defaults[qualname][param.name]
                    library = qualname.split(".")[0]
                    version = version_of(library)
                    add({
                        "name": param.name,
                        "value": label,
                        "provenance": "library_default",
                        "param": param.name,
                        "function": qualname.rsplit(".", 2)[-2] + "." + function_name if "." in qualname else function_name,
                        "note": note,
                        # The popover says "default in pandas 3.0.6".
                        "library": library,
                        **({"version": version} if version else {}),
                    }, call)
            for name, value_node in bound.items():
                if name in skipped_params and name != file_param:
                    continue
                if name in bookkeeping.get(function_name, ()):
                    continue
                if name in drawing_params and drawing_functions.fullmatch(function_name):
                    continue
                found = literal(value_node)
                if found is None:
                    continue
                value, text = found
                if isinstance(value, str) and (value in known_names or any(value in cols for cols in frames.values())):
                    continue
                add({"name": name, "value": text, "provenance": "literal", "param": name, "function": function_name}, call)
        for node in tree.body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                name = node.targets[0].id
                found = literal(node.value)
                # A helper of one cell, named with an underscore by Python's
                # custom and by the cells that Whybook and its agents write,
                # holds no constant to try; and a string that names a column,
                # a variable or a model, y = "wt82_71" or a formula, names
                # data, as a keyword argument does (design iteration 1.91).
                if found is None or name.startswith("_"):
                    continue
                if isinstance(found[0], str) and isinstance(node.value, ast.Constant):
                    if found[0] in known_names or any(found[0] in cols for cols in frames.values()) or "~" in found[0]:
                        continue
                add({"name": name, "value": found[1], "provenance": "literal", "param": None, "function": None})
        order = {"defaulted": 0, "library_default": 1, "literal": 2}
        decisions.sort(key=lambda d: order[d["provenance"]])
        for decision in decisions:
            if "calls" in decision:
                decision["calls"].sort(key=lambda call: (call["line"], call["col"]))
        result = {
            "defs": sorted(set(defs)),
            "uses": sorted({u for u in uses if u in known_names and not hasattr(builtins, u)}),
            "formulas": formulas,
            "columns": touched,
            "decisions": decisions[:max_decisions],
            "attachments": attachments,
        }
        if read_signatures:
            # In the order of the code: ast.walk reaches the last call of a chain first.
            for listed in signatures.values():
                listed["calls"].sort(key=lambda call: (call["line"], call["col"]))
            ordered = sorted(signatures.values(), key=lambda listed: (listed["calls"][0]["line"], listed["calls"][0]["col"]))
            result["signatures"] = ordered[:max_signatures]
        return result

    results = {}
    for cell in args.get("cells", []):
        try:
            results[cell["id"]] = analyze(cell["source"])
        except SyntaxError as error:
            results[cell["id"]] = {"error": f"SyntaxError: {error.msg}"}
        except Exception as error:
            results[cell["id"]] = {"error": repr(error)}
    display({"application/vnd.whybook.result+json": {"cells": results}}, raw=True)
