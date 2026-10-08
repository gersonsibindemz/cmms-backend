// atualizar-senha.js
import bcrypt from 'bcrypt';
import { pool } from './src/db.js';

async function atualizarSenha() {
  const email = 'admin@cmms.co.mz';
  const novaSenha = 'AdminPassword123!';

  console.log('A gerar hash seguro com bcrypt...');
  const hash = await bcrypt.hash(novaSenha, 10);

  console.log('A atualizar utilizador no Supabase...');
  const res = await pool.query(
    `UPDATE app_users 
     SET password_hash = $1 
     WHERE email = $2 
     RETURNING id, email, full_name, role`,
    [hash, email]
  );

  if (res.rowCount === 0) {
    console.error('Utilizador não encontrado no banco de dados.');
  } else {
    console.log('✓ Senha atualizada com sucesso para:', res.rows[0]);
  }

  await pool.end();
}

atualizarSenha().catch((err) => {
  console.error('Erro ao conectar ou atualizar:', err.message);
  process.exit(1);
});