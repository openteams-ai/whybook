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
- A small count: a table's row of whole numbers with one under 10.
- A key or a token, as ``privacy.py`` finds them.
- A run of base64 is decoded and read the same way.

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
import re
from dataclasses import asdict, dataclass, field
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

    @property
    def decision(self) -> str:
        if any(flag.level == "reject" for flag in self.flags):
            return "reject"
        return "ask" if self.flags else "allow"

    def __add__(self, other: Finding) -> Finding:
        seen = set(self.flags)
        return Finding(self.flags + tuple(flag for flag in other.flags if flag not in seen))

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
NAME = re.compile(
    r"\b(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?"
    r"|\b[A-Z]\.\s?[A-Z][a-z]{2,}\b"
    r"|\b[A-Z][a-z]+\s+[A-Z][a-z]+(?=\s+(?:at|from|of|in|\()\s*\(?[A-Z]{1,3}-?\d{3,8}\b)"
)
# Codes that look like an identifier and are not one.
NOT_ID = re.compile(r"^(?:ISO|UTF|RFC|SHA|CVE|PEP|GPT|ICD|NCT|IEC|EN|DIN|FY|ANSI|IEEE|SKU)-?\d{1,8}$")
DETAILS = {
    "age": re.compile(
        r"\bage[ds]?\"?\s*[:=]?\s*\d{1,3}\b|\b\d{1,3}\s*(?:years?\s*old|-year-old|y/?o)\b|\b(?:she|he|they) (?:is|was|are|were) \d{1,3}\b|\b\d{1,3}\s+años\b",
        re.I,
    ),
    "date": re.compile(
        r"\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+\d{4})?\b"
        r"|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b"
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
# "sex"="F". A value after a colon or an equals sign counts; after a space
# only a number does, so that a table's header ("age stage") is no detail.
SEPARATOR = r"(\"?[ \t]*[:=][ \t]*\"?|[ \t]+)"
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


def _personal(name: str) -> bool:
    lowered = name.lower()
    return any(word in lowered for word in PERSONAL_WORDS)


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

    @classmethod
    def from_json(cls, data: Any) -> Dataset:
        """From the view: ``{"synthetic": bool, "unit": str, "columns": [{"name", "levels"}]}``. Anything else gives a real dataset with no columns."""
        if not isinstance(data, dict):
            return cls()
        unit = data.get("unit") if isinstance(data.get("unit"), str) and data.get("unit") else None
        personal: dict[str, list[str]] = {}
        names: set[str] = set()
        columns = data.get("columns") if isinstance(data.get("columns"), list) else []
        for column in columns[:400]:
            if not isinstance(column, dict) or not isinstance(column.get("name"), str):
                continue
            name = column["name"][:80]
            names.add(name)
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
        )


def _span_near(position: int, spans: Iterable[tuple[int, int]], radius: int = NEAR) -> bool:
    return any(start - radius <= position <= end + radius for start, end in spans)


def _details(text: str, dataset: Dataset) -> list[tuple[str, str, int, int]]:
    """Each personal detail in the text: its kind, the text matched, and where it is."""
    found = []
    for kind, pattern in DETAILS.items():
        for match in pattern.finditer(text):
            found.append((kind, match.group(0), match.start(), match.end()))
    for match in NAMED_DETAIL.finditer(text):
        explicit = any(mark in match.group(2) for mark in ":=")
        if not explicit and not NUMBER.match(match.group(3)):
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
            found.append((label, match.group(0), match.start(), match.end()))
        for level in levels:
            if len(level) < 3 or level.lower() in {"none", "nan", "true", "false", "yes", "no", "other", "unknown"}:
                continue
            for match in re.finditer(rf"\b{re.escape(level)}", text, re.I):
                found.append((label, match.group(0), match.start(), match.end()))
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


def _naming(text: str, start: int) -> bool:
    """Whether the text at ``start`` is a value of a JSON key that names things, such as a column's label."""
    return bool(NAMING_KEY.search(text[max(0, start - 400) : start]))


def _ids(text: str, dataset: Dataset) -> list[tuple[str, str, int, int]]:
    found = []
    for match in ID.finditer(text):
        code = match.group(0)
        if code not in dataset.ids and (NOT_ID.match(code) or code in dataset.names or _naming(text, match.start())):
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
    """Rows of a table whose cells after the label are all whole numbers, with one under 10."""
    found = []
    offset = 0
    lines = text.splitlines(keepends=True)
    tabular = sum(1 for line in lines if TABLE_ROW.match(line.rstrip("\n"))) >= 2
    for line in lines:
        match = TABLE_ROW.match(line.rstrip("\n")) if tabular else None
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
    ids = _ids(scan, dataset)
    details = _details(scan, dataset)
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
    rows = [row for row, *_ in _small_counts(scan)]
    for table in _tables_inside(text):
        rows.extend(row for row, *_ in _small_counts(table))
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
