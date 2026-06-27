import type { Request, Response } from "express";

export interface AuthConfig {
  required: boolean;
  issuer: string;
  audience: string;
  resource: string;
  protectedResourceMetadataUrl: string;
  scopes: {
    read: string;
    write: string;
  };
}

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface JwtClaims {
  aud?: string | string[];
  exp?: number;
  iss?: string;
  nbf?: number;
  scope?: string;
  scp?: string[];
}

interface JwksKey {
  kid?: string;
  kty?: string;
  [key: string]: unknown;
}

interface JwksResponse {
  keys?: JwksKey[];
}

const jwksCache = new Map<string, JwksKey[]>();

const withTrailingSlash = (value: string) =>
  value.endsWith("/") ? value : `${value}/`;

const withoutTrailingSlash = (value: string) =>
  value.endsWith("/") ? value.slice(0, -1) : value;

const requiredEnv = (
  env: NodeJS.ProcessEnv,
  key: string,
  fallback?: string,
) => {
  const value = env[key] ?? fallback;
  if (!value) {
    throw new Error(`Missing required auth environment variable: ${key}`);
  }
  return value;
};

export const createAuthConfigFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): AuthConfig | undefined => {
  if (env.MOBILE_OPERATOR_AUTH_REQUIRED !== "1") {
    return undefined;
  }

  const issuer = withTrailingSlash(
    requiredEnv(env, "AUTH0_ISSUER_BASE_URL", env.AUTH_ISSUER_BASE_URL),
  );
  const audience = requiredEnv(
    env,
    "AUTH0_AUDIENCE",
    env.AUTH_AUDIENCE ?? env.MOBILE_OPERATOR_PUBLIC_URL,
  );
  const resource = withoutTrailingSlash(env.MOBILE_OPERATOR_PUBLIC_URL ?? audience);

  return {
    required: true,
    issuer,
    audience,
    resource,
    protectedResourceMetadataUrl: `${resource}/.well-known/oauth-protected-resource`,
    scopes: {
      read: env.MOBILE_OPERATOR_READ_SCOPE ?? "operator.read",
      write: env.MOBILE_OPERATOR_WRITE_SCOPE ?? "operator.write",
    },
  };
};

export const authChallenge = (auth: AuthConfig, scope: string) =>
  `Bearer resource_metadata="${auth.protectedResourceMetadataUrl}", scope="${scope}"`;

export const sendUnauthorized = (
  response: Response,
  auth: AuthConfig,
  scope: string,
) => {
  response
    .status(401)
    .set("WWW-Authenticate", authChallenge(auth, scope))
    .json({ error: "unauthorized", scope });
};

const decodeBase64UrlJson = <T>(encoded: string): T => {
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  return JSON.parse(decoded) as T;
};

const getJwks = async (issuer: string) => {
  const cached = jwksCache.get(issuer);
  if (cached) {
    return cached;
  }

  const response = await fetch(`${withoutTrailingSlash(issuer)}/.well-known/jwks.json`);
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS: ${response.status}`);
  }

  const data = (await response.json()) as JwksResponse;
  const keys = data.keys ?? [];
  jwksCache.set(issuer, keys);
  return keys;
};

const getBearerToken = (request: Request) => {
  const header = request.header("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
};

const verifySignature = async (
  token: string,
  header: JwtHeader,
  auth: AuthConfig,
) => {
  if (header.alg !== "RS256" || !header.kid) {
    throw new Error("Unsupported JWT header");
  }

  const keys = await getJwks(auth.issuer);
  const jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    throw new Error("JWT signing key not found");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error("Malformed JWT");
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signedContent = new TextEncoder().encode(
    `${encodedHeader}.${encodedPayload}`,
  );
  const signature = Buffer.from(encodedSignature, "base64url");
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    signedContent,
  );

  if (!valid) {
    throw new Error("Invalid JWT signature");
  }
};

const verifyClaims = (
  claims: JwtClaims,
  auth: AuthConfig,
  requiredScope: string,
) => {
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== auth.issuer) {
    throw new Error("Invalid JWT issuer");
  }
  if (typeof claims.exp !== "number" || claims.exp <= now) {
    throw new Error("JWT expired");
  }
  if (typeof claims.nbf === "number" && claims.nbf > now) {
    throw new Error("JWT not active yet");
  }

  const audiences = Array.isArray(claims.aud)
    ? claims.aud
    : claims.aud
      ? [claims.aud]
      : [];
  if (!audiences.includes(auth.audience) && !audiences.includes(auth.resource)) {
    throw new Error("Invalid JWT audience");
  }

  const scopes = new Set([
    ...(claims.scope?.split(/\s+/).filter(Boolean) ?? []),
    ...(claims.scp ?? []),
  ]);
  if (!scopes.has(requiredScope)) {
    throw new Error("Missing required JWT scope");
  }
};

export const verifyRequestAuth = async (
  request: Request,
  auth: AuthConfig,
  requiredScope: string,
) => {
  const token = getBearerToken(request);
  if (!token) {
    throw new Error("Missing bearer token");
  }

  const [encodedHeader, encodedPayload] = token.split(".");
  if (!encodedHeader || !encodedPayload) {
    throw new Error("Malformed JWT");
  }

  const header = decodeBase64UrlJson<JwtHeader>(encodedHeader);
  const claims = decodeBase64UrlJson<JwtClaims>(encodedPayload);

  await verifySignature(token, header, auth);
  verifyClaims(claims, auth, requiredScope);

  return claims;
};

