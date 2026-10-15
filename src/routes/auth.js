import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';

const router = Router();
const IS_PROD = process.env.NODE_ENV === 'production';

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  console.log('>>> [CMMS API] Tentativa de login para o email:', email);

  if (!email || !password) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
  }

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ error: 'JWT_SECRET não está definido nas variáveis de ambiente.' });
  }

  try {
    // 1. Busca usuário e dados da empresa
    const userQuery = await pool.query(
      `SELECT u.id, u.tenant_id, u.password_hash, u.full_name, u.role, u.is_active,
              u.operational_scope,
              t.is_active as tenant_active, t.name as tenant_name
       FROM app_users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = $1`,
      [email.toLowerCase().trim()]
    );

    const user = userQuery.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Utilizador inativo.' });
    }

    // Se não for super_admin, valida se o tenant está ativo
    if (user.role !== 'super_admin' && !user.tenant_active) {
      return res.status(403).json({ error: 'Empresa inativa.' });
    }

    // 2. Validação da senha criptografada via bcrypt
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    // 3. Emissão do token JWT
    const token = jwt.sign(
      {
        userId: user.id,
        tenantId: user.tenant_id,
        role: user.role,
        fullName: user.full_name,
        operational_scope: user.operational_scope,
      },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    // 4. Grava Cookie HttpOnly
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: IS_PROD ? 'none' : 'lax',
      maxAge: 8 * 60 * 60 * 1000
    });

    return res.status(200).json({
      message: 'Login realizado com sucesso.',
      user: {
        id: user.id,
        fullName: user.full_name,
        role: user.role,
        tenantId: user.tenant_id,
        tenantName: user.tenant_name,
        operational_scope: user.operational_scope,
      }
    });
  } catch (error) {
    console.error('Erro na autenticação:', error);
    return res.status(500).json({ error: error.message || 'Erro interno no servidor.' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('auth_token', {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? 'none' : 'lax'
  });
  return res.json({ message: 'Sessão encerrada com sucesso.' });
});

// GET /api/auth/me
router.get('/me', async (req, res) => {
  const token = req.cookies?.auth_token;
  if (!token) return res.status(401).json({ authenticated: false });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ authenticated: false });
  }

  if (!decoded || typeof decoded !== 'object') {
    return res.status(401).json({ authenticated: false });
  }

  const userId = decoded.userId || decoded.id;
  if (!userId) return res.status(401).json({ authenticated: false });

  try {
    const result = await pool.query(
      `SELECT u.id, u.tenant_id, u.full_name, u.email, u.role, u.is_active, u.operational_scope,
              t.name AS tenant_name, t.operational_scope AS tenant_scope, t.is_active AS tenant_active
       FROM public.app_users u
       LEFT JOIN public.tenants t ON t.id = u.tenant_id
       WHERE u.id = $1::uuid
         AND u.deleted_at IS NULL`,
      [userId],
    );

    const freshUser = result.rows[0];
    if (
      !freshUser
      || freshUser.is_active === false
      || (freshUser.role !== 'super_admin' && freshUser.tenant_active !== true)
    ) {
      res.clearCookie('auth_token', {
        httpOnly: true,
        secure: IS_PROD,
        sameSite: IS_PROD ? 'none' : 'lax',
      });
      return res.status(401).json({
        authenticated: false,
        message: 'Sessão revogada ou utilizador desativado.',
      });
    }

    return res.status(200).json({
      authenticated: true,
      user: {
        id: freshUser.id,
        fullName: freshUser.full_name,
        email: freshUser.email,
        role: freshUser.role,
        tenantId: freshUser.tenant_id,
        tenantName: freshUser.tenant_name,
        operational_scope: freshUser.operational_scope,
        tenant: {
          id: freshUser.tenant_id,
          name: freshUser.tenant_name,
          operational_scope: freshUser.tenant_scope,
        },
      },
    });
  } catch (error) {
    console.error('Erro ao validar sessão:', error);
    return res.status(500).json({
      authenticated: false,
      message: 'Erro interno ao validar sessão.',
    });
  }
});

export default router;