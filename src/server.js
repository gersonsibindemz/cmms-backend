import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import superAdminRoutes from './routes/superAdmin.js';
import adminTenantRoutes from './routes/adminTenants.js';
import userRoutes from './routes/users.js';
import assetRoutes from './routes/assets.js';
import fuelLogRoutes from './routes/fuelLogs.js';
import workOrderRoutes from './routes/workOrders.js';
import technicianRoutes from './routes/technicians.js';
import notificationRoutes from './routes/notifications.js';
import partsRoutes from './routes/parts.js';
import dashboardRoutes from './routes/dashboard.js';

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));
app.use(express.json());
app.use(cookieParser());

app.get('/health', (req, res) => {
  return res.json({ status: 'ok' });
});

app.use('/api/auth', authRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/admin', adminTenantRoutes);
app.use('/api/users', userRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/fuel', fuelLogRoutes);
app.use('/api/work-orders', workOrderRoutes);
app.use('/api/technicians', technicianRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/parts', partsRoutes);
app.use('/api/dashboard', dashboardRoutes);

app.use((err, req, res, next) => {
  console.error('[Unhandled Error]:', err);
  if (res.headersSent) return next(err);
  return res.status(err.status || 500).json({
    error: err.message || 'Erro interno do servidor.',
  });
});

const port = process.env.PORT ? Number(process.env.PORT) : 4000;
app.listen(port, () => {
  console.log(`CMMS API listening on port ${port}`);
});