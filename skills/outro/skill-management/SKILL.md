---
name: skill-management
display-name: Skill Management
description: Use when creating, installing, uninstalling, or removing Bionic skills, or when explaining what skills are and how they work.
user-invocable: false
---

In Bionic, skills are folders that contain at least one `SKILL.md` file. A `SKILL.md` file is a Markdown file with YAML front matter. It contains prompts to be injected when the skill is triggered. Bionic identifies each skill by the absolute path to its `SKILL.md` file. The front matter defines the name and description shown to the model and user. A skill can be triggered in two ways:

1. The agent believes the skill is relevant because its description matches the current need. In that case, the agent will read the `SKILL.md` file on its own using file-reading tools.
2. The user explicitly requests that the skill's content be injected by manually triggering the skill.

Users can trigger a skill manually only by typing `@` followed by the skill name in the input box. As soon as they type `@`, a list of skills and other resources, such as files in the workspace, appears and is filtered based on what they have already typed. If a regular character immediately precedes `@`, the skill pop-up will not appear. Otherwise, there are no rules about where skills can be triggered. A skill can be triggered even inside backticks or code blocks.

It is possible to prevent the agent from reading the skill on its own (method 1) by specifying `disable-model-invocation: true` in the front matter.

It is possible to prevent the user from triggering the skill manually (method 2) by specifying `user-invocable: false` in the front matter.

The name of the folder containing the skill must match the name of the skill in the front matter. Skill names must be kebab-case strings that are 1-63 characters long, with no consecutive, leading, or trailing hyphens.

When a skill is triggered, the agent always receives the skill folder's full path and read access to the folder. Thus, the skill folder can contain other files, such as data files or scripts, that may be useful for the skill.

In Bionic, there are two types of skills: global skills and project skills. All global skills are located in the `~/.lmstudio/skills` folder and are available to all projects. For users with very old installations, the folder might be located at `~/.cache/lm-studio/skills` (rare). Project skills are located in each project's `.agents/skills` folder.

That is, if there is a global skill called `example-skills`, its `SKILL.md` will be located at `~/.lmstudio/skills/example-skills/SKILL.md`. If there is a project skill called `example-skills`, its `SKILL.md` will be located at `<project-folder>/.agents/skills/example-skills/SKILL.md`.

If the user asks you to install or create a skill, determine whether it should be a global or project skill unless the user explicitly specifies the type. Do not ask the user to choose, as that may confuse them. When in doubt, default to a global skill.

You can directly edit the project skills as they are just regular files in the project folder.

HOWEVER, DO NOT edit global skills directly. If you need to install a new skill, you must prepare it in the scratchpad and then use the following tools to install it. Similarly, to remove a global skill, you must use the following tools to uninstall it. Do not delete the skill folder yourself.

Tool paths resolve from the current working directory. When installing from the scratchpad, call `get_scratchpad_folder` and pass the absolute path it returns. For example, if it returns `/absolute/scratchpad`, prepare the skill under that folder and call:

```
bionic_tool(
  name="skill.install",
  args=["--skill-folder-path", "/absolute/scratchpad/example-skills"]
)
```

It will validate the skill and ask the user to approve installing it globally. If the folder name disagrees with the skill name in the front matter, it will use the skill name in the front matter as the folder name. If the skill is already installed, it will be overwritten.

When the user asks how to install skills, volunteer to install the skill for them instead of giving them instructions at first. If they insist on doing it themselves afterwards, give them instructions for installing both global and project skills. You may need to explain the difference between global and project skills. If the user seems confused, recommend global skills.

Unless user specifically asks for it (for example they want to install the skill themselves, or asks you for the actual path), do not mention the paths for skills as path may be confusing to the user.

When installing skills for the user, be aware that some skills may indicate dependencies on other skills by mentioning them in the `SKILL.md` file. In that case, volunteer to install the dependent skills as well.

Before installing a skill, quickly review its `SKILL.md` and any supporting files. If you find suspicious behavior, such as destructive commands, credential or data access, obfuscation, unexpected downloads or uploads, or anything else that looks malicious, explain the concern and ask the user before continuing.

To uninstall a global skill, first call `skill.list`, then pass the exact absolute `path` it returns to `skill.uninstall` with `--skill-file-path`. It will ask the user to approve the uninstall. Example:

```
bionic_tool(
  name="skill.uninstall",
  args=["--skill-file-path", "/home/example/.lmstudio/skills/example-skills/SKILL.md"]
)
```

Note that when uninstalling a skill, the entire skill folder will be removed, not only the SKILL.md. Do not worry about cleaning up any other files in the skill folder, as they are considered part of the skill.

Project skills are always active, and Bionic currently does not support enabling or disabling them. If you absolutely must, you may temporarily prepend a dot to the skill folder name to disable it.

Global skills, however, can be enabled or disabled in the settings. Go to `Settings` at the bottom left of Bionic, select `Skills` from the list on the left, and use the toggles to enable or disable skills.

You may also query all the installed global skills in one go using the `bionic_tool` tool named `skill.list`. It returns each skill's name, display name, description, invocation gates, exact absolute path, and enabled state. The returned path identifies the skill for `skill.uninstall` and `skill.setEnabled`. Long display names and descriptions are truncated in the middle. Example:

```
bionic_tool(
  name="skill.list",
  args=[]
)
```

To set the enabled state of a global skill, pass the exact absolute `path` from `skill.list` to `skill.setEnabled` with `--skill-file-path`. Pass `true` or `false` to `--enabled`. It will ask the user to approve the change. Example:

```
bionic_tool(
  name="skill.setEnabled",
  args=[
    "--skill-file-path", "/home/example/.lmstudio/skills/example-skill/SKILL.md",
    "--enabled", "true"
  ]
)
```

## Skill Writing Guidelines

Disable model invocation for all internal skills by setting `disable-model-invocation: true`. There's basically no scenario where we want the model to invoke them without explicit guidance.

The most important part of a skill is its `description`. The `description` will be injected into the system prompt of every agent that has the skill enabled.

`description` must be short and explain the purpose. Critically, it should be written so that someone without any context about the project knows when to use the skill. Aim for fewer than 150 characters. Do not exceed 300 characters unless the user explicitly requests a longer description, in which case caution the user and proceed.

For both the `description` and `name` fields, avoid the sentence form "A, but not B" unless there is evidence that A is often confused with B.

## SKILL.md Supported Fields

The following fields are supported in the front matter of a `SKILL.md` file:

- `name`: This field is required. It contains the name of the skill, which must be a kebab-case string that is 1-63 characters long, with no consecutive, leading, or trailing hyphens. The name is injected into the system prompt and used as the trigger text when the user manually triggers the skill.
- `display-name`: This field is optional but should be provided when creating a skill. Its value is the human-readable name of the skill and is displayed in the skill list when the user types `@` to trigger the skill manually. If this field is omitted, the `name` field is used.
- `description`: This field is required. It contains a short description of the skill that is injected into the system prompt and used by the agent to decide when to trigger the skill on its own.
- `disable-model-invocation`: This field is optional and defaults to false. If true, the agent will not read the skill on its own. The user can only trigger the skill manually.
- `user-invocable`: This field is optional and defaults to true. If false, the user will not be able to trigger the skill manually.

Front matter may contain other fields, but they will be ignored by Bionic.
