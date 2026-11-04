// The error a `sail port` operation's body reader throws for an empty body. It lives apart from port.ts so a port's
// table module (port-codehost.ts) can catch it without importing port.ts, which imports that table: the cycle left
// CODEHOST uninitialised whenever port-codehost.ts was imported first.

/** A body that was read and held nothing: the operation is refused before its port is called. */
export class EmptyBody extends Error {
  // Written out, not implicit: Bun reads an implicit subclass constructor as uncovered.
  constructor(message: string) {
    super(message);
    this.name = 'EmptyBody';
  }
}
