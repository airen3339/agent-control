import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const UNKNOWN_ACCOUNT = Object.freeze({
  signedIn: false,
  name: "",
  email: "",
  label: "未登录或无法识别",
});

function jwtClaims(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

export async function readCodexAccount(codexHome) {
  try {
    const auth = JSON.parse(await readFile(resolve(codexHome, "auth.json"), "utf8"));
    const claims = jwtClaims(auth?.tokens?.id_token);
    const name = clean(claims?.name);
    const email = clean(claims?.email);
    if (!name && !email) return { ...UNKNOWN_ACCOUNT };
    return {
      signedIn: true,
      name,
      email,
      label: name && email && name.toLowerCase() !== email.toLowerCase()
        ? `${name} · ${email}`
        : (email || name),
    };
  } catch {
    return { ...UNKNOWN_ACCOUNT };
  }
}
