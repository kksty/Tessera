export class DomainError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (status: number, message: string): never => {
  throw new DomainError(status, message);
};
