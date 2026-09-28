---
name: database
description: Schema design, migrations, indexing, transactions and query optimisation across SQL and NoSQL. Use when the task touches tables, migrations, ORMs, or slow queries.
---

## Database Expert Context

You are working on database design, migrations, and query optimization.

### Schema Design Principles
- Every table needs: `id` (PK), `created_at`, `updated_at` — add them by default
- Normalize to 3NF first; denormalize only when profiling proves a bottleneck
- Use appropriate types: `VARCHAR(255)` for emails, `TEXT` for long content, `DECIMAL(10,2)` for money (never FLOAT)
- Nullable columns are a design smell — ask why the value can be absent before adding `NULL`
- Prefix junction tables with both entity names: `user_roles`, `product_tags`

### Migration Rules
- **Always write both `up` and `down` migrations** — rollback must work
- Migrations are immutable once merged — create a new migration to fix a bad one
- For large tables: adding a nullable column is safe; adding NOT NULL with no default is a table lock
- Safe column rename: add new column → backfill → update app → drop old column (3 deploys)
- Test migrations on a copy of production data before deploying

### Indexes
```sql
-- Index every foreign key
CREATE INDEX idx_orders_user_id ON orders(user_id);

-- Composite index: column order matters — most selective first
CREATE INDEX idx_orders_status_date ON orders(status, created_at DESC);

-- Partial index: only index the rows you query
CREATE INDEX idx_orders_pending ON orders(created_at) WHERE status = 'pending';

-- Unique constraint creates an index automatically
ALTER TABLE users ADD CONSTRAINT unique_email UNIQUE (email);
```
- Index columns used in `WHERE`, `JOIN ON`, `ORDER BY`, `GROUP BY`
- Over-indexing slows writes — don't index low-cardinality columns (boolean, enum)
- Use `EXPLAIN ANALYZE` to verify the query planner uses your index

### Query Patterns
```sql
-- Pagination: keyset is faster than OFFSET for large tables
SELECT * FROM products
WHERE id > :last_seen_id
ORDER BY id ASC
LIMIT 20;

-- Avoid N+1: use JOINs or subqueries to fetch related data in one query
SELECT u.*, COUNT(o.id) AS order_count
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
GROUP BY u.id;

-- Upsert (insert or update)
INSERT INTO products (id, name, price) VALUES (1, 'Widget', 9.99)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, price = EXCLUDED.price;
```

### Transactions
```sql
BEGIN;
  UPDATE accounts SET balance = balance - 100 WHERE id = 1;
  UPDATE accounts SET balance = balance + 100 WHERE id = 2;
  -- If any statement fails, ROLLBACK automatically; otherwise COMMIT
COMMIT;
```
- Keep transactions short — long transactions hold locks and block other writers
- Deadlock prevention: always acquire locks in the same order across all transactions

### PostgreSQL-Specific
- `JSONB` for semi-structured data (searchable, indexable); `JSON` only for storing raw strings
- `SERIAL` / `BIGSERIAL` for auto-increment; prefer `gen_random_uuid()` for distributed systems
- `RETURNING` clause: `INSERT INTO ... RETURNING id, created_at`
- Use `pg_dump` / `pg_restore` for backups, not raw SQL exports for large datasets

### Tool Guidance
```bash
# Alembic (Python)
alembic revision --autogenerate -m "add products table"
alembic upgrade head
alembic downgrade -1

# Prisma (Node.js)
npx prisma migrate dev --name "add_products"
npx prisma migrate deploy       # production
npx prisma db pull              # introspect existing DB

# psql
psql -d mydb -c "EXPLAIN ANALYZE SELECT ..."
```

### Common Mistakes
- Using `SELECT *` in production code — always list columns explicitly
- Storing comma-separated values in a column — use a junction table
- Not using connection pooling — use PgBouncer or the ORM's pool settings
- Missing `WHERE` clause in `UPDATE`/`DELETE` — always double-check before running
