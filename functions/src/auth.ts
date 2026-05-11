import type { NextFunction, Request, Response } from "express";
import { getAuth } from "firebase-admin/auth";

export interface AuthContext {
  uid: string;
}

export class AuthError extends Error {
  constructor(
    public readonly status: 401 | 403 | 500,
    message: string
  ) {
    super(message);
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  verifyRequestAuth(req)
    .then((auth) => {
      res.locals.auth = auth;
      next();
    })
    .catch(next);
}

export function getAuthContext(res: Response): AuthContext {
  const auth = res.locals.auth as AuthContext | undefined;
  if (!auth) throw new AuthError(401, "Authentication is required.");
  return auth;
}

async function verifyRequestAuth(req: Request): Promise<AuthContext> {
  if (isDevAuthDisabled()) return { uid: process.env.ALLOWED_USER_UID ?? "dev-user" };

  const allowedUserUid = process.env.ALLOWED_USER_UID;
  if (!allowedUserUid) {
    throw new AuthError(500, "ALLOWED_USER_UID is not configured.");
  }

  const token = parseBearerToken(req.header("authorization"));
  if (!token) throw new AuthError(401, "Authentication is required.");

  try {
    const decoded = await getAuth().verifyIdToken(token);
    if (decoded.uid !== allowedUserUid) throw new AuthError(403, "This account is not allowed.");
    return { uid: decoded.uid };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(401, "Authentication token is invalid or expired.");
  }
}

function parseBearerToken(header: string | undefined) {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function isDevAuthDisabled() {
  return process.env.AUTH_DISABLED_FOR_DEV === "true" && process.env.FUNCTIONS_EMULATOR === "true";
}
