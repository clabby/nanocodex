# Secure browser input scenarios (defined before implementation)

Use synthetic values only; no production credentials or payment data.

1. Legacy password hints retain strict seven-key parsing and direct `{request_id,value}` submission.
2. Typed hints contain metadata only. Fetch the authenticated description on opening; reject wrong request/origin, extra keys, unknown kinds, duplicate fields and invalid field IDs.
3. Render password, card number, expiry, CVC and sensitive text using description fields only. Keep values in uncontrolled inputs, never transcript callbacks or storage.
4. Submit all typed values once on the private endpoint. Reject extra/missing field values. A typed form never requests payment submission.
5. Strict status-only receipts are the sole callback payload. Malformed receipts and uncertain failures prevent retries and expose no response text.
6. Dialog opens from conversation with focus contained and restored. Cancel, Escape, backgrounding, expiry and unmount clear entered values; cancel revokes request.
7. Description failure exposes a generic message and never opens arbitrary fields. Async description completion after dismissal must not reopen the sheet.
8. Vault is optional: manual entry always works without saving values. No implicit save or CVC persistence.
