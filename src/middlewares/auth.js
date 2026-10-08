import jwt from 'jsonwebtoken';

export function authenticateToken(req, res, next) {
  const token = req.cookies?.auth_token;

  if (!token) {
    return res.status(401).json({ message: 'Autenticação necessária.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    req.user = {
      id: payload.id,
      tenantId: payload.tenantId,
      role: payload.role,
      fullName: payload.fullName,
    };

    return next();
  } catch {
    return res.status(403).json({ message: 'Token inválido ou expirado.' });
  }
}

export function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Acesso não permitido.' });
    }

    return next();
  };
}