export function applicationRange(value: string | null, now = Date.now()) {
  const days = value === null ? 30 : Number(value);
  if (!["1", "7", "14", "30"].includes(String(value ?? 30))) return undefined;
  const sinceAt = now - (days - 1) * 86_400_000;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(sinceAt);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return { days, since: `${part("year")}-${part("month")}-${part("day")}` };
}
