## `check_status`

View sub-agent status and background shell status. Non-blocking. Returns agent reports (working, completed, errored) and tracked shell summaries. When you are not sure when the agent will finish their work, use `wait` to wait for the result instead, as frequent checking would result in more activations and more context wasted.
