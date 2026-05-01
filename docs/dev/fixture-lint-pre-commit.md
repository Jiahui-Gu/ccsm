# Fixture lint pre-commit hook

`scripts/lint-fixtures.ts` runs in CI on every PR that touches a fixture path. To
catch violations earlier (before `git push`), opt in locally by symlinking the
provided template into `.git/hooks/pre-commit`:

```bash
ln -sf ../../scripts/pre-commit-fixture-lint.sh .git/hooks/pre-commit
```

The hook only runs `npm run lint:fixtures` when the staged diff actually
includes a fixture path, so unrelated commits stay fast. Disable any time by
removing the symlink. The hook is intentionally not auto-installed by
`postinstall` — pre-commit hooks are a per-developer choice.
