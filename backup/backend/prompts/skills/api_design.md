---
name: api_design
description: REST/GraphQL contract design: resources, versioning, status codes, pagination, rate limits, OpenAPI. Use when designing or reviewing an API surface.
---

## API Design Expert Context

You are designing or implementing a REST API. Apply these conventions.

### URL Design
```
GET    /products              → list (paginated)
POST   /products              → create
GET    /products/:id          → get one
PATCH  /products/:id          → partial update
PUT    /products/:id          → full replace
DELETE /products/:id          → delete

GET    /users/:id/orders      → nested resource (user's orders)
POST   /orders/:id/cancel     → action that doesn't map to CRUD
```
- Nouns, plural, lowercase, hyphens: `/product-reviews` not `/productReviews`
- Nest at most 2 levels deep — deeper nesting becomes unwieldy
- Actions that aren't CRUD: use a verb as the last segment (`/orders/:id/cancel`, `/users/:id/verify-email`)

### HTTP Status Codes
```
200 OK              — GET, PATCH, PUT success (returns body)
201 Created         — POST success (return created resource + Location header)
204 No Content      — DELETE success (no body)
400 Bad Request     — malformed request / validation failure (return error details)
401 Unauthorized    — not authenticated (missing/invalid token)
403 Forbidden       — authenticated but not authorized
404 Not Found       — resource doesn't exist
409 Conflict        — duplicate resource / state conflict
422 Unprocessable   — well-formed but semantically invalid
429 Too Many Reqs   — rate limit hit
500 Internal Error  — unexpected server error (never leak stack traces)
```

### Request & Response Shape
```json
// List response — always wrap in an envelope for pagination metadata
{
  "data": [...],
  "pagination": {
    "total": 1042,
    "page": 1,
    "per_page": 20,
    "next_cursor": "eyJpZCI6MjB9"
  }
}

// Error response — consistent shape for all errors
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request validation failed",
    "details": [
      { "field": "price", "message": "must be a positive number" }
    ]
  }
}
```

### Pagination
- **Cursor-based** (recommended for large/live datasets): `GET /posts?after=cursor123&limit=20`
  - Stable under concurrent inserts/deletes
  - Can't jump to arbitrary pages (usually fine)
- **Offset-based** (simple, supports page jumps): `GET /posts?page=5&per_page=20`
  - Skips/duplicates records when data changes while paginating

### Versioning
- URL versioning: `/api/v1/products` — simple, visible, cacheable
- Header versioning: `Accept: application/vnd.myapi.v2+json` — clean URLs but harder to test
- **Never break a published version** — add fields freely (backwards compatible), never remove or rename

### Authentication
```
Authorization: Bearer <jwt_token>
```
- JWT: stateless, good for microservices. Validate signature + expiry on every request.
- Session tokens: store in HttpOnly cookies — not localStorage (XSS-safe)
- API keys for machine-to-machine: long random strings, store hashed in DB

### Rate Limiting Headers
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 47
X-RateLimit-Reset: 1716998400
Retry-After: 30          (when 429 is returned)
```

### OpenAPI / Swagger
Always document your API with an OpenAPI spec. FastAPI generates it automatically at `/docs`.
For Express/Node: use `swagger-jsdoc` + `swagger-ui-express`.

### Pitfalls
- Returning `200 OK` with `{ "success": false }` — use proper HTTP status codes
- Leaking internal errors in 500 responses — log internally, return generic message to client
- Using `GET` for state-changing operations — they get cached and can be triggered by prefetching
- No idempotency for `POST` — add an `Idempotency-Key` header for payment/order creation
- Inconsistent naming across endpoints — decide camelCase or snake_case and stick to it
