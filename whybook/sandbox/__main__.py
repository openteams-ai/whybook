"""`python -m whybook.sandbox <kernel name>`: install a sandboxed copy of a kernelspec (kernelspec.py)."""

import sys

from .kernelspec import main

sys.exit(main())
