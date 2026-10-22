import { useState } from 'react';

/** A dialog that starts fresh each time it opens (a new key remounts it) and still animates closed. */
export function useDialog() {
  const [state, setState] = useState({ open: false, key: 0 });
  return {
    ...state,
    onOpenChange: (open: boolean) => setState((s) => ({ ...s, open })),
    show: () => setState((s) => ({ open: true, key: s.key + 1 })),
  };
}
