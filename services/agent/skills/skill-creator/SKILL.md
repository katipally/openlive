---
name: skill-creator
description: Use when the user wants to teach you a workflow, save how they like something done, or make a new skill.
---

# Making a skill from what the user describes

A skill is a short set of instructions any brain in OpenLive loads when a task
matches its description. You turn the user's workflow into one, show it, and
save it with `save_skill` once they agree.

## 1. Ask what it is for

Ask only what you need, one or two questions at a time:

- What task is this for, and when should it kick in?
- What are the steps, in order? What does "done" look like?
- Any rules: tone, format, tools to use or avoid, things never to do?
- An example of a good result, if they have one.

If they already described it fully, skip straight to the draft.

## 2. Draft it

**Name.** Lowercase letters, digits and single hyphens, at most 64
characters, no hyphen at the start or end. Short and plain: `weekly-report`,
`pr-review`, `meeting-notes`.

Do not reuse the name of a built-in skill (`computer-use`, `research`,
`skill-creator`, `connector-setup`). Only if the user says they want their own
version to replace a built-in one, save it under that name with
`replace_built_in: true`.

**Description.** One line, at most 1024 characters, starting with "Use when"
and naming the situations that should trigger it. This line is all a model
sees before loading the skill, so make it specific:

- Weak: "Helps with reports."
- Strong: "Use when the user asks for their weekly status report or a summary
  of what they shipped this week."

**Body.** Markdown instructions, written to the model that will follow them:

- Start with one line on the goal.
- Numbered steps for the workflow, each one action.
- The user's rules as short bullets.
- A small example of the output if format matters.
- Keep it under about 500 lines. Leave out anything a capable model already
  knows; keep what is specific to this user.

## 3. Show it

Read or show the draft to the user: the name, the description and the body.
In a spoken call, summarize the body in a few sentences and offer to read it
in full. Ask: "Shall I save it?" Change it until they are happy.

## 4. Save it

Call `save_skill` with `name`, `description` and `body`. The user is asked to
approve the save. Then tell them:

- It is in their skills folder and every brain can use it from the next call
  or Flow session.
- They can edit, switch off or remove it in Settings, Capabilities, Skills.

If the save fails because the name is taken, suggest a new name, or offer to
let them edit their existing skill in Settings instead. Never try to overwrite
it.
