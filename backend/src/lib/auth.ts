import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';

export interface User {
  id: string;
  name: string;
  username?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

const LOCAL_USER: User = { id: 'local', name: 'Local developer', username: 'local@localhost' };

/** Validates Entra ID v2 access tokens issued for the API app registration (delegated scope required). */
export function createAuthHook(config: Config) {
  if (!config.authEnabled) {
    return async (req: FastifyRequest) => {
      req.user = LOCAL_USER;
    };
  }
  if (!config.tenantId || !config.apiClientId) {
    throw new Error('AUTH_ENABLED=true needs ENTRA_TENANT_ID and ENTRA_API_CLIENT_ID');
  }
  const jwks = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`));
  const issuer = `https://login.microsoftonline.com/${config.tenantId}/v2.0`;
  const audience = [config.apiClientId, `api://${config.apiClientId}`];

  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return reply.code(401).send({ error: 'Missing bearer token' });
    let payload: JWTPayload & { scp?: string; name?: string; preferred_username?: string; oid?: string };
    try {
      ({ payload } = await jwtVerify(token, jwks, { issuer, audience }));
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'token validation failed');
      return reply.code(401).send({ error: 'Invalid token' });
    }
    const scopes = (payload.scp ?? '').split(' ');
    if (!scopes.includes(config.apiScopeName)) {
      return reply.code(403).send({ error: `Token lacks scope ${config.apiScopeName}` });
    }
    req.user = {
      id: payload.oid ?? payload.sub ?? 'unknown',
      name: payload.name ?? payload.preferred_username ?? 'User',
      username: payload.preferred_username,
    };
  };
}
