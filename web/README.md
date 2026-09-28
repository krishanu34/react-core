# ReACT-core Web (MVP)

Bell.ca-inspired Next.js UI for the ReACT-core AI-for-QA agent.

Scope of this MVP:

- No authentication (guest-only)
- Start a conversation
- Attach files (PDF · DOCX · TXT · MD · CSV · JSON · HTML)
- Send text input
- Local echo assistant reply — backend wiring comes next

## Stack

- Next.js 15 (App Router) + React 19
- TypeScript
- Tailwind CSS 4
- lucide-react icons

## Getting started

```bash
cd web
npm install
npm run dev
```

Then open <http://localhost:3000>.

## Layout

```
web/
├─ src/
│  ├─ app/
│  │  ├─ globals.css      # Bell.ca theme tokens + Tailwind
│  │  ├─ layout.tsx       # Root layout
│  │  └─ page.tsx         # Chat screen
│  └─ components/
│     ├─ BellLogo.tsx
│     ├─ Header.tsx
│     ├─ Footer.tsx
│     ├─ Chat.tsx         # Conversation shell + empty state
│     ├─ ChatInput.tsx    # Textarea + attachment picker + Send
│     └─ MessageBubble.tsx
├─ next.config.ts
├─ postcss.config.mjs
├─ tsconfig.json
└─ package.json
```

## Theme

Palette (see `src/app/globals.css`):

| Token              | Hex       | Use                         |
| ------------------ | --------- | --------------------------- |
| `bell-blue`        | `#0057B8` | Primary, buttons, accents   |
| `bell-blue-dark`   | `#003D82` | Hover / active              |
| `bell-blue-soft`   | `#E8F1FB` | Surfaces, chips             |
| `bell-ink`         | `#1A1A1A` | Body text                   |
| `bell-slate`       | `#4A4A4A` | Secondary text              |
| `bell-muted`       | `#767676` | Tertiary text, placeholders |
| `bell-border`      | `#DDDDDD` | Dividers                    |
| `bell-surface`     | `#FFFFFF` | Cards, chat body            |
| `bell-chrome`      | `#F5F7FA` | Page background             |
| `bell-accent`      | `#FFB81C` | Focus ring only             |

## Next steps

- Wire `POST /api/agent/stream` and handle SSE events
- Persist thread IDs
- Add attachment upload → server
- Wire `ask_user` checkpoint UI

## Runtime configuration

The backend URL is **read at request time**, not baked into the build.

```
# web/.env.local
API_BASE_URL=http://localhost:8080
```

Flow:

1. The root layout (server component, `dynamic = "force-dynamic"`) reads
   `process.env.API_BASE_URL` on every request via `src/lib/runtime-env.ts`.
2. It injects a `<script>` tag setting `window.__ENV__ = { API_BASE_URL }`.
3. The API client (`src/lib/api.ts`) reads `window.__ENV__.API_BASE_URL`
   at every call.

Consequences:

- Build the Next.js bundle **once**.
- To change the backend URL: edit `.env.local` (dev) or set the env var
  (Docker/PM2/systemd) and restart the Node process — no rebuild needed.
- `docker run -e API_BASE_URL=https://backend.prod:8080 …` works.

## Known advisories

`npm audit` reports one transitive `postcss` advisory nested under
`next/node_modules/postcss`. It's Next.js 15.x's bundled build-time PostCSS
and only affects untrusted CSS sources at build. The clean fix is Next.js 16
(breaking change) — will be picked up in a future upgrade sweep.
