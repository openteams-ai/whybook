# Making a new release of whybook

The workflow `.github/workflows/publish.yml` publishes whybook to PyPI when a GitHub release is published. It builds the sdist and the wheel from the release tag and checks them. It then uploads them to PyPI through trusted publishing, with a PEP 740 attestation for each file, and attaches them to the GitHub release. The repository stores no PyPI token.

whybook is not published to npm.

## One-time setup

1. On PyPI, open https://pypi.org/manage/project/whybook/settings/publishing/ and add a GitHub trusted publisher with owner `openteams-ai`, repository `whybook`, workflow `publish.yml` and environment `pypi`.
2. On GitHub, open Settings > Environments > New environment and name it `pypi`. In the "Deployment branches" dropdown, choose "Selected branches and tags", click "Add deployment branch or tag rule", set "Ref type" to Tag and the pattern to `v*`, and click "Add rule". To approve each upload by hand, also select "Required reviewers", add yourself, and click "Save protection rules".

## Making a release

1. Set the new version in `package.json`, by hand or with `hatch version 0.4.0` (after `pip install hatch`). `pyproject.toml` reads the version from `package.json`. Commit the change and push it to `main`.
2. Optionally, run the "Publish" workflow from the Actions tab on `main`. A run started by hand builds and checks the files, but does not upload them.
3. Create the release on GitHub: Releases > Draft a new release, type the tag `v0.4.0` (the version in `package.json` after a `v`), keep `main` as the target, click "Generate release notes", then "Publish release". From a terminal: `gh release create v0.4.0 --target main --title 0.4.0 --generate-notes`.
4. The "Publish" workflow builds and checks the files, waits for approval if the `pypi` environment has required reviewers, uploads the files to PyPI and attaches them to the release. It stops before the upload if the tag is not `v` followed by the version in `package.json`.
5. Check https://pypi.org/project/whybook/0.4.0/#files: each file lists its attestation, with the repository, the workflow and the tag that built it.

If a job fails for a reason outside the code, such as a network error, click "Re-run failed jobs" on the run page. If the build or a check fails, fix the cause on `main`, delete the release and its tag with `gh release delete v0.4.0 --cleanup-tag`, and create the release again. PyPI accepts each file name only once, so after any file of a version is on PyPI, a fix needs a new version.

## Manual release

Without the workflow, commit first and build from a checkout where `git status --short` prints nothing: hatch packs uncommitted changes, and untracked files that `.gitignore` does not list, into the sdist. Files uploaded this way have no attestation.

```bash
pip install build twine
jlpm clean:all
git clean -dfX
python -m build
twine upload dist/*
```

## Publishing to conda-forge

If the package is not on conda-forge yet, see https://conda-forge.org/docs/maintainer/adding_pkgs.html to add it.

Otherwise, a bot picks up each new version on PyPI and opens a pull request on the feedstock repository.
