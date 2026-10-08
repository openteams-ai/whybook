"""Keep the data on this machine: what a model outside it may read.

With the setting "Keep data on this machine", which a view sends as
``keep_data_local`` in a request's body, or with the server's
``c.Whybook.keep_data_local``, only local models read outputs and variables.
The remote model and Jev get names, kinds, sizes and what local models wrote
about the data, and write code. The server applies it here, before a prompt
is built, so a view that sends more is cut back.
"""

from __future__ import annotations

import ast
import dataclasses
import re
from typing import Any

from .config import Whybook

# A key, a token or a password in a variable: the kernel lists such a string
# with its length and ``"secret": true``, never its text, and a value that an
# older version of the view kept goes to no model. Four places hold
# the same rule: this module, the kernel's listing and its analysis of cells
# (kernel_code/inspect_variables.py, kernel_code/analyze_cells.py), which
# cannot import this package, and the view (looksSecret in
# src/model/restore.ts). tests/data/secret_names.json holds the cases that
# the four agree on.
#
# Only a string is a secret: a number or a flag is not, whatever its name,
# so max_tokens=512 keeps its chip. A string is one when its name or its text
# says so. The name is read in parts, split on every character that is not a
# letter and at each capital that starts a word: dbPassword is "db" and
# "password". A part that is one of SECRET_WORDS, a part that ends with one of
# SECRET_ENDINGS (githubtoken, dbpassword), or two parts of SECRET_PAIRS make a
# secret; max_tokens, n_tokens and author do not. The text is a secret when it
# holds a known prefix of a key followed by 16 or more characters, a password
# in a URL (postgresql://analyst:pw@host, as a connection string holds it), a
# query parameter whose name is a secret by the same rule (?api_key=...), a
# run of 20 or more letters and digits with upper case, lower case and
# digits, or any such run of 32 or more: a hex hash is hidden, an upper-case
# sample id such as S20240115A00123456789 is not.
SECRET_WORDS = frozenset(
    {"token", "secret", "secrets", "password", "passwords", "passwd", "pwd", "credential", "credentials", "bearer", "apikey", "auth"}
)
SECRET_ENDINGS = ("token", "secret", "password", "passwd", "apikey")
SECRET_PAIRS = frozenset({("api", "key"), ("access", "key"), ("private", "key"), ("secret", "key")})
SECRET_PREFIX = re.compile(
    r"(?<![A-Za-z0-9])(?:sk-|sk_live_|sk_test_|hf_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abpr]-|xapp-"
    r"|AKIA|ASIA|AIza|ya29\.|eyJ|npm_|pypi-)[A-Za-z0-9_.=-]{16,}"
)
NAME_PARTS = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+")
LONG_RUN = re.compile(r"[A-Za-z0-9]{20,}")
# scheme://user:password@host, the user possibly empty: redis://:pw@localhost.
URL_PASSWORD = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://[^\s/?#@:]*:[^\s/?#@]+@")
QUERY_NAME = re.compile(r"[?&]([A-Za-z0-9_.-]+)=[^&#\s]")


def _secret_name(name: str) -> bool:
    parts = [part.lower() for part in NAME_PARTS.findall(name)]
    if any(part in SECRET_WORDS or part.endswith(SECRET_ENDINGS) for part in parts):
        return True
    return any(pair in SECRET_PAIRS for pair in zip(parts, parts[1:]))


def _secret_text(text: str) -> bool:
    if SECRET_PREFIX.search(text) or URL_PASSWORD.search(text):
        return True
    if any(_secret_name(name) for name in QUERY_NAME.findall(text)):
        return True
    return any(
        len(run) >= 32 or (re.search("[A-Z]", run) and re.search("[a-z]", run) and re.search("[0-9]", run))
        for run in LONG_RUN.findall(text)
    )


def secret_string(name: str, text: str) -> bool:
    """Whether a string that a variable of this name holds looks like a key, a token or a password."""
    return _secret_name(name) or _secret_text(text)


def looks_secret(name: Any, value: Any = None) -> bool:
    """Whether a variable holds a secret, from its name and its value as the kernel lists it: ``repr`` of a string.

    A number, a flag or any other value that is not a string is never a secret.
    """
    if not isinstance(value, str):
        return False
    try:
        text = ast.literal_eval(value)
    except Exception:  # noqa: BLE001  a value that is no literal is no string
        return False
    return isinstance(text, str) and secret_string(name if isinstance(name, str) else "", text)


def without_secret(variable: dict[str, Any]) -> dict[str, Any]:
    """A variable of a request with no text of a secret: a kept value that looks like a key goes, and the variable says it is a secret."""
    if variable.get("secret") is True or looks_secret(variable.get("name"), variable.get("value")):
        return {**{key: value for key, value in variable.items() if key != "value"}, "secret": True}
    return variable


PICTURE_REFUSED = (
    "The data stays on this machine: a question about a picture would send the picture to the remote model."
)
TABLES_REFUSED = "The data stays on this machine: labels and captions need a local model."

# What a remote model may read of a variable: names, kinds and sizes, where it
# is defined, and a model's formula. Not its value, its levels, its range, its
# counts of missing or distinct values, a model's estimates, the range of a kept
# pick, or the text of an error, which can quote a value.
VARIABLE_FIELDS = (
    "name",
    "label",
    "kind",
    "type",
    "parent",
    "tag",
    "dtype",
    "library",
    "rows",
    "n_columns",
    "length",
    "secret",
    "shape",
    "nobs",
    "grouped_by",
    "defined_in",
    "model_class",
    "formula",
    "path",
    "table",
)
COLUMN_FIELDS = ("label", "name", "tag", "library")
# What a remote model may read of an output that a tool ran: its kind and size, and what a local model wrote.
OUTPUT_FIELDS = ("kind", "rows", "cols", "columns", "lines", "description", "headline", "library", "plot")


def keep_local(config: Whybook, body: Any) -> bool:
    """Whether the data stays on this machine for this request: the server's choice, or the view's setting."""
    if config.keep_data_local:
        return True
    if not isinstance(body, dict):
        return False
    context = body.get("context")
    return body.get("keep_data_local") is True or (isinstance(context, dict) and context.get("keep_data_local") is True)


def keep_local_for_remote(config: Whybook, body: Any) -> bool:
    """Whether a request to the connected model must leave the data out: it stays here, and the model runs elsewhere.

    A model on this machine (an Ollama server, say) reads the data as a local
    model does, so nothing is cut back for it.
    """
    from . import connection

    return keep_local(config, body) and not connection.runs_locally(config)


def local_column(column: Any) -> Any:
    """A column's name and kind, without its levels, its range or its counts."""
    if not isinstance(column, dict):
        return column
    return {key: column[key] for key in COLUMN_FIELDS if key in column}


def local_variable(variable: Any) -> Any:
    """A variable, or an item of a selection, as a remote model may read it: names, kinds and sizes."""
    if not isinstance(variable, dict):
        return variable
    kept = {key: variable[key] for key in VARIABLE_FIELDS if key in variable}
    if isinstance(variable.get("columns"), list):
        kept["columns"] = [local_column(column) for column in variable["columns"]]
    if isinstance(variable.get("groups"), list):
        kept["groups"] = [
            {
                "label": group.get("label"),
                "columns": group["columns"] if isinstance(group.get("columns"), int) else group.get("total", len(group.get("columns") or [])),
            }
            for group in variable["groups"]
            if isinstance(group, dict)
        ]
    if isinstance(variable.get("terms"), list):
        # The names of a model's terms, without the estimates.
        kept["terms"] = [term.get("term") if isinstance(term, dict) else str(term) for term in variable["terms"]]
    selection = variable.get("selection")
    if isinstance(selection, dict) and selection.get("of"):
        # The frame a kept pick comes from, without the range picked.
        kept["selection"] = {"of": selection["of"]}
    return kept


def local_state(state: dict[str, Any]) -> dict[str, Any]:
    """A state for Claude or Jev (``rankers.jev_state``, ``ranking.state_of``) with its selection cut back."""
    if isinstance(state.get("selected"), list):
        return {**state, "selected": [local_variable(item) for item in state["selected"]]}
    return state


def local_request(request: Any) -> Any:
    """A request for one cell (``solve.SolveRequest``) without values: variables and selection cut back, no picture, no range picked.

    The mask of the rows picked in a plot goes too: its bounds are values.
    """
    about = request.about
    if about:
        about = "The analyst picked part of a table or a plot. The values of what was picked stay on this machine."
    return dataclasses.replace(
        request,
        keep_local=True,
        variables=[local_variable(variable) for variable in request.variables],
        about=about,
        rows=None,
        image=None,
        previous_attempt=(
            {**request.previous_attempt, "error": error_type(request.previous_attempt.get("error", ""))}
            if request.previous_attempt
            else None
        ),
    )


def without_value(source: str, value: Any) -> str:
    """The code of a cell with each literal that holds ``value`` written as ``...``.

    A model outside the machine may suggest other values of a constant from
    its name and its code: with the data on this machine, it does not read
    the value itself. ``MIN_DAYS = 14`` goes as ``MIN_DAYS = ...``, and so
    does each 14 elsewhere in the cell, ``14.0`` and ``-14`` for ``-14``.
    """
    import io
    import tokenize

    try:
        target = ast.literal_eval(str(value).strip())
    except Exception:  # noqa: BLE001  a value that is no literal is not in the code as one
        return source

    def same(text: str, sign: int) -> bool:
        try:
            found = ast.literal_eval(text)
        except Exception:  # noqa: BLE001  an f-string or a bytes literal
            return False
        if isinstance(found, (int, float)) and not isinstance(found, bool):
            return isinstance(target, (int, float)) and not isinstance(target, bool) and sign * found == target
        return sign == 1 and type(found) is type(target) and found == target

    starts = [0]
    for line in source.splitlines(keepends=True):
        starts.append(starts[-1] + len(line))
    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return source
    spans = []
    for index, token in enumerate(tokens):
        if token.type not in (tokenize.NUMBER, tokenize.STRING):
            continue
        start = starts[token.start[0] - 1] + token.start[1]
        end = starts[token.end[0] - 1] + token.end[1]
        before = tokens[index - 1] if index else None
        # A minus is the value's sign after an operator or an opening bracket, not in 3 - 3.
        earlier = tokens[index - 2] if index > 1 else None
        unary = (
            before is not None
            and before.type == tokenize.OP
            and before.string == "-"
            and (earlier is None or (earlier.type == tokenize.OP and earlier.string not in (")", "]", "}")) or earlier.type in (tokenize.NEWLINE, tokenize.NL, tokenize.INDENT))
        )
        if unary and same(token.string, -1):
            spans.append((starts[before.start[0] - 1] + before.start[1], end))
        elif same(token.string, 1):
            spans.append((start, end))
    for start, end in reversed(spans):
        source = source[:start] + "..." + source[end:]
    return source


def error_type(message: Any) -> str:
    """The kind of an error without its message, which can quote a value: "KeyError"."""
    text = str(message or "").strip()
    head = text.split(":", 1)[0].strip()
    return head if head.replace(".", "").replace("_", "").isalnum() and len(head) <= 80 else "an error"


def local_output(output: Any) -> Any:
    if not isinstance(output, dict):
        return None
    kept = {key: output[key] for key in OUTPUT_FIELDS if key in output}
    if isinstance(kept.get("columns"), list):
        kept["columns"] = [str(column)[:80] for column in kept["columns"][:60]]
    if isinstance(kept.get("plot"), dict):
        # The axes' names and the columns they show; their limits are values.
        kept["plot"] = {key: kept["plot"][key] for key in ("kind", "x", "y", "title", "frame") if key in kept["plot"]}
    return kept


def tool_result(result: Any, keep_local: bool) -> dict[str, Any]:
    """What an agent's tool returns to the remote model: all of it, or without values when the data stays here."""
    if not isinstance(result, dict):
        return {"status": "error", "error": "the notebook gave no result"}
    if not keep_local:
        return result
    # A file's path, its length and why the view refused it hold no data. Nor
    # does a notebook that the run made: its name, its kernel, its language
    # and version, whether it reads parquet, and the names of its packages.
    # Nor does what became of a cell that failed: the label it had before
    # its fix, and whether it was removed or is no longer failed.
    kept: dict[str, Any] = {
        key: result[key]
        for key in (
            "status", "cell", "label", "title", "of", "path", "lines", "reason", "notebook", "kernel", "language",
            "version", "sandboxed", "parquet", "packages", "folder", "fixed", "removed", "failed",
        )
        if key in result
    }
    if isinstance(result.get("files"), list):
        # The frames written to files: their paths, formats, sizes and column names.
        kept["files"] = [
            {key: item[key] for key in ("frame", "path", "format", "rows", "columns") if key in item}
            if isinstance(item, dict)
            else str(item)[:200]
            for item in result["files"][:20]
        ]
    if result.get("error"):
        kept["error"] = error_type(result["error"])
    if isinstance(result.get("defines"), list):
        kept["defines"] = [local_variable(item) if isinstance(item, dict) else str(item)[:80] for item in result["defines"][:20]]
    if isinstance(result.get("outputs"), list):
        kept["outputs"] = [item for item in (local_output(output) for output in result["outputs"][:10]) if item]
    if isinstance(result.get("branches"), list):
        kept["branches"] = [tool_result(branch, True) for branch in result["branches"][:8]]
    return kept
