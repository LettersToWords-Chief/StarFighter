---
description: On-demand conversation logger — write a verbatim transcript of the current session to a log file on user request
---

# Session Log Workflow

## When to run
User says something like "save the conversation", "log this", or invokes `/session-log`.

## Log file location
`c:\Star Fighter\.agent\logs\conversation_log.txt`

## What to write
A **verbatim transcript** of the conversation — exactly what the user said and exactly what the AI responded, in order. No summarizing, no filtering, no editorial judgment. Every turn captured as written.

## Format
```
=== STAR FIGHTER CONVERSATION TRANSCRIPT ===
Session date: YYYY-MM-DD

---

[HH:MM] USER: <exact words>

[HH:MM] AI: <exact response as sent>

---

[HH:MM] USER: <next message>
...
```

## How to write it
Use `write_to_file` with `Overwrite: true`. This is a silent operation — no shell commands, no prompts.

## Important rules
- Verbatim means verbatim. Do not paraphrase, summarize, or decide what matters.
- Include the full AI response text, not a description of it.
- If appending to an existing log, include a session separator: `=== NEW SESSION: YYYY-MM-DD ===`
