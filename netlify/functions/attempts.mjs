import { getStore } from "@netlify/blobs";

const store = () => getStore({ name: "secureexam-attempts", consistency: "strong" });

// Read-only access to the EXISTING teacher session store (created by
// auth.js at login). This file never writes to, or deletes from,
// secureexam-teachers — it only ever reads a session record to check
// whether the caller is a signed-in, not-yet-expired teacher. This is
// not a second copy of any password: no password is read, stored, or
// compared here at all — only the opaque session token auth.js already
// issued on successful login.
const teacherStore = () => getStore({ name: "secureexam-teachers", consistency: "strong" });

const ATTEMPT_PREFIX = "attempt-";
// Marker keys live inside secureexam-attempts (never a new/other store),
// so clearAll's write access stays confined to the one store it's scoped
// to. They must never be treated as attempt records by list/exportAll.
const EXPORT_MARKER_PREFIX = "_export-marker-";
const EXPORT_MARKER_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ── Require a valid, non-expired teacher session. ──
// Returns { ok:true, session } or { ok:false, status, error }.
async function requireTeacherAuth(req) {
  const token = req.headers.get("x-auth-token");
  if (!token) {
    return { ok: false, status: 401, error: "Unauthorized. Teacher sign-in required." };
  }
  const session = await teacherStore().get("session-" + token, { type: "json" });
  if (!session) {
    // Covers both "no such session" (e.g. a student or outside caller with
    // no token, or a fabricated token) and a token that was already
    // invalidated by logout.
    return { ok: false, status: 401, error: "Unauthorized. Teacher sign-in required." };
  }
  if (!session.expiresAt || session.expiresAt < Date.now()) {
    return { ok: false, status: 401, error: "Session expired. Please log in again." };
  }
  return { ok: true, session };
}

// Only ever pass this the keys/records that actually belong to a real
// attempt — never an export-marker record. Used by list/exportAll/clearAll
// so a marker blob can never render as a fake student row, corrupt a
// score average, or get counted in a CSV/backup export.
function isAttemptKey(key) {
  return key.startsWith(ATTEMPT_PREFIX);
}

export default async (req) => {
  const method = req.method;
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  try {
    // ── Ordinary, unauthenticated actions — unchanged from before. ──
    // "list" is read by the teacher dashboard; "save" is how a student's
    // browser submits a completed assessment; "grade" is how a teacher
    // posts essay scores. None of these are destructive/admin operations,
    // so none of them require the new teacher-session check below — only
    // exportAll and clearAll do (see the isolation note on clearAll).

    if (method === "GET" && action === "list") {
      const { blobs } = await store().list();
      const attempts = [];
      for (const b of blobs) {
        if (!isAttemptKey(b.key)) continue; // skip export-marker records
        const a = await store().get(b.key, { type: "json" });
        if (a) attempts.push(a);
      }
      attempts.sort((a, b) => b.submittedAt - a.submittedAt);
      return Response.json({ ok: true, attempts });
    }

    if (method === "POST" && action === "save") {
      const body = await req.json();
      const id = Date.now();
      const attempt = { ...body, id, submittedAt: id };
      await store().setJSON(ATTEMPT_PREFIX + id, attempt);
      return Response.json({ ok: true, attempt });
    }

    if (method === "PATCH" && action === "grade") {
      const { id, essayScores, comments } = await req.json();
      const s = store();
      const attempt = await s.get(ATTEMPT_PREFIX + id, { type: "json" });
      if (!attempt) return Response.json({ ok: false, error: "Not found" }, { status: 404 });
      attempt.essayScores = essayScores;
      attempt.essayComments = comments;
      attempt.status = "graded";
      const essayTotal = Object.values(essayScores || {}).reduce((sum, v) => sum + Number(v), 0);
      const mcEarned = attempt.earned || 0;
      const totalPossible = (attempt.mcPossible || 0) + (attempt.essayPossible || 0);
      if (totalPossible > 0) {
        attempt.score = Math.round((mcEarned + essayTotal) / totalPossible * 100);
      }
      await s.setJSON(ATTEMPT_PREFIX + id, attempt);
      return Response.json({ ok: true, attempt });
    }

    // ── GET full backup export — TEACHER-AUTHORIZED ONLY. ──
    // Contains student names, IDs, responses, scores, essay text, comments,
    // and suspicious-activity logs, so this now requires the same
    // valid-session check as clearAll below.
    if (method === "GET" && action === "exportAll") {
      const auth = await requireTeacherAuth(req);
      if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status });

      const { blobs } = await store().list();
      const attempts = [];
      for (const b of blobs) {
        if (!isAttemptKey(b.key)) continue;
        const a = await store().get(b.key, { type: "json" });
        if (a) attempts.push(a);
      }
      attempts.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

      // Record that THIS authenticated session received a complete export,
      // so a subsequent clearAll from the same session can require it.
      // Written only inside secureexam-attempts — see EXPORT_MARKER_PREFIX
      // note above; this never touches secureexam-teachers or -exams.
      await store().setJSON(EXPORT_MARKER_PREFIX + auth.session.token, { exportedAt: Date.now() });

      return Response.json({ ok: true, exportedAt: Date.now(), count: attempts.length, attempts });
    }

    // ── DELETE all attempts — TEACHER-AUTHORIZED ONLY, and only after a
    // verified backup export from this same session. ──
    //
    // Store isolation: this reads secureexam-teachers ONLY through
    // requireTeacherAuth (a read-only session lookup — never a write or
    // delete there), and otherwise touches only attempt-/marker keys inside
    // secureexam-attempts. Nothing in this file ever references
    // secureexam-exams.
    //
    // Backup-verification limitation — read this before relying on it:
    // the server has no way to know whether the teacher's browser actually
    // saved the downloaded file to disk; that happens entirely outside any
    // request the server can see. What this DOES verify is that the server
    // sent a complete export to an authenticated request from this same
    // session within the last 30 minutes. That proves the data was served,
    // not that the file was kept — it is the closest honestly-verifiable
    // proxy available, not a guarantee of an actual saved backup.
    if (method === "DELETE" && action === "clearAll") {
      const auth = await requireTeacherAuth(req);
      if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status });

      const s = store();
      const markerKey = EXPORT_MARKER_PREFIX + auth.session.token;
      const marker = await s.get(markerKey, { type: "json" });
      if (!marker || !marker.exportedAt || (Date.now() - marker.exportedAt) > EXPORT_MARKER_TTL_MS) {
        return Response.json({
          ok: false,
          error: "Backup not verified. Download a backup from this session before clearing student data."
        }, { status: 403 });
      }

      const { blobs } = await s.list();
      const attemptKeys = blobs.map((b) => b.key).filter(isAttemptKey);
      await Promise.all(attemptKeys.map((k) => s.delete(k)));
      await s.delete(markerKey); // single-use — a fresh export is required for any future reset

      return Response.json({ ok: true, deleted: attemptKeys.length });
    }

    return Response.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
};

export const config = { path: "/api/attempts" };
