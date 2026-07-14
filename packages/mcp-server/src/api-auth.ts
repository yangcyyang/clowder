export const API_BEARER_TOKEN_ENV = 'CLOWDER_API_BEARER_TOKEN';

export function withApiBearerHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const token = process.env[API_BEARER_TOKEN_ENV]?.trim();
  if (!token) return { ...headers };
  return { ...headers, authorization: `Bearer ${token}` };
}

export function applyApiBearerHeader(headers: Headers): Headers {
  const token = process.env[API_BEARER_TOKEN_ENV]?.trim();
  if (token) headers.set('authorization', `Bearer ${token}`);
  return headers;
}
