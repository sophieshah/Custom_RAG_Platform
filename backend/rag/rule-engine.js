import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { resolvePythonExecutable } from "./local-embeddings.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bridgePath = path.join(repositoryRoot, "tb_isolation_rules_package", "bridge.py");
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15000;

export function runRuleEngine({
  action,
  caseData,
  pythonExecutable = resolvePythonExecutable(),
}) {
  if (action !== "validate" && action !== "evaluate") {
    throw new Error("Rule engine action must be validate or evaluate.");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, [bridgePath], {
      cwd: repositoryRoot,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let outputSize = 0;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`Python rule engine exceeded ${TIMEOUT_MS} ms.`));
    }, TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      outputSize += Buffer.byteLength(chunk);
      if (outputSize > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("Python rule engine output exceeded the size limit."));
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16000);
    });
    child.once("error", (error) => {
      finish(new Error(`Unable to start Python rule engine (${pythonExecutable}): ${error.message}`));
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(stderr.trim() || `Python rule engine exited with code ${code}.`));
        return;
      }
      try {
        finish(null, JSON.parse(stdout));
      } catch (error) {
        finish(new Error(`Python rule engine returned invalid JSON: ${error.message}`));
      }
    });
    child.stdin.once("error", (error) => {
      if (error.code !== "EPIPE") finish(error);
    });
    child.stdin.end(JSON.stringify({ action, case: caseData }));
  });
}
