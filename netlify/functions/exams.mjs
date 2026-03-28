import { getStore } from "@netlify/blobs";

const store = () => getStore({ name: "secureexam-exams", consistency: "strong" });

export default async (req) => {
  const method = req.method;
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  try {
    if (method === "GET" && action === "list") {
      const { blobs } = await store().list();
      const exams = [];
      for (const b of blobs) {
        const exam = await store().get(b.key, { type: "json" });
        if (exam) exams.push(exam);
      }
      exams.sort((a, b) => b.createdAt - a.createdAt);
      return Response.json({ ok: true, exams });
    }

    if (method === "POST" && action === "save") {
      const body = await req.json();
      const id = Date.now();
      const exam = { ...body, id, createdAt: id, status: body.status || "published" };
      await store().setJSON("exam-" + id, exam);
      return Response.json({ ok: true, exam });
    }

    if (method === "PATCH" && action === "toggle") {
      const { id } = await req.json();
      const s = store();
      const exam = await s.get("exam-" + id, { type: "json" });
      if (!exam) return Response.json({ ok: false, error: "Not found" }, { status: 404 });
      exam.status = exam.status === "published" ? "closed" : "published";
      await s.setJSON("exam-" + id, exam);
      return Response.json({ ok: true, exam });
    }

    if (method === "DELETE") {
      const id = url.searchParams.get("id");
      await store().delete("exam-" + id);
      return Response.json({ ok: true });
    }

    return Response.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
};

export const config = { path: "/api/exams" };
