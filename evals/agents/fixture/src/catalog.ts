import type { Cents } from "./money.ts";

export interface Book {
  sku: string;
  title: string;
  author: string;
  price: Cents;
  // A sale price replaces the list price while the book is on sale.
  salePrice?: Cents;
  stock: number;
}

const books: Book[] = [
  { sku: "BK-001", title: "The Pragmatic Programmer", author: "Hunt", price: 4999, stock: 12 },
  { sku: "BK-002", title: "Refactoring", author: "Fowler", price: 5499, salePrice: 3999, stock: 4 },
  { sku: "BK-003", title: "Domain-Driven Design", author: "Evans", price: 6499, stock: 0 },
  { sku: "BK-004", title: "Working Effectively with Legacy Code", author: "Feathers", price: 5799, stock: 7 },
  { sku: "BK-005", title: "Clean Architecture", author: "Martin", price: 3899, salePrice: 2999, stock: 9 },
  { sku: "BK-006", title: "Designing Data-Intensive Applications", author: "Kleppmann", price: 5999, stock: 21 },
  { sku: "BK-007", title: "Release It!", author: "Nygard", price: 4499, stock: 3 },
  { sku: "BK-008", title: "Accelerate", author: "Forsgren", price: 2999, stock: 15 },
];

export function allBooks(): readonly Book[] {
  return books;
}

export function findBook(sku: string): Book | undefined {
  return books.find((book) => book.sku === sku);
}

export function effectivePrice(book: Book): Cents {
  return book.salePrice ?? book.price;
}

export function search(query: string): Book[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  return books.filter((book) => book.title.toLowerCase().includes(needle) || book.author.toLowerCase().includes(needle));
}

// Replace the whole catalog. Tests use this to load a known set of books.
export function replaceCatalog(next: Book[]): void {
  books.splice(0, books.length, ...next);
}
