Add `removeItem` to the cart, with typed errors.

- In `src/cart.ts`, export `removeItem(cart: Cart, sku: string, qty?: number): Cart`. It returns a new cart and leaves the old one unchanged. Without `qty` it removes the whole line. When `qty` is equal to or more than the quantity of the line, the line goes away.
- Export a type `CartErrorCode` that is exactly `"UNKNOWN_SKU" | "INVALID_QTY" | "NOT_IN_CART"`.
- Export a class `CartError` that extends `Error`, has a read-only `code: CartErrorCode`, and is built as `new CartError(code, message)`.
- `removeItem` throws `CartError` with `NOT_IN_CART` for a sku that is not in the cart, and with `INVALID_QTY` for a quantity that is not a positive integer.
- `addItem` throws `CartError` too: `UNKNOWN_SKU` and `INVALID_QTY`. Keep its current messages.

Commit your change when you are done.
