---
name: testing
description: Unit, integration and end-to-end testing across pytest, Jest, Vitest, Cypress and Playwright. Use when writing, fixing, or expanding tests.
---

## Testing Expert Context

You are writing tests. Apply these patterns across unit, integration, and e2e testing.

### Test Pyramid
```
        ┌──────┐
        │  E2E  │  ← few, slow, tests real user flows (Cypress/Playwright)
        ├──────┤
        │ Integ │  ← moderate, test modules working together (real DB, real HTTP)
        ├──────┤
        │ Unit  │  ← many, fast, test pure logic in isolation (mock I/O)
        └──────┘
```
- Most tests should be unit tests (fast, deterministic)
- Integration tests cover the seams between layers (routes + DB, service + external API)
- E2E tests cover critical user journeys only — they're slow and brittle

### Jest / Vitest (JavaScript/TypeScript)
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { CartService } from './cart.service'
import { db } from './db'

vi.mock('./db')  // auto-mock the module

describe('CartService', () => {
  let service: CartService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new CartService(db)
  })

  it('adds an item and returns updated cart', async () => {
    // Arrange
    const mockCart = { id: '1', items: [] }
    vi.mocked(db.cart.findUnique).mockResolvedValue(mockCart)
    vi.mocked(db.cart.update).mockResolvedValue({ ...mockCart, items: [{ id: 'p1' }] })

    // Act
    const result = await service.addItem('1', { id: 'p1', qty: 1 })

    // Assert
    expect(result.items).toHaveLength(1)
    expect(db.cart.update).toHaveBeenCalledWith({
      where: { id: '1' },
      data: expect.objectContaining({ items: expect.any(Object) }),
    })
  })

  it('throws NotFoundError when cart does not exist', async () => {
    vi.mocked(db.cart.findUnique).mockResolvedValue(null)
    await expect(service.addItem('missing', { id: 'p1', qty: 1 }))
      .rejects.toThrow('Cart not found')
  })
})
```

### pytest (Python)
```python
import pytest
from unittest.mock import AsyncMock, patch
from services.cart import CartService

@pytest.fixture
def cart_service():
    return CartService()

@pytest.mark.asyncio
async def test_add_item_returns_updated_cart(cart_service):
    with patch.object(cart_service.db, 'find_cart', return_value={'id': '1', 'items': []}) as mock_find:
        result = await cart_service.add_item('1', {'id': 'p1', 'qty': 1})
        assert len(result['items']) == 1
        mock_find.assert_awaited_once_with('1')

def test_add_item_raises_for_missing_cart(cart_service):
    with patch.object(cart_service.db, 'find_cart', return_value=None):
        with pytest.raises(ValueError, match='Cart not found'):
            cart_service.add_item('missing', {'id': 'p1', 'qty': 1})
```

### AAA Pattern (Arrange / Act / Assert)
Every test follows three sections:
1. **Arrange** — set up the system under test and its dependencies
2. **Act** — call the code being tested (one call per test)
3. **Assert** — verify the outcome

One assertion concept per test — multiple `expect()` calls are fine if they all verify the same outcome.

### What to Mock
- **Mock**: external I/O (DB, HTTP APIs, file system, time, random)
- **Don't mock**: pure functions, business logic, your own internal modules
- When mocking HTTP: use `msw` (browser/node) or `responses` (Python requests)

### Integration Tests (FastAPI example)
```python
import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as c:
        yield c

async def test_create_product(client, db_session):
    response = await client.post('/products', json={'name': 'Widget', 'price': 9.99})
    assert response.status_code == 201
    body = response.json()
    assert body['name'] == 'Widget'
    assert 'id' in body
```

### Playwright (E2E)
```ts
import { test, expect } from '@playwright/test'

test('user can add product to cart', async ({ page }) => {
  await page.goto('/products/123')
  await page.getByRole('button', { name: 'Add to cart' }).click()
  await expect(page.getByTestId('cart-count')).toHaveText('1')
})
```

### Tool Guidance
```bash
# Vitest
npx vitest run          # run once
npx vitest              # watch mode
npx vitest --coverage   # with coverage report

# pytest
pytest -v               # verbose
pytest -k "test_cart"   # filter by name
pytest --cov=app        # coverage

# Playwright
npx playwright test
npx playwright test --ui         # interactive mode
npx playwright codegen localhost # record tests
```

### Pitfalls
- Testing implementation details (internal method names) — test observable behavior instead
- Slow tests from real HTTP calls — mock the network layer
- Not resetting mocks between tests — use `beforeEach(() => vi.clearAllMocks())`
- Flaky tests from `setTimeout`/`Date.now` — mock time with `vi.useFakeTimers()`
- 100% coverage as a goal — cover important paths and edge cases, not every line
