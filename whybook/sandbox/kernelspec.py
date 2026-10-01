"""A sandboxed copy of an installed kernelspec: `python -m whybook.sandbox <kernel name>`.

The copy runs the same command under the provisioner `whybook-sandbox`, with
the same language, environment and interrupt mode. Its display name says that
it is sandboxed, "R 4.4.3 (xr)" gives "R 4.4.3 (xr, sandboxed)", and its name
comes from its language: the copy of `xr` is `r-sandboxed`. Its icon is the
kernel's own logo in a box (design iteration 1.46), as an SVG, which
JupyterLab shows before a PNG; the PNGs stay the kernel's own, since drawing
them takes a browser. The package ships no logo of another project for it.

The copy goes into the user's Jupyter data folder by default, where
`jupyter kernelspec install` installs for the whole system unless given
--user; into the environment's with --sys-prefix, a prefix with --prefix,
or a folder that JUPYTER_PATH names with --path.
Wherever the kernel's R, Julia or other runtime lives, the copy names it as
the original does, and the provisioner finds the environment around it.
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

PROVISIONER = "whybook-sandbox"
# A kernelspec's logos, in the order an icon is drawn from them.
LOGOS = ("logo-svg.svg", "logo-64x64.png", "logo-32x32.png")

# The edge of the box: JupyterLab's secondary grey (--jp-ui-font-color2 of the
# light theme), 4.6:1 against the white of the light launcher and 4.1:1
# against the #111 of the dark one.
EDGE = "#757575"


class KernelspecError(ValueError):
    """The kernelspec cannot be copied into a sandboxed one; the message says why."""


def logo_href(path: Path) -> str:
    """A logo file as a data URI, for an icon that draws it."""
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"


def icon_svg(href: str, note: str = "") -> str:
    """The icon of a sandboxed kernel: its logo, unaltered and scaled, in a box with a clear edge.

    The box is 64 by 64 units with a translucent grey inside, which shows on
    the light and on the dark launcher alike, and the logo keeps its own
    proportions within the box. `note` goes into the SVG as a comment.
    """
    comment = f"<!-- {note.replace('--', '-')} -->" if note else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">{comment}'
        f'<rect x="2.5" y="2.5" width="59" height="59" rx="12" fill="{EDGE}" fill-opacity="0.16"'
        f' stroke="{EDGE}" stroke-width="3.5"/>'
        f'<image x="9" y="9" width="46" height="46" href="{href}"/>'
        "</svg>"
    )


def sandboxed_name(language: str) -> str:
    """The kernelspec's name: r-sandboxed for R, python-sandboxed for Python."""
    slug = re.sub(r"[^a-z0-9._-]+", "-", language.strip().lower()).strip("-")
    return f"{slug or 'kernel'}-sandboxed"


def sandboxed_display_name(display_name: str) -> str:
    """ "R 4.4.3 (xr)" gives "R 4.4.3 (xr, sandboxed)", and "Julia 1.11" gives "Julia 1.11 (sandboxed)"."""
    name = display_name.strip()
    if name.endswith(")") and "(" in name:
        return f"{name[:-1]}, sandboxed)"
    return f"{name} (sandboxed)"


def sandboxed_spec(spec: dict[str, Any], display_name: str | None = None, read_only: list[str] | None = None) -> dict[str, Any]:
    """The kernel.json of the copy: the same command, language, environment and interrupt mode, under the provisioner."""
    metadata = dict(spec.get("metadata") or {})
    named = (metadata.get("kernel_provisioner") or {}).get("provisioner_name")
    if named == PROVISIONER:
        raise KernelspecError(f'The kernelspec "{spec.get("display_name")}" runs in the sandbox already.')
    if named:
        raise KernelspecError(
            f'The kernelspec "{spec.get("display_name")}" starts its kernel through the provisioner {named}, '
            "and a kernel has one provisioner: the sandbox cannot wrap it."
        )
    provisioner: dict[str, Any] = {"provisioner_name": PROVISIONER}
    if read_only:
        provisioner["config"] = {"read_only": list(read_only)}
    metadata["kernel_provisioner"] = provisioner
    copy = dict(spec)
    copy["display_name"] = display_name or sandboxed_display_name(spec.get("display_name") or spec.get("language") or "Kernel")
    copy["metadata"] = metadata
    return copy


def write_icon(folder: Path, kernel: str) -> str:
    """Draw the kernel's own logo in the box, as the kernelspec's SVG icon, and say what it drew."""
    logo = next((folder / name for name in LOGOS if (folder / name).exists()), None)
    if logo is None:
        return "no icon: the kernelspec has no logo"
    note = f"The logo of the kernelspec {kernel}, unaltered and scaled, in the box of a sandboxed kernel (Whybook)."
    (folder / "logo-svg.svg").write_text(icon_svg(logo_href(logo), note) + "\n")
    return f"its logo, from {logo.name}, in a box"


def write_copy(source: Path, target: Path, spec: dict[str, Any], kernel: str) -> str:
    """Write the sandboxed copy of the kernelspec `kernel`, from the folder `source`, into `target`; say what icon it has."""
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target)
    (target / "kernel.json").write_text(json.dumps(spec, indent=2) + "\n")
    return write_icon(target, kernel)


def install(
    kernel: str,
    *,
    name: str | None = None,
    display_name: str | None = None,
    user: bool = True,
    prefix: str | None = None,
    path: str | None = None,
    read_only: list[str] | None = None,
) -> tuple[Path, dict[str, Any], str]:
    """Install the sandboxed copy of the kernelspec named `kernel`, and return its folder, its kernel.json and its icon."""
    from jupyter_client.kernelspec import KernelSpecManager, NoSuchKernel

    manager = KernelSpecManager()
    try:
        original = manager.get_kernel_spec(kernel)
    except NoSuchKernel:
        found = ", ".join(sorted(manager.find_kernel_specs())) or "none"
        raise KernelspecError(f'No kernelspec is named "{kernel}". Installed: {found}.') from None
    source = Path(original.resource_dir)
    spec = sandboxed_spec(json.loads((source / "kernel.json").read_text()), display_name, read_only)
    name = name or sandboxed_name(spec.get("language") or kernel)
    if name == kernel:
        raise KernelspecError(f'The copy needs a name other than "{kernel}": give one with --name.')
    if path is not None:
        target = Path(path).expanduser() / "kernels" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        icon = write_copy(source, target, spec, kernel)
        return target, spec, icon
    with tempfile.TemporaryDirectory() as scratch:
        staged = Path(scratch) / name
        icon = write_copy(source, staged, spec, kernel)
        installed = manager.install_kernel_spec(str(staged), name, user=user and prefix is None, prefix=prefix)
    return Path(installed), spec, icon


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m whybook.sandbox",
        description=(
            "Write a sandboxed copy of an installed kernelspec: the same kernel, run under bubblewrap on Linux "
            "or Seatbelt on macOS, with the notebook's folder writable and no network."
        ),
    )
    parser.add_argument("kernel", help="the name of an installed kernelspec, as `jupyter kernelspec list` gives it")
    parser.add_argument("--name", help="the copy's name; by default its language and -sandboxed, such as r-sandboxed")
    parser.add_argument("--display-name", help='the name that the launcher shows; by default "<the original>, sandboxed"')
    where = parser.add_mutually_exclusive_group()
    where.add_argument("--user", action="store_true", help="install for this user (the default)")
    where.add_argument("--sys-prefix", action="store_true", help="install into this Python environment")
    where.add_argument("--prefix", help="install under this prefix, in share/jupyter/kernels")
    where.add_argument("--path", help="install into a folder that JUPYTER_PATH names, in its kernels folder")
    parser.add_argument(
        "--read-only",
        action="append",
        default=[],
        metavar="PATH",
        help="another path the kernel reads, besides its environment; can be given more than once",
    )
    args = parser.parse_args(argv)
    prefix = sys.prefix if args.sys_prefix else args.prefix
    try:
        folder, spec, icon = install(
            args.kernel,
            name=args.name,
            display_name=args.display_name,
            user=prefix is None and args.path is None,
            prefix=prefix,
            path=args.path,
            read_only=args.read_only,
        )
    except KernelspecError as error:
        print(error, file=sys.stderr)
        return 1
    print(f'Installed "{spec["display_name"]}" in {folder}, with {icon}.')
    return 0
