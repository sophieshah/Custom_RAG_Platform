import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class AdminConfigStore {
  constructor({ directory = path.resolve(process.env.ADMIN_DATA_DIR || "data") } = {}) {
    this.directory = directory;
    this.filePath = path.join(directory, "admin-config.json");
  }

  async getAdditionalInstructions() {
    try {
      const stored = JSON.parse(await readFile(this.filePath, "utf8"));
      if (typeof stored.additionalInstructions !== "string") {
        throw new Error("Admin configuration has an invalid instructions value.");
      }
      return stored.additionalInstructions;
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw error;
    }
  }

  async setAdditionalInstructions(instructions) {
    if (typeof instructions !== "string" || instructions.length > 20000) {
      throw new Error("Additional instructions must be text of at most 20,000 characters.");
    }
    await mkdir(this.directory, { recursive: true });
    const temporaryPath = path.join(this.directory, `admin-config-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, JSON.stringify({ additionalInstructions: instructions }, null, 2), {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    return instructions;
  }
}
