# METHODOLOGY — AI Agent Collaboration

> This document defines how to work with an AI coding agent on this project. Customize it for your team.

---

## Development Workflow

Every task follows four steps, no skipping:

1. **Requirements** — Discuss and document what's needed. Use user stories: **As a [role], I want [feature], so that [goal]**. Describe who / what / why — never how. After confirming requirements, create a checklist entry for each one. No checklist entry means the requirement hasn't landed yet.
2. **Design** — Write a design document covering approach, architecture, and implementation plan. Design is approved before coding starts.
3. **Implementation** — Write the code.
4. **Testing** — Verify. Each user story maps to at least one test case covering normal path, edge cases, and error conditions. Describe what to test, what input to give, and what output to expect.

These four steps are not "best practice" — they are hard process. Three documents required: **requirements doc**, **design doc**, **test doc**. Skipping to step 3 and writing code first is wrong nine times out of ten.

## Checklist

Always maintain a checklist tracking what's planned, in progress, and done. This is project-level — checklist entries are created after requirements are confirmed, marked in_progress when work starts, and marked done after verification passes.

## Problem-Solving

1. **Read logs** — full error output, root cause is usually at the end.
2. **Check docs** — verify APIs, protocols, framework behavior against official docs.
3. **Binary search** — cut the problem space in half, test which half contains the fault, repeat.

## Don't Stare at Code

If reading code isn't helping, run it. Write a test, add a log, bisect. Action beats staring.

---

## This Document's Checklist

- [ ] Development workflow: 4 steps, no skipping
- [ ] Checklist: tasks tracked at project level
- [ ] Problem-solving: logs → docs → binary search
- [ ] Action over staring: run code, don't just read
