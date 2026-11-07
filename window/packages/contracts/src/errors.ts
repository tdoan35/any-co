/** Thrown by the CP-0 stubs until their owning workstream implements them. */
export class NotImplementedError extends Error {
  constructor(readonly owner: string, what: string) {
    super(`${what} is not implemented yet (owner: ${owner})`);
    this.name = "NotImplementedError";
  }
}
