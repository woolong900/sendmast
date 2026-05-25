#!/usr/bin/env node
const n = Number(process.argv[2] ?? '100');
console.log('email,first_name,last_name');
for (let i = 1; i <= n; i++) {
  const num = String(i).padStart(3, '0');
  console.log(`user${num}@example.test,User,${i}`);
}
