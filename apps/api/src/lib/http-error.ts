/**
 * Typed HTTP errors that the global Express error handler turns into JSON
 * responses. Routes throw these instead of calling `response.status(...)`
 * inline so the error shape stays consistent.
 */
export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

export const badRequest = (message: string) => new HttpError(400, message)
export const unauthorized = (message: string) => new HttpError(401, message)
export const forbidden = (message: string) => new HttpError(403, message)
export const notFound = (message: string) => new HttpError(404, message)
export const conflict = (message: string) => new HttpError(409, message)
