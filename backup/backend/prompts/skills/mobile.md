---
name: mobile
description: React Native and Flutter application patterns, navigation, native modules and store builds. Use when the task targets iOS or Android.
---

## Mobile Development Expert Context

You are working on a mobile application with React Native or Flutter.

### React Native (with Expo — recommended)
```tsx
import { View, Text, StyleSheet, FlatList, TouchableOpacity } from 'react-native'
import { useState } from 'react'

export function ProductList({ products }: { products: Product[] }) {
  const [selected, setSelected] = useState<string | null>(null)

  return (
    <FlatList
      data={products}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <TouchableOpacity
          style={[styles.item, selected === item.id && styles.selected]}
          onPress={() => setSelected(item.id)}
        >
          <Text style={styles.name}>{item.name}</Text>
        </TouchableOpacity>
      )}
    />
  )
}

const styles = StyleSheet.create({
  item: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#ccc' },
  selected: { backgroundColor: '#e0f0ff' },
  name: { fontSize: 16, fontWeight: '600' },
})
```

### React Native Core Rules
- Use `FlatList` / `SectionList` for long lists — never `ScrollView` with `.map()` (no virtualization)
- All styles via `StyleSheet.create()` — inline objects create new object refs every render
- `TouchableOpacity` for most buttons; `Pressable` for custom feedback styles
- Platform differences: `Platform.OS === 'ios'` or `Platform.select({ ios: ..., android: ... })`
- Images: `<Image source={require('./logo.png')} />` for local; `{ uri: url }` for remote

### Navigation (React Navigation)
```tsx
// Stack navigator
const Stack = createNativeStackNavigator<RootStackParams>()

function AppNavigator() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="Home" component={HomeScreen} />
      <Stack.Screen name="Product" component={ProductScreen} />
    </Stack.Navigator>
  )
}

// Navigate with type safety
navigation.navigate('Product', { id: '123' })
```

### Expo APIs
```ts
import * as SecureStore from 'expo-secure-store'
import * as Notifications from 'expo-notifications'
import { Camera } from 'expo-camera'

// Store sensitive data (tokens, keys) — not AsyncStorage
await SecureStore.setItemAsync('token', jwtToken)
const token = await SecureStore.getItemAsync('token')
```

### Flutter (Dart)
```dart
class ProductCard extends StatelessWidget {
  const ProductCard({ super.key, required this.product });
  final Product product;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: ListTile(
        title: Text(product.name, style: Theme.of(context).textTheme.titleMedium),
        subtitle: Text('\$${product.price.toStringAsFixed(2)}'),
        trailing: const Icon(Icons.chevron_right),
        onTap: () => context.go('/products/${product.id}'),
      ),
    );
  }
}
```

### Flutter Core Rules
- Prefer `const` constructors everywhere — Flutter reuses the widget tree node
- State management: Riverpod (recommended), Bloc, or Provider
- `ListView.builder` for long lists, not `Column` with a list
- `go_router` for routing — declarative and type-safe
- `http` or `dio` for network; `shared_preferences` for simple KV; `flutter_secure_storage` for tokens

### Performance (both platforms)
- Avoid setState / rebuild at the top of the widget/component tree — push state down
- Images: use caching (`cached_network_image` in Flutter, `expo-image` in RN)
- Heavy computation: move to a background isolate (Flutter) or `react-native-workers` (RN)
- Profile with Flipper (RN) or Flutter DevTools before optimizing

### Tool Guidance
```bash
# React Native / Expo
npx expo start
npx expo run:ios
npx expo run:android
eas build --platform ios        # EAS Build for production

# Flutter
flutter run
flutter build apk --release
flutter build ios --release
flutter test
flutter analyze
```

### Pitfalls
- Navigating without waiting for async operations — show loading state first
- Not handling keyboard overlaying input fields — use `KeyboardAvoidingView` (RN) / `Scaffold.resizeToAvoidBottomInset` (Flutter)
- Missing platform permissions (camera, location, notifications) in `app.json` / `AndroidManifest.xml` / `Info.plist`
- Calling `setState` after a widget is disposed — check `mounted` first in async callbacks
