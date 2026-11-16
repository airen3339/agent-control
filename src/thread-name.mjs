export function normalizedThreadName(value) {
  const name = String(value || "").trim();
  if (!name) throw Object.assign(new Error("会话标题不能为空"), { status: 400 });
  if (name.length > 200) throw Object.assign(new Error("会话标题不能超过 200 字"), { status: 400 });
  return name;
}
