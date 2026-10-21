# Contributing to Whybook

## Report a problem or propose a change

Report a bug or ask a question in [the issues](https://github.com/openteams-ai/whybook/issues). Give the versions of Whybook, JupyterLab, Python and the browser, the steps that show the problem, and what you expected. Leave out API keys, and data that you cannot share.

Pull requests are welcome. For a change larger than a fix, open an issue first to discuss it. CI runs the linters and the tests on each pull request.

## Report a security problem

Report a security problem privately, never in a public issue: [SECURITY.md](SECURITY.md) says how, and what is in scope.

## Full install

A full install of a release adds the local models and the Claude Code login to what the README installs:

```bash
pip install "whybook[claude,kernel,demo,local,models]"
```

The extra `claude` serves the Claude Code login, for development only: the server offers it when it starts with `--Whybook.claude_code_login=True`.

## Set up a checkout

Whybook is one Python package, `whybook`: the helpers that a notebook imports (`import whybook`), the server extension (`whybook.server`) and the frontend extension of the same name. The editable install builds the frontend extension, so it needs [Node.js](https://nodejs.org/en/download), in its latest LTS release. From a clone of this repository:

```bash
pip install --editable ".[dev,test,claude,kernel,demo,models]"
jupyter-builder develop . --overwrite
jupyter server extension enable whybook
jlpm build
pre-commit install
```

Add `speech` where moonshine-voice has a wheel: macOS 15 on Apple silicon, Linux with glibc 2.34 or later, and Windows.

`jlpm` is the version of yarn that JupyterLab installs. Run `jlpm build` again after each change to the TypeScript source, or keep `jlpm watch` running beside `jupyter lab`.

## Run the tests and the linters

- `pytest` from the root runs the Python tests. Where no sandbox can start, the tests of the sandboxed kernel skip.
- `jlpm test` runs the Jest tests.
- The integration tests are in `ui-tests/`, whose README has their commands.
- `jlpm lint:check` runs stylelint, prettier and ESLint on every file, as CI does. ESLint reads the types of the integration tests from `ui-tests/node_modules`, so run `jlpm install` in `ui-tests/` first.

The git hook of `pre-commit install` runs the same linters on the files of each commit. When a linter fixes a file, the commit stops: stage the fix and commit again.

## Rules for a change

- No test calls an AI model. The Python tests fake each call, and each integration test answers the requests that would reach a model.
- Every method of a server handler carries `@tornado.web.authenticated`. `python .github/scripts/check_auth.py` fails otherwise, and CI runs it.
- The code that Whybook sends to the kernel is in `whybook/server/kernel_code/`, and `jlpm build` copies it into `src/kernelCode.ts`. Edit the files in `kernel_code/`, then run `jlpm build` and commit both.
