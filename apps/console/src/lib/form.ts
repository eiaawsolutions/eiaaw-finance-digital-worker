/**
 * Read a text field out of a submitted form.
 *
 * `FormData.get` returns `string | File | null`, so `String(...)` on it would
 * render an uploaded file as "[object File]" and hand that to the API as if it
 * were a password. A File arriving here means the form was tampered with or
 * the field is misnamed; either way the honest reading is that no text was
 * supplied.
 */
export function textField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}
