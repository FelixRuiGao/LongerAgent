## `check_status`

Check for new messages (user messages, system notifications), sub-agent status, and tracked shell status. Non-blocking. Use to read messages when you see a `[Message Notification]` in a tool result. When you are not sure when the agent will finish their work, use `wait` to wait for the result instead of using `check_status` frequently, as frequent checking would result in more activations and more context wasted.
