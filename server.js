import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Accept");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const MASTER_KEY = process.env.MASTER_KEY || "08023034259";

// POST /api/update — receives data from MT5 EA
app.post("/api/update", async (req, res) => {
  try {
    const data = typeof req.body === "string"
      ? JSON.parse(req.body)
      : req.body;

    if (!data) return res.status(400).json({ error: "No data" });

    const { error } = await supabase
      .from("shield_state")
      .insert([data]);

    if (error) {
      console.error("SUPABASE INSERT ERROR:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ status: "ok" });

  } catch (err) {
    console.error("POST ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/state — multi-account, filtered by license_key
app.get("/api/state", async (req, res) => {
  try {
    const key = req.query.key || req.query.license_key;

    if (!key) {
      return res.status(400).json({ error: "license_key required" });
    }

    let query = supabase
      .from("shield_state")
      .select("*")
      .order("id", { ascending: false })
      .limit(50);

    // Master key returns ALL accounts
    // Any other key returns only that license's accounts
    if (key !== MASTER_KEY) {
      query = query.eq("license_key", key);
    }

    const { data, error } = await query;

    if (error) {
      console.error("SUPABASE READ ERROR:", error);
      return res.status(500).json({ error: error.message });
    }

    // Deduplicate — keep latest row per account_id
    const map = {};
    for (const row of data) {
      const aid = row.account_id || "unknown";
      if (!map[aid]) map[aid] = row;
    }

    return res.status(200).json(Object.values(map));

  } catch (err) {
    console.error("GET ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("Shield API Running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Shield API running on port ${PORT}`));
