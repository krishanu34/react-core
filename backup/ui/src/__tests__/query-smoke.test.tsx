import React from 'react';
import { render } from '@testing-library/react';
import QueryProvider from '../lib/QueryProvider';

it('QueryProvider mounts and exposes queryClient on window', () => {
  render(
    <QueryProvider>
      <div data-testid="ok">ok</div>
    </QueryProvider>
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((window as any).__queryClient).toBeDefined();
});
