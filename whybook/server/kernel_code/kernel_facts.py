"""What a kernel has, for an agent that writes cells in it: the language's version, whether it reads parquet, and its packages.

An agent that answers in a second notebook (design iteration 1.69) reads this
when the notebook opens, so that it writes code with the packages there are
and says which are missing. It installs nothing.

The frontend bundle holds the text of this file and runs it in the kernel, so
it must not import the whybook package.
"""


def _whybook_kernel_facts(args):
    import importlib.metadata
    import importlib.util
    import sys

    from IPython.display import display

    # The packages of an analysis, by the name that imports them.
    modules = [
        "pandas",
        "numpy",
        "scipy",
        "statsmodels",
        "sklearn",
        "polars",
        "pyarrow",
        "fastparquet",
        "patsy",
        "matplotlib",
        "seaborn",
        "plotnine",
        "lifelines",
        "linearmodels",
        "pingouin",
        "pymc",
    ]
    distributions = {"sklearn": "scikit-learn"}
    packages = {}
    for module in modules:
        if module in sys.modules or importlib.util.find_spec(module) is not None:
            try:
                packages[module] = importlib.metadata.version(distributions.get(module, module))
            except importlib.metadata.PackageNotFoundError:
                packages[module] = None
    # pandas reads parquet through pyarrow or fastparquet; polars reads it itself.
    parquet = any(module in packages for module in ("pyarrow", "fastparquet", "polars"))
    display(
        {
            "application/vnd.whybook.result+json": {
                "language": f"Python {sys.version.split()[0]}",
                "parquet": parquet,
                "packages": packages,
            }
        },
        raw=True,
    )
