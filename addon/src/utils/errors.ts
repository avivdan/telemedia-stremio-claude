export class AddonError extends Error {
  constructor(message: string, public status = 500, public code = 'ADDON_ERROR') {
    super(message);
    this.name = 'AddonError';
  }
}

export class NotFoundError extends AddonError {
  constructor(message = 'Not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class UpstreamError extends AddonError {
  constructor(message = 'Upstream error') {
    super(message, 502, 'UPSTREAM');
  }
}
