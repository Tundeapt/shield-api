import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.post("/update", async (req, res) => {
  console.log("Incoming:", req.body);

  try {
    const data = req.body;

    if (!data) {
      return res.status(400).json({ error: "No data" });
    }

    const { error } = await supabase
      .from("shield_state")
      .insert([data]);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ status: "ok" });

  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/", (req, res) => {
  res.send("Shield API Running");
});

app.listen(3000, () => console.log("Running"));
