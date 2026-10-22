import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { queryClient } from './lib/queries.ts';
import { router } from './app/router.tsx';
import { Toaster, TooltipProvider } from './components/ui/index.ts';
import { AuthGate } from './features/auth/auth-gate.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthGate>
          <RouterProvider router={router} />
        </AuthGate>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
