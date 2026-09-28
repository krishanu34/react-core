---
name: bug_fixing
description: Systematic root-cause analysis for a defect. Use when something is broken, crashing, throwing, failing a test, or behaving unexpectedly.
---

## Bug Fixing Expert Context

You are debugging and fixing a bug. Apply systematic root-cause analysis.

### Debugging Process (always follow this order)
1. **Reproduce** — find the exact input/state that triggers the bug. If you can't reproduce it, you can't fix it.
2. **Isolate** — narrow the scope. Which function? Which line? Binary search with logs or a debugger.
3. **Understand** — read the actual error message carefully. It tells you the type, the location, and often the reason.
4. **Hypothesize** — form one specific hypothesis. "I think X is null because Y."
5. **Verify** — prove the hypothesis with a log, assertion, or test before changing anything.
6. **Fix** — make the minimal change that addresses the root cause.
7. **Confirm** — reproduce the original bug scenario to verify it's gone. Add a regression test.

### Reading Error Messages
```
AttributeError: 'NoneType' object has no attribute 'name'
                 ^^^^^^^^
                 Something is None that you expected to be an object.
                 Look at what returned None — find the last assignment.

KeyError: 'user_id'
          ^^^^^^^^
          Dictionary doesn't have this key. Use .get() or check membership first.

TypeError: cannot unpack non-iterable NoneType object
           The right side of a = b, c assignment returned None.

UnboundLocalError: local variable 'result' referenced before assignment
                   You have a conditional path that never assigns 'result'.
```

### Common Bug Patterns

**None/null not checked before use**:
```python
# Bug
user = db.find_user(id)
print(user.name)  # AttributeError if user is None

# Fix
user = db.find_user(id)
if user is None:
    raise ValueError(f"User {id} not found")
print(user.name)
```

**Off-by-one errors**:
```python
# Bug: skips last element
for i in range(0, len(items) - 1):

# Fix
for i in range(len(items)):
# or just
for item in items:
```

**Async not awaited**:
```ts
// Bug: result is a Promise, not the value
const user = fetchUser(id)
console.log(user.name)  // undefined

// Fix
const user = await fetchUser(id)
```

**Shared mutable state**:
```ts
// Bug: all instances share the same array
class Cart {
  items = []  // class field — shared reference in some patterns
}

// Fix: initialize in constructor
class Cart {
  items: Item[]
  constructor() { this.items = [] }
}
```

**Race condition**:
```ts
// Bug: two async ops both read stale state
async function increment(id: string) {
  const current = await db.get(id)
  await db.set(id, current + 1)  // another request may have incremented between these two lines
}

// Fix: atomic update
async function increment(id: string) {
  await db.increment(id, 1)  // DB-level atomic operation
}
```

**Wrong comparison**:
```ts
if (value == null) // catches both null AND undefined — usually what you want
if (value === null) // only null — undefined passes through
if (!value) // catches null, undefined, 0, '', false — usually too broad
```

### Adding Debug Logging
When you need to trace a bug, add targeted logging (remove before committing):
```python
print(f"[DEBUG] user={user!r}")     # !r shows type info: 'None' vs "'admin'"
print(f"[DEBUG] items count={len(items)}, first={items[0] if items else 'EMPTY'}")
```

```ts
console.log('[DEBUG] response:', JSON.stringify(response, null, 2))
console.log('[DEBUG] typeof result:', typeof result, result)
```

### Writing a Regression Test
After fixing a bug, always add a test that would have caught it:
```python
def test_find_user_returns_none_for_missing_id():
    # This test would have caught the AttributeError before the fix
    result = db.find_user("nonexistent-id")
    assert result is None  # not an exception
```

### Tool Guidance
```bash
# Python debugger — set a breakpoint in code
import pdb; pdb.set_trace()
# or: python -m pdb script.py

# Node.js debugger
node --inspect-brk server.js   # then open chrome://inspect

# Check recent changes that might have introduced the bug
git log --oneline -20
git diff HEAD~5 -- path/to/file.py
git bisect start  # binary search through commits
```

### Pitfalls
- Fixing symptoms instead of the root cause — always ask "why did this happen?"
- Adding null checks everywhere without understanding why a value is null
- Changing multiple things at once — change one thing, verify, then move to the next
- Not adding a regression test — the bug will come back
