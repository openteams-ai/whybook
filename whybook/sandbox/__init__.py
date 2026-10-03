"""The kernel in a sandbox, with the notebook's folder mounted: design iteration 1.46.

`SandboxProvisioner` is a kernel provisioner, registered as `whybook-sandbox`.
The kernelspec "Python 3 (sandboxed)" names it, and so do the copies of other
kernelspecs that `python -m whybook.sandbox <kernel name>` writes
(`kernelspec.py`), such as "R 4.4.3 (xr, sandboxed)". It runs the kernel under
bubblewrap on Linux (`bwrap.py`) and under Seatbelt on macOS (`seatbelt.py`).
`policy.py` holds what both enforce. research/kernel-sandbox.md
has the research behind it, and architecture/code-map.md the overview.
"""

from .policy import SandboxUnavailable
from .provisioner import SandboxProvisioner

__all__ = ["SandboxProvisioner", "SandboxUnavailable"]
