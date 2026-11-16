export default {
  execute(input: Record<string, unknown>) {
    if (input.messageId === "<missing@example.org>") throw new Error("A_MAIL_READ: backend email exited with code 1");
    return Promise.resolve({ body: "See you at the Kundenmeeting." });
  },
};
