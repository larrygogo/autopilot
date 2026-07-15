import { Database } from "bun:sqlite";
import { _setDbForTest } from "../../src/core/db";
import { saveAttachment } from "../../src/core/requirements/attachments";

const db = new Database(":memory:");
db.exec(`CREATE TABLE requirement_attachments (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  category TEXT NOT NULL,
  extracted_text TEXT,
  created_at INTEGER NOT NULL
)`);
_setDbForTest(db);

const save = (originalName: string, content: string) => saveAttachment({
  requirementId: "req-race",
  originalName,
  mimeType: "text/plain",
  data: new TextEncoder().encode(content).buffer,
});

const settled = await Promise.allSettled([
  save("first.txt", "FIRST"),
  save("second.txt", "SECOND"),
]);
const rows = db.query<{ id: string; original_name: string; extracted_text: string }, []>(
  "SELECT id, original_name, extracted_text FROM requirement_attachments ORDER BY id",
).all();

console.log(JSON.stringify({ statuses: settled.map((r) => r.status), rows }));
_setDbForTest(null);
db.close();
