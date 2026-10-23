import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { allBooks, findBook, search } from "./catalog.ts";
import { formatCents } from "./money.ts";

export interface Reply {
  status: number;
  body: unknown;
}

// Bodies over 64 KB are rejected before they are parsed.
const MAX_BODY_BYTES = 64 * 1024;

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks);
  // Skip a UTF-8 byte order mark: some clients send one.
  const offset = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? 3 : 0;
  return raw.length === offset ? undefined : JSON.parse(raw.subarray(offset).toString("utf8"));
}

export function route(method: string, url: URL): Reply {
  if (method !== "GET") return { status: 405, body: { error: "method not allowed" } };

  if (url.pathname === "/books") {
    const query = url.searchParams.get("q");
    const books = query ? search(query) : allBooks();
    return { status: 200, body: books.map((book) => ({ ...book, display: formatCents(book.salePrice ?? book.price) })) };
  }

  const match = /^\/books\/([A-Z]{2}-\d{3})$/.exec(url.pathname);
  if (match) {
    const book = findBook(match[1]);
    if (!book) return { status: 404, body: { error: "not found" } };
    return { status: 200, body: book };
  }

  return { status: 404, body: { error: "not found" } };
}

function send(res: ServerResponse, reply: Reply): void {
  res.statusCode = reply.status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(reply.body));
}

export function startServer(port = 3000) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      send(res, route(req.method ?? "GET", url));
    } catch (error) {
      console.error(error);
      send(res, { status: 500, body: { error: "internal error" } });
    }
  });
  return server.listen(port);
}
