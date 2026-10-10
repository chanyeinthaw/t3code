# Agents

Agents are persistent conversations with their own configuration and working directory. Pulse is the built-in default agent.

As a hub admin, open **Settings > Agents** to configure Pulse or add another agent. Choose a name, a connected environment, and any additional instructions, then save. Each agent has a chat URL at `/agents/<id>` on your client's origin. Pulse uses `/agents/pulse`. Agent conversations stay out of the thread sidebar.

Each agent runs in `agents/<id>` under its environment's Pulse home. It uses the environment's default provider and permissions when created. You can change its model in the composer. Choose its environment in settings. Its app tools currently control only that environment.

Changing the environment starts a new conversation. Editing the name or instructions preserves the conversation. Clearing the configuration or removing an agent preserves its previous conversations and files. The default agent can be cleared but cannot be removed.

**Additional instructions** append after Pulse's existing provider instructions and apply to subsequent turns. Codex, Claude Code, OpenCode, and Pi support native instruction appending. Claude may wait for background work to finish before applying a change.
