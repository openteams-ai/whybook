# Security policy

Whybook is a research prototype, and only its latest release receives security fixes.

## Report a vulnerability

Report a vulnerability privately, never in a public issue: on the [Security tab](https://github.com/openteams-ai/whybook/security) of this repository, press "Report a vulnerability" ([direct link](https://github.com/openteams-ai/whybook/security/advisories/new)). Give the versions of Whybook, JupyterLab and Python, the steps that show the problem, and what an attacker could do with it.

## Scope

The report concerns Whybook's own parts: its server extension and routes, the code it runs in the kernel, the sandboxed kernel, the review guard, the stored keys of model providers, and any way that data leaves the machine while "Keep data on this machine" or `c.Whybook.way_to_use_models` should keep it there. A vulnerability in JupyterLab, Jupyter Server or a kernel itself goes to [Project Jupyter](https://jupyter.org/security).

## After a report

The maintainers confirm the report, fix it in a new release and publish a GitHub security advisory, which credits the reporter unless they prefer otherwise. The time to respond is best effort.
