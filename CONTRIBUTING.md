# Contributing to Aperture Chat

Thanks for your interest in improving Aperture Chat. Bug reports, ideas,
documentation fixes, code, and reviews are all welcome, and you don't need to
be an expert in the whole codebase to help.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug.** Use the [bug report form](https://github.com/Aperture-Chat/Aperture-Chat/issues/new?template=bug_report.yml).
  Steps to reproduce and the version you're running make a report far easier
  to act on.
- **Suggest a feature.** Use the [feature request form](https://github.com/Aperture-Chat/Aperture-Chat/issues/new?template=feature_request.yml)
  and describe the problem before the solution.
- **Improve the docs.** Typos, unclear steps, and outdated screenshots are
  worth a pull request on their own.
- **Fix an issue.** Issues labeled [`good first issue`](https://github.com/Aperture-Chat/Aperture-Chat/labels/good%20first%20issue)
  or [`help wanted`](https://github.com/Aperture-Chat/Aperture-Chat/labels/help%20wanted)
  are good places to start.
- **Review a pull request.** Trying a change locally and reporting what you
  found is useful even if you're not a maintainer.

Found a security problem? Don't open an issue. Follow [SECURITY.md](SECURITY.md)
to report it privately.

## Before you start

- **Search first.** Check [open issues](https://github.com/Aperture-Chat/Aperture-Chat/issues)
  and [pull requests](https://github.com/Aperture-Chat/Aperture-Chat/pulls) to
  avoid duplicate work.
- **Small fixes can go straight to a pull request.** Typos, documentation
  corrections, and clear bug fixes don't need an issue first.
- **Discuss larger changes in an issue first.** New features, behavior changes,
  new dependencies, schema or migration changes, and anything touching
  authentication, tenant isolation, or permissions should start with an issue
  so we can agree on the approach before you invest time in it.
- **Say you're working on it.** Comment on the issue so others know it's taken.
  If you can no longer finish it, say so and someone else can pick it up.

## Set up your environment

You'll need Git, Node.js 24 or newer (see `.nvmrc`), npm, and Python 3.12 or
newer.

1. [Fork the repository](https://github.com/Aperture-Chat/Aperture-Chat/fork)
   and clone your fork:

   ```bash
   git clone https://github.com/<your-username>/Aperture-Chat.git
   cd Aperture-Chat
   git remote add upstream https://github.com/Aperture-Chat/Aperture-Chat.git
   ```

2. Install dependencies:

   ```bash
   cp .env.example .env
   npm ci
   python3 -m venv services/api/.venv
   services/api/.venv/bin/python -m pip install -e './services/api[dev]'
   ```

3. Run the web app and the API in separate terminals:

   ```bash
   npm run dev:web
   ```

   ```bash
   cd services/api
   .venv/bin/uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
   ```

A clean local instance lets you create the first owner without a provider key.
Add and enable a model before testing anything that generates a response. Keep
`.env` local and use non-secret values; see the [README](README.md#development)
for more on local and container development.

Maintainers with write access can push branches to this repository instead of
a fork. Everything else below is the same.

## Make your change

1. Start a branch from the latest `dev`, the integration branch that every
   pull request targets:

   ```bash
   git fetch upstream
   git switch -c fix-sso-redirect upstream/dev
   ```

2. Keep the change focused on one fix, feature, or cleanup. Smaller pull
   requests get reviewed faster. If a change grows past roughly 500 lines of
   hand-written code (lockfiles, generated files, and fixtures don't count),
   consider splitting it into a series of pull requests.
3. Add or update tests for behavior you change, and update documentation and
   `.env.example` when configuration or user-facing behavior changes.
4. Follow the style of the surrounding code. Comment the non-obvious parts,
   such as intent, security boundaries, and surprising tradeoffs, rather than
   narrating what the code already says.
5. Write commit messages with a short, imperative summary line, for example
   `Fix SSO redirect URI for OIDC clients`, and use the body to explain why
   when that isn't obvious.

### Run the checks

CI runs on every pull request. Running the checks for the area you changed
before you push saves a round trip:

| If you changed | Run |
| --- | --- |
| Anything | `git diff --check` |
| Web app (`apps/web`) | `npm --workspace apps/web run typecheck`<br>`npm run test:web`<br>`npm run build:web` |
| API (`services/api`) | `cd services/api && .venv/bin/ruff check . && .venv/bin/python -m pytest` |
| Training scripts (`apps/web/scripts`) | `node --test apps/web/scripts/*.test.cjs`<br>`python3 apps/web/scripts/test_training_narration.py` |
| Release and install scripts (`scripts`) | `node --test scripts/promote-branch-images.test.mjs`<br>`python3 scripts/test_install_release.py`<br>`python3 scripts/test_updater.py` |
| Node.js version | `npm run check:node-baseline` |

Documentation-only changes need only `git diff --check` and a read-through of
the rendered result.

### Using AI tools

AI coding assistants are welcome. You're responsible for everything you
submit: read it, run it, and be ready to explain it in review. Agents working
in this repository should follow [AGENTS.md](AGENTS.md).

## Open a pull request

1. Push your branch to your fork and open a pull request against **`dev`**:

   ```bash
   git push -u origin fix-sso-redirect
   ```

   Pull requests against `test` or `main` fail the promotion checks, which
   accept only maintainer promotions.
2. Fill in the pull request template. The most useful parts are why the
   change is needed, how you tested it, and anything reviewers should look at
   closely, such as risks, migrations, or compatibility.
3. Link the issue it resolves (`Closes #123`) so it closes automatically.
4. For visible changes, add before and after screenshots or a short clip. Use
   synthetic accounts and data, and show both light and dark themes when the
   change affects both.
5. Open a [draft pull request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-pull-requests#draft-pull-requests)
   if you'd like early feedback, and mark it ready when it's complete.
6. Leave **Allow edits by maintainers** turned on so small fixes, such as a
   rebase or a typo, don't need a round trip.

## Review

- CI must pass. For a first-time contributor, a maintainer approves the CI
  run before it starts. If a check fails and the cause isn't clear, ask in the
  pull request.
- A maintainer reviews the change and may ask questions or request changes.
  Reply to each comment, either with a fix or with your reasoning.
- If `dev` moves ahead, update your branch from `upstream/dev`. Rebase freely
  before review starts; after that, merge `upstream/dev` and add new commits
  rather than force-pushing, so reviewers can see what changed since their
  last look.
- If a pull request hasn't had a response in a week, a polite comment is
  welcome.
- A maintainer merges the pull request once it's approved and CI is green.

## After your change is merged

Merged changes collect on `dev`. Maintainers then promote `dev` to `test`,
where container images are built and checked, and `test` to `main` for a
release. You don't need to do anything for this step; the details are in
[docs/RELEASING.md](docs/RELEASING.md).

When code you contribute is merged, you can claim an Aperture Chat T-shirt or
cap by leaving a comment on your merged pull request. See
[contributor gear](https://aperturechat.com/#gear).

## Keep private information out

This is a public repository. Never include credentials, tokens, private
hostnames or IP addresses, personal data, customer documents, runtime
databases, or production logs in issues, commits, screenshots, recordings, or
pull requests. Use placeholders such as `https://your-instance.example` in
examples.

## License

By contributing, you confirm that you have the right to submit your work and
agree that it will be distributed under the project's [MIT License](LICENSE.md).
