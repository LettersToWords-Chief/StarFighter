---
description: how to back up Star Fighter to GitHub
---

## Git Backup for Star Fighter

**IMPORTANT — PowerShell syntax:** Use semicolons (`;`) to chain commands, NOT `&&` (which is invalid in PowerShell).

// turbo-all
1. Stage all changes, commit with a descriptive message summarizing what was done this session, and push to GitHub:

```
git add -A; git commit -m "<descriptive message here>"; git push
```

Run this as a single command with semicolons in PowerShell from `c:\Star Fighter`.

The remote is `github.com:LettersToWords-Chief/StarFighter.git` on branch `master`.
