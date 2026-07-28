import { TenantContext } from '../shared/middleware/auth';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Populated by `authenticate` from the signed bearer token. Never from the body. */
      tenantContext?: TenantContext;
    }
  }
}

export {};
