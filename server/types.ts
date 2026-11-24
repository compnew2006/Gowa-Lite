import type {Request} from 'express';
import type {PublicUser} from './db.ts';

export interface AuthedRequest extends Request {
  user?: PublicUser;
  authToken?: string;
}
