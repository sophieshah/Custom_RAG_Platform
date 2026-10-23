import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDefaultInputConfig, validateInputConfig } from "./input-config.js";

export class AdminConfigStore {
  constructor({ directory = path.resolve(process.env.ADMIN_DATA_DIR || "data") } = {}) {
    this.directory = directory;
    this.filePath = path.join(directory, "admin-config.json");
    this.inputConfigPath = path.join(directory, "input-config.json");
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
      const existing = await readFile(this.filePath, "utf8")
        .then((content) => JSON.parse(content))
        .catch((error) => {
          if (error.code === "ENOENT") return {};
          throw error;
        });
      await writeFile(temporaryPath, JSON.stringify({
        ...existing,
        additionalInstructions: instructions,
      }, null, 2), {
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

  async getInputConfig() {
    try {
      const stored = JSON.parse(await readFile(this.inputConfigPath, "utf8"));
      return validateInputConfig(stored);
    } catch (error) {
      if (error.code === "ENOENT") return getDefaultInputConfig();
      throw error;
    }
  }

  async setInputConfig(inputConfig) {
    const validated = validateInputConfig(inputConfig);
    await mkdir(this.directory, { recursive: true });
    const temporaryPath = path.join(this.directory, `input-config-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, JSON.stringify(validated, null, 2), {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporaryPath, this.inputConfigPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    return validated;
  }
}
