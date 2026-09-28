---
name: typescript
description: TypeScript's type system: generics, utility and mapped types, type guards, discriminated unions, strict mode. Use when the task is about types rather than runtime behaviour.
---

## TypeScript Expert Context

You are working in TypeScript. Apply strict typing conventions throughout.

### tsconfig Baseline
```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "exactOptionalPropertyTypes": true,
    "target": "ES2022",
    "moduleResolution": "bundler",
    "esModuleInterop": true
  }
}
```
`strict: true` enables: `strictNullChecks`, `noImplicitAny`, `strictFunctionTypes`, and more. Enable it from day one.

### Naming & Structure
- `type` for unions, primitives, tuples: `type Status = 'active' | 'inactive'`
- `interface` for object shapes that may be extended: `interface User { id: number; name: string }`
- Both are equivalent for plain objects — pick one and be consistent
- `enum` is avoided by most teams — use `as const` objects instead:
  ```ts
  const Direction = { Up: 'UP', Down: 'DOWN' } as const
  type Direction = typeof Direction[keyof typeof Direction]
  ```

### Utility Types
```ts
Partial<User>           // all fields optional
Required<User>          // all fields required
Pick<User, 'id'|'name'> // only selected fields
Omit<User, 'password'>  // everything except selected fields
Record<string, User>    // dictionary / map
Readonly<User>          // immutable
NonNullable<T>          // removes null | undefined
ReturnType<typeof fn>   // infer function return type
Parameters<typeof fn>   // infer function parameter types
```

### Generic Patterns
```ts
// Generic function
function first<T>(arr: T[]): T | undefined {
  return arr[0]
}

// Generic interface
interface Repository<T, ID> {
  findById(id: ID): Promise<T | null>
  save(entity: T): Promise<T>
  delete(id: ID): Promise<void>
}

// Constrained generic
function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key]
}
```

### Type Guards & Narrowing
```ts
// Custom type guard
function isUser(value: unknown): value is User {
  return typeof value === 'object' && value !== null && 'id' in value
}

// Discriminated union — exhaustive switch
type Shape =
  | { kind: 'circle'; radius: number }
  | { kind: 'rect'; width: number; height: number }

function area(shape: Shape): number {
  switch (shape.kind) {
    case 'circle': return Math.PI * shape.radius ** 2
    case 'rect':   return shape.width * shape.height
    default: {
      const _exhaustive: never = shape  // compile error if a case is missing
      return _exhaustive
    }
  }
}
```

### Mapped & Conditional Types
```ts
// Mapped type: make all properties nullable
type Nullable<T> = { [K in keyof T]: T[K] | null }

// Conditional type
type IsString<T> = T extends string ? true : false

// Template literal types
type EventName = `on${Capitalize<string>}`  // 'onClick', 'onChange', etc.
```

### Async & Error Handling
```ts
// Result type instead of throw (functional style)
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E }

async function fetchUser(id: string): Promise<Result<User>> {
  try {
    const user = await db.user.findUnique({ where: { id } })
    if (!user) return { ok: false, error: new Error('Not found') }
    return { ok: true, value: user }
  } catch (e) {
    return { ok: false, error: e as Error }
  }
}

// Caller handles both cases explicitly
const result = await fetchUser(id)
if (!result.ok) { /* handle error */ return }
console.log(result.value.name)  // type-safe: TS knows value exists here
```

### Tool Guidance
```bash
tsc --noEmit          # type check only (fast feedback)
tsc --watch           # watch mode
npx ts-node file.ts   # run TS directly
npx tsx file.ts       # faster alternative (esbuild-based)
```

### Pitfalls
- `as SomeType` (type assertions) disables type checking — use type guards instead
- `any` spreads through the codebase — prefer `unknown` and narrow with guards
- Non-null assertion `!` hides real bugs — only use when you've truly verified it can't be null
- `Object` type accepts everything including primitives — use `object` (lowercase) or be specific
