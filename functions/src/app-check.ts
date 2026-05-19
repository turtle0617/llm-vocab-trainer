import type { NextFunction, Request, Response } from "express";
import { getAppCheck } from "firebase-admin/app-check";

export interface AppCheckContext {
  appId: string;
}

export class AppCheckError extends Error {
  constructor(
    public readonly status: 401,
    message: string
  ) {
    super(message);
  }
}

export function appCheckMiddleware(req: Request, res: Response, next: NextFunction) {
  verifyRequestAppCheck(req)
    .then((appCheck) => {
      res.locals.appCheck = appCheck;
      next();
    })
    .catch(next);
}

async function verifyRequestAppCheck(req: Request): Promise<AppCheckContext> {
  const token = req.header("x-firebase-appcheck");
  if (!token) throw new AppCheckError(401, "App Check token is required.");

  try {
    const decoded = await getAppCheck().verifyToken(token);
    return { appId: decoded.appId };
  } catch {
    throw new AppCheckError(401, "App Check token is invalid.");
  }
}
