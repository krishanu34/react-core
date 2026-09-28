---
name: react_frontend
description: React component and hook patterns, state management and data fetching. Use when the task touches React, JSX/TSX, hooks, or a React state library.
---

## React Expert Context

You are working on a React application. Apply these conventions and patterns.

### Component Rules
- Always use **functional components** with hooks — never class components
- One component per file; file name matches the component name (PascalCase)
- Keep components small: if it needs more than ~100 lines, split it
- Co-locate test files: `Button.tsx` → `Button.test.tsx`
- Export components as **named exports** (not default) for better refactoring

### Hooks Patterns
- `useState` for simple local state; `useReducer` for complex state with multiple sub-values
- `useCallback` only when passing functions to memoized children — not everywhere
- `useMemo` only for expensive computations — don't memo simple values
- Extract logic into **custom hooks** (`useCart`, `useAuth`) to keep components clean
- Always clean up effects: `return () => cleanup()` inside `useEffect`

### State Management
- Local state first (`useState`/`useReducer`)
- Shared state across siblings → lift state up or use `useContext`
- Global state (many components, complex updates) → Zustand or Redux Toolkit
- Server state (fetching, caching) → React Query / TanStack Query — not `useEffect` + `useState`

### Performance
- Wrap expensive pure components with `React.memo` (but profile first)
- Avoid creating objects/arrays inline in JSX — they cause unnecessary re-renders
- Use `key` correctly: stable unique IDs, never array indices for dynamic lists
- Lazy-load heavy routes: `const Page = React.lazy(() => import('./Page'))`

### Pitfalls to Avoid
- Never mutate state directly — always produce new objects/arrays
- `useEffect` with async: create an inner async function, don't make the effect itself async
- Stale closures: add all referenced values to the dependency array, or use `useRef`
- Conditional hooks are forbidden — hooks must always run in the same order

### Tool Guidance
```bash
# Start dev server
npm run dev   # Vite
npm start     # CRA

# Build
npm run build

# Install common deps
npm install @tanstack/react-query zustand react-router-dom
```

### File Structure (feature-based, not type-based)
```
src/
  features/
    cart/
      CartPage.tsx
      CartItem.tsx
      useCart.ts
      cart.store.ts
  components/          # shared UI only
  hooks/               # shared custom hooks
  lib/                 # utilities, API clients
```
