# Release security dependency remediation

This release-branch change replaces the vulnerable `gray-matter` dependency with `@11ty/gray-matter` and pins the transitive `undici` dependency through npm overrides to a patched 7.x release range. The lockfile is regenerated so CI and release validation resolve the same dependency graph.

This file is temporary release documentation and may be removed after the release branch is merged.
