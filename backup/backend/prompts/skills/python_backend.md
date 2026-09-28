---
name: python_backend
description: Python service conventions across FastAPI, Django and Flask: Pydantic, SQLAlchemy, async, packaging. Use when building or fixing a Python backend.
---

## Python Backend Expert Context

You are working on a Python backend. Apply these conventions across FastAPI, Django, and Flask.

### FastAPI (primary framework)
```python
from fastapi import FastAPI, Depends, HTTPException, status
from pydantic import BaseModel

app = FastAPI()

class ProductCreate(BaseModel):
    name: str
    price: float

class ProductResponse(BaseModel):
    id: int
    name: str
    price: float
    model_config = {"from_attributes": True}

@app.post("/products", response_model=ProductResponse, status_code=status.HTTP_201_CREATED)
async def create_product(body: ProductCreate, db: Session = Depends(get_db)):
    product = Product(**body.model_dump())
    db.add(product)
    db.commit()
    db.refresh(product)
    return product
```
- Use `response_model` on every endpoint — it validates and shapes the response
- Separate input schemas (`ProductCreate`) from response schemas (`ProductResponse`)
- Use `Depends()` for: DB sessions, auth, pagination params, shared validation
- Return `status.HTTP_*` constants, not raw integers

### SQLAlchemy 2.0 (modern style)
```python
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

class Base(DeclarativeBase):
    pass

class Product(Base):
    __tablename__ = "products"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(nullable=False)
    price: Mapped[float]
```
- Use `Mapped[type]` annotations — they replace `Column()` in SQLAlchemy 2.0
- Always use `db.refresh(obj)` after `commit()` to reload server-generated fields (id, timestamps)
- Avoid N+1: use `selectinload()` or `joinedload()` for relationships

### Async Patterns
```python
import asyncio
import httpx

async def fetch_many(urls: list[str]) -> list[dict]:
    async with httpx.AsyncClient() as client:
        tasks = [client.get(url) for url in urls]
        responses = await asyncio.gather(*tasks)
    return [r.json() for r in responses]
```
- `asyncio.gather()` for parallel I/O — don't `await` one by one in a loop
- Use `async with` for resources that need cleanup (DB connections, HTTP clients)
- Background tasks in FastAPI: `BackgroundTasks` for fire-and-forget, Celery for reliable queuing

### Error Handling
```python
from fastapi import HTTPException

# Raise 404 explicitly
product = db.get(Product, product_id)
if product is None:
    raise HTTPException(status_code=404, detail=f"Product {product_id} not found")

# Global exception handler
@app.exception_handler(ValueError)
async def value_error_handler(request, exc):
    return JSONResponse(status_code=422, content={"detail": str(exc)})
```

### Project Structure
```
app/
  main.py            # FastAPI app, middleware, router includes
  models/            # SQLAlchemy ORM models
  schemas/           # Pydantic request/response models
  routers/           # one file per resource (products.py, users.py)
  services/          # business logic (decoupled from HTTP layer)
  dependencies.py    # shared Depends() functions
  database.py        # engine, session factory
```

### Tool Guidance
```bash
uvicorn app.main:app --reload          # dev server
alembic revision --autogenerate -m ""  # generate migration
alembic upgrade head                   # apply migrations
pytest -v                              # run tests
pip install fastapi uvicorn sqlalchemy alembic pydantic
```

### Pitfalls
- Returning ORM objects directly without `response_model` — Pydantic won't serialize them
- Using `db.close()` manually — always use context managers or FastAPI's `Depends(get_db)`
- Blocking I/O inside `async def` — use `asyncio.to_thread()` to wrap sync calls
- `datetime.now()` without timezone — use `datetime.now(timezone.utc)` everywhere
