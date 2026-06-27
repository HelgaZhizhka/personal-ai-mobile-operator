import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { Request, Response } from "express";

export type AuthProvider = "auth0" | "internal";

export interface AuthConfig {
  provider: AuthProvider;
  required: boolean;
  issuer: string;
  audience: string;
  resource: string;
  protectedResourceMetadataUrl: string;
  scopes: {
    read: string;
    write: string;
  };
  internal?: InternalOAuthConfig;
}

export interface InternalOAuthConfig {
  clientId: string;
  clientSecret: string;
  loginPin: string;
  tokenSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  metadataUrl: string;
  codeTtlSeconds: number;
  tokenTtlSeconds: number;
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

interface InternalAccessTokenClaims {
  aud: string;
  exp: number;
  iat: number;
  iss: string;
  scope: string;
  sub: string;
}

interface InternalAuthorizationCode {
  clientId: string;
  codeChallenge: string;
  expiresAt: number;
  redirectUri: string;
  resource: string;
  scope: string;
}

export class OAuthHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly error: string,
    public readonly description: string,
  ) {
    super(description);
  }
}

const jwksCache = new Map<string, JwksKey[]>();
const internalAuthorizationCodes = new Map<string, InternalAuthorizationCode>();

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

  const provider =
    env.MOBILE_OPERATOR_AUTH_PROVIDER === "internal" ? "internal" : "auth0";
  const resource = withoutTrailingSlash(
    requiredEnv(
      env,
      "MOBILE_OPERATOR_PUBLIC_URL",
      env.AUTH0_AUDIENCE ?? env.AUTH_AUDIENCE,
    ),
  );
  const scopes = {
    read: env.MOBILE_OPERATOR_READ_SCOPE ?? "operator.read",
    write: env.MOBILE_OPERATOR_WRITE_SCOPE ?? "operator.write",
  };

  if (provider === "internal") {
    return {
      provider,
      required: true,
      issuer: resource,
      audience: resource,
      resource,
      protectedResourceMetadataUrl: `${resource}/.well-known/oauth-protected-resource`,
      scopes,
      internal: {
        clientId: requiredEnv(env, "MOBILE_OPERATOR_OAUTH_CLIENT_ID"),
        clientSecret: requiredEnv(env, "MOBILE_OPERATOR_OAUTH_CLIENT_SECRET"),
        loginPin: requiredEnv(env, "MOBILE_OPERATOR_LOGIN_PIN"),
        tokenSecret: requiredEnv(env, "MOBILE_OPERATOR_TOKEN_SECRET"),
        authorizationEndpoint: `${resource}/oauth/authorize`,
        tokenEndpoint: `${resource}/oauth/token`,
        metadataUrl: `${resource}/.well-known/oauth-authorization-server`,
        codeTtlSeconds: Number(env.MOBILE_OPERATOR_OAUTH_CODE_TTL_SECONDS ?? 300),
        tokenTtlSeconds: Number(
          env.MOBILE_OPERATOR_OAUTH_TOKEN_TTL_SECONDS ?? 3600,
        ),
      },
    };
  }

  const issuer = withTrailingSlash(
    requiredEnv(env, "AUTH0_ISSUER_BASE_URL", env.AUTH_ISSUER_BASE_URL),
  );
  const audience = requiredEnv(env, "AUTH0_AUDIENCE", env.AUTH_AUDIENCE ?? resource);

  return {
    provider,
    required: true,
    issuer,
    audience,
    resource,
    protectedResourceMetadataUrl: `${resource}/.well-known/oauth-protected-resource`,
    scopes,
  };
};

export const getProtectedResourceMetadata = (auth: AuthConfig) => ({
  resource: auth.resource,
  authorization_servers: [auth.issuer],
  scopes_supported: [auth.scopes.read, auth.scopes.write],
  resource_documentation: `${auth.resource}/health`,
});

const getInternalConfig = (auth: AuthConfig) => {
  if (auth.provider !== "internal" || !auth.internal) {
    throw new Error("Internal OAuth is not configured");
  }
  return auth.internal;
};

export const getInternalAuthorizationServerMetadata = (auth: AuthConfig) => {
  const internal = getInternalConfig(auth);
  return {
    issuer: auth.issuer,
    authorization_endpoint: internal.authorizationEndpoint,
    token_endpoint: internal.tokenEndpoint,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
    ],
    scopes_supported: [auth.scopes.read, auth.scopes.write],
    resource_parameter_supported: true,
    client_id_metadata_document_supported: false,
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

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const getStringValue = (value: unknown) =>
  typeof value === "string" ? value : undefined;

const safeEqual = (actual: string | undefined, expected: string) => {
  if (!actual) {
    return false;
  }
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
};

const allowedRedirectUri = (redirectUri: string) => {
  try {
    const url = new URL(redirectUri);
    return (
      url.protocol === "https:" &&
      (url.hostname === "chatgpt.com" ||
        url.hostname === "chat.openai.com" ||
        url.hostname.endsWith(".chatgpt.com") ||
        url.hostname.endsWith(".chat.openai.com"))
    );
  } catch {
    return false;
  }
};

const normalizeRequestedScopes = (scope: string | undefined, auth: AuthConfig) => {
  const requested = scope?.split(/\s+/).filter(Boolean) ?? [auth.scopes.read];
  const allowed = new Set([auth.scopes.read, auth.scopes.write]);
  const accepted = requested.filter((item) => allowed.has(item));
  return accepted.length > 0 ? accepted.join(" ") : auth.scopes.read;
};

export const renderInternalAuthorizePage = (
  query: Record<string, unknown>,
  error?: string,
) => {
  const hiddenInputs = Object.entries(query)
    .filter(([, value]) => typeof value === "string")
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(
          value as string,
        )}" />`,
    )
    .join("\n");
  const errorHtml = error
    ? `<p style="color:#b42318">${escapeHtml(error)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Personal AI Operator Sign In</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; background: #f6f5f2; color: #1f2933; }
      main { max-width: 420px; margin: 12vh auto; padding: 28px; background: white; border: 1px solid #dedbd2; border-radius: 8px; box-shadow: 0 12px 40px rgba(0,0,0,.08); }
      h1 { font-size: 24px; margin: 0 0 8px; }
      p { line-height: 1.45; color: #52606d; }
      label { display: block; font-weight: 650; margin: 22px 0 8px; }
      input[type="password"] { box-sizing: border-box; width: 100%; padding: 12px 14px; border: 1px solid #b8c2cc; border-radius: 6px; font-size: 18px; }
      button { width: 100%; margin-top: 18px; padding: 12px 14px; border: 0; border-radius: 6px; background: #1f2933; color: white; font-weight: 700; font-size: 16px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Personal AI Operator</h1>
      <p>Enter Olga's operator PIN to connect this ChatGPT app.</p>
      ${errorHtml}
      <form method="post" action="/oauth/authorize">
        ${hiddenInputs}
        <label for="pin">PIN</label>
        <input id="pin" name="pin" type="password" autocomplete="one-time-code" autofocus />
        <button type="submit">Connect</button>
      </form>
    </main>
  </body>
</html>`;
};

export const createInternalAuthorizationRedirect = (
  auth: AuthConfig,
  body: Record<string, unknown>,
) => {
  const internal = getInternalConfig(auth);
  const responseType = getStringValue(body.response_type);
  const clientId = getStringValue(body.client_id);
  const redirectUri = getStringValue(body.redirect_uri);
  const codeChallenge = getStringValue(body.code_challenge);
  const codeChallengeMethod = getStringValue(body.code_challenge_method);
  const resource = getStringValue(body.resource) ?? auth.resource;
  const scope = normalizeRequestedScopes(getStringValue(body.scope), auth);
  const state = getStringValue(body.state);
  const pin = getStringValue(body.pin);

  if (responseType !== "code") {
    throw new OAuthHttpError(400, "unsupported_response_type", "Use response_type=code.");
  }
  if (clientId !== internal.clientId) {
    throw new OAuthHttpError(400, "invalid_client", "Unknown OAuth client.");
  }
  if (!redirectUri || !allowedRedirectUri(redirectUri)) {
    throw new OAuthHttpError(400, "invalid_request", "Unsupported redirect_uri.");
  }
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    throw new OAuthHttpError(
      400,
      "invalid_request",
      "PKCE S256 code_challenge is required.",
    );
  }
  if (resource !== auth.resource) {
    throw new OAuthHttpError(400, "invalid_target", "Unsupported resource.");
  }
  if (!safeEqual(pin, internal.loginPin)) {
    throw new OAuthHttpError(401, "access_denied", "Invalid PIN.");
  }

  const code = randomBytes(32).toString("base64url");
  internalAuthorizationCodes.set(code, {
    clientId,
    codeChallenge,
    expiresAt: Date.now() + internal.codeTtlSeconds * 1000,
    redirectUri,
    resource,
    scope,
  });

  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) {
    url.searchParams.set("state", state);
  }
  return url.toString();
};

const readBasicClientCredentials = (request: Request) => {
  const header = request.header("authorization");
  const match = header?.match(/^Basic\s+(.+)$/i);
  if (!match) {
    return undefined;
  }
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) {
    return undefined;
  }
  return {
    clientId: decoded.slice(0, separator),
    clientSecret: decoded.slice(separator + 1),
  };
};

const verifyCodeChallenge = (codeVerifier: string, codeChallenge: string) => {
  const hashed = createHash("sha256").update(codeVerifier).digest("base64url");
  return safeEqual(hashed, codeChallenge);
};

const signInternalAccessToken = (
  auth: AuthConfig,
  claims: InternalAccessTokenClaims,
) => {
  const internal = getInternalConfig(auth);
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", internal.tokenSecret)
    .update(payload)
    .digest("base64url");
  return `paio.${payload}.${signature}`;
};

export const exchangeInternalAuthorizationCode = (
  auth: AuthConfig,
  request: Request,
) => {
  const internal = getInternalConfig(auth);
  const body = request.body as Record<string, unknown>;
  const basicCredentials = readBasicClientCredentials(request);
  const clientId =
    basicCredentials?.clientId ?? getStringValue(body.client_id);
  const clientSecret =
    basicCredentials?.clientSecret ?? getStringValue(body.client_secret);
  const grantType = getStringValue(body.grant_type);
  const code = getStringValue(body.code);
  const redirectUri = getStringValue(body.redirect_uri);
  const codeVerifier = getStringValue(body.code_verifier);

  if (grantType !== "authorization_code") {
    throw new OAuthHttpError(400, "unsupported_grant_type", "Use authorization_code.");
  }
  if (
    clientId !== internal.clientId ||
    !safeEqual(clientSecret, internal.clientSecret)
  ) {
    throw new OAuthHttpError(401, "invalid_client", "Invalid OAuth client.");
  }
  if (!code || !redirectUri || !codeVerifier) {
    throw new OAuthHttpError(400, "invalid_request", "Missing code, redirect_uri or code_verifier.");
  }

  const authorizationCode = internalAuthorizationCodes.get(code);
  internalAuthorizationCodes.delete(code);
  if (!authorizationCode || authorizationCode.expiresAt <= Date.now()) {
    throw new OAuthHttpError(400, "invalid_grant", "Authorization code expired.");
  }
  if (
    authorizationCode.clientId !== clientId ||
    authorizationCode.redirectUri !== redirectUri
  ) {
    throw new OAuthHttpError(400, "invalid_grant", "Authorization code mismatch.");
  }
  if (!verifyCodeChallenge(codeVerifier, authorizationCode.codeChallenge)) {
    throw new OAuthHttpError(400, "invalid_grant", "PKCE verification failed.");
  }

  const now = Math.floor(Date.now() / 1000);
  const accessToken = signInternalAccessToken(auth, {
    aud: authorizationCode.resource,
    exp: now + internal.tokenTtlSeconds,
    iat: now,
    iss: auth.issuer,
    scope: authorizationCode.scope,
    sub: "olga",
  });

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: internal.tokenTtlSeconds,
    scope: authorizationCode.scope,
  };
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

const verifyInternalAccessToken = (
  token: string,
  auth: AuthConfig,
  requiredScope: string,
) => {
  const internal = getInternalConfig(auth);
  const [prefix, encodedPayload, encodedSignature] = token.split(".");
  if (prefix !== "paio" || !encodedPayload || !encodedSignature) {
    throw new Error("Malformed internal access token");
  }

  const expectedSignature = createHmac("sha256", internal.tokenSecret)
    .update(encodedPayload)
    .digest("base64url");
  if (!safeEqual(encodedSignature, expectedSignature)) {
    throw new Error("Invalid internal access token signature");
  }

  const claims = decodeBase64UrlJson<InternalAccessTokenClaims>(encodedPayload);
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== auth.issuer) {
    throw new Error("Invalid internal access token issuer");
  }
  if (claims.aud !== auth.resource && claims.aud !== auth.audience) {
    throw new Error("Invalid internal access token audience");
  }
  if (claims.exp <= now) {
    throw new Error("Internal access token expired");
  }
  const scopes = new Set(claims.scope.split(/\s+/).filter(Boolean));
  if (!scopes.has(requiredScope)) {
    throw new Error("Missing required internal access token scope");
  }

  return claims;
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

  if (auth.provider === "internal") {
    return verifyInternalAccessToken(token, auth, requiredScope);
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
