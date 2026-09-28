---
name: code_review
description: Review and refactoring standards: SOLID, DRY, naming, complexity, technical debt. Use when asked to review, clean up, refactor, or improve existing code.
---

## Code Review & Refactoring Expert Context

You are reviewing or refactoring code. Apply these principles systematically.

### Review Checklist

**Correctness**
- Does the code do what it's supposed to do?
- Are all edge cases handled: empty input, null/undefined, zero, negative numbers, max values?
- Are concurrent operations thread-safe / race-condition free?
- Is error handling present and correct (not swallowing exceptions silently)?

**Readability**
- Can a new team member understand this without reading comments?
- Are names descriptive and intention-revealing? (`getUsersWithActiveSubscriptions` not `getUsers2`)
- Is the code at one level of abstraction per function?
- Are magic numbers extracted to named constants?

**Design**
- Single Responsibility: does each function/class do exactly one thing?
- Is there duplication that should be extracted? (Rule of Three: extract on the third repeat)
- Are abstractions at the right level — not too early, not too late?
- Is the dependency direction sensible (no circular deps, high-level modules don't depend on low-level details)?

**Performance** (check only if there's evidence of a problem)
- Are there N+1 queries (fetching in a loop)?
- Is there unnecessary work inside a hot loop?
- Are large collections handled with pagination/streaming?

### Common Refactoring Patterns

**Extract Function** — when a block of code needs a comment to explain it:
```ts
// Before
const tax = price * 0.08  // 8% tax

// After
const TAX_RATE = 0.08
function calculateTax(price: number): number {
  return price * TAX_RATE
}
```

**Replace Conditional with Polymorphism** — when switching on type repeatedly:
```ts
// Before
function render(shape: Shape) {
  if (shape.type === 'circle') return renderCircle(shape)
  if (shape.type === 'rect')   return renderRect(shape)
}

// After
interface Renderable { render(): string }
class Circle implements Renderable { render() { return `circle(${this.radius})` } }
class Rect   implements Renderable { render() { return `rect(${this.w}×${this.h})` } }
```

**Guard Clauses** — reduce nesting by returning early:
```ts
// Before
function process(user) {
  if (user) {
    if (user.active) {
      if (user.hasPermission) {
        doWork(user)
      }
    }
  }
}

// After
function process(user) {
  if (!user)               return
  if (!user.active)        return
  if (!user.hasPermission) return
  doWork(user)
}
```

**Introduce Parameter Object** — when a function has 4+ parameters:
```ts
// Before
function createOrder(userId, productId, quantity, couponCode, shippingAddress) { ... }

// After
interface OrderParams { userId: string; productId: string; quantity: number; couponCode?: string; shippingAddress: string }
function createOrder(params: OrderParams) { ... }
```

**Replace Magic Number with Named Constant**:
```ts
// Before: what is 86400?
if (ageInSeconds > 86400) { ... }

// After: obvious
const SECONDS_PER_DAY = 86400
if (ageInSeconds > SECONDS_PER_DAY) { ... }
```

### Code Smells to Flag
| Smell | What it looks like | Fix |
|---|---|---|
| Long function | >20 lines, multiple levels of nesting | Extract functions |
| Long parameter list | >3-4 parameters | Parameter object |
| Duplicated code | Same logic in multiple places | Extract to shared function |
| Dead code | Commented-out blocks, unused variables | Delete it |
| God class | One class doing everything | Split by responsibility |
| Feature envy | Method uses another class's data more than its own | Move the method |
| Primitive obsession | Passing strings for IDs, emails, currencies | Wrap in value objects |

### Giving Review Feedback
- Be specific: point to the exact line and explain why it's a concern
- Suggest a fix, don't just flag the problem
- Distinguish: blocker (must fix), suggestion (nice to have), question (need clarification)
- Don't nitpick style issues if a linter/formatter handles them — let the tool do it

### Tool Guidance
```bash
# Check for unused exports/vars
npx ts-prune          # unused TypeScript exports
npx knip              # dead code, unused deps

# Complexity metrics
npx eslint --rule 'complexity: ["warn", 10]'
radon cc -s -a .      # Python cyclomatic complexity

# Formatting (let the tool handle style)
npx prettier --write .
black .               # Python
```
