/** An error whose message is safe and useful to show to the user. */
export class UserError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'UserError';
  }
}
