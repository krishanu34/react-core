---
name: nodejs_backend
description: Node.js service conventions across Express, NestJS and Fastify: middleware, module layout, package management. Use when building or fixing a Node backend.
---

## Node.js Backend Expert Context

You are working on a Node.js backend. Apply these conventions across Express, NestJS, and Fastify.

### Express (lightweight APIs)
```ts
import express, { Request, Response, NextFunction } from 'express'
import { z } from 'zod'

const app = express()
app.use(express.json())

const CreateProductSchema = z.object({
  name: z.string().min(1),
  price: z.number().positive(),
})

app.post('/products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = CreateProductSchema.parse(req.body)  // throws ZodError if invalid
    const product = await db.product.create({ data: body })
    res.status(201).json(product)
  } catch (err) {
    next(err)  // always pass to error middleware
  }
})

// Global error handler — must have 4 params
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) return res.status(400).json({ errors: err.errors })
  res.status(500).json({ message: err.message })
})
```

### NestJS (structured, enterprise-scale)
```ts
@Controller('products')
@UseGuards(JwtAuthGuard)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateProductDto): Promise<Product> {
    return this.productsService.create(dto)
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number): Promise<Product> {
    return this.productsService.findOne(id)
  }
}
```
- Controllers handle HTTP only — business logic lives in services
- Use `class-validator` + `ValidationPipe` for DTO validation
- Modules scope providers: `ProductsModule` provides `ProductsService`, `ProductsRepository`

### Async Patterns
```ts
// Run independent async ops in parallel — never await in a loop
const [user, products] = await Promise.all([
  db.user.findUnique({ where: { id } }),
  db.product.findMany({ where: { userId: id } }),
])

// Stream large datasets instead of loading into memory
app.get('/export', async (req, res) => {
  const stream = db.product.findManyStream()
  pipeline(stream, csv.stringify(), res, (err) => {
    if (err) console.error(err)
  })
})
```

### Prisma ORM
```ts
// schema.prisma
model Product {
  id        Int      @id @default(autoincrement())
  name      String
  price     Float
  createdAt DateTime @default(now())
}

// Usage
const products = await prisma.product.findMany({
  where: { price: { gte: 10 } },
  include: { category: true },  // eager load relation
  orderBy: { createdAt: 'desc' },
  take: 20, skip: offset,       // pagination
})
```
- Always use `prisma.$transaction()` for multi-step writes that must be atomic
- `findUnique` vs `findFirst`: `findUnique` only works on unique/ID fields; `findFirst` for any query

### Project Structure
```
src/
  routes/            # one file per resource
  controllers/       # request parsing, response formatting
  services/          # business logic
  middleware/        # auth, validation, logging, error handling
  models/            # DB schema (Prisma schema or ORM models)
  lib/               # DB client, external API clients
  app.ts             # Express setup
  server.ts          # listen()
```

### Tool Guidance
```bash
npm run dev          # nodemon or tsx watch
npm run build        # tsc
npx prisma migrate dev --name "add_products"
npx prisma studio    # visual DB browser
npm test             # jest
```

### Pitfalls
- Unhandled promise rejections — always `try/catch` in async route handlers or use `express-async-errors`
- `req.body` is `undefined` without `express.json()` middleware
- Putting business logic in route handlers — hard to test; move to services
- `process.exit(1)` in middleware — let the process manager restart cleanly
