'use client';

import { createAuthClient } from 'better-auth/react';

// No baseURL: the client is served from the same origin as the API, and a
// hardcoded one would break every deployment that is not localhost.
export const authClient = createAuthClient();
export const { signIn, signUp, signOut, useSession } = authClient;
