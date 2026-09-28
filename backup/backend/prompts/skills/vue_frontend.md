---
name: vue_frontend
description: Vue 3 Composition API, Pinia state and Nuxt conventions. Use when the task touches Vue, .vue single-file components, or Nuxt.
---

## Vue.js Expert Context

You are working on a Vue 3 application. Use the **Composition API** with `<script setup>`.

### Component Structure (preferred)
```vue
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

const props = defineProps<{ title: string; count?: number }>()
const emit = defineEmits<{ update: [value: number] }>()

const localCount = ref(props.count ?? 0)
const doubled = computed(() => localCount.value * 2)

function increment() {
  localCount.value++
  emit('update', localCount.value)
}
</script>

<template>
  <div>{{ title }}: {{ doubled }}</div>
</template>
```

### Reactivity Rules
- `ref()` for primitives; `reactive()` for plain objects (but prefer `ref` everywhere for consistency)
- Always access ref values with `.value` in `<script>` — the template unwraps automatically
- `computed()` for derived state — never derive values directly in the template for expensive ops
- `watch()` for side effects when a value changes; `watchEffect()` to auto-track dependencies

### State Management (Pinia)
```ts
// stores/cart.ts
import { defineStore } from 'pinia'

export const useCartStore = defineStore('cart', () => {
  const items = ref<CartItem[]>([])
  const total = computed(() => items.value.reduce((s, i) => s + i.price, 0))

  function addItem(item: CartItem) { items.value.push(item) }

  return { items, total, addItem }
})
```

### Routing (Vue Router 4)
```ts
// router/index.ts
const routes = [
  { path: '/', component: () => import('@/views/Home.vue') },  // lazy load
  { path: '/product/:id', component: () => import('@/views/Product.vue') },
]
```
- Use `useRouter()` and `useRoute()` composables inside components
- `<RouterLink>` for navigation, never raw `<a>` tags

### Composables (reusable logic)
```ts
// composables/useFetch.ts
export function useFetch<T>(url: string) {
  const data = ref<T | null>(null)
  const error = ref<Error | null>(null)
  const loading = ref(true)

  onMounted(async () => {
    try { data.value = await fetch(url).then(r => r.json()) }
    catch (e) { error.value = e as Error }
    finally { loading.value = false }
  })

  return { data, error, loading }
}
```

### Template Best Practices
- `v-for` always with `:key` using stable unique IDs
- Avoid `v-if` and `v-for` on the same element — wrap with `<template>`
- `v-model` shorthand is fine; use `v-model:propName` for custom components

### Tool Guidance
```bash
npm run dev       # Vite dev server
npm run build     # production build
vue-tsc --noEmit  # type-check without emitting
```

### Pitfalls to Avoid
- Destructuring a `reactive()` object loses reactivity — use `toRefs()` if needed
- Mutating `props` directly — emit an event and let the parent update
- `v-html` without sanitization — XSS risk
- Forgetting `.value` on refs in `<script setup>` — TypeScript will catch this
