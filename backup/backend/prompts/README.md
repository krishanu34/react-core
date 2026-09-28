# Prompts System

All agent instructions are stored as `.md` files — no hardcoding in Python. Edit a prompt,
restart the server (or call `PromptLoader.clear_cache()`), and the change takes effect.

---

## Structure

```
prompts/
├── loader.py              # PromptLoader — loads, caches, substitutes variables
├── tool_use_agent.md      # Base system prompt for the agent (used every request)
├── react_agent.md         # ReAct fallback prompt (AGENT_MODE=react)
├── orchestrator.md        # Orchestrator-level prompt
├── planning.md            # Planning prompt
└── skills/                # Domain skill overlays — injected per request
    ├── react_frontend.md
    ├── nextjs.md
    ├── vue_frontend.md
    ├── angular_frontend.md
    ├── python_backend.md
    ├── nodejs_backend.md
    ├── database.md
    ├── data_science.md
    ├── api_design.md
    ├── devops.md
    ├── typescript.md
    ├── mobile.md
    ├── testing.md
    ├── code_review.md
    ├── bug_fixing.md
    └── security.md
```

---

## Base Prompts vs. Skill Overlays

### Base Prompts (`prompts/*.md`)

Loaded once per agent run. Defines the agent's identity, phases, and general rules.

```python
from prompts.loader import PromptLoader

prompt = PromptLoader.load(
    "tool_use_agent",
    tool_descriptions="...",
    memory_context="...",
)
```

### Skill Overlays (`prompts/skills/*.md`)

Injected **on top of** the base prompt when the user's message matches a domain.
Detected automatically by `agents/skill_detector.py` — zero configuration.

```
User: "fix the bug in my React component"
         ↓
  Detector matches: react_frontend + bug_fixing
         ↓
  Final system prompt = tool_use_agent.md
                      + "## Domain Expertise"
                      + react_frontend.md
                      + bug_fixing.md
```

Skills are loaded the same way as base prompts — just with a subdirectory prefix:

```python
skill = PromptLoader.load("skills/react_frontend")
```

---

## PromptLoader

```python
from prompts.loader import PromptLoader

# Load a base prompt with variable substitution
prompt = PromptLoader.load("tool_use_agent", tool_descriptions="...", memory_context="...")

# Load a skill overlay (no variables)
skill = PromptLoader.load("skills/react_frontend")

# List all available prompts (base + skills)
all_prompts = PromptLoader.list_available()

# Force re-read from disk (useful during development)
PromptLoader.clear_cache()
```

**Caching:** First load reads from disk. Subsequent loads return the cached string.
Cache is process-wide — shared across all requests. `clear_cache()` clears everything.

**Variable substitution:** Use `{variable_name}` in `.md` files. Pass values as `**kwargs`
to `PromptLoader.load()`. Missing variables raise `KeyError`. Extra kwargs are ignored.

---

## 16 Domain Skills

Each skill file teaches the agent expert-level conventions for one domain. Skills are
concise (40-80 lines) and actionable — patterns, pitfalls, tool commands.

| File | Covers |
|---|---|
| `react_frontend.md` | Hooks patterns, state management, performance, file structure |
| `nextjs.md` | App Router, Server Components, data fetching, Server Actions |
| `vue_frontend.md` | Composition API, Pinia, Vue Router, composables |
| `angular_frontend.md` | Signals, RxJS operators, DI, standalone components |
| `python_backend.md` | FastAPI endpoints, SQLAlchemy 2.0, async patterns, Alembic |
| `nodejs_backend.md` | Express middleware, NestJS modules, Prisma, error handling |
| `database.md` | Schema design, migration safety, indexing, N+1 prevention |
| `data_science.md` | Pandas/NumPy ops, ML pipeline, visualization, vectorization |
| `api_design.md` | URL conventions, HTTP status codes, pagination, versioning |
| `devops.md` | Dockerfile best practices, GitHub Actions, nginx, secrets |
| `typescript.md` | Strict mode, utility types, generics, discriminated unions |
| `mobile.md` | React Native FlatList, expo APIs, Flutter widgets, navigation |
| `testing.md` | AAA pattern, what to mock, Jest/pytest/Playwright examples |
| `code_review.md` | SOLID, extract function, guard clauses, code smells |
| `bug_fixing.md` | Debugging process, reading errors, regression tests |
| `security.md` | JWT, bcrypt, input validation, OWASP Top 10, CORS |

---

## Adding a New Skill

**Step 1** — Create the `.md` file:

```markdown
<!-- prompts/skills/graphql.md -->
## GraphQL Expert Context

You are working with GraphQL. Apply these conventions.

### Schema Design
- Use descriptive type names: `Product`, not `ProductType`
- ...

### Resolvers
- Keep resolvers thin — delegate to services
- ...

### Tool Guidance
'''bash
npm install @apollo/server graphql
'''
```

**Step 2** — Register it in `agents/skill_detector.py`:

```python
"graphql": {
    "priority": 6,
    "keywords": [
        "graphql", "apollo", "schema", "resolver", "query",
        "mutation", "subscription", "gql`", "typedefs",
    ],
    "file_ext": [".graphql", ".gql"],
},
```

**Step 3** — Done. No other code changes needed.

---

## Guidelines for Writing Skill Files

- **Be specific, not generic.** "Use functional components" beats "write good code."
- **Include runnable examples.** A 10-line code block teaches more than a paragraph.
- **List the anti-patterns.** The "Pitfalls" section is as valuable as the rules.
- **Add tool commands.** Developers copy-paste from the CLI section.
- **Keep it under 80 lines.** A skill is focused expertise, not a textbook chapter.
- **No markdown headers above `##`.** The base prompt injects skills under its own `##` section.
