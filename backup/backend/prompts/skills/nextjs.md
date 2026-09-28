---
name: nextjs
description: Next.js App Router conventions: server/client components, server actions, route handlers, middleware. Use when the project is Next.js or the task names page.tsx/layout.tsx.
---

## Next.js Expert Context

You are working on a Next.js application. Apply App Router conventions (Next.js 13+).

### App Router vs Pages Router
- **App Router** (`app/`) — default for Next.js 13+. Use this unless the project already uses `pages/`
- Files: `page.tsx` (route UI), `layout.tsx` (shared shell), `loading.tsx`, `error.tsx`, `not-found.tsx`
- Colocation: place components next to the page that uses them inside `app/`

### Server vs Client Components
- Everything in `app/` is a **Server Component by default** — runs on the server, zero JS to client
- Add `"use client"` at the top only when you need: `useState`, `useEffect`, event handlers, browser APIs
- Push `"use client"` as far down the tree as possible — keep parents as server components
- Server Components can `async` and `await` directly — no `useEffect` for data fetching

### Data Fetching
```tsx
// Server Component — fetch directly, no useEffect
async function ProductPage({ params }: { params: { id: string } }) {
  const product = await db.product.findUnique({ where: { id: params.id } })
  return <ProductDetail product={product} />
}
```
- Use `cache()` to deduplicate identical requests in one render pass
- `revalidate` options: `{ next: { revalidate: 60 } }` for ISR, `{ cache: 'no-store' }` for dynamic

### Route Handlers (`app/api/route.ts`)
```ts
export async function GET(request: Request) {
  return Response.json({ data })
}
export async function POST(request: Request) {
  const body = await request.json()
  return Response.json({ ok: true }, { status: 201 })
}
```

### Server Actions
```tsx
"use server"
export async function createPost(formData: FormData) {
  // runs on server, can call DB directly
  await db.post.create({ data: { title: formData.get('title') as string } })
  revalidatePath('/posts')
}
```

### Routing
- `[slug]` — dynamic segment
- `[...slug]` — catch-all segment
- `(group)` — route group (doesn't affect URL)
- `@modal` — parallel routes (advanced modals)

### Performance
- Images: always use `next/image` — handles lazy loading, sizing, and WebP conversion
- Fonts: `next/font` loads fonts at build time with zero layout shift
- Links: use `next/link` for client-side navigation
- Static assets in `public/` are served with cache headers automatically

### Tool Guidance
```bash
npm run dev       # development server (hot reload)
npm run build     # production build
npm run start     # run production build locally
npx next lint     # lint with Next.js rules
```

### Common Pitfalls
- Importing a Server Component inside a Client Component — wrap it in a slot/children prop instead
- Using `useRouter` from `next/navigation` (App Router), NOT `next/router` (Pages Router)
- Missing `"use client"` on components using hooks — check the error message carefully
- `params` and `searchParams` are async in Next.js 15 — always `await` them
