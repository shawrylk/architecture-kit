# Use the cart

Call `addItem` with a cart, a book SKU, and a quantity.
The function returns a new cart and combines quantities for the same SKU.
The subtotal uses each book's sale price when the book is on sale.

```typescript
import { addItem, subtotal } from "./cart.ts";

const cart = addItem({ lines: [] }, "BK-002", 1);
const cents = subtotal(cart); // 3999
```
