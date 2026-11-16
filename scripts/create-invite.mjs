const relayUrl = process.env.RELAY_PUBLIC_URL;
const relayKey = process.env.RELAY_KEY;
const label = process.argv.slice(2).join(" ");

if (!relayUrl || !relayKey) {
  process.stderr.write("请设置 RELAY_PUBLIC_URL 和 RELAY_KEY\n");
  process.exit(2);
}

const response = await fetch(new URL("/admin/invites", relayUrl), {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Relay-Key": relayKey,
  },
  body: JSON.stringify({ label }),
});
if (!response.ok) {
  process.stderr.write(`生成邀请码失败（HTTP ${response.status}）\n`);
  process.exit(1);
}
const result = await response.json();
process.stdout.write(`${result.inviteCode}\n`);
