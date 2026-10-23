import { AdminConfigStore } from "../backend/rag/admin-config.js";

const configStore = new AdminConfigStore();

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const inputConfig = await configStore.getInputConfig();
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(inputConfig);
  } catch (error) {
    console.error("Input configuration request failed:", error instanceof Error ? error.message : "Unknown error");
    return res.status(500).json({ error: "Unable to load the input form configuration." });
  }
}
