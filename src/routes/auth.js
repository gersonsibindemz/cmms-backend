import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { withTenantContext } from '../db.js';
import { authenticateToken } from '../middlewares/auth.js';

const router = Router();
const cookieName = 'auth_token';
const tokenLifetimeMs = 8 * 60 * 60 * 1000;

function getCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'none',
    path: '/',
  };
}

router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
    return res.status(400).json({ message: 'Email e senha são obrigatórios.' });
  }

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ message: 'Autenticação não configurada.' });
  }

  const result = await withTenantContext(null, 'super_admin', (client) =>
    client.query(
      `SELECT
         u.id,
         u.tenant_id,
         u.email,
         u.password_hash,
         u.full_name,
         u.role,
         u.is_active,
         t.is_active AS tenant_is_active
       FROM app_users AS u
       LEFT JOIN tenants AS t ON t.id = u.tenant_id
       WHERE LOWER(u.email) = LOWER($1)
       LIMIT 1`,
      [email.trim()],
    ),
  );

  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ message: 'Email ou senha inválidos.' });
  }

  if (!user.is_active) {
    return res.status(403).json({ message: 'Conta desativada.' });
  }

  if (user.role !== 'super_admin' && user.tenant_is_active === false) {
    return res.status(403).json({ message: 'Tenant desativado.' });
  }

  const currentUser = {
    id: user.id,
    tenantId: user.tenant_id,
    role: user.role,
    fullName: user.full_name,
  };
  const token = jwt.sign(currentUser, process.env.JWT_SECRET, { expiresIn: '8h' });

  return res
    .cookie(cookieName, token, { ...getCookieOptions(), maxAge: tokenLifetimeMs })
    .json({ user: currentUser });
});

router.post('/logout', (req, res) => {
  return res.clearCookie(cookieName, getCookieOptions()).json({ message: 'Logout realizado.' });
});

router.get('/me', authenticateToken, (req, res) => {
  return res.json({ user: req.user });
});

export default router;