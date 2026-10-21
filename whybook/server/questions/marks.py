"""The names and values in the text of a question, marked as code or as data.

A question marks each name of the code, and each value, in backticks, as
Markdown marks inline code: "What if `reml` were `False`?" (design iteration
1.145). A parameter, a function, a constant, a fitted model and a value are
code: the analyst types them in a cell. It marks each name of the data, a
column, a frame, a table or a file, with two asterisks: "Does the effect of
**treatment_arm** on **pain_score** differ by **age**?" (design iteration
1.146). The view shows code in the code font and data by its exact name, in
bold. The comment of a cell's code, the id of a question and the models that
order and type questions read the text without the marks: the models were
measured on such texts.
"""

from __future__ import annotations

import re

# Two asterisks with no space after the first pair or before the second, as
# Markdown's bold: "x ** 2 and y ** 3" holds no data.
_MARKED = re.compile(r"`([^`\n]+)`|\*\*(\S(?:[^*`\n]*\S)?)\*\*")


def as_code(text: object) -> str:
    """A name of the code or a value, in backticks. A text with a backtick or a line break, or an empty one, stays as it is."""
    text = str(text)
    return f"`{text}`" if text and "`" not in text and "\n" not in text else text


def as_data(text: object) -> str:
    """A name of the data, between two asterisks. A text with an asterisk, a backtick or a line break, a space at an end, or none, stays as it is."""
    text = str(text)
    return f"**{text}**" if text.strip() == text and text and not any(mark in text for mark in "*`\n") else text


def plain(text: str) -> str:
    """The text without the marks of its names and values: "What if reml were False in the fit of model_data?"."""
    return _MARKED.sub(lambda found: found.group(1) or found.group(2), text)
