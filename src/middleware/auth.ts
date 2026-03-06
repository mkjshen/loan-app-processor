import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

export function basicAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const base64 = authHeader.slice('Basic '.length);
  const decoded = Buffer.from(base64, 'base64').toString('utf8');
  const [username, password] = decoded.split(':');

  if (username !== config.admin.username || password !== config.admin.password) {
    res.status(403).json({ error: 'Invalid credentials' });
    return;
  }

  next();
}
