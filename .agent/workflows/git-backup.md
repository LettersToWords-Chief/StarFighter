---
description: how to back up Star Fighter to GitHub
---

# Git Backup — Star Fighter

Remote: `git@github.com:LettersToWords-Chief/StarFighter.git` (SSH, same key as PupPals)
Branch: `master`

## Steps

1. Stage all changes:
```
git add -A
```

2. Commit with a descriptive message (PowerShell uses `;` not `&&`):
```
git commit -m "your message here"
```

3. Push to GitHub:
```
git push
```

Combined one-liner (PowerShell):
```
git add -A; git commit -m "your message here"; git push
