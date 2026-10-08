import bcrypt from 'bcrypt';

const hash = await bcrypt.hash('AdminPassword123!', 10);
console.log('HASH_GERADO:', hash);