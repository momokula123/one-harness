---
name: session-control
display-name: Session Control
description: Create projects and sessions, send prompts, and control session queues and lifecycle.
user-invocable: false
---

Session controls allow you to manipulate projects, sessions, messages within Bionic. Please make sure you have read the the introspection skill for information on how to locate project, session, message, and queued-message identifiers.

To request control permission, use the `bionic_tool` with name "session_control.request_session_control_permission".

```
bionic_tool(
  name="session_control.request_session_control_permission",
  args=[]
)
```

In Bionic, each project has a working directory and zero or more external files/directories.

To create a project, use the `bionic_tool` with name "session_control.create_project".

```
bionic_tool(
  name="session_control.create_project",
  args=["--name", "My Project", "--working-directory", "/path/to/project"]
)
```

You should only create a project when the user explicitly states so.

The working directory must be outside LM Studio home. Omit `--working-directory` to have LM Studio create one.

Create a session and optionally send its first prompt:

```
bionic_tool(
  name="session_control.create_session",
  args=[
    "--project", "2f8a91c4",
    "--title", "Investigate the bug",
    "--prompt", "Find the cause of the failing test."
  ]
)
```

To rename a session, use `session_control.rename_session`:

```
bionic_tool(
  name="session_control.rename_session",
  args=[
    "--project", "2f8a91c4",
    "--session", "784ee605",
    "--title", "Investigate startup failure"
  ]
)
```

To send a prompt to an existing session, use the `bionic_tool` with name "session_control.send_prompt" as shown below:

```
bionic_tool(
  name="session_control.send_prompt",
  args=[
    "--project", "2f8a91c4",
    "--session", "784ee605",
    "--prompt", "Also check the recent configuration changes.",
    "--allow-queue", "true"
  ]
)
```

Restore an archived session with `session_control.set_session_archived` and `--archived false` before sending it a prompt.

Bionic allows messages to be queued. If `--allow-queue` is `true`, a busy session will queue the message instead of causing an error.

Use `introspection.read_session_queued_message` to inspect the queue.

A queued message can also be marked as "steering". Normally, a queued message will only be sent after the assistant has finished its turn. A steering message, will send upon finishing the next tool call, allowing earlier interruption.

A later queued message that is marked as steering will be sent before an earlier queued message that is not marked as steering. i.e. Steering messages will cut in line.

To set a queued message as steering, use the `bionic_tool` with name "session_control.set_queued_message_steering" as shown below:

```
bionic_tool(
  name="session_control.set_queued_message_steering",
  args=[
    "--project", "2f8a91c4",
    "--session", "784ee605",
    "--queued-message", "0b6b749e",
    "--steering", "true"
  ]
)
```

To delete a queued message, use the `bionic_tool` with name "session_control.delete_queued_message" as shown below:

```
bionic_tool(
  name="session_control.delete_queued_message",
  args=[
    "--project", "2f8a91c4",
    "--session", "784ee605",
    "--queued-message", "0b6b749e"
  ]
)
```

Bionic allows extremely efficient session forking through its superior data structures. To fork a session, use the `bionic_tool` with name "session_control.fork_session" as shown below:

```
bionic_tool(
  name="session_control.fork_session",
  args=[
    "--project", "2f8a91c4",
    "--session", "784ee605",
    "--message", "4f08cc9a"
  ]
)
```

The `--message` is optional and specifies the message after which the session should be forked. If omitted, the session will be forked at its latest state. Note: Not all messages can be forked at. The actual fork point might be later than the specified message.

To interrupt a session, use the `bionic_tool` with name "session_control.interrupt_session" as shown below:

```
bionic_tool(
  name="session_control.interrupt_session",
  args=[
    "--project", "2f8a91c4",
    "--session", "784ee605"
  ]
)
```

To archive (soft delete) or restore a session, use `session_control.set_session_archived`. Pass `--archived true` to archive, or `--archived false` to restore:

```
bionic_tool(
  name="session_control.set_session_archived",
  args=[
    "--project", "2f8a91c4",
    "--session", "784ee605",
    "--archived", "true"
  ]
)
```

It is also possible to move sessions across projects. Moving stops existing session notifications. However, doing so can greatly confuse the session about its working context. Thus, don't do it unless absolutely necessary.

```
bionic_tool(
  name="session_control.move_session",
  args=[
    "--project", "2f8a91c4",
    "--session", "784ee605",
    "--destination-project", "91be772a"
  ]
)
```
