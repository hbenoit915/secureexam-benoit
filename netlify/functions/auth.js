import { getStore } from "@netlify/blobs";

const store = () => getStore({ name: "secureexam-teachers", consistency: "strong" });

// ── Teacher accounts ──
// These are stored in Netlify Blobs on first request (auto-seeded).
// To add or change accounts, update SEED_ACCOUNTS below and
// delete the "seeded" key from your Netlify Blobs store.
const SEED_ACCOUNTS = [
  { username: "hbenoit", password: "benoit47", name: "Mr. Benoit" },
  { username: "EPISD",   password: "TEA2026",  name: "EPISD Admin" }
];

async function seedIfNeeded() {
  const seeded = await store().get("seeded");
  if (seeded) return;
  for (const acct of SEED_ACCOUNTS) {
    await store().setJSON("teacher-" + acct.username, acct);
  }
  await store().set("seeded", "yes");
}

export default async (req) => {
  const method = req.method;

  // Handle preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token",
        "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS"
      }
    });
  }

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token"
  };

  try {
    // ── POST — Login ──
    if (method === "POST") {
      await seedIfNeeded();

      const body = await req.json();
      const { username, password } = body;

      if (!username || !password) {
        return Response.json({ ok: false, error: "Username and password required." }, { headers });
      }

      // Look up teacher account
      const acct = await store().get("teacher-" + username, { type: "json" });

      if (!acct || acct.password !== password) {
        return Response.json({ ok: false, error: "Invalid username or password." }, { headers });
      }

      // Generate a session token and store it
      const token = crypto.randomUUID();
      const session = {
        token,
        username,
        name: acct.name,
        createdAt: Date.now(),
        expiresAt: Date.now() + 12 * 60 * 60 * 1000  // 12 hours
      };
      await store().setJSON("session-" + token, session);

      return Response.json({ ok: true, token, name: acct.name }, { headers });
    }

    // ── DELETE — Logout ──
    if (method === "DELETE") {
      const token = req.headers.get("x-auth-token");
      if (token) {
        await store().delete("session-" + token).catch(() => {});
      }
      return Response.json({ ok: true }, { headers });
    }

    return Response.json({ ok: false, error: "Method not allowed." }, { status: 405, headers });

  } catch (err) {
    console.error("Auth error:", err);
    return Response.json({ ok: false, error: "Server error. Try again." }, { status: 500, headers });
  }
};

export const config = { path: "/api/auth" };
