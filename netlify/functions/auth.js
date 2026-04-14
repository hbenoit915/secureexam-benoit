// ============================================================
// SecureExam — Netlify Serverless Function: /api/auth
// File location in your repo: netlify/functions/auth.js
//   OR: api/auth.js  (depending on your Netlify setup)
//
// Handles:
//   POST /api/auth   — teacher login, returns session token
//   DELETE /api/auth — teacher logout, invalidates token
// ============================================================

// ── Dependencies ──
// Run in your repo:  npm install @neondatabase/serverless bcryptjs
const { neon } = require('@neondatabase/serverless');
const bcrypt    = require('bcryptjs');
const crypto    = require('crypto');

// ── Database connection ──
// Set DATABASE_URL in your Netlify environment variables
// (Site settings → Environment variables)
const sql = neon(process.env.DATABASE_URL);

// ── One-time DB setup ──
// Run these SQL statements once in your Neon console to create
// the required tables:
//
//   CREATE TABLE IF NOT EXISTS teachers (
//     id       SERIAL PRIMARY KEY,
//     username TEXT UNIQUE NOT NULL,
//     pw_hash  TEXT NOT NULL,
//     name     TEXT NOT NULL
//   );
//
//   CREATE TABLE IF NOT EXISTS sessions (
//     token      TEXT PRIMARY KEY,
//     teacher_id INTEGER REFERENCES teachers(id),
//     created_at TIMESTAMPTZ DEFAULT NOW(),
//     expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '12 hours'
//   );
//
//   -- Then insert your teacher accounts (run once):
//   INSERT INTO teachers (username, pw_hash, name) VALUES
//     ('hbenoit', '$2a$10$HASH_FOR_benoit47', 'Mr. Benoit'),
//     ('EPISD',   '$2a$10$HASH_FOR_TEA2026',  'EPISD Admin')
//   ON CONFLICT (username) DO NOTHING;
//
// To generate the bcrypt hashes for your passwords, run this
// in a terminal once:
//   node -e "const b=require('bcryptjs'); console.log(b.hashSync('benoit47',10)); console.log(b.hashSync('TEA2026',10));"
// Then paste the output hashes into the INSERT above.

exports.handler = async function(event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
    'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // ── POST /api/auth — Login ──
  if (event.httpMethod === 'POST') {
    try {
      const { username, password } = JSON.parse(event.body || '{}');

      if (!username || !password) {
        return { statusCode: 200, headers,
          body: JSON.stringify({ ok: false, error: 'Username and password required.' }) };
      }

      // Look up teacher in Neon
      const rows = await sql`
        SELECT id, pw_hash, name FROM teachers
        WHERE username = ${username}
        LIMIT 1
      `;

      if (!rows.length) {
        // Return same message as wrong password — don't reveal which field is wrong
        return { statusCode: 200, headers,
          body: JSON.stringify({ ok: false, error: 'Invalid username or password.' }) };
      }

      const teacher = rows[0];

      // Compare password against stored bcrypt hash
      const valid = await bcrypt.compare(password, teacher.pw_hash);
      if (!valid) {
        return { statusCode: 200, headers,
          body: JSON.stringify({ ok: false, error: 'Invalid username or password.' }) };
      }

      // Generate a secure random session token
      const token = crypto.randomBytes(32).toString('hex');

      // Store token in sessions table (expires in 12 hours)
      await sql`
        INSERT INTO sessions (token, teacher_id)
        VALUES (${token}, ${teacher.id})
      `;

      // Clean up expired sessions in the background
      sql`DELETE FROM sessions WHERE expires_at < NOW()`.catch(() => {});

      return { statusCode: 200, headers,
        body: JSON.stringify({ ok: true, token, name: teacher.name }) };

    } catch (err) {
      console.error('Auth POST error:', err);
      return { statusCode: 500, headers,
        body: JSON.stringify({ ok: false, error: 'Server error. Try again.' }) };
    }
  }

  // ── DELETE /api/auth — Logout ──
  if (event.httpMethod === 'DELETE') {
    try {
      const token = event.headers['x-auth-token'] ||
                    (JSON.parse(event.body || '{}').token);
      if (token) {
        await sql`DELETE FROM sessions WHERE token = ${token}`;
      }
      return { statusCode: 200, headers,
        body: JSON.stringify({ ok: true }) };
    } catch (err) {
      // Logout errors are non-critical — always return ok
      return { statusCode: 200, headers,
        body: JSON.stringify({ ok: true }) };
    }
  }

  return { statusCode: 405, headers,
    body: JSON.stringify({ ok: false, error: 'Method not allowed.' }) };
};

// ============================================================
// HOW TO VERIFY A TOKEN IN OTHER ROUTES
// Copy this helper into your other api/*.js files to protect
// teacher-only endpoints (exams, attempts, etc.)
// ============================================================
//
// async function verifyToken(token) {
//   if (!token) return null;
//   const rows = await sql`
//     SELECT t.id, t.name FROM sessions s
//     JOIN teachers t ON t.id = s.teacher_id
//     WHERE s.token = ${token}
//       AND s.expires_at > NOW()
//     LIMIT 1
//   `;
//   return rows.length ? rows[0] : null;
// }
//
// Usage in a protected route:
//   const teacher = await verifyToken(event.headers['x-auth-token']);
//   if (!teacher) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };
