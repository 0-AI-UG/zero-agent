export class AuthError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
  }
}

export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
  }
}

export class ConflictError extends Error {
  constructor(message = "Conflict") {
    super(message);
  }
}
