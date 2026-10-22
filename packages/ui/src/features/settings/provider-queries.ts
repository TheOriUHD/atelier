import { useQuery } from '@tanstack/react-query';
import { keys } from '../../lib/queries.ts';
import { rpc } from '../../lib/rpc.ts';

/** Not under `keys.providers`, so provider status events don't trigger a rescan. */
export const detectKey = ['providers.detect'] as const;

/** Local servers on default ports and API keys in the environment; rescans whenever a page mounts. */
export function useDetectedProviders() {
  return useQuery({ queryKey: detectKey, queryFn: () => rpc().call('providers.detect', {}), staleTime: 0 });
}

/** Stored secrets as masked tails (the plaintext never leaves the backend). */
export function useSecrets() {
  return useQuery({ queryKey: keys.secrets, queryFn: () => rpc().call('secrets.list', {}) });
}
