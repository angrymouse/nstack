# Agent Instructions

This repository builds the `nstack` CLI and project templates.

## Versioning

Bump the package version in `package.json` for every repository change or commit.

## Template Documentation Maintenance

When changing nstack behavior, CLI flows, deployment semantics, generated files,
resource handling, package-manager behavior, or recommended app workflows, update
the generated app AI docs in the template as part of the same change:

- `templates/encore-nuxt/AGENTS.md`
- `templates/encore-nuxt/NSTACK_GUIDELINES.md`

Keep those files accurate for newly initialized apps. If a framework adjustment
does not affect generated app workflows, no template doc update is needed.
