"""The pain diary demo, written into a folder: `python -m whybook.demo [folder]`.

The demo is three files of examples/pain_diary in the repository: the notebook
pain_diary_cohort.ipynb, prep.py and clinic.sqlite. The notebook imports its
helpers and data from prep.py, and clinic.sqlite holds the clinic's records as
a SQLite file. A wheel carries the files in whybook/demo/pain_diary
(`force-include` in pyproject.toml), so the command writes the demo of the
installed release. A checkout keeps the one copy in examples/pain_diary, and an
editable install reads it there. The later demo, pain_diary_cohort_6h.ipynb
(1 MB), stays in the repository.
"""

from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

FILES = ("pain_diary_cohort.ipynb", "prep.py", "clinic.sqlite")
NOTEBOOK = FILES[0]
# Where the command writes when it is given no folder: in the current directory.
DEFAULT_FOLDER = "whybook-demo"
# Where the files are, in the order the command looks: a wheel's install, then a checkout.
PACKAGED = Path(__file__).with_name("pain_diary")
REPOSITORY = Path(__file__).resolve().parents[2] / "examples" / "pain_diary"


class DemoError(Exception):
    """The demo was not written; the message says why."""


def source() -> Path:
    """The first folder that holds every file of the demo."""
    for folder in (PACKAGED, REPOSITORY):
        if all((folder / name).is_file() for name in FILES):
            return folder
    raise DemoError(f"The files of the demo are in neither {PACKAGED} nor {REPOSITORY}: install Whybook again.")


def write(folder: Path) -> None:
    """Copy the files of the demo into `folder`, which is made if it does not exist.

    When `folder` has one of the files already, no file is written.
    """
    origin = source()
    if folder.exists() and not folder.is_dir():
        raise DemoError(f"{folder} is a file: give the name of a folder.")
    present = [name for name in FILES if os.path.lexists(folder / name)]
    if present:
        raise DemoError(
            f"{folder} already has {_names(present)}, so nothing was written. "
            "Choose another folder, or move these files out of it."
        )
    written: list[Path] = []
    try:
        folder.mkdir(parents=True, exist_ok=True)
        for name in FILES:
            # Mode "x" fails on a file that appeared after the check above. The
            # copy gets the permissions of a new file: the installed file can be
            # read-only, as in the Nix store.
            with (origin / name).open("rb") as file, (folder / name).open("xb") as copy:
                written.append(folder / name)
                shutil.copyfileobj(file, copy)
    except OSError as error:
        for path in written:
            path.unlink(missing_ok=True)
        raise DemoError(f"The demo could not be written into {folder}: {error}") from error


def _names(names: list[str]) -> str:
    """The names as a sentence lists them: a, a and b, or a, b and c."""
    return names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"


def _shell(path: str) -> str:
    """The path quoted for the shell of this system, where it needs quotes."""
    return subprocess.list2cmdline([path]) if os.name == "nt" else shlex.quote(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m whybook.demo",
        description=(
            "Write Whybook's demo into a folder: pain_diary_cohort.ipynb, prep.py and clinic.sqlite. "
            "In a folder that already has one of these files, the command writes none of them."
        ),
    )
    parser.add_argument(
        "folder",
        nargs="?",
        default=DEFAULT_FOLDER,
        help=f"the folder to write into, made if it does not exist; by default {DEFAULT_FOLDER} in the current directory",
    )
    args = parser.parse_args(argv)
    try:
        write(Path(args.folder))
    except DemoError as error:
        print(error, file=sys.stderr)
        return 1
    palette = "Cmd+Shift+C" if sys.platform == "darwin" else "Ctrl+Shift+C"
    print(f"Wrote {_names(list(FILES))} into {args.folder}. Open the notebook with:")
    print()
    print(f"    jupyter lab {_shell(os.path.join(args.folder, NOTEBOOK))}")
    print()
    print(f'In JupyterLab, choose "Open Notebook in Whybook" in the command palette ({palette}), then press Run all.')
    return 0
