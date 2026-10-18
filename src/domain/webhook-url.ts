const loopbackNames = new Set(["localhost", "127.0.0.1", "[::1]"]);

const privateOrReserved = (nums: readonly number[]): boolean => {
  const a = nums[0] ?? 0;
  const b = nums[1] ?? 0;
  if (a === 10 || a === 127 || a === 0 || a >= 224) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  return false;
};

const privateAddress = "must not target a private or link-local address";

export const webhookUrlProblem = (value: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an http or https URL";
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return "must not include a username or password";
  }
  const host = url.hostname.toLowerCase();
  const parts = host.split(".");
  const address =
    parts.length === 4 ? parts.map((part) => Number(part)) : undefined;
  const loopback = loopbackNames.has(host);
  if (host.includes(":") && !loopback) {
    return privateAddress;
  }
  if (address !== undefined && privateOrReserved(address) && !loopback) {
    return privateAddress;
  }
  if (loopback) {
    return url.protocol === "http:" ? undefined : "must be http on localhost";
  }
  if (url.protocol === "https:") {
    return undefined;
  }
  return "must be https, or http on localhost";
};
