import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from "node:fs";
import { resolve } from "node:path";

/** One supervisor per dedicated Chrome/audio pair. Also protects seq allocation. */
export function openRunStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, "meeting-session.json");
  const lock = resolve(directory, "meeting-session.lock");
  try {
    const pid = Number(readFileSync(lock, "utf8"));
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      unlinkSync(lock);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let fd;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("A meeting supervisor is already running (meeting-session.lock).");
    throw error;
  }
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return {
    read() {
      try { return JSON.parse(readFileSync(path, "utf8")); }
      catch (error) {
        if (error.code === "ENOENT") return null;
        throw new Error(`Cannot read meeting recovery state: ${error.message}`);
      }
    },
    write(state) {
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(state) + "\n", { mode: 0o600 });
      renameSync(temp, path);
    },
    close() { unlinkSync(lock); },
  };
}
