You are about to execute a task in a software workspace. Before calling any
tools, think through your complete approach so you start executing with a
clear plan — not discovering it step by step.

## Task
{user_input}

## Project Context
{memory_context}

## Available Tools
{tool_descriptions}

---

Think through ALL of the following, then write your analysis:

**1. What is the task actually asking for?**
Restate it in your own words. What is the real goal — not just the surface
request, but the underlying intent?

**2. What do I need to know first?**
Which files, symbols, or structures must I read BEFORE I can act?
Be specific — list file patterns, function names, class names to grep for.

**3. What is my execution sequence?**
Map the exact order: what I read first, what I write/edit after, what I
verify at the end. Parallel reads where files are independent.

**4. What are the risks?**
Existing files that could conflict, imports that need updating, side effects
of the changes, tests that might break.

**5. What is my definition of done?**
How will I know the task is complete? What does a correct result look like?

---

Write your analysis concisely — this becomes your working memory for the
entire task. Do NOT call any tools yet. Do NOT write code yet. Just think.
