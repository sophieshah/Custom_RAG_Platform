import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import multer from "multer";
import { indexDocument } from "./index-document.js";
import { titleFromPath } from "./documents.js";
import {
  readSystemInstructionsFromSource,
  saveSystemInstructionsToSource,
} from "./system-instructions.js";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_LOGIN_ATTEMPTS = 8;
const MAX_LOGIN_ADDRESSES = 10000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const SESSION_DURATION_MS = 2 * 60 * 60 * 1000;
const SUPPORTED_EXTENSIONS = new Set([".pdf", ".md", ".txt"]);

function hash(value) {
  return createHash("sha256").update(value).digest();
}

function safeEqual(first, second) {
  return timingSafeEqual(hash(first), hash(second));
}

function cleanUploadName(originalName) {
  const basename = path.posix.basename(path.win32.basename(originalName));
  const extension = path.extname(basename).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error("Only PDF, Markdown (.md), and text (.txt) files are supported.");
  }
  const stem = path.basename(basename, path.extname(basename))
    .replace(/[^a-zA-Z0-9._() -]/g, "_")
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, 100);
  if (!stem) throw new Error("The uploaded file needs a valid filename.");
  return `${stem}${extension}`;
}

function createAdminSessions({ username, password, configured }) {
  const sessions = new Map();
  const failures = new Map();

  function isRateLimited(address) {
    const attempt = failures.get(address);
    if (!attempt || Date.now() - attempt.startedAt >= LOGIN_WINDOW_MS) return false;
    return attempt.count >= MAX_LOGIN_ATTEMPTS;
  }

  function recordFailure(address) {
    const current = failures.get(address);
    if (!current || Date.now() - current.startedAt >= LOGIN_WINDOW_MS) {
      if (failures.size >= MAX_LOGIN_ADDRESSES) {
        failures.delete(failures.keys().next().value);
      }
      failures.set(address, { startedAt: Date.now(), count: 1 });
    } else {
      current.count += 1;
    }
  }

  function authenticate(req, res, next) {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.get("authorization") || "");
    const tokenDigest = match ? hash(match[1]).toString("hex") : "";
    const expiresAt = sessions.get(tokenDigest);
    if (!expiresAt || expiresAt <= Date.now()) {
      sessions.delete(tokenDigest);
      return res.status(401).json({ error: "Admin login is required." });
    }
    return next();
  }

  const router = express.Router();

  router.post("/login", (req, res) => {
    if (!configured) {
      return res.status(503).json({ error: "Admin access is not configured on this server." });
    }
    for (const [key, attempt] of failures) {
      if (Date.now() - attempt.startedAt >= LOGIN_WINDOW_MS) failures.delete(key);
    }
    const address = req.ip || req.socket.remoteAddress || "unknown";
    if (isRateLimited(address)) {
      return res.status(429).json({ error: "Too many login attempts. Try again in 15 minutes." });
    }
    const suppliedUsername = typeof req.body?.username === "string" ? req.body.username : "";
    const suppliedPassword = typeof req.body?.password === "string" ? req.body.password : "";
    const usernameMatches = safeEqual(suppliedUsername, username);
    const passwordMatches = safeEqual(suppliedPassword, password);
    const valid = usernameMatches && passwordMatches;
    if (!valid) {
      recordFailure(address);
      return res.status(401).json({ error: "Invalid admin credentials." });
    }
    failures.delete(address);
    for (const [key, expiry] of sessions) {
      if (expiry <= Date.now()) sessions.delete(key);
    }
    const token = randomBytes(32).toString("base64url");
    sessions.set(hash(token).toString("hex"), Date.now() + SESSION_DURATION_MS);
    res.setHeader("Cache-Control", "no-store");
    return res.json({ token, expiresInSeconds: SESSION_DURATION_MS / 1000 });
  });

  router.use(authenticate);

  router.post("/logout", (req, res) => {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.get("authorization") || "");
    if (match) sessions.delete(hash(match[1]).toString("hex"));
    return res.status(204).end();
  });

  router.get("/instructions", async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    const systemInstructions =
      await readSystemInstructionsFromSource();

    return res.json({ systemInstructions });
  } catch (error) {
    return next(error);
  }
});

router.put("/instructions", async (req, res, next) => {
  try {
    const { systemInstructions } = req.body || {};

    if (typeof systemInstructions !== "string") {
      return res.status(400).json({
        error: "System instructions must be text.",
      });
    }

    const saved =
      await saveSystemInstructionsToSource(systemInstructions);

    return res.json({
      success: true,
      systemInstructions: saved,
      message: "System instructions saved to source code.",
    });
  } catch (error) {
    if (error instanceof Error &&
        error.message.includes("100000")) {
      return res.status(400).json({ error: error.message });
    }

    return next(error);
  }
});

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  }).single("file");

  router.post("/documents", (req, res, next) => {
    upload(req, res, async (uploadError) => {
      if (uploadError) {
        return res.status(400).json({
          error: uploadError.code === "LIMIT_FILE_SIZE"
            ? "File size must be 20 MB or less."
            : uploadError.message,
        });
      }
      if (!req.file) return res.status(400).json({ error: "Select one file to upload." });

      let filename;
      try {
        filename = cleanUploadName(req.file.originalname);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }

      const config = req.app.locals.adminConfig;
      const uploadDirectory = path.join(config.directory, "uploads");
      const sourceFile = `admin_uploads/${filename.toLowerCase()}`;
      const finalPath = path.join(uploadDirectory, filename);
      const temporaryPath = path.join(uploadDirectory, `${Date.now()}-${randomBytes(8).toString("hex")}${path.extname(filename)}`);
      try {
        await mkdir(uploadDirectory, { recursive: true });
        await writeFile(temporaryPath, req.file.buffer, { flag: "wx" });
        const chunkCount = await indexDocument({
          filePath: temporaryPath,
          sourceFile,
          title: titleFromPath(filename),
          embeddingWorker: req.app.locals.embeddingWorker,
          qdrant: req.app.locals.qdrant,
        });
        await copyFile(temporaryPath, finalPath);
        await rm(temporaryPath, { force: true });
        return res.json({ filename, chunkCount, message: `Indexed ${chunkCount} chunks from ${filename}.` });
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch((cleanupError) => {
          console.error("Unable to clean up temporary admin upload:", cleanupError.message);
        });
        return next(error);
      }
    });
  });

  return router;
}

export function createAdminRouter({ username="admin", password="123", configured = Boolean(username && password) }) {
  return createAdminSessions({ username, password, configured });
}
