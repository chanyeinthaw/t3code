/** Reserved for future One Chat instructions; no special instructions are active yet. */
export const ONE_CHAT_SYSTEM_INSTRUCTIONS = "";

export function oneChatInstructions(additionalInstructions: string): string {
  return [ONE_CHAT_SYSTEM_INSTRUCTIONS, additionalInstructions]
    .filter((part) => part.trim() !== "")
    .join("\n\n");
}
