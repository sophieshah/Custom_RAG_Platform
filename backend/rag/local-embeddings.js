import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workerScript = path.join(repositoryRoot, "backend", "rag", "embedding-worker.py");
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const START_TIMEOUT_MS = 120000;

export function resolvePythonExecutable() {
  if (process.env.PYTHON_EXECUTABLE) return process.env.PYTHON_EXECUTABLE;
  const venvPython = process.platform === "win32"
    ? path.join(repositoryRoot, ".venv", "Scripts", "python.exe")
    : path.join(repositoryRoot, ".venv", "bin", "python");
  return existsSync(venvPython) ? venvPython : "python";
}

export class LocalEmbeddingWorker {
  constructor({ pythonExecutable = resolvePythonExecutable() } = {}) {
    this.pythonExecutable = pythonExecutable;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.startPromise = null;
    this.closed = false;
    this.dimension = null;
  }

  start() {
    if (this.startPromise) return this.startPromise;
    if (this.closed) return Promise.reject(new Error("Embedding worker is closed."));

    this.startPromise = new Promise((resolve, reject) => {
      const child = spawn(this.pythonExecutable, [workerScript], {
        cwd: repositoryRoot,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
      this.child = child;
      let readySettled = false;
      const startupTimer = setTimeout(() => {
        child.kill();
        if (!readySettled) {
          readySettled = true;
          reject(new Error(`Local embedding model did not load within ${START_TIMEOUT_MS} ms.`));
        }
      }, START_TIMEOUT_MS);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        console.error("Embedding worker:", chunk.trimEnd());
      });
      child.stdout.on("data", (chunk) => {
        this.stdoutBuffer += chunk;
        if (Buffer.byteLength(this.stdoutBuffer) > MAX_LINE_BYTES) {
          child.kill();
          this.rejectPending(new Error("Embedding worker output exceeded the size limit."));
          return;
        }
        let newline;
        while ((newline = this.stdoutBuffer.indexOf("\n")) !== -1) {
          const line = this.stdoutBuffer.slice(0, newline);
          this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
          this.handleMessage(line, (dimension) => {
            if (readySettled) return;
            readySettled = true;
            clearTimeout(startupTimer);
            this.dimension = dimension;
            resolve(dimension);
          });
        }
      });
      child.once("error", (error) => {
        clearTimeout(startupTimer);
        if (!readySettled) {
          readySettled = true;
          reject(new Error(`Unable to start Python embedding worker (${this.pythonExecutable}): ${error.message}`));
        }
        this.rejectPending(error);
      });
      child.once("close", (code) => {
        clearTimeout(startupTimer);
        const error = new Error(`Local embedding worker exited with code ${code}.`);
        if (!readySettled) {
          readySettled = true;
          reject(error);
        }
        this.rejectPending(error);
      });
    });
    return this.startPromise;
  }

  handleMessage(line, onReady) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.rejectPending(new Error(`Embedding worker returned invalid JSON: ${error.message}`));
      return;
    }
    if (message.ready === true) {
      if (!Number.isInteger(message.dimension) || message.dimension < 1) {
        this.rejectPending(new Error("Embedding worker reported an invalid vector dimension."));
        return;
      }
      onReady(message.dimension);
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(`Local embedding failed: ${message.error}`));
    } else if (!Array.isArray(message.vectors)) {
      pending.reject(new Error("Embedding worker returned no vectors."));
    } else {
      pending.resolve(message.vectors);
    }
  }

  async embedQueries(texts) {
    return this.embed(texts.map((text) => `query: ${text}`));
  }

  async embedPassages(texts) {
    return this.embed(texts.map((text) => `passage: ${text}`));
  }

  async embed(texts) {
    await this.start();
    if (this.closed || !this.child || this.child.killed) {
      throw new Error("Local embedding worker is not available.");
    }
    if (!Array.isArray(texts) || texts.length === 0 || !texts.every((text) => typeof text === "string")) {
      throw new Error("Embedding input must be a non-empty array of strings.");
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, texts })}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.child || this.child.exitCode !== null) return;
    this.child.stdin.end();
    await new Promise((resolve) => {
      this.child.once("close", resolve);
      setTimeout(() => {
        if (this.child && this.child.exitCode === null) this.child.kill();
        resolve();
      }, 5000).unref();
    });
  }
}
