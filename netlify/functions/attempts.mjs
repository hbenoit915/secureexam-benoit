import { getStore } from "@netlify/blobs";

const store = () => getStore({ name: "secureexam-attempts", consistency: "strong" });

export default async (req) => {
  const method = req.method;
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  try {
    if (method === "GET" && action === "list") {
      const { blobs } = await store().list();
      const attempts = [];
      for (const b of blobs) {
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
      await store().setJSON("attempt-" + id, attempt);
      return Response.json({ ok: true, attempt });
    }

    return Response.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
};

export const config = { path: "/api/attempts" };
