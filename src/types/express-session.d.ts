import 'express-session';

declare module 'express-session' {
  interface SessionData {
    nonce?: string;
    siweSessionId?: string;
    address?: string;
  }
}
