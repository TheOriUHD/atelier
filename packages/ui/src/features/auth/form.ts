import { useState, type FormEvent } from 'react';
import type { z } from 'zod';
import { describeError, errorCode } from '../../lib/rpc.ts';

/** One message per field, plus `form` for errors that belong to no single field. */
export type FormErrors<K extends string> = Partial<Record<K | 'form', string>>;

/**
 * Validates with `schema` (field errors from zod), then runs `action`. A backend error goes to the
 * field its code names in `fieldFor` (e.g. `exists` → username), or to the whole form.
 */
export function useFormSubmit<T extends object>(
  schema: z.ZodType<T>,
  fieldFor: Partial<Record<string, keyof T & string>>,
  action: (values: T) => Promise<unknown>,
) {
  type K = keyof T & string;
  const [errors, setErrors] = useState<FormErrors<K>>({});
  const [pending, setPending] = useState(false);

  const submit = async (values: unknown) => {
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      const next: FormErrors<K> = {};
      for (const issue of parsed.error.issues) next[issue.path[0] as K] ??= issue.message;
      return setErrors(next);
    }
    setErrors({});
    setPending(true);
    try {
      await action(parsed.data);
    } catch (e) {
      const field = fieldFor[errorCode(e) ?? ''] ?? 'form';
      setErrors({ [field]: describeError(e).message } as FormErrors<K>);
    } finally {
      setPending(false);
    }
  };

  return {
    errors,
    pending,
    /** Submits values that didn't come from the form itself (a server picked from a list). */
    submit: (values: unknown) => void submit(values),
    /** The form's `onSubmit`, given the values it currently shows. */
    onSubmit: (values: unknown) => (e: FormEvent) => {
      e.preventDefault();
      void submit(values);
    },
  };
}
