"""`python -m whybook.demo`: the demo files of examples/pain_diary in a folder, from a wheel's install or from a checkout.

A wheel carries the files in whybook/demo/pain_diary, and a checkout has no such
folder. So the test of a wheel's install points the command at a folder of its own.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

from whybook import demo

ROOT = Path(__file__).resolve().parents[3]
EXAMPLES = ROOT / "examples" / "pain_diary"
PALETTE = "Cmd+Shift+C" if sys.platform == "darwin" else "Ctrl+Shift+C"


@pytest.fixture
def checkout(tmp_path, monkeypatch):
    """An install with no demo files in the package, as an editable install of a checkout is."""
    monkeypatch.setattr(demo, "PACKAGED", tmp_path / "no-package-data")


def test_writes_the_demo_of_the_checkout_into_a_new_folder(checkout, tmp_path, capsys):
    folder = tmp_path / "new" / "pain_diary"
    assert demo.main([str(folder)]) == 0
    assert sorted(path.name for path in folder.iterdir()) == ["clinic.sqlite", "pain_diary_cohort.ipynb", "prep.py"]
    assert [name for name in demo.FILES if (folder / name).read_bytes() != (EXAMPLES / name).read_bytes()] == []
    assert capsys.readouterr().out == (
        f"Wrote pain_diary_cohort.ipynb, prep.py and clinic.sqlite into {folder}. Open the notebook with:\n"
        "\n"
        f"    jupyter lab {folder / 'pain_diary_cohort.ipynb'}\n"
        "\n"
        f'In JupyterLab, choose "Open Notebook in Whybook" in the command palette ({PALETTE}), then press Run all.\n'
    )


def test_writes_the_files_of_the_wheel_before_those_of_a_checkout(tmp_path, monkeypatch):
    packaged = tmp_path / "site-packages" / "whybook" / "demo" / "pain_diary"
    packaged.mkdir(parents=True)
    for name in demo.FILES:
        (packaged / name).write_text(f"the release's {name}")
    monkeypatch.setattr(demo, "PACKAGED", packaged)
    assert demo.REPOSITORY == EXAMPLES
    folder = tmp_path / "pain_diary"
    assert demo.main([str(folder)]) == 0
    assert {name: (folder / name).read_text() for name in demo.FILES} == {name: f"the release's {name}" for name in demo.FILES}


def test_writes_into_whybook_demo_when_given_no_folder(checkout, tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert demo.main([]) == 0
    assert sorted(path.name for path in (tmp_path / "whybook-demo").iterdir()) == ["clinic.sqlite", "pain_diary_cohort.ipynb", "prep.py"]
    assert f"    jupyter lab {os.path.join('whybook-demo', 'pain_diary_cohort.ipynb')}\n" in capsys.readouterr().out


@pytest.mark.skipif(os.name == "nt", reason="cmd.exe quotes with double quotes, which subprocess.list2cmdline writes")
def test_quotes_a_folder_with_a_space_in_the_command_it_prints(checkout, tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert demo.main(["my demo"]) == 0
    assert "    jupyter lab 'my demo/pain_diary_cohort.ipynb'\n" in capsys.readouterr().out


def test_writes_no_file_when_the_folder_has_one_of_them(tmp_path):
    """Run as the README runs it: the exit status is 1, and the message names the files that are there."""
    folder = tmp_path / "pain_diary"
    folder.mkdir()
    (folder / "prep.py").write_text("my prep.py")
    (folder / "clinic.sqlite").write_text("my clinic.sqlite")
    # From the root of the checkout, python -m imports the checkout's whybook.
    done = subprocess.run([sys.executable, "-m", "whybook.demo", str(folder)], cwd=ROOT, capture_output=True, text=True)
    assert (done.returncode, done.stdout) == (1, "")
    assert done.stderr == (
        f"{folder} already has prep.py and clinic.sqlite, so nothing was written. "
        "Choose another folder, or move these files out of it.\n"
    )
    assert {path.name: path.read_text() for path in folder.iterdir()} == {"prep.py": "my prep.py", "clinic.sqlite": "my clinic.sqlite"}


def test_names_the_packages_of_the_notebook_when_the_environment_lacks_one(checkout, tmp_path, monkeypatch, capsys):
    """`pip install whybook` installs neither pandas nor statsmodels, and the notebook's first cell imports both."""
    found = importlib.util.find_spec
    monkeypatch.setattr(importlib.util, "find_spec", lambda name, *args: None if name == "statsmodels" else found(name, *args))
    folder = tmp_path / "pain_diary"
    assert demo.main([str(folder)]) == 0
    assert sorted(path.name for path in folder.iterdir()) == ["clinic.sqlite", "pain_diary_cohort.ipynb", "prep.py"]
    assert capsys.readouterr().out.endswith(
        'then press Run all.\n\nThe demo needs numpy, pandas, pyarrow and statsmodels: pip install "whybook[kernel,demo]"\n'
    )


def test_names_no_package_when_the_environment_has_them_all(checkout, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(importlib.util, "find_spec", lambda name, *args: object())
    assert demo.main([str(tmp_path / "pain_diary")]) == 0
    assert capsys.readouterr().out.endswith("then press Run all.\n")
