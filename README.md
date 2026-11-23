# mend

mend applies an edit that an AI model wrote to a tree of text files, in one of four formats: a unified diff, SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. Every file is changed or nothing is.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

PATCH is the path of the patch file, or `-` (or absent) to read it from standard input. `--check` does everything but write. `--strict` matches lines exactly.

Built by an AI agent for make.fun's ["Build mend, one patch tool for every AI edit format" bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
