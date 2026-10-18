const express = require("express");
const multer = require("multer");
const fetch = require("node-fetch");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");

const app = express();
const MAX_SIZE = 20 * 1024 * 1024; // Roblox's own hard cap, don't raise this
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
});

// ---- your values, filled in directly ----
const ROBLOX_API_KEY = "On9OWk63I0utYvHhbN8JANg8ZS9D48QKBQ5gK3yJQ4jCZpexZXlKaGJHY2lPaUpTVXpJMU5pSXNJbXRwWkNJNkluTnBaeTB5TURJeExUQTNMVEV6VkRFNE9qVXhPalE1V2lJc0luUjVjQ0k2SWtwWFZDSjkuZXlKaGRXUWlPaUpTYjJKc2IzaEpiblJsY201aGJDSXNJbWx6Y3lJNklrTnNiM1ZrUVhWMGFHVnVkR2xqWVhScGIyNVRaWEoyYVdObElpd2lZbUZ6WlVGd2FVdGxlU0k2SWs5dU9VOVhhell6U1RCMWRGbDJTR2hpVGpoS1FVNW5PRnBUT1VRME9GRkxRbEUxWjBzemVVcFJOR3BEV25CbGVDSXNJbTkzYm1WeVNXUWlPaUkxT0RFek1UYzBNVGt3SWl3aVpYaHdJam94TnpreE5UTTROekF3TENKcFlYUWlPakUzT1RFMU16VXhNREFzSW01aVppSTZNVGM1TVRVek5URXdNSDAuS1NHaVFyeW1fWDl3b1UwejZPM1ZhNElaM2k1WEY0VVp1dEtBZEg0a3o3SFZHaHpQTUtPRk9WME9uTGFzWWJIZkZGTUhFV044VExBdDJiOV85a3FKZGRyZFk0U3JwXzBoVHVDRWhLTklnNUpIX1ZDeFJnQzg0WEVIYmpvYldNalJxcGJEUnY3SzhqLWwtYXdxX3FaZkk5SmNHNVVQQzdwdTZkT2cwd2JGbkxmaXR1Vm1CQUU1MUZXbXRTamdsZjRhZHBPdkFVek05ZkJHR2kzMHZlcXdHTkQwZ2hVMlNxZUNDY3Q5dzFUT3ItRkhiZHE5NG4yVmYteTRSWEdpejdFYWNwd19jME9aU3ZMbjdiRklrcV9FNzVmRXRMaHlNYnYxek8tc2xidWRxdVV1ZTFwNDNFMGJFRGRIZkliQndmMEpYMDU1djdPbmJwbld0NjNsbkRMT2Zn";
const ROBLOX_USER_ID = "5813174190";
const APP_SECRET = "spawn777car";
// ------------------------------------------

const PORT = process.env.PORT || 3000;
const LATEST_FILE = path.join(__dirname, "latest.json");

// valid rotation fix codes — must match the FLIP_TABLE keys in the Roblox script
const VALID_FLIPS = new Set(["auto", "none", "x180", "z180", "x90", "xneg90", "y180", "x180z180"]);

function readLatest() {
  try {
    return JSON.parse(fs.readFileSync(LATEST_FILE, "utf8"));
  } catch (e) {
    return null;
  }
}

function writeLatest(data) {
  fs.writeFileSync(LATEST_FILE, JSON.stringify(data, null, 2));
}

function checkSecret(req, res) {
  const given = req.query.secret || req.headers["x-app-secret"];
  if (given !== APP_SECRET) {
    res.status(401).json({ error: "bad secret" });
    return false;
  }
  return true;
}

app.use(express.static(path.join(__dirname, "public")));

app.post("/upload", upload.single("glb"), async (req, res) => {
  if (!checkSecret(req, res)) return;
  if (!req.file) return res.status(400).json({ error: "no file uploaded" });

  const displayName = (req.body.name || "MyModel").slice(0, 50);
  const flip = VALID_FLIPS.has(req.body.flip) ? req.body.flip : "none";

  try {
    const form = new FormData();
    form.append(
      "request",
      JSON.stringify({
        assetType: "Model",
        displayName,
        description: "Uploaded from phone pipeline",
        creationContext: { creator: { userId: ROBLOX_USER_ID } },
      })
    );
    form.append("fileContent", req.file.buffer, {
      filename: req.file.originalname || "model.glb",
      contentType: "model/gltf-binary",
    });

    const createRes = await fetch("https://apis.roblox.com/assets/v1/assets", {
      method: "POST",
      headers: { "x-api-key": ROBLOX_API_KEY, ...form.getHeaders() },
      body: form,
    });

    const createJson = await createRes.json();
    if (!createRes.ok) {
      console.error("Roblox create asset failed:", createJson);
      return res.status(createRes.status).json({ error: createJson });
    }

    const operationId = createJson.path.split("/")[1];

    const result = await pollOperation(operationId);
    if (result.error) {
      return res.status(500).json({ error: result.error });
    }

    const latest = {
      assetId: result.assetId,
      moderationState: result.moderationState || "UNKNOWN",
      displayName,
      flip,
      uploadedAt: new Date().toISOString(),
    };
    writeLatest(latest);
    console.log("Upload done:", latest);
    res.json({ ok: true, ...latest });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// bigger files take longer to process on Roblox's side — poll for up to ~2 minutes
async function pollOperation(operationId) {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(
      `https://apis.roblox.com/assets/v1/operations/${operationId}`,
      { headers: { "x-api-key": ROBLOX_API_KEY } }
    );
    const j = await r.json();
    if (j.done) {
      if (j.response && j.response.assetId) {
        const state =
          j.response.moderationResult &&
          j.response.moderationResult.moderationState;
        return { assetId: j.response.assetId, moderationState: state };
      }
      return { error: j.error || "upload failed moderation or processing" };
    }
    await new Promise((r2) => setTimeout(r2, 2000));
  }
  return { error: "timed out waiting for Roblox to process the asset" };
}

app.get("/latest", (req, res) => {
  if (!checkSecret(req, res)) return;
  const latest = readLatest();
  if (!latest) return res.status(404).json({ error: "nothing uploaded yet" });
  res.json(latest);
});

// friendly error instead of a crash/hang when a file is over the 20MB cap
app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "File is too big — must be under 20MB (Roblox's own hard limit)." });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: String(err) });
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
