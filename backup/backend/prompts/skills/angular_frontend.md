---
name: angular_frontend
description: Angular 15+ standalone components, RxJS/observables, DI and the Angular CLI. Use when the task touches Angular, NgModules, or .component.ts/.service.ts files.
---

## Angular Expert Context

You are working on an Angular application (Angular 15+). Apply standalone component patterns.

### Standalone Components (Angular 15+ preferred)
```ts
import { Component, signal, computed } from '@angular/core'
import { CommonModule } from '@angular/common'
import { RouterModule } from '@angular/router'

@Component({
  selector: 'app-product',
  standalone: true,
  imports: [CommonModule, RouterModule],
  template: `
    <div>{{ product().name }} — {{ total() }}</div>
  `,
})
export class ProductComponent {
  product = signal({ name: 'Widget', price: 10 })
  quantity = signal(1)
  total = computed(() => this.product().price * this.quantity())
}
```

### Signals (Angular 17+)
- `signal()` replaces `@Input()` + zone-based CD for local state
- `computed()` for derived values (memoized automatically)
- `effect()` for side effects that track signal reads
- Use signals for new code; Observables still needed for async streams

### Dependency Injection
```ts
@Injectable({ providedIn: 'root' })  // singleton app-wide
export class CartService {
  private items = signal<CartItem[]>([])
  readonly count = computed(() => this.items().length)

  add(item: CartItem) { this.items.update(list => [...list, item]) }
}
```
- `providedIn: 'root'` creates a singleton — use for services that should be shared
- `providedIn: 'any'` creates one instance per lazy module
- Inject with `inject()` function (Angular 14+) or constructor injection

### RxJS Patterns
```ts
// In services — still the right tool for HTTP, WebSocket, complex async
items$ = this.http.get<Item[]>('/api/items').pipe(
  map(items => items.filter(i => i.active)),
  catchError(err => { console.error(err); return EMPTY }),
)
```
- Always unsubscribe: `takeUntilDestroyed()` in components (Angular 16+)
- Prefer `async` pipe in templates over manual subscriptions
- Use `switchMap` for cancellable requests, `mergeMap` for parallel, `concatMap` for ordered

### Routing
```ts
export const routes: Routes = [
  { path: '', component: HomeComponent },
  {
    path: 'admin',
    canActivate: [authGuard],
    loadChildren: () => import('./admin/routes').then(m => m.ADMIN_ROUTES),
  },
]
```
- Route guards as functions (Angular 15+): `export const authGuard = () => inject(AuthService).isLoggedIn()`
- Lazy-load feature routes with `loadChildren`
- Use `ActivatedRoute` to read params: `inject(ActivatedRoute).paramMap`

### Change Detection
- Default strategy re-checks everything — use `ChangeDetectionStrategy.OnPush` for performance
- `OnPush` components only re-check when: input ref changes, signal changes, async pipe emits, or `markForCheck()` called
- With signals, Angular 17+ zoneless mode is possible — no zone.js needed

### Tool Guidance
```bash
ng serve              # dev server
ng build --configuration production
ng generate component features/cart/cart-page --standalone
ng test               # Karma + Jasmine
ng lint               # ESLint
```

### Pitfalls to Avoid
- Subscribing in components without unsubscribing — memory leak
- Heavy logic in templates — move to `computed()` or component methods
- Using `any` type for HTTP responses — define interfaces
- `ngOnChanges` vs signals: signals are reactive by nature; no need for `ngOnChanges` when using them
