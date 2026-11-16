export default {
  execute(input: Record<string, unknown>) {
    return Promise.resolve({ hits: [{ id: "<prev@example.org>", date: "2026-10-20T10:00:00Z", from: String(input.from ?? ""), subject: "Re: Kundenmeeting agenda" }] });
  },
};
