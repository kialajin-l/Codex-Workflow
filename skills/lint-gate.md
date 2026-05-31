# Lint Gate Skill

Before returning your result, ensure:
1. All modified files pass the project's linter.
2. If linting fails, report the errors in the `risks` field.
3. Mark `status: "blocked"` if lint errors exist and cannot be auto-fixed.
