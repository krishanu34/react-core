/**
 * uuid — RFC-4122 v4 UUID that works in INSECURE contexts (plain HTTP).
 *
 * `crypto.randomUUID()` is only defined in a **secure context** (HTTPS or
 * localhost), so on a plain-HTTP deployment (e.g. http://<vm-ip>:3002) it is
 * `undefined` and calling it throws "crypto.randomUUID is not a function" —
 * which breaks session/thread/run id generation, chat, and sync.
 *
 * This helper prefers `crypto.randomUUID()` when available, then falls back to
 * `crypto.getRandomValues()` (which IS available over HTTP — unlike
 * `crypto.subtle` / `randomUUID`), and finally to `Math.random()`.
 */
export function uuid(): string {
  const c: Crypto | undefined = typeof crypto !== "undefined" ? crypto : undefined;

  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      /* fall through — some browsers expose it but throw in insecure contexts */
    }
  }

  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // Set version (4) and variant (RFC 4122) bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") + "-" +
    hex.slice(4, 6).join("") + "-" +
    hex.slice(6, 8).join("") + "-" +
    hex.slice(8, 10).join("") + "-" +
    hex.slice(10, 16).join("")
  );
}
