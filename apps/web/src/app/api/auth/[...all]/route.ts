import { toNextJsHandler } from 'better-auth/next-js';
import { getAuth } from '@/server/auth';

// Better Auth's own endpoints: sign-in, sign-up, sign-out, session.
//
// A Route Handler rather than a Server Action because these are a public HTTP
// contract the client library calls, not a form submission (ADR-0005).
//
// The handler is built per request rather than at module scope. `next build`
// imports this file to collect route metadata, and a build must not need a
// database or a production secret to produce static output - nor fail with a
// bundler stack trace instead of a sentence naming the missing variable.
export async function GET(request: Request): Promise<Response> {
  return toNextJsHandler(getAuth()).GET(request);
}

export async function POST(request: Request): Promise<Response> {
  return toNextJsHandler(getAuth()).POST(request);
}
