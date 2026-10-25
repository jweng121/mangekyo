import "server-only";
import { spawn } from "node:child_process";
import path from "node:path";

export function evidenceWorker<T>(request: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.MANGEKYO_PYTHON || "python", [path.join(process.cwd(), "scripts", "evidence-worker.py")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Evidence processing timed out")); }, 45000);
    child.stdout.on("data", data => { output += data.toString(); if (output.length > 24 * 1024 * 1024) { child.kill(); reject(new Error("Evidence response too large")); } });
    child.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-1000); });
    child.on("error", () => { clearTimeout(timer); reject(new Error("Python is required for PDF and SQLite evidence. Install scripts/requirements-evidence.txt.")); });
    child.on("close", code => { clearTimeout(timer); try { const result = JSON.parse(output); if (code || result.error) reject(new Error(result.error || "Evidence processing failed")); else resolve(result); } catch { reject(new Error(stderr.includes("ModuleNotFoundError") ? "Install the PDF dependencies from scripts/requirements-evidence.txt." : "Evidence processing failed")); } });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(request));
  });
}
