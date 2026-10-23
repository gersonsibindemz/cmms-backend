import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { pool, withTenantContext } from '../db.js';
import { authenticateToken } from '../middlewares/auth.js';
import { removeUserAvatar, uploadUserAvatar } from '../services/storage.js';

const router = Router();
const IS_PROD = process.env.NODE_ENV === 'production';
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter(req, file, callback) {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return callback(null, true);
    }
    const error = new Error('Formato da foto de perfil inválido. Use JPEG, PNG ou WebP.');
    error.code = 'UNSUPPORTED_AVATAR_TYPE';
    return callback(error);
  },
});

function parseAvatarUpload(req, res, next) {
  avatarUpload.single('avatar')(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
        .json({ error: error.message });
    }
    if (error.code === 'UNSUPPORTED_AVATAR_TYPE') {
      return res.status(415).json({ error: error.message });
    }
    return next(error);
  });
}

router.post('/me/avatar', authenticateToken, parseAvatarUpload, async (req, res, next) => {
  if (!req.file || req.file.size === 0) {
    return res.status(400).json({ error: 'Envie uma foto no campo "avatar".' });
  }

  let oldAvatarUrl = null;
  try {
    const oldUserRes = await pool.query('SELECT avatar_url FROM public.app_users WHERE id = $1::uuid', [req.user.id]);
    oldAvatarUrl = oldUserRes.rows[0]?.avatar_url;
  } catch (e) {}

  let uploadedAvatar;
  try {
    uploadedAvatar = await uploadUserAvatar(req.user.id, req.file.buffer, req.file.mimetype);
    const result = await withTenantContext(req.user.tenantId, req.user.role, (client) =>
      client.query(
        `UPDATE public.app_users
         SET avatar_url = $1
         WHERE id = $2::uuid
           AND deleted_at IS NULL
         RETURNING avatar_url`,
        [uploadedAvatar.publicUrl, req.user.id],
      ),
    );
    if (!result.rowCount) {
      await removeUserAvatar(uploadedAvatar.storagePath);
      return res.status(404).json({ error: 'Utilizador não encontrado.' });
    }
    if (oldAvatarUrl) {
      try {
        await removeUserAvatar(oldAvatarUrl);
      } catch (delErr) {
        console.warn('Erro ao remover avatar anterior:', delErr);
      }
    }

    return res.json({
      message: 'Avatar atualizado com sucesso.',
      avatar_url: result.rows[0].avatar_url,
    });
  } catch (error) {
    if (uploadedAvatar) {
      try {
        await removeUserAvatar(uploadedAvatar.storagePath);
      } catch (cleanupError) {
        console.error('Erro ao remover foto de perfil após falha:', cleanupError);
      }
    }
    return next(error);
  }
});

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
      `SELECT u.id, u.tenant_id, u.password_hash, u.full_name, u.email, u.role, u.is_active,
              u.avatar_url,
              u.deleted_at, u.suspension_reason,
              u.operational_scope,
              t.is_active as tenant_active, t.name as tenant_name, t.operational_scope as tenant_scope
       FROM app_users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = $1`,
      [email.toLowerCase().trim()]
    );

    const user = userQuery.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    if (user.deleted_at !== null) {
      return res.status(403).json({ error: 'Utilizador eliminado.' });
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
        isSuspended: user.is_active === false,
        readonly_penalty: user.is_active === false,
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
      token,
      user: {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        role: user.role,
        tenantId: user.tenant_id,
        tenantName: user.tenant_name,
        operational_scope: user.operational_scope,
        isSuspended: user.is_active === false,
        readonly_penalty: user.is_active === false,
        suspension_reason: user.suspension_reason,
        avatar_url: user.avatar_url,
        tenant: {
          id: user.tenant_id,
          name: user.tenant_name,
          operational_scope: user.tenant_scope,
        },
      }
    });
  } catch (error) {
    console.error('Erro na autenticação:', error);
    return res.status(500).json({ error: error.message || 'Erro interno no servidor.' });
  }
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.cookies?.auth_token) {
    token = req.cookies.auth_token;
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const userId = decoded.userId || decoded.id;
      if (userId) {
        await pool.query(
          `UPDATE public.app_users 
           SET last_sign_in = NOW(), last_login_at = NOW() 
           WHERE id = $1::uuid`,
          [userId]
        );
      }
    } catch (e) {}
  }

  res.clearCookie('auth_token', {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? 'none' : 'lax'
  });
  return res.json({ message: 'Sessão encerrada com sucesso.' });
});

// POST /api/auth/record-exit (acionado no fecho de aba/janela ou reset do cookie)
router.post('/record-exit', async (req, res) => {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.cookies?.auth_token) {
    token = req.cookies.auth_token;
  } else if (req.body?.token) {
    token = req.body.token;
  }

  const userId = req.body?.userId;

  try {
    let targetUserId = userId;
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        targetUserId = decoded.userId || decoded.id || targetUserId;
      } catch (e) {}
    }
    if (targetUserId) {
      await pool.query(
        `UPDATE public.app_users 
         SET last_sign_in = NOW(), last_login_at = NOW() 
         WHERE id = $1::uuid`,
        [targetUserId]
      );
      return res.json({ success: true, recorded: true });
    }
  } catch (err) {
    console.error('Erro ao registar saída:', err);
  }

  return res.json({ success: true });
});
  return res.json({ message: 'Sessão encerrada com sucesso.' });
});

// GET /api/auth/me
router.get('/me', async (req, res) => {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.cookies?.auth_token) {
    token = req.cookies.auth_token;
  }
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
      `SELECT u.id, u.tenant_id, u.full_name, u.email, u.role, u.is_active,
              u.avatar_url,
              u.suspension_reason, u.operational_scope,
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
        isSuspended: freshUser.is_active === false,
        readonly_penalty: freshUser.is_active === false,
        suspension_reason: freshUser.suspension_reason,
        avatar_url: freshUser.avatar_url,
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