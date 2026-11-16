export {};
const [ownerText, groupText, timeoutText] = process.argv.slice(2);
const owner = Number(ownerText);
const group = Number(groupText);
const timeout = Number(timeoutText);
if (!Number.isInteger(owner) || owner < 2 || !Number.isInteger(group) || group < 2 || !Number.isFinite(timeout) || timeout < 1 || timeout > 300000) process.exit(2);
const deadline = Date.now() + timeout;
while (Date.now() < deadline) {
  try { process.kill(owner, 0); } catch { break; }
  await Bun.sleep(100);
}
try { if (process.platform === "win32") process.kill(group, "SIGKILL"); else process.kill(-group, "SIGKILL"); } catch { process.exit(0); }
