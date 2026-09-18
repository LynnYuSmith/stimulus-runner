"use strict";
/* Runs the Python crash tests as part of `npm test`.
 *
 * They live in Python because they have to start, kill -9 and restart serve.py itself -- the
 * thing whose durability is in question. This wrapper only finds an interpreter, so that one
 * `npm test` covers both halves of the trial log instead of the server half being the one
 * everybody forgets to run.
 *
 * No interpreter is a FAILURE, not a skip: serve.py cannot run without Python either, so a
 * machine that cannot run these cannot run the runner.
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const script = path.join(__dirname, "stimlog_crash.test.py");
for (const exe of ["python3", "python", "py"]) {
  const r = spawnSync(exe, [script], { stdio: "inherit" });
  if (r.error && r.error.code === "ENOENT") continue;   // not this one; try the next
  process.exit(r.status === null ? 1 : r.status);
}
console.error("  FAILED: no Python interpreter found (tried python3, python, py).\n"
  + "  serve.py needs one too, so this is a broken environment rather than a skippable test.");
process.exit(1);
